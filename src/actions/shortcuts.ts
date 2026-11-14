/**
 * Keyboard shortcut chords: how they are written, matched and displayed.
 *
 * A chord is stored as text, e.g. `"Cmd+Shift+K"`, `"Space"`, `"Shift+Left"`.
 * Modifiers always appear in the order Ctrl, Alt, Shift, Cmd, so two chords
 * are equal exactly when their strings are.
 */

export type Modifier = "Ctrl" | "Alt" | "Shift" | "Cmd";

export interface Chord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  cmd: boolean;
  /** A key id: a lower-case letter, a digit, punctuation, or a named key. */
  key: string;
}

const MODIFIER_ORDER: readonly Modifier[] = ["Ctrl", "Alt", "Shift", "Cmd"];

/** `KeyboardEvent.code` to key id, for keys whose `key` changes with Shift or Alt. */
const CODE_KEYS: Readonly<Record<string, string>> = {
  Space: "Space",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  Tab: "Tab",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

const DISPLAY_KEYS: Readonly<Record<string, string>> = {
  Space: "Space",
  Enter: "↩",
  Escape: "esc",
  Backspace: "⌫",
  Delete: "⌦",
  Tab: "⇥",
  Left: "←",
  Right: "→",
  Up: "↑",
  Down: "↓",
  Home: "↖",
  End: "↘",
  PageUp: "⇞",
  PageDown: "⇟",
};

const DISPLAY_MODIFIERS: Readonly<Record<Modifier, string>> = {
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Cmd: "⌘",
};

const SPOKEN_MODIFIERS: Readonly<Record<Modifier, string>> = {
  Ctrl: "Control",
  Alt: "Option",
  Shift: "Shift",
  Cmd: "Command",
};

const SPOKEN_KEYS: Readonly<Record<string, string>> = {
  Left: "Left Arrow",
  Right: "Right Arrow",
  Up: "Up Arrow",
  Down: "Down Arrow",
  Enter: "Return",
  Backspace: "Delete",
  Delete: "Forward Delete",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "[": "Left Bracket",
  "]": "Right Bracket",
  "\\": "Backslash",
  "-": "Minus",
  "=": "Equals",
  "`": "Backtick",
};

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
  "Fn",
]);

function modifiersOf(chord: Chord): Modifier[] {
  const held: Record<Modifier, boolean> = {
    Ctrl: chord.ctrl,
    Alt: chord.alt,
    Shift: chord.shift,
    Cmd: chord.cmd,
  };
  return MODIFIER_ORDER.filter((modifier) => held[modifier]);
}

/** Parses chord text. Returns `null` for anything that is not a valid chord. */
export function parseChord(text: string): Chord | null {
  // "Cmd++" is Cmd and the plus key: split on "+" but keep a trailing one.
  const parts = text === "+" ? ["+"] : text.replace(/\+\+$/, "+Plus").split("+");
  const key = parts.pop();
  if (!key) {
    return null;
  }
  const chord: Chord = {
    ctrl: false,
    alt: false,
    shift: false,
    cmd: false,
    key: key === "Plus" ? "+" : key,
  };
  for (const part of parts) {
    switch (part) {
      case "Ctrl":
        chord.ctrl = true;
        break;
      case "Alt":
        chord.alt = true;
        break;
      case "Shift":
        chord.shift = true;
        break;
      case "Cmd":
        chord.cmd = true;
        break;
      default:
        return null;
    }
  }
  return chord;
}

/** Canonical chord text. */
export function formatChord(chord: Chord): string {
  return [...modifiersOf(chord), chord.key].join("+");
}

/**
 * The key id for a keyboard event, or `null` for a bare modifier press.
 *
 * Letters follow the character the layout produces, as Mac shortcuts do, so
 * ⌘K is the key labelled K on any layout. With Option held, macOS reports the
 * composed character ("˚"), so the physical key is used instead.
 */
