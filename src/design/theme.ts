/**
 * Applies the user's appearance settings to the document: the theme, and the
 * accent ramp for both themes (the stage is always dark, so both are needed
 * at once).
 */

import type { AccentChoice, AppearanceSettings, ThemeMode } from "@/ipc";
import {
  ACCENT_PRESETS,
  accentRamp,
  DEFAULT_ACCENT_ID,
  findAccentPreset,
  type Oklch,
  type ThemeName,
  toCss,
  toHex,
} from "./color";

const SYSTEM_DARK = "(prefers-color-scheme: dark)";

export function resolveTheme(mode: ThemeMode, systemIsDark: boolean): ThemeName {
  if (mode === "system") {
    return systemIsDark ? "dark" : "light";
  }
  return mode;
}

export interface ResolvedAccent {
  hue: number;
  chromaLimit: number | undefined;
}

/** The hue behind an accent choice. An unknown preset id falls back to the default. */
export function resolveAccent(choice: AccentChoice): ResolvedAccent {
  if (choice.kind === "custom") {
    return { hue: ((choice.hue % 360) + 360) % 360, chromaLimit: undefined };
  }
  const preset =
    findAccentPreset(choice.id) ?? findAccentPreset(DEFAULT_ACCENT_ID) ?? ACCENT_PRESETS[0];
  if (!preset) {
    throw new Error("the accent preset list is empty");
  }
  return { hue: preset.hue, chromaLimit: preset.chromaLimit };
}

function supportsOklch(): boolean {
  return typeof CSS !== "undefined" && CSS.supports("color", "oklch(0% 0 0)");
}

/** The custom properties that express an accent, for both themes. */
export function accentProperties(
  accent: ResolvedAccent,
  format: (color: Oklch) => string = toCss,
): Record<string, string> {
  const dark = accentRamp(accent.hue, "dark", accent.chromaLimit);
  const light = accentRamp(accent.hue, "light", accent.chromaLimit);
  return {
    "--tint-h": String(Number(accent.hue.toFixed(2))),
    "--accent-d": format(dark.accent),
    "--accent-soft-d": format(dark.accentSoft),
    "--accent-fill-hover-d": format(dark.accentFillHover),
    "--accent-l": format(light.accent),
    "--accent-soft-l": format(light.accentSoft),
    "--accent-fill-hover-l": format(light.accentFillHover),
    // The fill and the text on it are the same in both themes.
    "--accent-fill": format(dark.accentFill),
    "--accent-fg": format(dark.accentFg),
  };
}

export function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(SYSTEM_DARK).matches;
}

export function applyAppearance(
  appearance: AppearanceSettings,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.theme = resolveTheme(appearance.theme, systemPrefersDark());
  const properties = accentProperties(
    resolveAccent(appearance.accent),
    supportsOklch() ? toCss : toHex,
  );
  for (const [name, value] of Object.entries(properties)) {
    root.style.setProperty(name, value);
  }
}

/** Calls `onChange` when macOS switches between light and dark. Returns the unsubscriber. */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") {
    return () => {};
  }
  const query = window.matchMedia(SYSTEM_DARK);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
