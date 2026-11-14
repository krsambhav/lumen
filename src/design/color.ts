/**
 * Colour maths for the design system (DESIGN.md §2).
 *
 * Everything is defined in OKLCH. This module is the single place that knows
 * the neutral scale and how an accent hue becomes a usable set of colours in
 * each theme; `tokens.css` mirrors it for first paint and a test keeps the two
 * in step.
 */

export interface Oklch {
  /** Lightness, 0–1. */
  l: number;
  /** Chroma, roughly 0–0.4. */
  c: number;
  /** Hue in degrees. */
  h: number;
}

export type ThemeName = "dark" | "light";

type Rgb = readonly [number, number, number];

/** OKLCH to linear-light sRGB. Components may fall outside 0–1 when out of gamut. */
export function oklchToLinearSrgb({ l, c, h }: Oklch): Rgb {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);

  const lp = l + 0.3963377774 * a + 0.2158037573 * b;
  const mp = l - 0.1055613458 * a - 0.0638541728 * b;
  const sp = l - 0.0894841775 * a - 1.291485548 * b;

  const lc = lp ** 3;
  const mc = mp ** 3;
  const sc = sp ** 3;

  return [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ];
}

const GAMUT_EPSILON = 1e-4;

export function inSrgbGamut(color: Oklch): boolean {
  return oklchToLinearSrgb(color).every(
    (channel) => channel >= -GAMUT_EPSILON && channel <= 1 + GAMUT_EPSILON,
  );
}

