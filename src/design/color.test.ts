import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCENT_PRESETS,
  accentRamp,
  contrastRatio,
  inSrgbGamut,
  maxChroma,
  NEUTRAL_TOKENS,
  NEUTRALS,
  neutral,
  type Oklch,
  type ThemeName,
  toCss,
  toHex,
} from "./color";

const THEMES: readonly ThemeName[] = ["dark", "light"];
const SURFACES = ["bg", "surface-1", "surface-2", "surface-3"] as const;

/** WCAG 2.2 AA. */
const TEXT = 4.5;
const NON_TEXT = 3;

describe("conversion", () => {
  it("maps the ends of the lightness axis to black and white", () => {
    expect(toHex({ l: 0, c: 0, h: 0 })).toBe("#000000");
    expect(toHex({ l: 1, c: 0, h: 0 })).toBe("#ffffff");
  });

  it("matches known sRGB values", () => {
    // Reference values from the CSS Color 4 sample conversions.
    expect(toHex({ l: 0.628, c: 0.2577, h: 29.23 })).toBe("#ff0000");
    expect(toHex({ l: 0.452, c: 0.3132, h: 264.05 })).toBe("#0000ff");
  });

  it("clips out-of-gamut colours instead of wrapping", () => {
    expect(toHex({ l: 0.9, c: 0.4, h: 106 })).toMatch(/^#[0-9a-f]{6}$/);
    expect(inSrgbGamut({ l: 0.9, c: 0.4, h: 106 })).toBe(false);
  });

  it("writes compact CSS", () => {
    expect(toCss({ l: 0.9, c: 0.155, h: 106 })).toBe("oklch(90% 0.155 106)");
    expect(toCss({ l: 0.155, c: 0.006, h: 106 }, 0.5)).toBe("oklch(15.5% 0.006 106 / 0.5)");
  });

  it("finds the gamut boundary", () => {
    const edge = maxChroma(0.7, 145);
    expect(inSrgbGamut({ l: 0.7, c: edge, h: 145 })).toBe(true);
    expect(inSrgbGamut({ l: 0.7, c: edge + 0.005, h: 145 })).toBe(false);
  });

  it("computes WCAG contrast", () => {
    const black: Oklch = { l: 0, c: 0, h: 0 };
    const white: Oklch = { l: 1, c: 0, h: 0 };
    expect(contrastRatio(black, white)).toBeCloseTo(21, 1);
    expect(contrastRatio(white, white)).toBe(1);
  });
});

describe("neutrals", () => {
  it("are never pure grey", () => {
    for (const theme of THEMES) {
      for (const token of NEUTRAL_TOKENS) {
        expect(NEUTRALS[theme][token].c, `${theme} ${token}`).toBeGreaterThan(0);
      }
    }
  });

  it("stay inside sRGB for every preset hue", () => {
    for (const { hue } of ACCENT_PRESETS) {
      for (const theme of THEMES) {
        for (const token of NEUTRAL_TOKENS) {
          expect(inSrgbGamut(neutral(theme, token, hue)), `${theme} ${token} @${hue}`).toBe(true);
        }
      }
    }
  });
});

describe.each(ACCENT_PRESETS)("contrast with the $name accent", ({ hue, chromaLimit }) => {
  describe.each(THEMES)("%s theme", (theme) => {
    const ramp = accentRamp(hue, theme, chromaLimit);

    it.each(SURFACES)("text is readable on %s", (surface) => {
      const background = neutral(theme, surface, hue);
      for (const ink of ["ink-1", "ink-2", "ink-3"] as const) {
        expect(
          contrastRatio(neutral(theme, ink, hue), background),
          `${ink} on ${surface}`,
        ).toBeGreaterThanOrEqual(TEXT);
      }
    });

    it.each(SURFACES)("the accent ink is readable as text on %s", (surface) => {
      expect(contrastRatio(ramp.accent, neutral(theme, surface, hue))).toBeGreaterThanOrEqual(TEXT);
    });

    it("text on the accent fill is readable, at rest and on hover", () => {
      expect(contrastRatio(ramp.accentFg, ramp.accentFill)).toBeGreaterThanOrEqual(TEXT);
      expect(contrastRatio(ramp.accentFg, ramp.accentFillHover)).toBeGreaterThanOrEqual(TEXT);
    });

    it("the primary button has a visible edge", () => {
      // Its ring is the accent ink; the fill alone is too close to a light window.
      const edge = contrastRatio(ramp.accent, neutral(theme, "bg", hue));
      const fill = contrastRatio(ramp.accentFill, neutral(theme, "bg", hue));
      expect(Math.max(edge, fill)).toBeGreaterThanOrEqual(NON_TEXT);
    });

    it("primary text is readable on the selection fill", () => {
      expect(contrastRatio(neutral(theme, "ink-1", hue), ramp.accentSoft)).toBeGreaterThanOrEqual(
        TEXT,
      );
    });

    it("primary text is readable on a hovered or pressed fill", () => {
      expect(
        contrastRatio(neutral(theme, "ink-1", hue), neutral(theme, "surface-4", hue)),
      ).toBeGreaterThanOrEqual(TEXT);
    });

    it.each(SURFACES)("control outlines stand out from %s", (surface) => {
      expect(
        contrastRatio(neutral(theme, "line-strong", hue), neutral(theme, surface, hue)),
      ).toBeGreaterThanOrEqual(NON_TEXT);
    });

    it("stays inside sRGB", () => {
      for (const color of Object.values(ramp)) {
        expect(inSrgbGamut(color)).toBe(true);
      }
    });
  });
});

describe("status colours", () => {
  const status: Record<ThemeName, Record<string, Oklch>> = {
    dark: {
      danger: { l: 0.72, c: 0.17, h: 25 },
      warning: { l: 0.82, c: 0.14, h: 62 },
      success: { l: 0.8, c: 0.14, h: 152 },
    },
    light: {
      danger: { l: 0.52, c: 0.19, h: 25 },
      warning: { l: 0.52, c: 0.12, h: 62 },
      success: { l: 0.5, c: 0.13, h: 152 },
    },
  };

  it.each(THEMES)("are readable as text in the %s theme", (theme) => {
    for (const [name, color] of Object.entries(status[theme])) {
      for (const surface of SURFACES) {
        expect(
          contrastRatio(color, neutral(theme, surface, 106)),
          `${name} on ${surface}`,
        ).toBeGreaterThanOrEqual(TEXT);
      }
    }
  });
});

describe("the bright accent", () => {
  it("only lets yellow reach the lightest value", () => {
    expect(accentRamp(106, "dark").accent.l).toBe(0.9);
    for (const hue of [25, 165, 205, 245, 285, 330]) {
      expect(accentRamp(hue, "dark").accent.l, `hue ${hue}`).toBeLessThanOrEqual(0.82);
    }
  });

  it("keeps Silver nearly neutral", () => {
    const silver = ACCENT_PRESETS.find((preset) => preset.id === "silver");
    expect(silver).toBeDefined();
    if (silver) {
      expect(accentRamp(silver.hue, "dark", silver.chromaLimit).accent.c).toBeLessThanOrEqual(
        0.012,
      );
    }
  });

  it("is the fill in both themes, with the same dark text on it", () => {
    const dark = accentRamp(245, "dark");
    const light = accentRamp(245, "light");
    expect(light.accentFill).toEqual(dark.accentFill);
    expect(light.accentFg).toEqual(dark.accentFg);
    expect(dark.accentFill).toEqual(dark.accent);
  });

  it("is an ink, not a fill, when used for marks on a light window", () => {
    expect(accentRamp(106, "light").accent.l).toBe(0.5);
  });

  it("moves the right way under the pointer in each theme", () => {
    const dark = accentRamp(106, "dark");
    const light = accentRamp(106, "light");
    expect(dark.accentFillHover.l).toBeGreaterThan(dark.accentFill.l);
    expect(light.accentFillHover.l).toBeLessThan(light.accentFill.l);
  });
});

describe("tokens.css", () => {
  const css = readFileSync(path.resolve(import.meta.dirname, "tokens.css"), "utf8");

  /** The body of the first rule whose selector list is exactly `selector`. */
  function block(source: string, selector: string): string {
    const start = source.indexOf(`${selector} {`);
    expect(start, `selector ${selector}`).toBeGreaterThanOrEqual(0);
    return source.slice(start, source.indexOf("}", start));
  }

  function declared(body: string, name: string): string | undefined {
    return new RegExp(`--${name}:\\s*([^;]+);`).exec(body)?.[1]?.trim();
  }

  const supports = css.slice(css.indexOf("@supports (color: oklch(0% 0 0))"));

  it("declares every neutral in OKLCH exactly as color.ts defines it", () => {
    const dark = block(supports, '[data-theme="light"] .stage');
    const light = block(supports, '  [data-theme="light"]');
    for (const token of NEUTRAL_TOKENS) {
      const expected = (theme: ThemeName) => {
        const { l, c } = NEUTRALS[theme][token];
        return `oklch(${Number((l * 100).toFixed(2))}% ${c} var(--tint-h))`;
      };
      expect(declared(dark, token), `dark ${token}`).toBe(expected("dark"));
      if (token !== "void") {
        expect(declared(light, token), `light ${token}`).toBe(expected("light"));
      }
    }
  });

  it("carries sRGB fallbacks that match the OKLCH values", () => {
    const dark = block(css, ".stage");
    const light = block(css, '[data-theme="light"]');
    for (const token of NEUTRAL_TOKENS) {
      expect(declared(dark, token), `dark ${token}`).toBe(toHex(neutral("dark", token, 106)));
      if (token !== "void") {
        expect(declared(light, token), `light ${token}`).toBe(toHex(neutral("light", token, 106)));
      }
    }
  });

  it("defaults to the Limelight accent", () => {
    const dark = accentRamp(106, "dark");
    const light = accentRamp(106, "light");
    const expected: Record<string, Oklch> = {
      "accent-d": dark.accent,
      "accent-soft-d": dark.accentSoft,
      "accent-fill-hover-d": dark.accentFillHover,
      "accent-l": light.accent,
      "accent-soft-l": light.accentSoft,
      "accent-fill-hover-l": light.accentFillHover,
      "accent-fill": dark.accentFill,
      "accent-fg": dark.accentFg,
    };
    const root = block(css, ":root");
    const oklch = block(supports, "  :root");
    for (const [name, color] of Object.entries(expected)) {
      expect(declared(root, name), `${name} (sRGB)`).toBe(toHex(color));
      expect(declared(oklch, name), `${name} (OKLCH)`).toBe(toCss(color));
    }
  });
});

describe("stage chrome over video", () => {
  const css = readFileSync(path.resolve(import.meta.dirname, "tokens.css"), "utf8");

  type Rgb = [number, number, number];

  function parseHex(hex: string): Rgb {
    return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as Rgb;
  }

  /** Source-over compositing in gamma-encoded sRGB, as the browser does it. */
  function over(top: Rgb, alpha: number, bottom: Rgb): Rgb {
    return top.map((channel, index) => channel * alpha + (bottom[index] ?? 0) * (1 - alpha)) as Rgb;
  }

  function luminance(color: Rgb): number {
    const [r, g, b] = color.map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    ) as Rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrast(a: Rgb, b: Rgb): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  }

  interface Stop {
    alpha: number;
    at: number;
  }

  function scrimStops(name: string): Stop[] {
    const start = css.indexOf(`--${name}: linear-gradient(`);
    const body = css.slice(start, css.indexOf(");", start));
    const stops = [...body.matchAll(/rgba\(4, 4, 3, ([\d.]+)\) (\d+)px/g)].map((match) => ({
      alpha: Number(match[1]),
      at: Number(match[2]),
    }));
    expect(stops.length, `${name} stops`).toBeGreaterThan(8);
    return stops;
  }

  /** The scrim's alpha `depth` px from the edge it starts at. */
  function alphaAt(stops: Stop[], depth: number): number {
    for (let index = 1; index < stops.length; index += 1) {
      const from = stops[index - 1];
      const to = stops[index];
      if (from && to && depth <= to.at) {
        const t = (depth - from.at) / (to.at - from.at);
        return from.alpha + (to.alpha - from.alpha) * t;
      }
    }
    return 0;
  }

  function declaredAlpha(name: string): number {
    const match = new RegExp(
      `--${name}: oklch\\(95% 0\\.012 var\\(--tint-h\\) / ([\\d.]+)\\);`,
    ).exec(css);
    expect(match, `--${name}`).not.toBeNull();
    return Number(match?.[1]);
  }

  const white: Rgb = [1, 1, 1];
  const scrim = parseHex(toHex(neutral("dark", "void", 106)));
  const ink = parseHex(toHex(neutral("dark", "ink-1", 106)));
  const bottom = scrimStops("scrim-bottom");
  const top = scrimStops("scrim-top");

  /** Where things sit, in px from the window edge (DESIGN.md §4 and §7). */
  const TRANSPORT_ROW_TOP = 46;
  const TITLE_BOTTOM = 32;

  it("keeps transport-row text readable over a white picture", () => {
    const backdrop = over(scrim, alphaAt(bottom, TRANSPORT_ROW_TOP), white);
    expect(contrast(ink, backdrop)).toBeGreaterThanOrEqual(TEXT);
    const secondary = over(ink, declaredAlpha("stage-ink-2"), backdrop);
    expect(contrast(secondary, backdrop)).toBeGreaterThanOrEqual(TEXT);
  });

  /**
   * Lines do not lean on the scrim. The track and the needles are outlined
   * in void, so what they stand against, over any picture, is void.
   */
  it("keeps the timeline track visible over a white picture by its outline", () => {
    expect(css).toMatch(/--stage-edge: var\(--void\);/);
    // The unplayed track is translucent ink: over white it is nearly white itself.
    const track = over(ink, declaredAlpha("stage-track"), white);
    expect(contrast(track, scrim)).toBeGreaterThanOrEqual(NON_TEXT);
    expect(contrast(ink, scrim)).toBeGreaterThanOrEqual(NON_TEXT);
    // The played part, the buffered part and the rest must be three distinct steps.
    expect(declaredAlpha("stage-buffer")).toBeGreaterThan(declaredAlpha("stage-track"));
    expect(declaredAlpha("stage-buffer")).toBeLessThan(1);
  });

  it("outlines every needle on the stage, and lights it on a light surface", () => {
    // A dark surface needs nothing around a needle; a light one a line of the
    // accent ink; the stage, in either theme, a line of void.
    expect(css).toMatch(/--needle-edge: transparent;/);
    expect(css).toMatch(/\[data-theme="light"\] \{[^}]*--needle-edge: var\(--accent\);/);
    expect(css).toMatch(
      /\.stage,\s*\[data-theme="light"\] \.stage \{[^}]*--needle-edge: var\(--void\);/,
    );
  });

  it("makes the scrims no longer than the text needs", () => {
    // The picture comes first: both are shorter than the bars they back are tall, twice over.
    expect(bottom.at(-1)?.at).toBeLessThanOrEqual(160);
    expect(top.at(-1)?.at).toBeLessThanOrEqual(100);
  });

  it("keeps the title readable and title-bar icons visible over a white picture", () => {
    const backdrop = over(scrim, alphaAt(top, TITLE_BOTTOM), white);
    expect(contrast(ink, backdrop)).toBeGreaterThanOrEqual(TEXT);
    const icon = over(ink, declaredAlpha("stage-ink-2"), backdrop);
    expect(contrast(icon, backdrop)).toBeGreaterThanOrEqual(NON_TEXT);
  });

  /**
   * The on-screen display has no scrim. Its letters and its scale are
   * outlined in void instead, so over any picture, a white one included,
   * what they stand against is void.
   */
  it("outlines the on-screen display in void, opaque and wide enough to count", () => {
    const styles = readFileSync(path.resolve(import.meta.dirname, "../styles.css"), "utf8");
    expect(styles).toMatch(/-webkit-text-stroke: var\(--osd-outline\) var\(--void\);/);
    // Painted beneath the fill, so the letters keep their shapes.
    expect(styles).toMatch(/paint-order: stroke fill;/);
    // Half the stroke falls outside the letter: 1 px at the smallest size, 20 px.
    // It grows with the type, to a limit.
    const outline = /--osd-outline: min\(([\d.]+)em, ([\d.]+)px\);/.exec(css);
    expect(outline, "--osd-outline").not.toBeNull();
    expect((Number(outline?.[1]) / 2) * 20).toBeGreaterThanOrEqual(1);
    expect(Number(outline?.[2]) / 2).toBeGreaterThanOrEqual(1);
    expect(contrast(ink, scrim)).toBeGreaterThanOrEqual(TEXT);
  });

  it.each(ACCENT_PRESETS)("keeps the $name needle visible against its outline", (preset) => {
    const needle = parseHex(toHex(accentRamp(preset.hue, "dark", preset.chromaLimit).accent));
    expect(contrast(needle, scrim)).toBeGreaterThanOrEqual(NON_TEXT);
  });

  it.each([
    ["scrim-bottom", bottom],
    ["scrim-top", top],
  ] as const)("%s has no edge: it falls smoothly to nothing", (_name, stops) => {
    const alphas = stops.map((stop) => stop.alpha);
    expect(alphas.at(-1)).toBe(0);
    // Monotonic, and the last step before transparent is all but invisible.
    for (let index = 1; index < alphas.length; index += 1) {
      expect(alphas[index]).toBeLessThanOrEqual(alphas[index - 1] ?? 1);
    }
    expect(alphas.at(-2)).toBeLessThan(0.01);
    // No knee: the steepest step is not much steeper than its neighbours.
    const steps = alphas.slice(1).map((alpha, index) => (alphas[index] ?? 0) - alpha);
    for (let index = 1; index < steps.length; index += 1) {
      expect(Math.abs((steps[index] ?? 0) - (steps[index - 1] ?? 0))).toBeLessThan(0.07);
    }
  });

  it("declares each scrim's full length, so elements painted with one can be that tall", () => {
    expect(css).toContain(`--scrim-bottom-h: ${bottom.at(-1)?.at}px;`);
    expect(css).toContain(`--scrim-top-h: ${top.at(-1)?.at}px;`);
  });
});

