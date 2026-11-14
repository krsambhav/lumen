import { chordGlyphs, chordSpoken } from "@/actions/shortcuts";
import { cn } from "@/lib/cn";

interface ShortcutProps {
  /** Chord text, e.g. `"Shift+Cmd+k"`. */
  chord: string;
  /**
   * `keycap` draws an outline around the chord. Use it wherever the chord
   * follows a name on the same line (tooltips), so a bare letter cannot be
   * read as part of the name. `plain` is for columns of shortcuts (menus).
   */
  variant?: "plain" | "keycap";
  className?: string;
}

/** Letters, digits and words are set in the interface font; everything else is a symbol. */
const WORD = /^[A-Za-z0-9]+$/;

/**
 * A keyboard shortcut drawn as key glyphs (⇧⌘K). Screen readers get the
 * spelled-out form instead of the symbols.
 *
 * The interface font has ↑ and ↓ but none of ← → ⌘ ⇧ ⌥ ⌃, so every symbol is
 * set in the system font; otherwise two arrows in one chord would not match.
 */
export function Shortcut({ chord, variant = "plain", className }: ShortcutProps) {
  const glyphs = chordGlyphs(chord);
  if (glyphs.length === 0) {
    return null;
  }
  return (
    <kbd
      className={cn(
        "tabular inline-flex flex-none items-center font-sans",
        variant === "keycap" &&
          "h-[18px] min-w-[18px] justify-center rounded-xs border border-line-strong px-1",
        className,
      )}
    >
      <span aria-hidden="true" className="inline-flex items-center gap-px whitespace-nowrap">
        {glyphs.map((glyph, index) => (
          <span
            // Glyph order is fixed for a chord, so the index is a stable key.
            // biome-ignore lint/suspicious/noArrayIndexKey: static list
            key={index}
            className={
              WORD.test(glyph) ? (glyph.length > 1 ? "px-0.5" : undefined) : "font-[system-ui]"
            }
          >
            {glyph}
          </span>
        ))}
      </span>
      <span className="sr-only">{chordSpoken(chord)}</span>
    </kbd>
  );
}
