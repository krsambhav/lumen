import { Slider as SliderPrimitive } from "radix-ui";
import {
  type KeyboardEvent,
  type ReactElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";
import { useSurface } from "./surface";
import { Tooltip, TooltipOffset } from "./tooltip";

export interface ScaleMark {
  value: number;
  /** Read out in place of the value while the needle rests on the mark, e.g. "Normal". */
  label?: string;
}

/** Where values sit along a scale that is not a straight line. */
export interface ScaleCurve {
  /** From a value to its place along the track, 0 to 1. */
  toFraction: (value: number) => number;
  /** From a place along the track, 0 to 1, to the value there. */
  fromFraction: (fraction: number) => number;
}

export interface ScaleProps {
  /** The accessible name. */
  label: string;
  value: number;
  min: number;
  max: number;
  /** What one arrow key moves by, and the grid a dragged needle lands on. */
  step?: number;
  /** A double-click on the needle resets to this. */
  defaultValue?: number;
  /**
   * Where the level starts, for a scale that goes both ways from a neutral
   * value: the level is lit from here to the needle, either way. Without
   * it the level runs from the minimum.
   */
  origin?: number;
  /** Round values drawn as ticks; a dragged needle snaps to them when close. */
  marks?: readonly ScaleMark[];
  /**
   * Draws this many even divisions under the track, like the graduations of
   * the brand mark. For scales in panels; the stage timeline stays bare.
   */
  divisions?: number;
  /** The value in words with its unit, e.g. "65 percent". */
  valueText: string;
  disabled?: boolean;
  /** For a scale that gives part of its range more room than the rest. */
  curve?: ScaleCurve;
  /** Where the End key goes, when that should not be the maximum. */
  end?: number;
  /**
   * The value is not in effect at the moment (the volume while muted): the
   * level and the needle dim, and the needle keeps its place.
   */
  dimmed?: boolean;
  /**
   * A tooltip on the needle: its reading, and the keys that move it. It
   * opens when the pointer rests on the scale and follows the needle while
   * it is dragged.
   */
  tooltip?: {
    label: string;
    shortcut?: string | readonly string[];
    /** How far it stands off the needle, where the surrounding region's default will not do. */
    offset?: number;
  };
  /** Fires continuously while dragging. */
  onChange: (value: number) => void;
  /** Fires once when a drag or key press settles. */
  onCommit?: (value: number) => void;
  className?: string;
}

/** How close, in pixels, a dragged needle must come to a mark to snap to it. */
const SNAP_PX = 6;

/** A mark steps aside while the needle is within this many pixels of it. */
const RETRACT_PX = 5;

/** Half the needle's width in pixels. Radix insets the thumb by up to this much at the ends. */
const NEEDLE_HALF = 1;

/** The slider underneath works in thousandths of the track, whatever the values are. */
const POSITIONS = 1000;

/** How long the pointer rests on the scale before its tooltip opens: as for every tooltip. */
const TOOLTIP_DELAY_MS = 500;

/**
 * Where a value sits along the track, matching where Radix puts the needle:
 * it insets the thumb so its edge, not its centre, meets the track's ends.
 * The extra pixel to the left puts a 1 px tick under the needle's left half,
 * on the pixel grid.
 */
function positionOf(fraction: number): string {
  const inset = (1 - 2 * fraction) * NEEDLE_HALF - NEEDLE_HALF;
  return `calc(${(fraction * 100).toFixed(4)}% + ${inset.toFixed(3)}px)`;
}

/** What each key does to the needle, in steps. Shift makes an arrow ten steps. */
const KEY_STEPS: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowUp: 1,
  ArrowLeft: -1,
  ArrowDown: -1,
  PageUp: 10,
  PageDown: -10,
};

/**
 * The design system's slider: a hairline scale with a needle (DESIGN.md §7).
 *
 * Arrow keys step, Shift+arrows and the Page keys step ten times, Home and
 * End jump to the ends, and a double-click on the needle resets to the
 * default. Snapping to marks applies to dragging only, so the keyboard can
 * always reach every value, including the ones next to a mark.
 */
