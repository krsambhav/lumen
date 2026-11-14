import { runAction } from "@/actions/registry";
import { commands, events, type Scrolled, type Subscription, subscription } from "@/ipc";
import { send } from "@/lib/notify";
import { formatTimecode } from "@/lib/timecode";
import { type OsdMessage, showOsd } from "./osd";
import { currentPosition, usePlayer } from "./store";

/** How far fingers travel, in points, before a gesture is taken to be along one axis. */
export const DECIDE_PX = 6;
/** Travel for one step of the volume. */
export const VOLUME_STEP_PX = 14;
/** Seconds of film for each point of sideways travel. */
export const SEEK_SECONDS_PER_PX = 0.12;
/** While fingers move sideways, a seek is sent at most this often. */
const SEEK_EVERY_MS = 33;
/** A gesture stops this far short of the end, so scrolling never ends the film. */
const STOPS_SHORT = 1;

/** What a scroll gesture is allowed to do. Passed in, so the gesture can be tested without the app. */
export interface ScrollDeps {
  /** Whether a point of the window, in points from its top-left corner, is on the bare picture. */
  overPicture: (x: number, y: number) => boolean;
  /** One step of the volume, up or down. */
  volume: (direction: 1 | -1) => void;
  /** One step through the film, for a wheel turned sideways. */
  step: (direction: 1 | -1) => void;
  position: () => number;
  /** The film's length, or `null` if it cannot be moved through. */
  duration: () => number | null;
  /** A quick, approximate seek while the fingers are still moving. */
  seekRoughly: (seconds: number) => void;
  /** The exact seek, once they have lifted. */
  seekExactly: (seconds: number) => void;
  say: (message: OsdMessage) => void;
  now: () => number;
}

interface Gesture {
  onPicture: boolean;
  axis: "x" | "y" | null;
  right: number;
  up: number;
  /** Volume steps already taken. */
  steps: number;
  /** Where the film was when the fingers began to move sideways. */
  from: number;
  target: number | null;
  sought: number;
}

/**
 * Turns scrolling over the picture into volume (up and down) and seeking
 * (sideways). A gesture is one or the other, decided by which way the
 * fingers first travel, so a slightly crooked swipe up never seeks.
 */
export function createScrollHandler(deps: ScrollDeps): (event: Scrolled) => void {
  let gesture: Gesture | null = null;

  function begin(event: Scrolled): Gesture {
    return {
      onPicture: deps.overPicture(event.x, event.y),
      axis: null,
      right: 0,
      up: 0,
      steps: 0,
      from: deps.position(),
      target: null,
      sought: Number.NEGATIVE_INFINITY,
    };
  }

  function sideways(current: Gesture) {
    const duration = deps.duration();
    if (duration === null) {
      return;
    }
    const wanted = current.from + current.right * SEEK_SECONDS_PER_PX;
    const target = Math.min(Math.max(0, duration - STOPS_SHORT), Math.max(0, wanted));
    current.target = target;
    const moved = Math.round(Math.abs(target - current.from));
    deps.say({
      label: `${target >= current.from ? "Forward" : "Back"} ${moved} s`,
      value: formatTimecode(target, duration),
    });
    if (deps.now() - current.sought >= SEEK_EVERY_MS) {
      current.sought = deps.now();
      deps.seekRoughly(target);
    }
  }

  return (event) => {
    if (!event.precise) {
      // A wheel turns in notches and has no beginning or end: each notch
      // is one step, wherever the pointer is at that moment.
      if (event.phase !== "ended" && deps.overPicture(event.x, event.y)) {
        if (event.up !== 0) {
          deps.volume(event.up > 0 ? 1 : -1);
        } else if (event.right !== 0 && deps.duration() !== null) {
          deps.step(event.right > 0 ? 1 : -1);
        }
      }
      return;
    }

    if (event.phase === "began" || gesture === null) {
      gesture = begin(event);
    }
    const current = gesture;
    if (event.phase === "ended") {
      gesture = null;
      if (current.onPicture && current.axis === "x" && current.target !== null) {
        deps.seekExactly(current.target);
      }
      return;
    }
    if (!current.onPicture) {
      return;
    }
    current.right += event.right;
    current.up += event.up;
    if (current.axis === null) {
      const far = Math.max(Math.abs(current.right), Math.abs(current.up));
      if (far < DECIDE_PX) {
        return;
      }
      current.axis = Math.abs(current.up) >= Math.abs(current.right) ? "y" : "x";
    }
    if (current.axis === "y") {
      const steps = Math.trunc(current.up / VOLUME_STEP_PX);
      for (; current.steps < steps; current.steps += 1) {
        deps.volume(1);
      }
      for (; current.steps > steps; current.steps -= 1) {
        deps.volume(-1);
      }
    } else {
      sideways(current);
    }
  };
}

/** True if the point is on the bare picture: not on a control, a panel or anything open over it. */
function overPicture(x: number, y: number): boolean {
  return document.elementFromPoint(x, y)?.closest("[data-picture]") != null;
}

/**
 * Scrolling over the picture: up and down for the volume, sideways to move
 * through the film (DESIGN.md §8). The backend reports the scrolling, with
 * the glide after the fingers lift left out.
 */
export function connectScrollGestures(): Subscription {
  const handle = createScrollHandler({
    overPicture,
    volume: (direction) =>
      void runAction(direction > 0 ? "audio.volumeUp" : "audio.volumeDown", "pointer"),
    step: (direction) =>
      void runAction(direction > 0 ? "playback.forward" : "playback.back", "pointer"),
    position: () => currentPosition(usePlayer.getState()),
    duration: () => usePlayer.getState().duration,
    seekRoughly: (seconds) => send("seek", commands.playerSeekTo(seconds, false)),
    seekExactly: (seconds) => {
      usePlayer.setState({ position: seconds, positionAt: performance.now() });
      send("seek", commands.playerSeekTo(seconds, true));
    },
    say: showOsd,
    now: () => performance.now(),
  });
  return subscription(events.scrolled.listen((event) => handle(event.payload)));
}
