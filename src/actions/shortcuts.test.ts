import { describe, expect, it } from "vitest";
import {
  chordAria,
  chordGlyphs,
  chordSpoken,
  chordTextFromEvent,
  formatChord,
  parseChord,
  worksInsideAScope,
  worksWhileTyping,
} from "./shortcuts";

function key(init: Partial<KeyboardEventInit> & { key: string; code: string }) {
  return new KeyboardEvent("keydown", init);
}

describe("parseChord / formatChord", () => {
  it("round-trips chords in canonical modifier order", () => {
    for (const text of ["Space", "Cmd+k", "Shift+Left", "Ctrl+Alt+Shift+Cmd+F5", "Cmd+,"]) {
      const chord = parseChord(text);
      expect(chord).not.toBeNull();
      expect(chord && formatChord(chord)).toBe(text);
    }
  });

  it("normalises modifier order", () => {
    const chord = parseChord("Cmd+Shift+k");
    expect(chord && formatChord(chord)).toBe("Shift+Cmd+k");
  });

  it("understands the plus key", () => {
    expect(parseChord("+")).toMatchObject({ key: "+", cmd: false });
    expect(parseChord("Cmd++")).toMatchObject({ key: "+", cmd: true });
  });

  it("rejects unknown modifiers and empty text", () => {
    expect(parseChord("Hyper+k")).toBeNull();
    expect(parseChord("")).toBeNull();
  });
});

describe("chordTextFromEvent", () => {
  it("ignores bare modifier presses", () => {
    expect(chordTextFromEvent(key({ key: "Shift", code: "ShiftLeft", shiftKey: true }))).toBeNull();
    expect(chordTextFromEvent(key({ key: "Meta", code: "MetaLeft", metaKey: true }))).toBeNull();
  });

  it("reads named keys from the physical key", () => {
    expect(chordTextFromEvent(key({ key: " ", code: "Space" }))).toBe("Space");
    expect(chordTextFromEvent(key({ key: "ArrowLeft", code: "ArrowLeft", shiftKey: true }))).toBe(
      "Shift+Left",
    );
  });

  it("follows the layout's character for letters", () => {
    // On Dvorak the physical KeyV produces "k".
    expect(chordTextFromEvent(key({ key: "k", code: "KeyV", metaKey: true }))).toBe("Cmd+k");
  });

  it("falls back to the physical key when Option composes a character", () => {
    expect(chordTextFromEvent(key({ key: "˚", code: "KeyK", altKey: true }))).toBe("Alt+k");
  });

  it("keeps digits and punctuation stable under Shift", () => {
    expect(chordTextFromEvent(key({ key: "!", code: "Digit1", shiftKey: true }))).toBe("Shift+1");
    expect(chordTextFromEvent(key({ key: "?", code: "Slash", shiftKey: true }))).toBe("Shift+/");
    expect(chordTextFromEvent(key({ key: ",", code: "Comma", metaKey: true }))).toBe("Cmd+,");
  });

  it("is case-insensitive for letters", () => {
    expect(chordTextFromEvent(key({ key: "K", code: "KeyK", shiftKey: true, metaKey: true }))).toBe(
      "Shift+Cmd+k",
    );
  });
});

describe("display", () => {
  it("renders glyphs in macOS order", () => {
    expect(chordGlyphs("Shift+Cmd+k")).toEqual(["⇧", "⌘", "K"]);
    expect(chordGlyphs("Ctrl+Alt+Left")).toEqual(["⌃", "⌥", "←"]);
    expect(chordGlyphs("Space")).toEqual(["Space"]);
    expect(chordGlyphs("F11")).toEqual(["F11"]);
  });

  it("returns nothing for an invalid chord", () => {
    expect(chordGlyphs("Nope+k")).toEqual([]);
  });

  it("spells chords out for VoiceOver", () => {
    expect(chordSpoken("Shift+Cmd+k")).toBe("Shift Command K");
    expect(chordSpoken("Alt+Left")).toBe("Option Left Arrow");
    expect(chordSpoken("Cmd+,")).toBe("Command Comma");
  });
});

describe("chordAria", () => {
  it("uses the names aria-keyshortcuts expects", () => {
    expect(chordAria("Shift+Cmd+k")).toBe("Shift+Meta+K");
    expect(chordAria("Ctrl+Left")).toBe("Control+ArrowLeft");
    expect(chordAria("Space")).toBe("Space");
  });

  it("is undefined when there is no usable chord", () => {
    expect(chordAria(undefined)).toBeUndefined();
    expect(chordAria("Nope+k")).toBeUndefined();
  });
});

describe("worksWhileTyping", () => {
  it("allows command chords and function keys", () => {
    expect(worksWhileTyping("Cmd+k")).toBe(true);
    expect(worksWhileTyping("F11")).toBe(true);
  });

  it("keeps plain keys for the text field", () => {
    expect(worksWhileTyping("Space")).toBe(false);
    expect(worksWhileTyping("Left")).toBe(false);
    expect(worksWhileTyping("Shift+a")).toBe(false);
  });

  it("leaves the chords that edit or move through text to the field", () => {
    for (const chord of [
      "Cmd+a",
      "Cmd+c",
      "Cmd+v",
      "Cmd+x",
      "Cmd+z",
      "Shift+Cmd+z",
      "Cmd+Left",
      "Cmd+Right",
      "Shift+Cmd+Right",
      "Cmd+Backspace",
    ]) {
      expect(worksWhileTyping(chord), chord).toBe(false);
    }
    // Next item is ⌘→ on the stage; in a field the same keys go to the end of the line.
    expect(worksWhileTyping("Cmd+j")).toBe(true);
  });

  it("leaves Control with a letter to the field, where it moves the caret", () => {
    expect(worksWhileTyping("Ctrl+a")).toBe(false);
    expect(worksWhileTyping("Ctrl+e")).toBe(false);
    // With Command as well it is nobody's text command.
    expect(worksWhileTyping("Ctrl+Cmd+f")).toBe(true);
  });
});

describe("worksInsideAScope", () => {
  it("lets chords with Command or Control and the function keys through, and no plain key", () => {
    expect(worksInsideAScope("Cmd+k")).toBe(true);
    // There is no text in a menu to move through.
    expect(worksInsideAScope("Cmd+Left")).toBe(true);
    expect(worksInsideAScope("Ctrl+a")).toBe(true);
    expect(worksInsideAScope("F5")).toBe(true);
    expect(worksInsideAScope("Space")).toBe(false);
    expect(worksInsideAScope("Shift+Left")).toBe(false);
    expect(worksInsideAScope("not a chord+")).toBe(false);
  });
});
