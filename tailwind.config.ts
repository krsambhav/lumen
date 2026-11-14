import type { Config } from "tailwindcss";

/**
 * Tailwind is configured from the design tokens only (DESIGN.md). The default
 * palette, type scale and radii are replaced, not extended, so a class that is
 * off-system does not exist.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    colors: {
      transparent: "transparent",
      current: "currentColor",
      void: "var(--void)",
      bg: "var(--bg)",
      surface: {
        1: "var(--surface-1)",
        2: "var(--surface-2)",
        3: "var(--surface-3)",
        4: "var(--surface-4)",
      },
      line: {
        DEFAULT: "var(--line)",
        strong: "var(--line-strong)",
      },
      ink: {
        1: "var(--ink-1)",
        2: "var(--ink-2)",
        3: "var(--ink-3)",
      },
      accent: {
        DEFAULT: "var(--accent)",
        soft: "var(--accent-soft)",
        fill: "var(--accent-fill)",
        "fill-hover": "var(--accent-fill-hover)",
        fg: "var(--accent-fg)",
      },
      danger: "var(--danger)",
      warning: "var(--warning)",
      success: "var(--success)",
      stage: {
        ink: "var(--stage-ink)",
        "ink-2": "var(--stage-ink-2)",
        hover: "var(--stage-hover)",
        press: "var(--stage-press)",
        track: "var(--stage-track)",
        buffer: "var(--stage-buffer)",
        veil: "var(--stage-veil)",
      },
    },
    fontFamily: {
      sans: [
        '"Plus Jakarta Sans Variable"',
        "ui-sans-serif",
        "system-ui",
        "-apple-system",
        "sans-serif",
      ],
    },
    fontSize: {
      caption: ["0.6875rem", { lineHeight: "1rem", letterSpacing: "0.01em", fontWeight: "500" }],
      body: ["0.8125rem", { lineHeight: "1.25rem" }],
      heading: [
        "1.0625rem",
        { lineHeight: "1.5rem", letterSpacing: "-0.01em", fontWeight: "600" },
      ],
      title: [
        "1.375rem",
        { lineHeight: "1.75rem", letterSpacing: "-0.015em", fontWeight: "600" },
      ],
      display: [
        "1.875rem",
        { lineHeight: "2.25rem", letterSpacing: "-0.02em", fontWeight: "600" },
      ],
      // The on-screen display: scales with the window so it reads from the sofa.
      osd: ["var(--osd-size)", { lineHeight: "1.2", letterSpacing: "-0.01em", fontWeight: "600" }],
    },
    fontWeight: {
      body: "var(--weight-body)",
      medium: "500",
      semibold: "600",
    },
    borderRadius: {
      none: "0",
      xs: "4px",
      sm: "6px",
      md: "10px",
      lg: "14px",
      full: "9999px",
    },
    boxShadow: {
      none: "none",
      pop: "var(--shadow-pop)",
      palette: "var(--shadow-palette)",
    },
    transitionDuration: {
      fast: "var(--dur-fast)",
      base: "var(--dur-base)",
    },
    transitionTimingFunction: {
      out: "var(--ease-out)",
      linear: "linear",
    },
    zIndex: {
      0: "0",
      chrome: "10",
      inspector: "20",
      popover: "30",
      palette: "40",
      toast: "50",
      tooltip: "60",
    },
    extend: {
      spacing: {
        titlebar: "var(--titlebar-h)",
        "titlebar-lead": "var(--titlebar-lead)",
        controlbar: "var(--controlbar-h)",
        "scrim-bottom": "var(--scrim-bottom-h)",
        "scrim-top": "var(--scrim-top-h)",
        gutter: "var(--gutter)",
        sidebar: "var(--sidebar-w)",
        inspector: "var(--inspector-w)",
        palette: "var(--palette-w)",
      },
      backgroundImage: {
        "scrim-bottom": "var(--scrim-bottom)",
        "scrim-top": "var(--scrim-top)",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "fade-out": { from: { opacity: "1" }, to: { opacity: "0" } },
        "rise-in": {
          from: { opacity: "0", transform: "translateY(var(--shift-sm))" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "drop-in": {
          from: { opacity: "0", transform: "translateY(calc(var(--shift-sm) * -1))" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "slide-in": {
          from: { opacity: "0", transform: "translateX(var(--shift-lg))" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "slide-out": {
          from: { opacity: "1", transform: "translateX(0)" },
          to: { opacity: "0", transform: "translateX(var(--shift-lg))" },
        },
        "pop-in": {
          from: { opacity: "0", transform: "scale(var(--scale-from))" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        sweep: {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(var(--sweep, 18px))" },
        },
      },
      animation: {
        // An entrance fills backwards only: once it is over the element is
        // styled by its own classes again. Held forwards, its last frame
        // would go on overriding them, and a `transform` kept that way makes
        // the element the containing block of everything fixed inside it.
        "fade-in": "fade-in var(--dur-base) var(--ease-out) backwards",
        "fade-out": "fade-out var(--dur-fast) var(--ease-out) both",
        "rise-in": "rise-in var(--dur-base) var(--ease-out) backwards",
        "drop-in": "drop-in var(--dur-base) var(--ease-out) backwards",
        "slide-in": "slide-in var(--dur-base) var(--ease-out) backwards",
        "slide-out": "slide-out var(--dur-fast) var(--ease-out) both",
        "pop-in": "pop-in var(--dur-base) var(--ease-out) backwards",
        sweep: "sweep 900ms cubic-bezier(0.65, 0, 0.35, 1) infinite alternate",
      },
    },
  },
  plugins: [],
} satisfies Config;
