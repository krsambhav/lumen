import { useEffect, useState } from "react";
import { commands } from "@/ipc";
import { usePlayer } from "./store";

/** A film is cut into about this many stills: one for every few pixels of timeline. */
const STILLS_PER_FILM = 300;
/** How many are kept. A hover rarely revisits more than the last few places. */
const KEPT = 80;

/** Stills of the open film, by place; forgotten when another film opens. */
let stills = new Map<number, string>();
let stillsOf: string | null = null;
/** The file has shown that it has no stills to give (no FFmpeg, no picture). */
let none = false;
let busy = false;
/** The place most recently wanted while a still was being fetched. */
let waiting: { place: number; seconds: number } | null = null;
const listeners = new Set<() => void>();

function forget(source: string | null) {
  stills = new Map();
  stillsOf = source;
  none = false;
  waiting = null;
}

function keep(place: number, url: string) {
  stills.delete(place);
  stills.set(place, url);
  // The oldest go first: a Map remembers the order things were put in.
  for (const oldest of stills.keys()) {
    if (stills.size <= KEPT) {
      break;
    }
    stills.delete(oldest);
  }
}

function fetchStill(source: string, place: number, seconds: number) {
  if (busy) {
    // One at a time: only the place wanted last is worth fetching next.
    waiting = { place, seconds };
    return;
  }
  busy = true;
  void commands
    .playerPreviewFrame(seconds)
    .catch(() => null)
    .then((result) => {
      busy = false;
      if (stillsOf !== source) {
        return;
      }
      if (result?.status === "ok" && result.data !== null) {
        keep(place, result.data);
      } else {
        // Nothing to show for this file; do not ask for every pixel of it.
        none = true;
        waiting = null;
      }
      for (const listener of listeners) {
        listener();
      }
      const next = waiting;
      waiting = null;
      if (next && !stills.has(next.place)) {
        fetchStill(source, next.place, next.seconds);
      }
    });
}

export interface Preview {
  /**
   * A still is to be expected for this film: it has a picture and is a file
   * on this Mac. The loupe keeps room for it from the start, so it does not
   * change size when the still arrives (DESIGN.md §7).
   */
  expected: boolean;
  /** The still nearest to the time asked for that has arrived so far. */
  url: string | null;
}

/**
 * A small still of the open film near `seconds`, for the timeline's loupe.
 * `null` asks for nothing. While the still for a new place is on its way the
 * last one stays, so the loupe never blinks.
 */
export function usePreview(seconds: number | null): Preview {
  const source = usePlayer((state) => state.source);
  const duration = usePlayer((state) => state.duration);
  const hasPicture = usePlayer((state) => state.video !== null);
  const [, redraw] = useState(0);
  // The last still shown, and which film it was of.
  const [last, setLast] = useState<{ of: string | null; url: string } | null>(null);

  if (stillsOf !== source) {
    forget(source);
  }

  useEffect(() => {
    const listener = () => redraw((count) => count + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const possible =
    source !== null && !source.includes("://") && hasPicture && duration !== null && duration > 0;
  const expected = possible && !none;
  const step = duration === null ? 1 : Math.max(1, duration / STILLS_PER_FILM);
  const place = seconds === null ? null : Math.round(seconds / step);
  const have = place === null ? undefined : stills.get(place);

  useEffect(() => {
    if (expected && source !== null && place !== null && have === undefined) {
      fetchStill(source, place, place * step);
    }
  }, [expected, source, place, step, have]);

  // Remember the last still shown, to stand in while the next one arrives.
  useEffect(() => {
    if (have !== undefined) {
      setLast({ of: source, url: have });
    }
  }, [have, source]);
  const standIn = last?.of === source ? last.url : null;

  return { expected, url: expected ? (have ?? standIn) : null };
}

/** Forgets every still. For tests. */
export function resetPreviews(): void {
  forget(null);
  busy = false;
}
