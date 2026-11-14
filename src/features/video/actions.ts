import {
  Film,
  FlipHorizontal2,
  FlipVertical2,
  RotateCcw,
  RotateCw,
  Rows3,
  SunMedium,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Action, ActionContext } from "@/actions/registry";
import { confirm, needsMedia } from "@/features/player/actions";
import { setShape } from "@/features/player/adjust";
import { usePlayer } from "@/features/player/store";
import { showing } from "@/features/playlist/actions";
import { setPicture } from "@/features/settings/change";
import { useSettings } from "@/features/settings/store";
import { useInterface } from "@/features/shell/interface";
import type { Ratio, Shape } from "@/ipc";
import { isNeutral, NEUTRAL_PICTURE } from "./picture";
import {
  isOwnShape,
  MAX_ZOOM,
  MIN_ZOOM,
  OWN_SHAPE,
  ratioName,
  turned,
  turnName,
  zoomText,
} from "./shape";

/** The sizes the zoom keys step through. */
export const ZOOMS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function shape(): Shape {
  return usePlayer.getState().shape;
}

/** Needs something open that has a picture. */
function needsPicture(): string | undefined {
  const state = usePlayer.getState();
  return needsMedia() ?? (state.video === null ? "This has no picture" : undefined);
}

/** The next size up or down from `zoom`, or `zoom` itself at the end of the range. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) {
    return ZOOMS.find((step) => step > zoom + 0.001) ?? MAX_ZOOM;
  }
  return [...ZOOMS].reverse().find((step) => step < zoom - 0.001) ?? MIN_ZOOM;
}

function zoomTo(context: ActionContext, zoom: number) {
  setShape({ ...shape(), zoom });
  confirm(context, {
    label: "Zoom",
    value: zoomText(zoom),
    scale: {
      at: Math.log2(zoom / MIN_ZOOM) / Math.log2(MAX_ZOOM / MIN_ZOOM),
      mark: Math.log2(1 / MIN_ZOOM) / Math.log2(MAX_ZOOM / MIN_ZOOM),
    },
  });
}

function turn(context: ActionContext, clockwise: boolean) {
  const next = turned(shape(), clockwise);
  setShape(next);
  confirm(context, { label: turnName(next.turns) });
}

/** Shows the picture in `aspect`, or as the file has it. */
export function setAspect(context: ActionContext, aspect: Ratio | null) {
  setShape({ ...shape(), aspect });
  confirm(context, { label: "Aspect", value: aspect ? ratioName(aspect) : "Original" });
}

/** Cuts the picture to `crop` about its centre, or shows all of it. */
export function setCrop(context: ActionContext, crop: Ratio | null) {
  setShape({ ...shape(), crop });
  confirm(context, { label: "Crop", value: crop ? ratioName(crop) : "None" });
}

/** The actions of the picture: its frame, and its lasting adjustments. */
export const videoActions: readonly Action[] = [
  {
    id: "video.rotate",
    name: "Rotate clockwise",
    keywords: ["turn", "sideways", "portrait", "orientation"],
    category: "video",
    icon: RotateCw,
    shortcuts: ["Cmd+r"],
    unavailable: needsPicture,
    run: (context) => turn(context, true),
  },
  {
    id: "video.rotateBack",
    name: "Rotate anticlockwise",
    keywords: ["turn", "sideways", "counterclockwise", "orientation"],
    category: "video",
    icon: RotateCcw,
    shortcuts: ["Alt+Cmd+r"],
    unavailable: needsPicture,
    run: (context) => turn(context, false),
  },
  {
    id: "video.mirror",
    name: "Mirror",
    keywords: ["flip horizontally", "reverse", "left to right"],
    category: "video",
    icon: FlipHorizontal2,
    shortcuts: [],
    checked: () => shape().mirrored,
    unavailable: needsPicture,
    run: (context) => {
      const mirrored = !shape().mirrored;
      setShape({ ...shape(), mirrored });
      confirm(context, { label: mirrored ? "Mirrored" : "Not mirrored" });
    },
  },
  {
    id: "video.flip",
    name: "Flip",
    keywords: ["flip vertically", "upside down", "top to bottom"],
    category: "video",
    icon: FlipVertical2,
    shortcuts: [],
    checked: () => shape().flipped,
    unavailable: needsPicture,
    run: (context) => {
      const flipped = !shape().flipped;
      setShape({ ...shape(), flipped });
      confirm(context, { label: flipped ? "Flipped" : "Not flipped" });
    },
  },
  {
    id: "video.zoomIn",
    name: "Zoom in",
    keywords: ["bigger", "magnify", "enlarge", "fill"],
    category: "video",
    icon: ZoomIn,
    shortcuts: ["z"],
    repeats: true,
    unavailable: () =>
      needsPicture() ??
      (shape().zoom >= MAX_ZOOM - 0.001 ? "This is as large as it goes" : undefined),
    run: (context) => zoomTo(context, stepZoom(shape().zoom, 1)),
  },
  {
    id: "video.zoomOut",
    name: "Zoom out",
    keywords: ["smaller", "shrink"],
    category: "video",
    icon: ZoomOut,
    shortcuts: ["Shift+z"],
    repeats: true,
    unavailable: () =>
      needsPicture() ??
      (shape().zoom <= MIN_ZOOM + 0.001 ? "This is as small as it goes" : undefined),
    run: (context) => zoomTo(context, stepZoom(shape().zoom, -1)),
  },
  {
    id: "video.deinterlace",
    name: "Deinterlace",
    keywords: ["combing", "interlaced", "television", "lines"],
    category: "video",
    icon: Rows3,
    shortcuts: ["d"],
    checked: () => shape().deinterlace !== "off",
    unavailable: needsPicture,
    run: (context) => {
      const on = shape().deinterlace === "off";
      setShape({ ...shape(), deinterlace: on ? "on" : "off" });
      confirm(context, { label: "Deinterlace", value: on ? "On" : "Off" });
    },
  },
  {
    id: "video.resetFrame",
    name: "Reset the frame",
    keywords: ["aspect", "crop", "zoom", "rotation", "original", "undo"],
    category: "video",
    icon: Film,
    shortcuts: [],
    unavailable: () =>
      needsPicture() ?? (isOwnShape(shape()) ? "The frame is as the file has it" : undefined),
    run: (context) => {
      setShape(OWN_SHAPE);
      confirm(context, { label: "Frame reset" });
    },
  },
  {
    id: "video.resetPicture",
    name: "Reset the picture",
    keywords: ["brightness", "contrast", "saturation", "tuner", "neutral", "undo"],
    category: "video",
    icon: SunMedium,
    shortcuts: [],
    unavailable: () =>
      isNeutral(useSettings.getState().settings.video.picture)
        ? "The picture is not adjusted"
        : undefined,
    run: (context) => {
      setPicture(NEUTRAL_PICTURE);
      confirm(context, { label: "Picture reset" });
    },
  },
  {
    id: "view.video",
    name: "Show video adjustments",
    label: () => (showing("video") ? "Hide video adjustments" : "Show video adjustments"),
    keywords: ["tuner", "brightness", "contrast", "aspect", "crop", "zoom", "panel", "picture"],
    category: "view",
    icon: Film,
    shortcuts: ["Shift+Cmd+v"],
    unavailable: needsMedia,
    run: (context) => useInterface.getState().togglePanel("video", context.source === "keyboard"),
  },
];
