import { describe, expect, it } from "vitest";
import {
  DEINTERLACE,
  isOwnShape,
  OWN_SHAPE,
  RATIOS,
  ratioName,
  sameRatio,
  turned,
  turnName,
  zoomText,
} from "./shape";

describe("the picture's shape", () => {
  it("starts as the file has it", () => {
    expect(isOwnShape(OWN_SHAPE)).toBe(true);
    for (const changed of [
      { aspect: { width: 4, height: 3 } },
      { crop: { width: 235, height: 100 } },
      { zoom: 1.5 },
      { turns: 1 },
      { flipped: true },
      { mirrored: true },
      { deinterlace: "auto" as const },
    ]) {
      expect(isOwnShape({ ...OWN_SHAPE, ...changed })).toBe(false);
    }
  });

  it("names ratios as they are spoken of, and others by their numbers", () => {
    expect(RATIOS.map((ratio) => ratio.name)).toEqual([
      "4:3",
      "16:10",
      "16:9",
      "1.85:1",
      "2:1",
      "2.35:1",
      "2.39:1",
    ]);
    expect(ratioName({ width: 185, height: 100 })).toBe("1.85:1");
    expect(ratioName({ width: 5, height: 4 })).toBe("5:4");
    expect(sameRatio(null, null)).toBe(true);
    expect(sameRatio({ width: 4, height: 3 }, null)).toBe(false);
    expect(sameRatio({ width: 4, height: 3 }, { width: 4, height: 3 })).toBe(true);
  });

  it("turns a quarter at a time, either way, and names where it is", () => {
    expect(turned(OWN_SHAPE, true).turns).toBe(1);
    expect(turned(OWN_SHAPE, false).turns).toBe(3);
    expect(turned({ ...OWN_SHAPE, turns: 3 }, true).turns).toBe(0);
    expect([0, 1, 2, 3, -1].map(turnName)).toEqual([
      "Not turned",
      "90° clockwise",
      "Upside down",
      "90° anticlockwise",
      "90° anticlockwise",
    ]);
  });

  it("reads a zoom as a percentage", () => {
    expect(zoomText(1)).toBe("100%");
    expect(zoomText(1.5)).toBe("150%");
    expect(zoomText(0.754)).toBe("75%");
  });

  it("offers deinterlacing off, automatic and on, in that order", () => {
    expect(DEINTERLACE.map((choice) => choice.value)).toEqual(["off", "auto", "on"]);
  });
});
