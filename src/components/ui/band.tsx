import { Slider as SliderPrimitive } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "./tooltip";

interface BandProps {
  /** The accessible name: "250 hertz". */
  label: string;
  /** What stands under it: "250". */
  caption: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** The neutral value: where the level starts, and where a double-click returns to. */
  origin: number;
  /** The value with its unit, in words: "plus 4.5 decibels". */
  valueText: string;
  /** The value as its tooltip shows it: "+4.5 dB". */
  display: string;
  /** Not in effect at the moment: the level and the needle step back. */
  dimmed?: boolean;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
}

/** How long the pointer rests on a band before its tooltip opens: as for every tooltip. */
const TOOLTIP_DELAY_MS = 500;

/**
 * One band of the equaliser (DESIGN.md §7): a Scale stood on end. The
 * needle lies across the track, the level is lit from the neutral value to
 * the needle, and the reading shows beside the needle while it is held.
 */
export function Band({
  label,
  caption,
  value,
  min,
  max,
  step,
  origin,
  valueText,
  display,
  dimmed = false,
  onChange,
  onCommit,
}: BandProps) {
  const needle = useRef<HTMLSpanElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rested, setRested] = useState(false);
  const rest = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(rest.current), []);

  const range = max - min;
  const share = (at: number) => (range > 0 ? ((at - min) / range) * 100 : 0);
  const low = Math.min(share(value), share(origin));
  const high = Math.max(share(value), share(origin));

  return (
    <div className="flex w-7 flex-none flex-col items-center gap-1">
      <SliderPrimitive.Root
        orientation="vertical"
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([next]) => {
          if (next !== undefined) {
            onChange(next);
          }
        }}
        onValueCommit={([next]) => {
          if (next !== undefined) {
            onCommit?.(next);
          }
        }}
        onPointerDown={() => setDragging(true)}
        onPointerUp={() => {
          setDragging(false);
          // Used with the pointer, it does not keep the keyboard: the arrow
          // keys go back to the film (DESIGN.md §8).
          needle.current?.blur();
        }}
        onPointerCancel={() => setDragging(false)}
        onPointerEnter={() => {
          clearTimeout(rest.current);
          rest.current = setTimeout(() => setRested(true), TOOLTIP_DELAY_MS);
        }}
        onPointerLeave={() => {
          clearTimeout(rest.current);
          setRested(false);
        }}
        className="group/band relative flex h-28 w-7 touch-none select-none justify-center"
      >
        <SliderPrimitive.Track
          className={cn(
            "relative h-full w-0.5 rounded-full bg-line-strong",
            "origin-center transition-transform duration-fast ease-out group-hover/band:scale-x-[2] motion-reduce:transition-none",
          )}
        >
          <span
            aria-hidden="true"
            data-level=""
            className={cn(
              "absolute w-full rounded-full bg-ink-1 transition-opacity duration-fast ease-out",
              dimmed && "opacity-0",
            )}
            style={{ bottom: `${low}%`, top: `${100 - high}%` }}
          />
        </SliderPrimitive.Track>
        <Tooltip label={display} held={dragging || rested} side="top">
          <SliderPrimitive.Thumb
            ref={needle}
            aria-label={label}
            aria-valuetext={valueText}
            onDoubleClick={() => {
              onChange(origin);
              onCommit?.(origin);
            }}
            className={cn(
              // The needle, lying down: 14 × 2 px inside a 28 × 24 px area to grab.
              "relative block h-0.5 w-3.5 rounded-xs outline-offset-4 transition-colors duration-fast ease-out",
              "before:absolute before:-inset-x-[7px] before:-inset-y-[11px] before:content-['']",
              dimmed ? "bg-ink-3" : "needle",
            )}
          />
        </Tooltip>
      </SliderPrimitive.Root>
      <span aria-hidden="true" className="tabular whitespace-nowrap text-caption text-ink-3">
        {caption}
      </span>
    </div>
  );
}
