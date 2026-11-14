import type { Deinterlace, Ratio, Shape } from "@/ipc";

/** Mirrors `Shape::default()` in src-tauri/src/engine/adjust.rs: the picture as the file has it. */
export const OWN_SHAPE: Shape = {
  aspect: null,
  crop: null,
  zoom: 1,
  turns: 0,
  flipped: false,
  mirrored: false,
  deinterlace: "off",
};

/** The least and the most the picture can be magnified: `MIN_ZOOM` and `MAX_ZOOM` in the backend. */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;

/** A shape to choose, with the name it is chosen by. */
export interface NamedRatio {
  name: string;
  ratio: Ratio;
}

/**
 * The shapes films and television come in, widest last. Each is named the
 * way it is spoken of: by its ratio, as two whole numbers or as one to one.
 */
export const RATIOS: readonly NamedRatio[] = [
  { name: "4:3", ratio: { width: 4, height: 3 } },
  { name: "16:10", ratio: { width: 16, height: 10 } },
  { name: "16:9", ratio: { width: 16, height: 9 } },
  { name: "1.85:1", ratio: { width: 185, height: 100 } },
  { name: "2:1", ratio: { width: 2, height: 1 } },
  { name: "2.35:1", ratio: { width: 235, height: 100 } },
  { name: "2.39:1", ratio: { width: 239, height: 100 } },
];

export function sameRatio(a: Ratio | null, b: Ratio | null): boolean {
  return a === b || (a !== null && b !== null && a.width === b.width && a.height === b.height);
}

/** The name a ratio is chosen by, or the two numbers themselves if it is not one of the usual. */
export function ratioName(ratio: Ratio): string {
  return (
    RATIOS.find((named) => sameRatio(named.ratio, ratio))?.name ?? `${ratio.width}:${ratio.height}`
  );
}

export const DEINTERLACE: readonly { value: Deinterlace; name: string; detail?: string }[] = [
  { value: "off", name: "Off" },
  { value: "auto", name: "Automatic", detail: "When the file says it is interlaced" },
  { value: "on", name: "On" },
];

/** True if nothing about the picture's shape has been changed from the file's own. */
export function isOwnShape(shape: Shape): boolean {
  return (
    shape.aspect === null &&
    shape.crop === null &&
    shape.zoom === 1 &&
    shape.turns === 0 &&
    !shape.flipped &&
    !shape.mirrored &&
    shape.deinterlace === "off"
  );
}

/** A quarter turn more, clockwise or the other way. */
export function turned(shape: Shape, clockwise: boolean): Shape {
  return { ...shape, turns: (shape.turns + (clockwise ? 1 : 3)) % 4 };
}

/** How far round the picture is turned, in words: "90° clockwise". */
export function turnName(turns: number): string {
  switch (((turns % 4) + 4) % 4) {
    case 1:
      return "90° clockwise";
    case 2:
      return "Upside down";
    case 3:
      return "90° anticlockwise";
    default:
      return "Not turned";
  }
}

/** A zoom as it is read: "150%". */
export function zoomText(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