/** The largest chroma that stays inside sRGB at this lightness and hue. */
export function maxChroma(l: number, h: number): number {
  let low = 0;
  let high = 0.4;
  for (let i = 0; i < 24; i += 1) {
    const mid = (low + high) / 2;
    if (inSrgbGamut({ l, c: mid, h })) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return low;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function encodeGamma(channel: number): number {
  const c = clamp01(channel);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** `#rrggbb`, clipped to sRGB. Used for fallbacks on WebKit without `oklch()`. */
export function toHex(color: Oklch): string {
  const hex = oklchToLinearSrgb(color)
    .map((channel) =>
      Math.round(encodeGamma(channel) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
  return `#${hex}`;
}

function trim(value: number, digits: number): string {
  return Number(value.toFixed(digits)).toString();
}

/** A CSS `oklch()` string, e.g. `oklch(90% 0.155 106)`. */
export function toCss(color: Oklch, alpha?: number): string {
  const body = `${trim(color.l * 100, 2)}% ${trim(color.c, 4)} ${trim(color.h, 2)}`;
  return alpha === undefined ? `oklch(${body})` : `oklch(${body} / ${trim(alpha, 3)})`;
}

/** WCAG relative luminance. */
export function relativeLuminance(color: Oklch): number {
  const [r, g, b] = oklchToLinearSrgb(color).map(clamp01) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1–21. */
export function contrastRatio(a: Oklch, b: Oklch): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ---------------------------------------------------------------------------
// Neutrals
// ---------------------------------------------------------------------------

export const NEUTRAL_TOKENS = [
  "void",
  "bg",
  "surface-1",
  "surface-2",
  "surface-3",
  "surface-4",
  "line",
  "line-strong",
  "ink-1",
  "ink-2",
  "ink-3",
] as const;

export type NeutralToken = (typeof NEUTRAL_TOKENS)[number];

type NeutralScale = Record<NeutralToken, { l: number; c: number }>;

/** Lightness and chroma of each neutral; the hue is the accent's. */
export const NEUTRALS: Record<ThemeName, NeutralScale> = {
  dark: {
    void: { l: 0.11, c: 0.004 },
    bg: { l: 0.155, c: 0.006 },
    "surface-1": { l: 0.19, c: 0.007 },
    "surface-2": { l: 0.225, c: 0.008 },
    "surface-3": { l: 0.27, c: 0.009 },
    "surface-4": { l: 0.31, c: 0.009 },
    line: { l: 0.31, c: 0.009 },
    "line-strong": { l: 0.56, c: 0.01 },
    "ink-1": { l: 0.95, c: 0.012 },
    "ink-2": { l: 0.76, c: 0.012 },
    "ink-3": { l: 0.65, c: 0.012 },
  },
  light: {
    void: { l: 0.11, c: 0.004 },
    bg: { l: 0.965, c: 0.006 },
    "surface-1": { l: 0.985, c: 0.004 },
    "surface-2": { l: 0.995, c: 0.002 },
    "surface-3": { l: 0.935, c: 0.007 },
    "surface-4": { l: 0.9, c: 0.008 },
    line: { l: 0.885, c: 0.008 },
    "line-strong": { l: 0.6, c: 0.01 },
    "ink-1": { l: 0.22, c: 0.012 },
    "ink-2": { l: 0.42, c: 0.012 },
    "ink-3": { l: 0.5, c: 0.012 },
  },
};

export function neutral(theme: ThemeName, token: NeutralToken, hue: number): Oklch {
  const { l, c } = NEUTRALS[theme][token];
  return { l, c, h: hue };
}

// ---------------------------------------------------------------------------
// Accent
// ---------------------------------------------------------------------------

export interface AccentPreset {
  id: string;
  name: string;
  hue: number;
  /** Caps chroma; used by Silver, which is deliberately near-neutral. */
  chromaLimit?: number;
}

export const DEFAULT_ACCENT_ID = "limelight";

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: "limelight", name: "Limelight", hue: 106 },
  { id: "tungsten", name: "Tungsten", hue: 78 },
  { id: "ember", name: "Ember", hue: 40 },
  { id: "signal", name: "Signal", hue: 25 },
  { id: "rose", name: "Rose", hue: 5 },
  { id: "orchid", name: "Orchid", hue: 330 },
  { id: "iris", name: "Iris", hue: 285 },
  { id: "azure", name: "Azure", hue: 245 },
  { id: "lagoon", name: "Lagoon", hue: 205 },
  { id: "jade", name: "Jade", hue: 165 },
  { id: "silver", name: "Silver", hue: 250, chromaLimit: 0.012 },
];

export interface AccentRamp {
  /**
   * The accent as ink: the needle, lamps, the focus ring, accent text. Bright
   * in the dark theme, a dark ink of the same hue in the light theme.
   */
  accent: Oklch;
  /** Selection fill behind the current item. */
  accentSoft: Oklch;
  /**
   * The accent as a fill (the primary button). It is the bright colour in
   * both themes, so a light window gets a lit button rather than a dark slab.
   */
  accentFill: Oklch;
  /** The fill under the pointer: lighter in dark, a little deeper in light. */
  accentFillHover: Oklch;
  /** Text and icons on the fill. Dark in both themes. */
  accentFg: Oklch;
}

const DARK_ACCENT = { maxL: 0.9, restL: 0.82, minL: 0.74, chroma: 0.155, yellow: 106 };
const LIGHT_ACCENT = { l: 0.5, chroma: 0.13 };

/**
 * How light the bright accent may get. Yellow is the one hue that is
 * naturally light; greens and cyans pushed as far read as neon, so every hue
 * away from yellow is held to a lower ceiling.
 */
function brightCeiling(hue: number): number {
  const distance = Math.abs(((hue - DARK_ACCENT.yellow + 540) % 360) - 180);
  const yellowness = distance >= 45 ? 0 : Math.cos((distance / 45) * (Math.PI / 2));
  return DARK_ACCENT.restL + (DARK_ACCENT.maxL - DARK_ACCENT.restL) * yellowness;
}

/**
 * The lightest value under the ceiling at which the hue can carry the wanted
 * chroma inside sRGB. If no lightness reaches it, the one that carries the
 * most wins.
 */
function brightLightness(hue: number, wanted: number): number {
  const ceiling = Number(brightCeiling(hue).toFixed(2));
  let best = ceiling;
  let bestChroma = -1;
  for (let step = 0; step <= 16; step += 1) {
    const l = Number((ceiling - step * 0.01).toFixed(2));
    if (l < DARK_ACCENT.minL) {
      break;
    }
    const available = maxChroma(l, hue);
    if (available >= wanted) {
      return l;
    }
    if (available > bestChroma) {
      best = l;
      bestChroma = available;
    }
  }
  return best;
}

function within(l: number, chroma: number, hue: number): Oklch {
  const lightness = Number(Math.min(0.96, l).toFixed(3));
  return { l: lightness, c: Math.min(chroma, maxChroma(lightness, hue)), h: hue };
}

/**
 * Turns a hue into the accent colours for a theme, kept inside sRGB.
 *
 * Every hue aims for the same chroma in its bright form, so accents feel
 * equally strong on a 2 px needle, and takes whatever lightness allows it.
 */
export function accentRamp(hue: number, theme: ThemeName, chromaLimit = Infinity): AccentRamp {
  const wanted = Math.min(DARK_ACCENT.chroma, chromaLimit);
  const brightL = brightLightness(hue, wanted);
  const bright = within(brightL, wanted, hue);
  const accentFg: Oklch = { l: 0.21, c: Math.min(0.03, chromaLimit), h: hue };

  if (theme === "dark") {
    return {
      accent: bright,
      accentSoft: within(0.3, Math.min(0.045, chromaLimit), hue),
      accentFill: bright,
      accentFillHover: within(brightL + 0.04, wanted, hue),
      accentFg,
    };
  }
  return {
    accent: within(LIGHT_ACCENT.l, Math.min(LIGHT_ACCENT.chroma, chromaLimit), hue),
    accentSoft: within(0.92, Math.min(0.05, chromaLimit), hue),
    accentFill: bright,
    accentFillHover: within(brightL - 0.035, wanted, hue),
    accentFg,
  };
}

export function findAccentPreset(id: string): AccentPreset | undefined {
  return ACCENT_PRESETS.find((preset) => preset.id === id);
}
