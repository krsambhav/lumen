import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge has to be told about the design system's own scales. Without
 * this it treats `text-body` (a size) and `text-ink-2` (a colour) as the same
 * kind of class and drops one, and it does not see that `h-titlebar` and `h-8`
 * conflict, so an override would not override.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      spacing: [
        "titlebar",
        "titlebar-lead",
        "controlbar",
        "gutter",
        "sidebar",
        "inspector",
        "palette",
        "scrim-bottom",
        "scrim-top",
      ],
    },
    classGroups: {
      "font-size": [{ text: ["caption", "body", "heading", "title", "display", "osd"] }],
      "font-weight": [{ font: ["body", "medium", "semibold"] }],
      rounded: [{ rounded: ["none", "xs", "sm", "md", "lg", "full"] }],
      shadow: [{ shadow: ["none", "pop", "palette"] }],
      duration: [{ duration: ["fast", "base"] }],
      ease: [{ ease: ["out", "linear"] }],
      z: [{ z: ["0", "chrome", "inspector", "popover", "palette", "toast", "tooltip"] }],
      "bg-image": [{ bg: ["scrim-bottom", "scrim-top"] }],
      animate: [
        {
          animate: [
            "none",
            "fade-in",
            "fade-out",
            "rise-in",
            "drop-in",
            "slide-in",
            "slide-out",
            "pop-in",
            "sweep",
          ],
        },
      ],
    },
  },
});

/** Joins class names, letting later Tailwind classes override earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
