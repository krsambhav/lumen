import { create } from "zustand";
import { focusOrigin } from "@/lib/focus-origin";

/**
 * What the palette is open for: everything, only going to a time, only
 * opening an address, or searching for torrents to play.
 */
export type PaletteMode = "all" | "time" | "address" | "torrents";

interface PaletteState {
  open: boolean;
  mode: PaletteMode;
  /**
   * The control that had keyboard focus when the palette opened, to give it
   * back on closing. A control that was only clicked is not kept: the
   * keyboard was the player's then and should be again.
   */
  returnTo: HTMLElement | null;
  /** What the input starts with, when it was opened with something already typed. */
  seed: string;
  show: (mode?: PaletteMode, seed?: string) => void;
  hide: () => void;
}

export const usePalette = create<PaletteState>((set, get) => ({
  open: false,
  mode: "all",
  returnTo: null,
  seed: "",
  show: (mode = "all", seed = "") => {
    if (get().open) {
      set({ mode, seed });
      return;
    }
    const focused = document.activeElement;
    const returnTo =
      focusOrigin() === "keyboard" && focused instanceof HTMLElement && focused !== document.body
        ? focused
        : null;
    set({ open: true, mode, returnTo, seed });
  },
  hide: () => set({ open: false }),
}));
