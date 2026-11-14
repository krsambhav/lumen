/**
 * The action registry: every thing the user can do, declared once.
 *
 * An action has an id, a name, default shortcuts and a handler. Tooltips, the
 * keyboard dispatcher, the menu bar, the command palette and the Shortcuts
 * settings tab all read from here, so they cannot disagree (DESIGN.md §8).
 */

import type { ComponentType } from "react";

export type ActionCategory =
  | "file"
  | "edit"
  | "playback"
  | "audio"
  | "video"
  | "subtitles"
  | "view"
  | "window"
  | "app";

/** The categories in the order menus and the palette list them, with their names. */
export const CATEGORIES: readonly { id: ActionCategory; name: string }[] = [
  { id: "file", name: "File" },
  { id: "edit", name: "Edit" },
  { id: "playback", name: "Playback" },
  { id: "audio", name: "Audio" },
  { id: "video", name: "Video" },
  { id: "subtitles", name: "Subtitles" },
  { id: "view", name: "View" },
  { id: "window", name: "Window" },
  // About Lumen itself. Last here, though its menu is the first in the bar:
  // what the palette lists first should be about the film.
  { id: "app", name: "Lumen" },
];

/**
 * Where a request to run an action came from. An action uses it to decide
 * how to confirm what it did: a change made with a control that shows the
 * new state itself needs no second confirmation on screen.
 */
export type ActionSource = "keyboard" | "control" | "pointer" | "menu" | "palette" | "system";

export interface ActionContext {
  source: ActionSource;
}

export interface Action {
  /** Stable identifier, `category.verb`: "playback.toggle". Stored in settings. */
  id: string;
  /** What the action does, in sentence case: "Open file…". */
  name: string;
  category: ActionCategory;
  /**
   * The name as it stands right now, for an action whose name follows state
   * ("Enter full screen", then "Exit full screen"): what choosing it will
   * do. Menus, buttons and the palette show it; `name` is what the Shortcuts
   * tab lists the action under, and the palette finds it by either.
   */
  label?: () => string;
  /**
   * The other words people use for it ("loop" for Repeat, "louder" for
   * Volume up): the palette finds the action by these too.
   */
  keywords?: readonly string[];
  /**
   * Worked by its key alone, as one step of something larger (Escape's
   * ladder): the palette does not list it.
   */
  unlisted?: boolean;
  /** Drawn beside the name in the palette and in menus that show icons. */
  icon?: ComponentType<{ className?: string }>;
  /**
   * For an action that switches something on and off: whether it is on now.
   * Menus show a check beside it.
   */
  checked?: () => boolean;
  /** Default chords. The first is the one shown in tooltips and menus. */
  shortcuts: readonly string[];
  /** Holding the key repeats the action (seeking, volume). */
  repeats?: boolean;
  /**
   * Why the action cannot run right now, or `undefined` if it can. Shortcuts
   * for an unavailable action do nothing.
   */
  unavailable?: () => string | undefined;
  run: (context: ActionContext) => void | Promise<void>;
}

const actions = new Map<string, Action>();
/** Chord text to action id. Rebuilt whenever actions or overrides change. */
let chords = new Map<string, string>();

function rebuildChords(): void {
  chords = new Map();
  for (const action of actions.values()) {
    for (const chord of action.shortcuts) {
      // First registration wins; `conflicts()` reports the rest.
      if (!chords.has(chord)) {
        chords.set(chord, action.id);
      }
    }
  }
}

/** Adds actions to the registry. Registering an id again replaces it. */
export function registerActions(list: readonly Action[]): void {
  for (const action of list) {
    actions.set(action.id, action);
  }
  rebuildChords();
}

export function getAction(id: string): Action | undefined {
  return actions.get(id);
}

export function allActions(): Action[] {
  return [...actions.values()];
}

/** The chord shown for an action, or `undefined` if it has none. */
export function shortcutFor(id: string): string | undefined {
  return actions.get(id)?.shortcuts[0];
}

/** The action a chord triggers, if any. */
export function actionForChord(chord: string): Action | undefined {
  const id = chords.get(chord);
  return id === undefined ? undefined : actions.get(id);
}

/**
 * Runs an action by id, saying where the request came from. Returns false if
 * the action does not exist or is unavailable.
 */
export function runAction(id: string, source: ActionSource): boolean {
  const action = actions.get(id);
  if (!action || action.unavailable?.() !== undefined) {
    return false;
  }
  void action.run({ source });
  return true;
}

/** Chords claimed by more than one action, with the ids that claim them. */
export function conflicts(): Map<string, string[]> {
  const claims = new Map<string, string[]>();
  for (const action of actions.values()) {
    for (const chord of action.shortcuts) {
      claims.set(chord, [...(claims.get(chord) ?? []), action.id]);
    }
  }
  return new Map([...claims].filter(([, ids]) => ids.length > 1));
}

/** Empties the registry. For tests. */
export function clearActions(): void {
  actions.clear();
  chords.clear();
}
