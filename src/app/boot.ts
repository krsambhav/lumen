import type { Session, Settings } from "@/ipc";

/** What the backend injects into every window before the page's scripts run. */
export interface Boot {
  settings: Settings;
  /** How things were left at the end of the last run. */
  session: Session;
}

declare global {
  interface Window {
    __LUMEN_BOOT__?: Partial<Boot>;
  }
}

/** Mirrors `Settings::default()` in src-tauri/src/settings.rs. */
export const DEFAULT_SETTINGS: Settings = {
  general: { checkForUpdates: true },
  appearance: {
    theme: "dark",
    accent: { kind: "preset", id: "limelight" },
  },
  video: {
    picture: {
      brightness: 0,
      contrast: 0,
      saturation: 0,
      gamma: 0,
      hue: 0,
      sharpness: 0,
      noiseReduction: 0,
    },
    presets: [],
  },
  audio: {
    equaliser: { enabled: false, gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    presets: [],
    device: null,
    channels: "auto",
    passthrough: false,
    visualiser: true,
  },
  subtitles: {
    style: {
      font: null,
      scale: 1,
      bold: false,
      colour: "#FFFFFF",
      outlineColour: "#000000",
      outline: 1.5,
      background: 0,
      raise: 0,
      restyle: false,
    },
    search: { apiKey: "", languages: ["en"] },
  },
};

/** Mirrors `Session::default()` in src-tauri/src/session.rs. */
export const DEFAULT_SESSION: Session = {
  volume: 100,
  muted: false,
  repeat: "off",
  shuffle: false,
  interface: {
    timeRemaining: false,
    inspectorTab: "playlist",
    recentActions: [],
  },
};

/**
 * The boot payload, or defaults when the page runs outside the app (tests,
 * a plain browser tab during UI development).
 */
export function readBoot(): Boot {
  const boot = window.__LUMEN_BOOT__;
  return {
    settings: boot?.settings ?? DEFAULT_SETTINGS,
    session: boot?.session ?? DEFAULT_SESSION,
  };
}

/** True inside the Tauri web view, false in tests and plain browsers. */
export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
