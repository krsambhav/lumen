import type { Equaliser, EqualiserPreset } from "@/ipc";

/** The centre of each band, in hertz: `BANDS` in src-tauri/src/engine/adjust.rs. */
export const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
/** The most a band can be raised or lowered, in decibels. */
export const MAX_GAIN = 12;
/** What one arrow key moves a band by. */
export const GAIN_STEP = 0.5;

const LEVEL = BANDS.map(() => 0);

/** The sets of gains Lumen comes with. The first is no change at all. */
export const BUILT_IN: readonly EqualiserPreset[] = [
  { name: "Flat", gains: LEVEL },
  { name: "Bass boost", gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { name: "Bass cut", gains: [-6, -5, -4, -2, 0, 0, 0, 0, 0, 0] },
  { name: "Treble boost", gains: [0, 0, 0, 0, 0, 0, 2, 4, 5, 6] },
  { name: "Treble cut", gains: [0, 0, 0, 0, 0, 0, -2, -4, -5, -6] },
  { name: "Loudness", gains: [5, 4, 2, 0, -1, -1, 0, 2, 4, 5] },
  { name: "Voices", gains: [-3, -3, -2, 0, 2, 4, 4, 3, 1, 0] },
  { name: "Late night", gains: [-6, -5, -3, -1, 1, 3, 3, 2, 0, -1] },
  { name: "Rock", gains: [4, 3, 2, 0, -1, -1, 1, 3, 4, 4] },
  { name: "Pop", gains: [-1, 0, 2, 3, 4, 3, 1, 0, -1, -1] },
  { name: "Jazz", gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  { name: "Classical", gains: [3, 2, 1, 0, 0, 0, -1, -1, 2, 3] },
  { name: "Electronic", gains: [5, 4, 1, 0, -2, 1, 0, 2, 4, 5] },
  { name: "Acoustic", gains: [3, 3, 2, 1, 1, 1, 2, 2, 2, 1] },
];

/** A band's frequency as it stands under the band: "250", "1k", "16k". */
export function bandCaption(hertz: number): string {
  return hertz >= 1000 ? `${hertz / 1000}k` : `${hertz}`;
}

/** A band's frequency in words, for assistive technology: "250 hertz", "1 kilohertz". */
export function bandName(hertz: number): string {
  return hertz >= 1000 ? `${hertz / 1000} kilohertz` : `${hertz} hertz`;
}

/** A gain as it is read: "+4.5 dB", "−3 dB", "0 dB". The minus is a real minus. */
export function gainText(gain: number): string {
  const size = Math.abs(gain);
  const figure = Number.isInteger(size) ? `${size}` : size.toFixed(1);
  return `${gain > 0 ? "+" : gain < 0 ? "−" : ""}${figure} dB`;
}

/** A gain in words: "plus 4.5 decibels". */
export function gainSpoken(gain: number): string {
  const size = Math.abs(gain);
  const figure = Number.isInteger(size) ? `${size}` : size.toFixed(1);
  const unit = size === 1 ? "decibel" : "decibels";
  return gain === 0 ? `0 ${unit}` : `${gain > 0 ? "plus" : "minus"} ${figure} ${unit}`;
}

function sameGains(a: readonly number[], b: readonly number[]): boolean {
  return BANDS.every((_, band) => (a[band] ?? 0) === (b[band] ?? 0));
}

/**
 * The preset whose gains these are, the user's own before Lumen's (a saved
 * "Flat for my speakers" should be called that), or `undefined` if they are
 * nobody's: gains set by hand.
 */
export function presetOf(
  gains: readonly number[],
  saved: readonly EqualiserPreset[],
): EqualiserPreset | undefined {
  return [...saved, ...BUILT_IN].find((preset) => sameGains(preset.gains, gains));
}

/** True if every band is level. */
export function isFlat(gains: readonly number[]): boolean {
  return sameGains(gains, LEVEL);
}

/** The equaliser with one band moved. */
export function withGain(equaliser: Equaliser, band: number, gain: number): Equaliser {
  const gains = BANDS.map((_, index) => (index === band ? gain : (equaliser.gains[index] ?? 0)));
  return { ...equaliser, gains };
}

/** True if a preset of this name is one of Lumen's own, which cannot be replaced or deleted. */
export function isBuiltIn(name: string): boolean {
  return BUILT_IN.some((preset) => preset.name.toLowerCase() === name.trim().toLowerCase());
}