export function eventKey(event: Pick<KeyboardEvent, "key" | "code">): string | null {
  if (MODIFIER_CODES.has(event.code)) {
    return null;
  }
  const named = CODE_KEYS[event.code];
  if (named) {
    return named;
  }
  if (/^F\d{1,2}$/.test(event.code)) {
    return event.code;
  }
  if (/^Digit\d$/.test(event.code)) {
    return event.code.slice(5);
  }
  if (/^Numpad\d$/.test(event.code)) {
    return event.code.slice(6);
  }
  if (/^[a-z]$/i.test(event.key)) {
    return event.key.toLowerCase();
  }
  if (/^Key[A-Z]$/.test(event.code)) {
    return event.code.slice(3).toLowerCase();
  }
  return event.key.length === 1 ? event.key.toLowerCase() : null;
}

type ChordEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
>;

/** The chord a keyboard event represents, or `null` for a bare modifier. */
export function chordFromEvent(event: ChordEvent): Chord | null {
  const key = eventKey(event);
  if (key === null) {
    return null;
  }
  return {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    cmd: event.metaKey,
    key,
  };
}

/** Chord text for a keyboard event, or `null` for a bare modifier. */
export function chordTextFromEvent(event: ChordEvent): string | null {
  const chord = chordFromEvent(event);
  return chord ? formatChord(chord) : null;
}

function keyLabel(key: string): string {
  return DISPLAY_KEYS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** The glyphs for a chord in macOS order, one entry per keycap: `["⇧", "⌘", "K"]`. */
export function chordGlyphs(text: string): string[] {
  const chord = parseChord(text);
  if (!chord) {
    return [];
  }
  return [
    ...modifiersOf(chord).map((modifier) => DISPLAY_MODIFIERS[modifier]),
    keyLabel(chord.key),
  ];
}

/** A chord as VoiceOver should read it: "Shift Command K". */
export function chordSpoken(text: string): string {
  const chord = parseChord(text);
  if (!chord) {
    return "";
  }
  const key =
    SPOKEN_KEYS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return [...modifiersOf(chord).map((modifier) => SPOKEN_MODIFIERS[modifier]), key].join(" ");
}

const ARIA_MODIFIERS: Readonly<Record<Modifier, string>> = {
  Ctrl: "Control",
  Alt: "Alt",
  Shift: "Shift",
  Cmd: "Meta",
};

const ARIA_KEYS: Readonly<Record<string, string>> = {
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Up: "ArrowUp",
  Down: "ArrowDown",
};

/** A chord in the form `aria-keyshortcuts` expects: `"Meta+Shift+K"`. */
export function chordAria(text: string | undefined): string | undefined {
  const chord = text ? parseChord(text) : null;
  if (!chord) {
    return undefined;
  }
  const key =
    ARIA_KEYS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return [...modifiersOf(chord).map((modifier) => ARIA_MODIFIERS[modifier]), key].join("+");
}

/** Chords that edit or move through text on the Mac. In a text field they stay with the field. */
const TEXT_EDITING = new Set([
  "Cmd+a",
  "Cmd+c",
  "Cmd+v",
  "Cmd+x",
  "Cmd+z",
  "Shift+Cmd+z",
  "Cmd+Left",
  "Cmd+Right",
  "Cmd+Up",
  "Cmd+Down",
  "Shift+Cmd+Left",
  "Shift+Cmd+Right",
  "Shift+Cmd+Up",
  "Shift+Cmd+Down",
  "Cmd+Backspace",
  "Cmd+Delete",
]);

function isFunctionKey(chord: Chord): boolean {
  return /^F\d{1,2}$/.test(chord.key);
}

/**
 * True for chords that are safe as global shortcuts while a text field has
 * focus: those with Cmd, except the ones that edit text, and the function
 * keys. Bare letters, Space and arrows go to the field; so does Control with
 * a letter, which moves the caret on the Mac (⌃A, ⌃E, ⌃K).
 */
export function worksWhileTyping(text: string): boolean {
  const chord = parseChord(text);
  if (!chord) {
    return false;
  }
  return (chord.cmd && !TEXT_EDITING.has(formatChord(chord))) || isFunctionKey(chord);
}

/**
 * True for chords that still reach the player from inside an open menu,
 * pop-up list or dialog, where every plain key belongs to that thing: those
 * with Cmd or Ctrl, and the function keys.
 */
export function worksInsideAScope(text: string): boolean {
  const chord = parseChord(text);
  if (!chord) {
    return false;
  }
  return chord.cmd || chord.ctrl || isFunctionKey(chord);
}
