import { describe, expect, it } from "vitest";
import { accentRamp, toCss, toHex } from "./color";
import { accentProperties, applyAppearance, resolveAccent, resolveTheme } from "./theme";

describe("resolveTheme", () => {
  it("uses an explicit choice as given", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("follows macOS when set to system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("resolveAccent", () => {
  it("looks up a preset", () => {
    expect(resolveAccent({ kind: "preset", id: "azure" })).toEqual({
      hue: 245,
      chromaLimit: undefined,
    });
  });

  it("falls back to Limelight for an unknown preset", () => {
    expect(resolveAccent({ kind: "preset", id: "from-a-newer-version" }).hue).toBe(106);
  });

  it("wraps custom hues into 0–360", () => {
    expect(resolveAccent({ kind: "custom", hue: 370 }).hue).toBe(10);
    expect(resolveAccent({ kind: "custom", hue: -30 }).hue).toBe(330);
  });

  it("carries Silver's chroma limit", () => {
    expect(resolveAccent({ kind: "preset", id: "silver" }).chromaLimit).toBe(0.012);
  });
});

describe("accentProperties", () => {
  it("sets the tint hue and both theme ramps", () => {
    const properties = accentProperties({ hue: 245, chromaLimit: undefined });
    expect(properties["--tint-h"]).toBe("245");
    expect(properties["--accent-d"]).toBe(toCss(accentRamp(245, "dark").accent));
    expect(properties["--accent-l"]).toBe(toCss(accentRamp(245, "light").accent));
    // The fill is the bright colour whichever theme is showing.
    expect(properties["--accent-fill"]).toBe(properties["--accent-d"]);
    expect(Object.keys(properties)).toHaveLength(9);
  });

  it("can write sRGB for WebKit without oklch()", () => {
    const properties = accentProperties({ hue: 106, chromaLimit: undefined }, toHex);
    expect(properties["--accent-d"]).toBe("#ece45c");
  });
});

describe("applyAppearance", () => {
  it("writes the theme and accent onto the root element", () => {
    const root = document.createElement("div");
    applyAppearance({ theme: "light", accent: { kind: "custom", hue: 40 } }, root);
    expect(root.dataset.theme).toBe("light");
    expect(root.style.getPropertyValue("--tint-h")).toBe("40");
    expect(root.style.getPropertyValue("--accent-d")).not.toBe("");
  });
});