export function Scale({
  label,
  value,
  min,
  max,
  step = 1,
  defaultValue,
  origin,
  marks,
  divisions,
  valueText,
  disabled,
  curve,
  end,
  dimmed = false,
  tooltip,
  onChange,
  onCommit,
  className,
}: ScaleProps) {
  const onStage = useSurface() === "stage";
  const range = max - min;
  const rootRef = useRef<HTMLSpanElement>(null);
  const needleRef = useRef<HTMLSpanElement>(null);
  const source = useRef<"pointer" | "keyboard">("keyboard");

  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [rested, setRested] = useState(false);
  const restTimer = useRef<ReturnType<typeof setTimeout>>();

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const measure = () => setWidth(root.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => clearTimeout(restTimer.current), []);

  const fractionOf = (at: number): number => {
    if (curve) {
      return curve.toFraction(at);
    }
    return range > 0 ? (at - min) / range : 0;
  };
  const valueAt = (fraction: number): number =>
    curve ? curve.fromFraction(fraction) : min + fraction * range;

  /** The nearest value on the step grid, inside the range. */
  const onGrid = (raw: number): number => {
    const stepped = step > 0 ? min + Math.round((raw - min) / step) * step : raw;
    // Rounding to a step can leave a float's worth of dust: 0.30000000000000004.
    const tidy = Number(stepped.toFixed(6));
    return Math.min(max, Math.max(min, tidy));
  };

  /**
   * How close, in pixels, a dragged needle must come to `mark` from one side
   * to snap to it.
   *
   * Where steps are finer than a pixel the pointer cannot pick out a round
   * value, so the mark is a detent six pixels wide. Where a step is wider
   * than a pixel the pointer can land on every value, and a detent that wide
   * would only hide the mark's neighbours; the reach is then half a step, so
   * each value keeps its own share of the track.
   */
  function reach(mark: number, side: -1 | 1): number {
    if (step <= 0) {
      return SNAP_PX;
    }
    const neighbour = Math.min(max, Math.max(min, mark + side * step));
    const stepPx = Math.abs(fractionOf(neighbour) - fractionOf(mark)) * width;
    // "Wider than a pixel", with room for the arithmetic's last digit.
    return stepPx > 1.001 ? Math.min(SNAP_PX, stepPx / 2) : SNAP_PX;
  }

  /** A dragged needle lands on the grid, or on a mark if one is close. */
  function fromPointer(position: number): number {
    const fraction = position / POSITIONS;
    if (marks && width > 0) {
      let nearest: number | null = null;
      let distance = Number.POSITIVE_INFINITY;
      for (const mark of marks) {
        const place = fractionOf(mark.value);
        const gap = Math.abs(fraction - place) * width;
        if (gap <= reach(mark.value, fraction < place ? -1 : 1) && gap < distance) {
          nearest = mark.value;
          distance = gap;
        }
      }
      if (nearest !== null) {
        return nearest;
      }
    }
    return onGrid(valueAt(fraction));
  }

  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (disabled || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    let next: number | undefined;
    if (event.key === "Home") {
      next = min;
    } else if (event.key === "End") {
      next = end ?? max;
    } else {
      const steps = KEY_STEPS[event.key];
      if (steps !== undefined) {
        const reach = event.shiftKey && Math.abs(steps) === 1 ? steps * 10 : steps;
        next = onGrid(value + reach * step);
      }
    }
    if (next === undefined) {
      return;
    }
    // The values are ours, not the slider's thousandths: it must not move too.
    event.preventDefault();
    source.current = "keyboard";
    if (next !== value) {
      onChange(next);
      onCommit?.(next);
    }
  }

  const resting = marks?.find((mark) => mark.value === value);
  const at = fractionOf(value);
  const needle = (
    <SliderPrimitive.Thumb
      ref={needleRef}
      aria-label={label}
      // In the scale's own values, not the slider's thousandths.
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={resting?.label ?? valueText}
      onDoubleClick={() => {
        if (defaultValue !== undefined && !disabled) {
          onChange(defaultValue);
          onCommit?.(defaultValue);
        }
      }}
      className={cn(
        // The needle: 2 px wide, inside an invisible 24 x 24 px area to grab.
        // Its focus ring sits further out than usual because it is so thin.
        "relative block h-3.5 w-0.5 rounded-xs outline-offset-4 transition-colors duration-fast ease-out",
        "before:absolute before:-inset-x-[11px] before:-inset-y-[5px] before:content-['']",
        dimmed ? (onStage ? "bg-stage-ink-2" : "bg-ink-3") : "needle",
        onStage && dimmed && "shadow-[0_0_0_1px_var(--stage-edge)]",
      )}
    />
  );

  return (
    <SliderPrimitive.Root
      ref={rootRef}
      min={0}
      max={POSITIONS}
      step={1}
      value={[Math.round(at * POSITIONS)]}
      disabled={disabled}
      onPointerDown={() => {
        source.current = "pointer";
        setDragging(true);
      }}
      onPointerUp={() => {
        setDragging(false);
        // A control used with the pointer does not keep keyboard focus, so the
        // arrow keys go back to the player (DESIGN.md §8).
        needleRef.current?.blur();
      }}
      onPointerCancel={() => setDragging(false)}
      onPointerEnter={() => {
        clearTimeout(restTimer.current);
        restTimer.current = setTimeout(() => setRested(true), TOOLTIP_DELAY_MS);
      }}
      onPointerLeave={() => {
        clearTimeout(restTimer.current);
        setRested(false);
      }}
      onKeyDown={onKeyDown}
      onValueChange={([next]) => {
        if (next !== undefined && source.current === "pointer") {
          onChange(fromPointer(next));
        }
      }}
      onValueCommit={([next]) => {
        if (next !== undefined && source.current === "pointer") {
          onCommit?.(fromPointer(next));
        }
      }}
      className={cn(
        "group/scale relative flex h-6 w-full min-w-0 touch-none select-none items-center",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
        className,
      )}
    >
      <SliderPrimitive.Track
        className={cn(
          "relative h-0.5 w-full grow rounded-full",
          "origin-center transition-transform duration-fast ease-out group-hover/scale:scale-y-[2] motion-reduce:transition-none",
          onStage ? "bg-stage-track shadow-[0_0_0_1px_var(--stage-edge)]" : "bg-line-strong",
        )}
      >
        {origin === undefined ? (
          <SliderPrimitive.Range
            className={cn(
              "absolute h-full rounded-full transition-opacity duration-fast ease-out",
              onStage ? "bg-stage-ink" : "bg-ink-1",
              dimmed && "opacity-0",
            )}
          />
        ) : (
          <span
            aria-hidden="true"
            data-level=""
            className={cn(
              "absolute h-full rounded-full transition-opacity duration-fast ease-out",
              onStage ? "bg-stage-ink" : "bg-ink-1",
              dimmed && "opacity-0",
            )}
            style={{
              left: positionOf(Math.min(at, fractionOf(origin))),
              right: `calc(100% - ${positionOf(Math.max(at, fractionOf(origin)))})`,
            }}
          />
        )}
      </SliderPrimitive.Track>

      {/* Graduations and marks stand on the track, as in the brand mark. */}
      {divisions && divisions > 1
        ? Array.from({ length: divisions + 1 }, (_, index) => index / divisions).map((fraction) => (
            <span
              key={fraction}
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute bottom-1/2 mb-px h-[3px] w-px",
                onStage ? "bg-stage-track" : "bg-line-strong",
              )}
              style={{ left: positionOf(fraction) }}
            />
          ))
        : null}
      {marks?.map((mark) => {
        const place = fractionOf(mark.value);
        // The needle is about to stand on it: the mark steps aside, so the two
        // never fuse into one shape.
        const crowded = width > 0 && Math.abs(at - place) * width < RETRACT_PX;
        return (
          <span
            key={mark.value}
            aria-hidden="true"
            data-mark=""
            className={cn(
              "pointer-events-none absolute bottom-1/2 mb-px h-1.5 w-px transition-opacity duration-fast ease-out",
              onStage ? "bg-stage-ink-2 shadow-[0_0_0_1px_var(--stage-edge)]" : "bg-ink-2",
              crowded && "opacity-0",
            )}
            style={{ left: positionOf(place) }}
          />
        );
      })}

      {tooltip ? (
        <NeedleTooltip {...tooltip} held={dragging || rested}>
          {needle}
        </NeedleTooltip>
      ) : (
        needle
      )}
    </SliderPrimitive.Root>
  );
}

