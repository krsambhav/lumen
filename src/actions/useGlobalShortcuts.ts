import { useEffect } from "react";
import { focusedFromKeyboard } from "@/lib/focus-origin";
import { actionForChord } from "./registry";
import {
  type Chord,
  chordTextFromEvent,
  parseChord,
  worksInsideAScope,
  worksWhileTyping,
} from "./shortcuts";

const ACTIVATE = ["Space", "Enter"];
const ARROWS = ["Left", "Right", "Up", "Down"];
const ADJUST = [...ARROWS, "Home", "End", "PageUp", "PageDown"];

/**
 * The keys a control uses itself, by role. A control that has keyboard focus
 * keeps these and no others, so a focused button never stops the arrows from
 * seeking (DESIGN.md §8).
 */
const ROLE_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  ["button", ACTIVATE],
  ["link", ["Enter"]],
  ["checkbox", ["Space"]],
  ["switch", ACTIVATE],
  ["radio", ["Space", ...ARROWS]],
  ["tab", [...ACTIVATE, ...ARROWS, "Home", "End"]],
  ["combobox", [...ACTIVATE, "Up", "Down"]],
  ["slider", ADJUST],
  ["scrollbar", ADJUST],
  ["spinbutton", ADJUST],
]);

/**
 * Things that take every plain key while focus is inside them: they move a
 * highlight with the arrows, pick by typing a letter, and close on Escape.
 * `data-keys="own"` opts in anything else that needs the same.
 *
 * A list that lives in a panel is not one of these. It says which keys it
 * uses with `data-own-keys`, and is then a control like any other.
 */
const KEY_SCOPES = [
  '[role="menu"]',
  '[role="menubar"]',
  '[role="listbox"]',
  '[role="tree"]',
  '[role="grid"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[data-keys="own"]',
].join(",");

const NOT_TYPED_INTO = ["button", "checkbox", "radio", "range", "submit", "reset"];

function isTextEntry(target: EventTarget | null): boolean {
  if (target instanceof HTMLElement && target.isContentEditable) {
    return true;
  }
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  return target instanceof HTMLInputElement && !NOT_TYPED_INTO.includes(target.type);
}

/** True when `target` is inside something that takes every plain key. */
function isInsideAScope(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const scope = target.closest(KEY_SCOPES);
  return scope !== null && !scope.hasAttribute("data-own-keys");
}

/** The ARIA role of a control: the explicit one, or the element's own. */
function roleOf(element: Element): string | null {
  const explicit = element.getAttribute("role");
  if (explicit) {
    return explicit;
  }
  if (element instanceof HTMLButtonElement || element.tagName === "SUMMARY") {
    return "button";
  }
  if (element instanceof HTMLAnchorElement && element.hasAttribute("href")) {
    return "link";
  }
  if (element instanceof HTMLInputElement) {
    switch (element.type) {
      case "range":
        return "slider";
      case "checkbox":
      case "radio":
        return element.type;
      default:
        return "button";
    }
  }
  return null;
}

/** True when the kind of control `target` is uses this chord itself. */
function usedByControl(chord: Chord, target: EventTarget | null): boolean {
  // Shift is allowed: Shift+arrows is a slider's larger step.
  if (chord.cmd || chord.ctrl || chord.alt || !(target instanceof Element)) {
    return false;
  }
  // A control can say exactly which keys it takes, where its role's usual
  // set is the wrong one: the timeline leaves the vertical arrows to the
  // volume, and a list in a panel takes Return and Delete.
  const listed = target.closest("[data-own-keys]")?.getAttribute("data-own-keys");
  if (listed !== null && listed !== undefined) {
    return listed.split(" ").includes(chord.key);
  }
  const role = roleOf(target);
  return role !== null && (ROLE_KEYS.get(role)?.includes(chord.key) ?? false);
}

