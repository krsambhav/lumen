import type { Picture, PicturePreset } from "@/ipc";

/** Mirrors `Picture::default()` in src-tauri/src/engine/adjust.rs: the picture left alone. */
export const NEUTRAL_PICTURE: Picture = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  gamma: 0,
  hue: 0,
  sharpness: 0,
  noiseReduction: 0,
};

export interface Level {
  key: keyof Picture;
  name: string;
  min: number;
  max: number;
  /** It goes both ways from 0, and reads with its sign. */
  bothWays: boolean;
}

/** The tuner's scales, in the order they are listed. */
export const LEVELS: readonly Level[] = [
  { key: "brightness", name: "Brightness", min: -100, max: 100, bothWays: true },
  { key: "contrast", name: "Contrast", min: -100, max: 100, bothWays: true },
  { key: "saturation", name: "Saturation", min: -100, max: 100, bothWays: true },
  { key: "gamma", name: "Gamma", min: -100, max: 100, bothWays: true },
  { key: "hue", name: "Hue", min: -100, max: 100, bothWays: true },
  { key: "sharpness", name: "Sharpness", min: 0, max: 100, bothWays: false },
  { key: "noiseReduction", name: "Noise reduction", min: 0, max: 100, bothWays: false },
];

/** A level as it is read at the end of its row: "+12", "−30", "0". The minus is a real minus. */
export function levelText(value: number, bothWays: boolean): string {
  if (value === 0 || !bothWays) {
    return `${value}`;
  }
  return `${value > 0 ? "+" : "−"}${Math.abs(value)}`;
}

/** A level in words: "plus 12", "minus 30". */
export function levelSpoken(value: number, bothWays: boolean): string {
  if (value === 0 || !bothWays) {
    return `${value}`;
  }
  return `${value > 0 ? "plus" : "minus"} ${Math.abs(value)}`;
}

export function samePicture(a: Picture, b: Picture): boolean {
  return LEVELS.every((level) => a[level.key] === b[level.key]);
}

export function isNeutral(picture: Picture): boolean {
  return samePicture(picture, NEUTRAL_PICTURE);
}

/** What the picture left alone is called among the presets. */
export const NEUTRAL_NAME = "Neutral";

/** The name of the preset these levels are: "Neutral", one of the saved, or `null` for set by hand. */
export function pictureName(picture: Picture, saved: readonly PicturePreset[]): string | null {
  if (isNeutral(picture)) {
    return NEUTRAL_NAME;
  }
  return saved.find((preset) => samePicture(preset.picture, picture))?.name ?? null;
}
