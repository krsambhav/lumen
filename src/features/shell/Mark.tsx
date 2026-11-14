import { useId } from "react";
import { cn } from "@/lib/cn";

interface MarkProps {
  /**
   * How many divisions the scale has. The mark itself has 24; a shorter one
   * stands in where there is no picture to show (a media tile), drawn at the
   * same size so its hairlines stay whole pixels.
   */
  divisions?: number;
  className?: string;
}

const PITCH = 10;

/**
 * The brand mark: an engraved scale with one lit needle (DESIGN.md §1).
 *
 * It is drawn with filled rectangles on whole pixels, one SVG unit per CSS
 * pixel, so every hairline is exactly one pixel wide on a 1x display too.
 * It is decoration, so it is hidden from assistive technology.
 */
export function Mark({ divisions = 24, className }: MarkProps) {
  const width = divisions * PITCH + 1;
  // The needle rests a third of the way along, a little left of centre.
  const needleAt = Math.round(divisions / 3);
  return (
    <svg
      viewBox={`0 0 ${width} 28`}
      width={width}
      height={28}
      aria-hidden="true"
      focusable="false"
      className={cn("flex-none", className)}
    >
      <rect x="0" y="20" width={width} height="1" className="fill-line-strong" />
      {Array.from({ length: divisions + 1 }, (_, index) => {
        const major = index % 4 === 0;
        return (
          <rect
            // The ticks are a fixed sequence.
            // biome-ignore lint/suspicious/noArrayIndexKey: static list
            key={index}
            x={index * PITCH}
            y={major ? 10 : 15}
            width="1"
            height={major ? 10 : 5}
            className={major ? "fill-ink-2" : "fill-line-strong"}
          />
        );
      })}
      {/* Lit in both themes; on a light surface it takes a line of the accent ink (see `.needle`). */}
      <rect
        x={needleAt * PITCH}
        y="1"
        width="2"
        height="26"
        rx="1"
        className="fill-accent-fill [stroke:var(--needle-edge)]"
      />
    </svg>
  );
}

/**
 * The same scale at the width of whatever holds it: the instrument at rest,
 * with its needle at the start (DESIGN.md §7, "Empty state").
 *
 * The divisions are 10 px apart, as in the mark, and drawn as rectangles on
 * whole pixels, repeated by an SVG pattern, so every hairline is one pixel
 * wide. The scale is as long as a whole number of divisions allows, so it
 * ends on a tick. (WebKit before 15.4 has no `round()` and draws it full
 * width, where the last division may be a short one.)
 */
export function Ruler({ className }: Pick<MarkProps, "className">) {
  // Pattern ids are document-wide; colons from `useId` would need escaping in a reference.
  const id = useId().replace(/:/g, "");
  return (
    <div
      aria-hidden="true"
      className={cn("relative h-7 w-full [width:calc(round(down,100%-1px,10px)+1px)]", className)}
    >
      <svg aria-hidden="true" className="absolute inset-0 size-full" focusable="false">
        <defs>
          <pattern id={`${id}-minor`} width={PITCH} height="5" patternUnits="userSpaceOnUse">
            <rect width="1" height="5" className="fill-line-strong" />
          </pattern>
          <pattern id={`${id}-major`} width={PITCH * 4} height="10" patternUnits="userSpaceOnUse">
            <rect width="1" height="10" className="fill-ink-2" />
          </pattern>
        </defs>
        <rect x="0" y="20" width="100%" height="1" className="fill-line-strong" />
        <rect x="0" y="15" width="100%" height="5" fill={`url(#${id}-minor)`} />
        <rect x="0" y="10" width="100%" height="10" fill={`url(#${id}-major)`} />
      </svg>
      <div className="needle absolute left-0 top-px h-[26px] w-0.5 rounded-xs" />
    </div>
  );
}
