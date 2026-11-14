import { describe, expect, it } from "vitest";
import {
  formatVolume,
  fractionToVolume,
  MAX_VOLUME,
  NORMAL_VOLUME,
  stepVolume,
  VOLUME_STEP,
  volumeToFraction,
} from "./volume";

describe("the volume scale", () => {
  it("gives ordinary levels three quarters of its length and boost the rest", () => {
    expect(volumeToFraction(0)).toBe(0);
    expect(volumeToFraction(50)).toBe(0.375);
    expect(volumeToFraction(NORMAL_VOLUME)).toBe(0.75);
    expect(volumeToFraction(150)).toBe(0.875);
    expect(volumeToFraction(MAX_VOLUME)).toBe(1);
  });

  it("maps positions back to the same levels", () => {
    for (let volume = 0; volume <= MAX_VOLUME; volume += VOLUME_STEP) {
      expect(fractionToVolume(volumeToFraction(volume))).toBeCloseTo(volume, 9);
    }
  });

  it("never leaves the scale", () => {
    expect(volumeToFraction(-20)).toBe(0);
    expect(volumeToFraction(900)).toBe(1);
    expect(fractionToVolume(-1)).toBe(0);
    expect(fractionToVolume(2)).toBe(MAX_VOLUME);
  });

  it("puts every step of ordinary volume at least three pixels apart on a 96 px scale", () => {
    const width = 96;
    const below = (volumeToFraction(55) - volumeToFraction(50)) * width;
    const above = (volumeToFraction(155) - volumeToFraction(150)) * width;
    expect(below).toBeGreaterThanOrEqual(3);
    // Boost is coarser on purpose, but still more than a pixel a step.
    expect(above).toBeGreaterThan(1);
  });
});

describe("stepping", () => {
  it("moves to the neighbouring multiple of five", () => {
    expect(stepVolume(63, 1)).toBe(65);
    expect(stepVolume(65, 1)).toBe(70);
    expect(stepVolume(63, -1)).toBe(60);
    expect(stepVolume(65, -1)).toBe(60);
  });

  it("stops at silence and at full boost", () => {
    expect(stepVolume(0, -1)).toBe(0);
    expect(stepVolume(MAX_VOLUME, 1)).toBe(MAX_VOLUME);
    expect(stepVolume(198, 1)).toBe(MAX_VOLUME);
  });
});

describe("formatVolume", () => {
  it("writes a whole percentage", () => {
    expect(formatVolume(85)).toBe("85%");
    expect(formatVolume(62.6)).toBe("63%");
  });
});
