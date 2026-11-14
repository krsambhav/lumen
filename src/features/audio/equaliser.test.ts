import { describe, expect, it } from "vitest";
import {
  BANDS,
  BUILT_IN,
  bandCaption,
  bandName,
  gainSpoken,
  gainText,
  isBuiltIn,
  isFlat,
  presetOf,
  withGain,
} from "./equaliser";

describe("the equaliser's bands", () => {
  it("are ten, one to an octave from 31 Hz to 16 kHz", () => {
    expect(BANDS).toHaveLength(10);
    expect(BANDS[0]).toBe(31);
    expect(BANDS[9]).toBe(16000);
  });

  it("are captioned briefly and named in words", () => {
    expect(BANDS.map(bandCaption)).toEqual([
      "31",
      "62",
      "125",
      "250",
      "500",
      "1k",
      "2k",
      "4k",
      "8k",
      "16k",
    ]);
    expect(bandName(250)).toBe("250 hertz");
    expect(bandName(1000)).toBe("1 kilohertz");
  });
});

describe("gains", () => {
  it("read with their sign, a real minus and the unit", () => {
    expect(gainText(4.5)).toBe("+4.5 dB");
    expect(gainText(-3)).toBe("−3 dB");
    expect(gainText(0)).toBe("0 dB");
    expect(gainText(12)).toBe("+12 dB");
  });

  it("are spoken in words", () => {
    expect(gainSpoken(4.5)).toBe("plus 4.5 decibels");
    expect(gainSpoken(-1)).toBe("minus 1 decibel");
    expect(gainSpoken(0)).toBe("0 decibels");
  });
});

describe("presets", () => {
  it("begin with Flat, which is no change at all", () => {
    expect(BUILT_IN[0]?.name).toBe("Flat");
    expect(isFlat(BUILT_IN[0]?.gains ?? [])).toBe(true);
    for (const preset of BUILT_IN) {
      expect(preset.gains).toHaveLength(BANDS.length);
    }
  });

  it("are found from their gains, the user's own before Lumen's", () => {
    const flat = BANDS.map(() => 0);
    expect(presetOf(flat, [])?.name).toBe("Flat");
    expect(presetOf(flat, [{ name: "Flat for my speakers", gains: flat }])?.name).toBe(
      "Flat for my speakers",
    );
    expect(presetOf([6, 5, 4, 2, 0, 0, 0, 0, 0, 0], [])?.name).toBe("Bass boost");
  });

  it("are nobody's once a band is moved by hand", () => {
    const bass = BUILT_IN.find((preset) => preset.name === "Bass boost");
    if (!bass) {
      throw new Error("no Bass boost");
    }
    const moved = withGain({ enabled: true, gains: [...bass.gains] }, 9, 0.5);
    expect(moved.gains[9]).toBe(0.5);
    expect(moved.gains.slice(0, 9)).toEqual(bass.gains.slice(0, 9));
    expect(moved.enabled).toBe(true);
    expect(presetOf(moved.gains, [])).toBeUndefined();
  });

  it("of Lumen's own are known by name, whatever the case", () => {
    expect(isBuiltIn(" bass BOOST ")).toBe(true);
    expect(isBuiltIn("My bass")).toBe(false);
  });

  it("fill bands the settings left out with 0", () => {
    expect(withGain({ enabled: false, gains: [1] }, 3, 2).gains).toEqual([
      1, 0, 0, 2, 0, 0, 0, 0, 0, 0,
    ]);
  });
});