describe("the native window background", () => {
  // The colour behind the web view is set from Rust, which cannot read CSS.
  const rust = readFileSync(
    path.resolve(import.meta.dirname, "../../src-tauri/src/platform/macos/window.rs"),
    "utf8",
  );
  const colours = [
    ...rust.matchAll(/colorWithSRGBRed_green_blue_alpha\(([\d.]+), ([\d.]+), ([\d.]+), 1\.0\)/g),
  ].map((match) => [Number(match[1]), Number(match[2]), Number(match[3])]);

  function channels(hex: string): number[] {
    return [1, 3, 5].map((at) =>
      Number((Number.parseInt(hex.slice(at, at + 2), 16) / 255).toFixed(3)),
    );
  }

  it("matches the void token in dark and the bg token in light", () => {
    expect(colours).toEqual([
      channels(toHex(neutral("dark", "void", 106))),
      channels(toHex(neutral("light", "bg", 106))),
    ]);
  });
});

describe("the native title bar", () => {
  // Rust places the traffic lights and cannot read CSS, so the two are compared here.
  const rust = readFileSync(
    path.resolve(import.meta.dirname, "../../src-tauri/src/lib.rs"),
    "utf8",
  );
  const tokens = readFileSync(path.resolve(import.meta.dirname, "tokens.css"), "utf8");

  function constant(name: string): number {
    return Number(new RegExp(`pub const ${name}: f64 = ([\\d.]+);`).exec(rust)?.[1]);
  }

  function token(name: string): number {
    return Number(new RegExp(`--${name}: ([\\d.]+)px;`).exec(tokens)?.[1]);
  }

  it("is as tall in Rust as in the design tokens", () => {
    expect(constant("TITLEBAR_HEIGHT")).toBe(token("titlebar-h"));
  });

  it("starts the traffic lights at the gutter, and keeps the title clear of them", () => {
    expect(constant("TRAFFIC_LIGHTS_X")).toBe(token("gutter"));
    // The corner the lights are never faded from under the pointer in.
    expect(constant("TITLEBAR_LEAD")).toBe(token("titlebar-lead"));
    // Three lights are at most 60 px wide; the title starts 8 px after them.
    expect(token("titlebar-lead")).toBe(token("gutter") + 60 + 8);
  });
});
