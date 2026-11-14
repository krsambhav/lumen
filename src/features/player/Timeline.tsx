import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { commands } from "@/ipc";
import { cn } from "@/lib/cn";
import { send } from "@/lib/notify";
import { spokenPosition, wholeSecond } from "@/lib/timecode";
import { chapterIndexAt, chapterName } from "./chapters";
import { useChromeHold } from "./chrome";
import { usePreview } from "./preview";
import { currentPosition, usePlayer } from "./store";
import { Timecode } from "./Timecode";

/** While dragging, keyframe seeks are sent at most this often. */
const SCRUB_INTERVAL_MS = 33;

/** Seconds an arrow key moves; Shift and the Page keys move a minute. */
const ARROW_STEP = 5;
const LONG_STEP = 60;

/**
 * While the needle is being dragged it stops this far short of the end, in
 * seconds, so that reaching the end of the track does not end the film (and
 * start the next one) with the button still down. Letting go at the end goes
 * to within the second figure of it, which then plays out.
 */
const DRAG_STOPS_SHORT = 1;
const RELEASE_STOPS_SHORT = 0.25;

/**
 * The loupe with a still or a chapter's name in it is this wide: a 192 px
 * still, 4 px each side of it, and the hairline border around the two.
 */
const LOUPE_REM = 12.625;

/**
 * The keys the timeline takes when it has keyboard focus. Not the vertical
 * arrows: they mean volume everywhere (DESIGN.md §8).
 */
const OWN_KEYS = "Left Right Home End PageUp PageDown";

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * The seek bar: a bare scale across the stage with the needle at the current
 * position (DESIGN.md §7).
 *
 * The needle and the played portion are moved by an animation-frame loop
 * that writes transforms directly, so playback never re-renders React and
 * the needle glides between the ten position reports a second.
 */
