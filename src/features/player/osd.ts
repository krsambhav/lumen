import { create } from "zustand";

/** How long a confirmation stays on screen after the last change. */
export const OSD_MS = 1200;
/** How long it takes to fade out; `--dur-base` in the design tokens. */
export const OSD_FADE_MS = 200;

export interface OsdMessage {
  /** What changed: "Volume", "Forward 5 s", "Paused". */
  label: string;
  /** The new value, already formatted: "65%", "0:42:17". */
  value?: string;
  /**
   * For ranges: where the value sits along a scale, from 0 to 1, and where
   * the scale's one mark is, if it has one. Places, not values, so a scale
   * that is not a straight line (the volume) is drawn the same way here as
   * in the control bar.
   */
  scale?: { at: number; mark?: number };
}

interface OsdState {
  /** What is on screen, or was until a moment ago and is fading out. */
  message: OsdMessage | null;
  /** False while the message fades out. */
  visible: boolean;
  show: (message: OsdMessage) => void;
  clear: () => void;
}

let hideTimer: ReturnType<typeof setTimeout> | undefined;
let removeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The on-screen display: one short line confirming a change that the visible
 * controls do not already show (DESIGN.md §7). A new message replaces the
 * old one in place and restarts the clock.
 */
export const useOsd = create<OsdState>((set) => ({
  message: null,
  visible: false,
  show: (message) => {
    clearTimeout(hideTimer);
    clearTimeout(removeTimer);
    set({ message, visible: true });
    hideTimer = setTimeout(() => {
      set({ visible: false });
      // The words go once they have faded, so that the same message shown
      // again later is a change, and is announced again.
      removeTimer = setTimeout(() => set({ message: null }), OSD_FADE_MS);
    }, OSD_MS);
  },
  clear: () => {
    clearTimeout(hideTimer);
    clearTimeout(removeTimer);
    set({ message: null, visible: false });
  },
}));

export function showOsd(message: OsdMessage): void {
  useOsd.getState().show(message);
}