/**
 * Decides whether a key press belongs to a global shortcut or to whatever
 * has focus (DESIGN.md §8):
 *
 * - In a text field only chords with Cmd that do not edit text, and the
 *   function keys, are shortcuts.
 * - Inside an open menu, pop-up list or dialog, only chords with Cmd or Ctrl
 *   and the function keys are.
 * - A control that has keyboard focus keeps the keys its kind uses.
 * - Otherwise the shortcut wins, even if a control was just clicked.
 */
export function shortcutApplies(chordText: string, target: EventTarget | null): boolean {
  if (isTextEntry(target)) {
    return worksWhileTyping(chordText);
  }
  if (isInsideAScope(target)) {
    return worksInsideAScope(chordText);
  }
  const chord = parseChord(chordText);
  return chord === null || !(focusedFromKeyboard(target) && usedByControl(chord, target));
}

/** True when `target` is showing something of its own that Escape should close first. */
function hasOpenLayer(target: EventTarget | null): boolean {
  // Radix marks a trigger whose tooltip or popover is showing.
  return target instanceof Element && (target.getAttribute("data-state") ?? "").endsWith("open");
}

/** What the dispatcher asks of the app around it. */
export interface ShortcutOptions {
  /**
   * A key was pressed for an action that can do nothing just now: say why,
   * so that no key press goes unanswered (DESIGN.md §7, "On-screen display").
   */
  refused?: (reason: string) => void;
  /**
   * Escape, with nothing open on the control that has focus: closes the
   * next thing that is open somewhere else (a toast), and says whether
   * there was one.
   */
  dismiss?: () => boolean;
}

/**
 * Installs the keyboard listeners that turn key presses into actions.
 *
 * The first listens in the capture phase and stops the event when it acts,
 * so a slider that happens to hold focus after a click does not also respond.
 *
 * The second is there because of the menu bar. Its items show the same
 * shortcuts, as real key equivalents, and macOS offers the menu bar any key
 * press the page leaves unhandled. So a key that is somebody's shortcut but
 * was held back by the rules above (a letter pressed inside a dialog, say)
 * is marked as handled once nothing in the page has wanted it: the rules
 * here are then the only ones, wherever the key is pressed.
 */
export function useGlobalShortcuts(options: ShortcutOptions = {}): void {
  const { refused, dismiss } = options;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.isComposing) {
        return;
      }
      const chord = chordTextFromEvent(event);
      const target = event.target;
      if (!chord || !shortcutApplies(chord, target)) {
        return;
      }
      const action = actionForChord(chord);
      const reason = action?.unavailable?.();
      const usable = action !== undefined && reason === undefined;

      // Escape steps out one level at a time, innermost first: whatever is
      // open closes (left to the thing that is open, and then the toast in
      // front); then the keyboard is given back to the picture, which lets
      // the chrome go; only then does the action bound to Escape run.
      if (chord === "Escape") {
        if (hasOpenLayer(target)) {
          return;
        }
        if (!event.repeat && dismiss?.()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (focusedFromKeyboard(target) && target instanceof HTMLElement) {
          event.preventDefault();
          event.stopPropagation();
          target.blur();
          return;
        }
      }

      if (!action) {
        return;
      }
      // The chord is spoken for: the browser and the focused control do
      // nothing with it, whether or not the action can run right now.
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat && !action.repeats) {
        return;
      }
      if (usable) {
        void action.run({ source: "keyboard" });
      } else if (reason !== undefined && chord !== "Escape") {
        // Escape with nothing left to step out of is not a question.
        refused?.(reason);
      }
    }

    function keepFromTheMenuBar(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing) {
        return;
      }
      const text = chordTextFromEvent(event);
      const chord = text ? parseChord(text) : null;
      if (!text || !chord || !actionForChord(text)) {
        return;
      }
      // What is typed is the field's, and a control's own keys are about to
      // work it: neither is left over.
      if (isTextEntry(event.target) || usedByControl(chord, event.target)) {
        return;
      }
      event.preventDefault();
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keydown", keepFromTheMenuBar);
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keydown", keepFromTheMenuBar);
    };
  }, [refused, dismiss]);
}
