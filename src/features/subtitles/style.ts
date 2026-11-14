import type { Swatch } from "@/components/ui/swatches";
import type { SubtitleStyle } from "@/ipc";

/** Mirrors `SubtitleStyle::default()` in src-tauri/src/engine/adjust.rs. */
export const USUAL_STYLE: SubtitleStyle = {
  font: null,
  scale: 1,
  bold: false,
  colour: "#FFFFFF",
  outlineColour: "#000000",
  outline: 1.5,
  background: 0,
  raise: 0,
  restyle: false,
};

/** The colours subtitles are usually set in. Yellow is the cinema's own. */
export const TEXT_COLOURS: readonly Swatch[] = [
  { value: "#FFFFFF", name: "White" },
  { value: "#F2EFE4", name: "Warm white" },
  { value: "#FFE14D", name: "Yellow" },
  { value: "#9FE8FF", name: "Pale blue" },
];

export const OUTLINE_COLOURS: readonly Swatch[] = [
  { value: "#000000", name: "Black" },
  { value: "#2B2B2B", name: "Charcoal" },
  { value: "#12233F", name: "Dark blue" },
];

/** The limits of each scale: as in the backend's `SubtitleStyle::sanitised`. */
export const MIN_SCALE = 0.5;
export const MAX_SCALE = 2.5;
export const MAX_OUTLINE = 4;

export function sameStyle(a: SubtitleStyle, b: SubtitleStyle): boolean {
  return (
    a.font === b.font &&
    a.scale === b.scale &&
    a.bold === b.bold &&
    a.colour.toUpperCase() === b.colour.toUpperCase() &&
    a.outlineColour.toUpperCase() === b.outlineColour.toUpperCase() &&
    a.outline === b.outline &&
    a.background === b.background &&
    a.raise === b.raise &&
    a.restyle === b.restyle
  );
}

/** A share, 0 to 1, as it is read: "50%". */
export function percentText(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Where subtitles stand, as it is read: "Bottom", "12%", "Top". */
export function raiseText(raise: number): string {
  if (raise <= 0) {
    return "Bottom";
  }
  return raise >= 100 ? "Top" : `${Math.round(raise)}%`;
}

/** An outline's thickness as it is read: "None", "1.5". */
export function outlineText(outline: number): string {
  return outline <= 0 ? "None" : `${Number(outline.toFixed(2))}`;
}
