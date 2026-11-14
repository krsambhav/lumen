import type { SVGProps } from "react";
import { cn } from "@/lib/cn";

/**
 * Transport glyphs: solid shapes. A solid play triangle is the most
 * recognisable mark on a player and reads from across a room, which an
 * outline at 18 px does not (DESIGN.md §6).
 *
 * They are drawn as fills with their corners rounded in the path, never as a
 * fill with a stroke over it. Stage icons are a translucent ink, and a
 * translucent stroke on a translucent fill shows through itself as a lighter
 * rim around the shape.
 */

type GlyphProps = Omit<SVGProps<SVGSVGElement>, "viewBox" | "fill">;

function Glyph({ className, children, ...props }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={cn("flex-none", className)}
      {...props}
    >
      {children}
    </svg>
  );
}

/** Play, shifted 1 px right so the triangle sits optically centred. */
export function PlayGlyph({ className, ...props }: GlyphProps) {
  return (
    <Glyph className={cn("translate-x-px", className)} {...props}>
      <path d="M5.5 6.32A2.2 2.2 0 0 1 8.85 4.45L18.13 10.12A2.2 2.2 0 0 1 18.13 13.88L8.85 19.55A2.2 2.2 0 0 1 5.5 17.68Z" />
    </Glyph>
  );
}

export function PauseGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="5" y="3" width="5.5" height="18" rx="1.75" />
      <rect x="13.5" y="3" width="5.5" height="18" rx="1.75" />
    </Glyph>
  );
}

export function PreviousGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="4" y="4" width="2.5" height="16" rx="1.25" />
      <path d="M20 7.29A2 2 0 0 0 16.83 5.67L10.27 10.37A2 2 0 0 0 10.27 13.63L16.83 18.33A2 2 0 0 0 20 16.71Z" />
    </Glyph>
  );
}

export function NextGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <path d="M4 7.29A2 2 0 0 1 7.17 5.67L13.73 10.37A2 2 0 0 1 13.73 13.63L7.17 18.33A2 2 0 0 1 4 16.71Z" />
      <rect x="17.5" y="4" width="2.5" height="16" rx="1.25" />
    </Glyph>
  );
}

/** Stop: a square, its corners rounded like the other glyphs', a little smaller than Play so the two weigh the same. */
export function StopGlyph(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="5.5" y="5.5" width="13" height="13" rx="2.25" />
    </Glyph>
  );
}