export function Timeline() {
  const duration = usePlayer((state) => state.duration);
  // Whole seconds only: this drives the accessible value, not the needle.
  const second = usePlayer((state) => wholeSecond(state.position));
  const chapters = usePlayer((state) => state.chapters);
  const shape = usePlayer((state) =>
    state.video ? state.video.width / Math.max(1, state.video.height) : 16 / 9,
  );
  const seekable = duration !== null && duration > 0;

  const rootRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const needleRef = useRef<HTMLDivElement>(null);
  /** The fraction under the pointer while dragging; overrides the real position. */
  const scrub = useRef<number | null>(null);
  const kick = useRef<() => void>(() => {});

  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState<{ x: number; width: number; seconds: number } | null>(null);
  useChromeHold("timeline", dragging);

  useEffect(() => {
    const root = rootRef.current;
    const fill = fillRef.current;
    const needle = needleRef.current;
    if (!root || !fill || !needle) {
      return;
    }
    let width = root.clientWidth;
    let frame = 0;
    let stopped = false;

    const paint = () => {
      frame = 0;
      const state = usePlayer.getState();
      const length = state.duration ?? 0;
      const fraction =
        scrub.current ?? (length > 0 ? clamp(currentPosition(state) / length, 0, 1) : 0);
      fill.style.transform = `scaleX(${fraction})`;
      // The needle is 2 px wide; keep it inside the track at both ends.
      needle.style.transform = `translate3d(${fraction * (width - 2)}px, -50%, 0)`;
      if (!stopped && (state.status === "playing" || scrub.current !== null)) {
        frame = requestAnimationFrame(paint);
      }
    };
    const start = () => {
      if (frame === 0 && !stopped) {
        frame = requestAnimationFrame(paint);
      }
    };
    kick.current = start;

    const unsubscribe = usePlayer.subscribe(start);
    const observer = new ResizeObserver(() => {
      width = root.clientWidth;
      start();
    });
    observer.observe(root);
    // Paint once now: a hidden window gets no animation frames.
    paint();

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      unsubscribe();
      observer.disconnect();
    };
  }, []);

  // Seeks while dragging: the latest target wins, and they are spaced out.
  const pending = useRef<number | null>(null);
  const lastSent = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  function sendScrub() {
    const target = pending.current;
    if (target === null) {
      return;
    }
    pending.current = null;
    lastSent.current = performance.now();
    send("seek", commands.playerSeekTo(target, false));
  }

  function requestScrub(seconds: number) {
    pending.current = seconds;
    const wait = SCRUB_INTERVAL_MS - (performance.now() - lastSent.current);
    clearTimeout(timer.current);
    if (wait <= 0) {
      sendScrub();
    } else {
      timer.current = setTimeout(sendScrub, wait);
    }
  }

  useEffect(() => () => clearTimeout(timer.current), []);

  function locate(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left, 0, rect.width);
    const fraction = rect.width > 0 ? x / rect.width : 0;
    return { x, width: rect.width, fraction, seconds: fraction * (duration ?? 0) };
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!seekable || event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = locate(event);
    scrub.current = at.fraction;
    setDragging(true);
    requestScrub(Math.min(at.seconds, Math.max(0, (duration ?? 0) - DRAG_STOPS_SHORT)));
    kick.current();
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!seekable) {
      return;
    }
    const at = locate(event);
    setHover({ x: at.x, width: at.width, seconds: at.seconds });
    if (scrub.current !== null) {
      scrub.current = at.fraction;
      requestScrub(Math.min(at.seconds, Math.max(0, (duration ?? 0) - DRAG_STOPS_SHORT)));
    }
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (scrub.current === null) {
      return;
    }
    const at = locate(event);
    clearTimeout(timer.current);
    pending.current = null;
    const landing = Math.min(at.seconds, Math.max(0, (duration ?? 0) - RELEASE_STOPS_SHORT));
    // Land exactly on the frame, and move the needle there now so it does
    // not jump back while the seek completes.
    usePlayer.setState({ position: landing, positionAt: performance.now() });
    send("seek", commands.playerSeekTo(landing, true));
    scrub.current = null;
    setDragging(false);
    kick.current();
    // Used with the pointer: give the keyboard back to the player.
    event.currentTarget.blur();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!seekable || duration === null || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const now = currentPosition(usePlayer.getState());
    const step = event.shiftKey ? LONG_STEP : ARROW_STEP;
    const targets: Record<string, number> = {
      ArrowLeft: now - step,
      ArrowRight: now + step,
      PageDown: now - LONG_STEP,
      PageUp: now + LONG_STEP,
      Home: 0,
      End: duration,
    };
    const target = targets[event.key];
    if (target === undefined) {
      return;
    }
    event.preventDefault();
    send("seek", commands.playerSeekTo(clamp(target, 0, duration), true));
  }

  // While the needle is dragged the picture itself follows it; the loupe
  // then shows no still (DESIGN.md §7).
  const preview = usePreview(hover && seekable && !dragging ? hover.seconds : null);
  const over = hover ? chapterIndexAt(chapters, hover.seconds) : -1;
  const chapter = over >= 0 ? chapters[over] : undefined;
  const named = chapters.length > 0 && chapter !== undefined;
  const still = preview.expected && !dragging;
  const wide = still || named;
  // The timecode alone is as wide as its longest reading; with a still or a
  // chapter's name the loupe has one fixed width. Either way it can be kept
  // inside the track with nothing measured: half its width at each end.
  const half = wide ? LOUPE_REM / 2 : (duration ?? 0) >= 3600 ? 1.875 : 1.5;
  // A still as wide as the loupe allows, and no taller than it is wide.
  const stillHeight = Math.min(192, Math.round(192 / shape));

  return (
    <div
      ref={rootRef}
      role="slider"
      // A timeline that cannot seek is not somewhere Tab should stop.
      tabIndex={seekable ? 0 : -1}
      aria-label="Position"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration ?? 0)}
      aria-valuenow={second}
      aria-valuetext={spokenPosition(second, duration)}
      aria-disabled={!seekable || undefined}
      data-own-keys={OWN_KEYS}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKeyDown}
      className={cn(
        // With keyboard focus the ring is drawn on the needle: see styles.css.
        "ring-on-needle group/timeline relative h-6 w-full touch-none select-none",
        seekable ? "cursor-pointer" : "cursor-default",
      )}
    >
      <div
        className={cn(
          "absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 overflow-hidden rounded-full bg-stage-track",
          // Outlined, so the track is drawn over any picture without leaning on the scrim.
          "shadow-[0_0_0_1px_var(--stage-edge)]",
          "origin-center transition-transform duration-fast ease-out motion-reduce:transition-none",
          seekable && "group-hover/timeline:scale-y-[2]",
          dragging && "scale-y-[2]",
        )}
      >
        <div ref={fillRef} className="h-full w-full origin-left scale-x-0 bg-stage-ink" />
        {/*
          Chapters are gaps in the track (DESIGN.md §7): 2 px of the outline's
          own colour where each one starts, so the line reads as cut there
          over any picture. They are inside the track, and thicken with it.
        */}
        {seekable
          ? chapters.map((each, index) =>
              each.time <= 0.5 || each.time >= (duration ?? 0) - 0.5 ? null : (
                <span
                  // Chapters do not move within a film.
                  // biome-ignore lint/suspicious/noArrayIndexKey: static list
                  key={index}
                  aria-hidden="true"
                  data-chapter-gap=""
                  className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-[var(--stage-edge)]"
                  style={{ left: `${(each.time / (duration ?? 1)) * 100}%` }}
                />
              ),
            )
          : null}
      </div>
      {hover && seekable && !dragging ? (
        // A hairline under the pointer: where a click will land.
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-stage-ink shadow-[0_0_0_1px_var(--stage-edge)]"
          style={{ left: clamp(Math.round(hover.x), 0, Math.max(0, hover.width - 1)) }}
        />
      ) : null}
      <div
        ref={needleRef}
        aria-hidden="true"
        data-needle=""
        className={cn(
          "needle pointer-events-none absolute left-0 top-1/2 h-3.5 w-0.5 rounded-xs",
          !seekable && "opacity-0",
        )}
      />
      {hover && seekable ? (
        // The loupe: a still of the film there, the time, and the chapter.
        <div
          aria-hidden="true"
          data-loupe=""
          className={cn(
            "pointer-events-none absolute bottom-full mb-1 flex -translate-x-1/2 flex-col items-stretch rounded-sm border border-line bg-surface-2 text-caption text-ink-1 shadow-pop",
            wide
              ? "w-[12.625rem] gap-1 p-1"
              : cn("px-2 py-1", half > 1.5 ? "min-w-[3.75rem]" : "min-w-[3rem]"),
          )}
          // Kept inside the track at both ends, so it never runs off the window.
          style={{ left: `clamp(${half}rem, ${hover.x}px, calc(100% - ${half}rem))` }}
        >
          {still ? (
            // Its room is kept from the start, so the loupe does not grow when the still arrives.
            <div
              className="w-full flex-none overflow-hidden rounded-xs bg-void"
              style={{ height: stillHeight }}
            >
              {preview.url ? (
                <img
                  src={preview.url}
                  alt=""
                  draggable={false}
                  className="size-full object-cover"
                />
              ) : null}
            </div>
          ) : null}
          <div
            className={cn("flex min-w-0 items-baseline gap-2", wide ? "px-1" : "justify-center")}
          >
            <Timecode seconds={hover.seconds} span={duration ?? 0} className="flex-none" />
            {named ? (
              <span className="min-w-0 truncate text-ink-2">{chapterName(chapter, over)}</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