function NeedleTooltip({
  label,
  shortcut,
  offset,
  held,
  children,
}: NonNullable<ScaleProps["tooltip"]> & { held: boolean; children: ReactElement }) {
  const tip = (
    <Tooltip label={label} shortcut={shortcut} held={held}>
      {children}
    </Tooltip>
  );
  return offset === undefined ? tip : <TooltipOffset value={offset}>{tip}</TooltipOffset>;
}

export interface ScaleRowProps extends Omit<ScaleProps, "className"> {
  /** The value as shown at the end of the row, e.g. "+6 dB". */
  display: string;
  className?: string;
}

/**
 * A labelled scale for panels: name, scale, value. The name and the value
 * keep their widths and never wrap; only the scale stretches. The value is
 * in full ink while it differs from the scale's neutral (its `defaultValue`)
 * and steps back when it does not, so a column of them shows at a glance
 * which have been touched (DESIGN.md §7).
 */
export function ScaleRow({ display, className, ...scale }: ScaleRowProps) {
  const neutral = scale.defaultValue !== undefined && scale.value === scale.defaultValue;
  return (
    <div className={cn("flex h-8 min-w-0 items-center gap-3", className)}>
      <span className="w-28 flex-none truncate text-body text-ink-2">{scale.label}</span>
      <Scale {...scale} className="min-w-0 flex-1" />
      <span
        data-reading=""
        className={cn(
          "tabular w-14 flex-none whitespace-nowrap text-right text-body transition-colors duration-fast ease-out",
          neutral ? "text-ink-3" : "text-ink-1",
        )}
      >
        {display}
      </span>
    </div>
  );
}
