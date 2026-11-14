import { describe, expect, it } from "vitest";
import { formatSpeed, isNormalSpeed, SPEEDS, spokenSpeed, stepSpeed } from "./speed";

describe("speed", () => {
  it("covers a quarter to four times, in the steps of the design", () => {
    expect(SPEEDS[0]).toBe(0.25);
    expect(SPEEDS[SPEEDS.length - 1]).toBe(4);
    expect(SPEEDS).toContain(1);
    expect([...SPEEDS].sort((a, b) => a - b)).toEqual([...SPEEDS]);
  });

  it("steps to the next speed in either direction and stops at the ends", () => {
    expect(stepSpeed(1, 1)).toBe(1.25);
    expect(stepSpeed(1, -1)).toBe(0.75);
    expect(stepSpeed(2, 1)).toBe(3);
    expect(stepSpeed(4, 1)).toBe(4);
    expect(stepSpeed(0.25, -1)).toBe(0.25);
  });

  it("goes to the nearest step from a speed that is between two", () => {
    expect(stepSpeed(1.1, 1)).toBe(1.25);
    expect(stepSpeed(1.1, -1)).toBe(1);
    // What the engine reports for a step is that step, give or take.
    expect(stepSpeed(1.2500001, 1)).toBe(1.5);
  });

  it("is written with a multiplication sign and no needless zeros", () => {
    expect(formatSpeed(1.5)).toBe("1.5×");
    expect(formatSpeed(0.25)).toBe("0.25×");
    expect(formatSpeed(2)).toBe("2×");
    expect(formatSpeed(1.2500001)).toBe("1.25×");
  });

  it("knows normal speed, and says a speed in words", () => {
    expect(isNormalSpeed(1)).toBe(true);
    expect(isNormalSpeed(1.004)).toBe(true);
    expect(isNormalSpeed(1.25)).toBe(false);
    expect(spokenSpeed(1)).toBe("normal speed");
    expect(spokenSpeed(1.5)).toBe("1.5 times normal speed");
  });
});
