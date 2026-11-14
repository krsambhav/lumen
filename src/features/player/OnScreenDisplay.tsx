import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { cn } from "@/lib/cn";
import { useOsd } from "./osd";

/**
 * The on-screen display (DESIGN.md §7): one line at the top right confirming
 * a change, large enough to read from across a room. It appears without the
 * rest of the chrome and does not dim the picture: its letters and its scale
 * are outlined instead, the way subtitles are.
 */
export function OnScreenDisplay() {
  const message = useOsd((state) => state.message);
  const visible = useOsd((state) => state.visible);
  return (
    // Always in the tree so assistive technology hears changes; empty when idle.
    <div
      data-osd=""
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none absolute inset-0 z-chrome"
    >
      {message ? (
        // Not keyed by message: the next one replaces this one in place, so
        // holding a key down never restarts the fade.
        <div
          className={cn(
            // Below the title bar's line, so it never meets the title.
            "absolute right-gutter top-[calc(var(--titlebar-h)+0.25rem)]",
            // The type size is set here so the scale, sized in ems, follows it.
            "flex max-w-[calc(100%-2*var(--gutter))] flex-col items-end gap-[0.4em] text-osd",
            // It answers a key press, so it arrives at `fast`; it leaves at `base` (DESIGN.md §5).
            "animate-fade-in [animation-duration:var(--dur-fast)] transition-opacity duration-base ease-out",
            !visible && "opacity-0",
          )}
        >
          <p className="outlined-text tabular flex min-w-0 max-w-full items-baseline gap-[0.6em] whitespace-nowrap text-stage-ink">
            {/*
              A long label gives way in a narrow window, in the middle, with
              an ellipsis that is text like the rest: one the engine draws
              for itself gets no outline, and is lost over a bright picture.
              The padding is room for the outline and shadow inside the clip.
            */}
            <MiddleTruncate text={message.label} untouchable className="-m-[0.8em] p-[0.8em]" />
            {message.value ? <span className="flex-none">{message.value}</span> : null}
          </p>
          {message.scale ? <OsdScale {...message.scale} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** The scale's drawing, in its own units: 192 by 14, like a Scale in a panel. */
const WIDTH = 192;
const HEIGHT = 14;
const NEEDLE = 2;
/** How far the outline stands off each shape: half the letters' stroke, in these units. */
const OUTLINE = 1;
/** The mark steps aside while the needle is within this many units of it. */
const RETRACT = 5;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rounded bar, optionally grown on every side to make its outline. */
function bar({ x, y, width, height }: Rect, grow: number) {
  return {
    x: x - grow,
    y: y - grow,
    width: width + 2 * grow,
    height: height + 2 * grow,
    rx: Math.min(width, height) / 2 + grow,
  };
}

/**
 * A range, drawn for viewing over any picture. Over a bright one the played
 * and unplayed parts are both simply light, so the level is also told by
 * thickness: the part up to the needle is twice as thick.
 *
 * Every shape is drawn twice: once grown by the outline's width in void,
 * all of those beneath, then once in its own colour, so no outline ever
 * crosses another shape.
 */
function OsdScale({ at, mark }: { at: number; mark?: number }) {
  const fraction = Math.min(1, Math.max(0, at));
  const travel = WIDTH - NEEDLE;
  const glide = "transition-transform duration-fast ease-out motion-reduce:transition-none";
  const middle = HEIGHT / 2;

  const range: Rect = { x: 0, y: middle - 1, width: WIDTH, height: 2 };
  const level: Rect = { x: 0, y: middle - 2, width: WIDTH, height: 4 };
  const needle: Rect = { x: 0, y: 0, width: NEEDLE, height: HEIGHT };
  // The needle is about to stand on the mark: it steps aside, so the two
  // never fuse into one shape.
  const crowded = mark !== undefined && Math.abs(fraction - mark) * travel < RETRACT;
  const tick: Rect | null =
    mark !== undefined && !crowded
      ? { x: mark * travel + NEEDLE / 2 - 0.5, y: 1, width: 1, height: middle - 2 }
      : null;

  const layer = (grow: number, colours: { line: string; needle: string }) => (
    <>
      {tick ? <rect {...bar(tick, grow)} rx={grow} className={colours.line} /> : null}
      <rect {...bar(range, grow)} className={colours.line} />
      <rect
        data-part={grow > 0 ? undefined : "level"}
        {...bar(level, grow)}
        className={cn(colours.line, glide)}
        // Scaled from the left edge of the drawing, which is where it starts.
        style={{ transform: `scaleX(${fraction})`, transformOrigin: "0 0" }}
      />
      <rect
        data-part={grow > 0 ? undefined : "needle"}
        {...bar(needle, grow)}
        className={cn(colours.needle, glide)}
        style={{ transform: `translateX(${fraction * travel}px)` }}
      />
    </>
  );

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      // 9.6em by 0.7em: 192 by 14 px at the smallest type size.
      className="outlined-shape h-[0.7em] w-[9.6em] flex-none overflow-visible"
    >
      {layer(OUTLINE, { line: "fill-void", needle: "fill-void" })}
      {layer(0, { line: "fill-stage-ink", needle: "fill-accent" })}
    </svg>
  );
}
