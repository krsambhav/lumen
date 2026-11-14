import { Fragment } from "react";
import { cn } from "@/lib/cn";
import { formatTimecode } from "@/lib/timecode";

interface TimecodeProps {
  seconds: number;
  /** The length of the media, which decides whether hours are shown. */
  span?: number;
  /** Shown before the digits, e.g. a minus sign for time remaining. */
  prefix?: string;
  className?: string;
}

/**
 * A timecode in tabular numerals. The colons are raised a little: the
 * family draws them on the baseline, where they look low between digits.
 */
export function Timecode({ seconds, span, prefix, className }: TimecodeProps) {
  const parts = formatTimecode(seconds, span).split(":");
  return (
    <span className={cn("tabular whitespace-nowrap", className)}>
      {prefix}
      {parts.map((part, index) => (
        // The parts of a timecode are positional.
        // biome-ignore lint/suspicious/noArrayIndexKey: static order
        <Fragment key={index}>
          {index > 0 ? <span className="relative -top-[0.06em]">:</span> : null}
          {part}
        </Fragment>
      ))}
    </span>
  );
}
