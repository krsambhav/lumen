import { describe, expect, it } from "vitest";
import {
  isNeutral,
  LEVELS,
  levelSpoken,
  levelText,
  NEUTRAL_NAME,
  NEUTRAL_PICTURE,
  pictureName,
  samePicture,
} from "./picture";

describe("the picture's levels", () => {
  it("are listed in order, the two-way ones before the one-way ones", () => {
    expect(LEVELS.map((level) => level.name)).toEqual([
      "Brightness",
      "Contrast",
      "Saturation",
      "Gamma",
      "Hue",
      "Sharpness",
      "Noise reduction",
    ]);
    for (const level of LEVELS) {
      expect(level.min).toBe(level.bothWays ? -100 : 0);
      expect(level.max).toBe(100);
    }
  });

  it("read with their sign and a real minus when they go both ways", () => {
    expect(levelText(12, true)).toBe("+12");
    expect(levelText(-30, true)).toBe("−30");
    expect(levelText(0, true)).toBe("0");
    expect(levelText(40, false)).toBe("40");
  });

  it("are spoken in words", () => {
    expect(levelSpoken(12, true)).toBe("plus 12");
    expect(levelSpoken(-30, true)).toBe("minus 30");
    expect(levelSpoken(0, true)).toBe("0");
    expect(levelSpoken(40, false)).toBe("40");
  });
});

describe("picture presets", () => {
  const warm = { ...NEUTRAL_PICTURE, saturation: 20, hue: -5 };
  const saved = [{ name: "Warm", picture: warm }];

  it("knows the picture left alone", () => {
    expect(isNeutral(NEUTRAL_PICTURE)).toBe(true);
    expect(isNeutral({ ...NEUTRAL_PICTURE, gamma: 1 })).toBe(false);
    expect(samePicture(warm, { ...warm })).toBe(true);
  });

  it("names the levels after the preset they are, or nothing when they were set by hand", () => {
    expect(pictureName(NEUTRAL_PICTURE, saved)).toBe(NEUTRAL_NAME);
    expect(NEUTRAL_NAME).toBe("Neutral");
    expect(pictureName({ ...warm }, saved)).toBe("Warm");
    expect(pictureName({ ...warm, contrast: 1 }, saved)).toBeNull();
  });
});
