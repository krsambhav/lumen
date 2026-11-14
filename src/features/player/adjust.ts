import { type CommandResult, commands, type PlayerChange, type Shape } from "@/ipc";
import { notifyFailure } from "@/lib/notify";
import { gateChanges, usePlayer } from "./store";

/*
 * Values of the open file that a scale can drag: how the picture is shaped,
 * how far the sound and the subtitles are moved against it.
 *
 * Asked for many times a second, they are shown at once and sent one at a
 * time, with only the newest waiting to go next: sent all together they
 * could be taken in any order, and the last handled, not the last asked
 * for, would be what stayed. What the player says meanwhile is its answer
 * to an older request; it is kept, and shown only if nothing newer was
 * asked for by the time everything has been answered.
 */

interface Wanted<T> {
  /** Shows `value` at once and has the player told. */
  want: (value: T) => void;
}

function wanted<T>(options: {
  /** The kind of change the player reports this value with. */
  type: PlayerChange["type"];
  /** The value in such a change. */
  from: (change: PlayerChange) => T | undefined;
  show: (value: T) => void;
  send: (value: T) => Promise<CommandResult<unknown>>;
  /** Completes "Lumen could not …" if the player refuses. */
  what: string;
}): Wanted<T> {
  let sending = false;
  let waiting: { value: T } | null = null;
  let heard: { value: T } | null = null;

  function pump(value: T): void {
    sending = true;
    void options
      .send(value)
      .then(
        (result) => result,
        (): CommandResult<unknown> => ({
          status: "error",
          error: { kind: "internal", message: "the player did not answer" },
        }),
      )
      .then((result) => {
        sending = false;
        const next = waiting;
        waiting = null;
        if (result.status === "error") {
          notifyFailure(options.what, result.error);
          // What is shown is what was asked for, not what is so: ask.
          heard = null;
          if (next === null) {
            void commands
              .playerSnapshot()
              .then((snapshot) => usePlayer.getState().reset(snapshot))
              .catch(() => {});
            return;
          }
        }
        if (next !== null) {
          pump(next.value);
          return;
        }
        // Everything asked for has been answered: the player's last word stands.
        const said = heard;
        heard = null;
        if (said !== null) {
          options.show(said.value);
        }
      });
  }

  gateChanges(options.type, (change) => {
    if (!sending && waiting === null) {
      return true;
    }
    const value = options.from(change);
    if (value !== undefined) {
      heard = { value };
    }
    return false;
  });

  return {
    want: (value) => {
      options.show(value);
      if (sending) {
        waiting = { value };
      } else {
        pump(value);
      }
    },
  };
}

const shape = wanted<Shape>({
  type: "shape",
  from: (change) => (change.type === "shape" ? change.shape : undefined),
  show: (value) => usePlayer.setState({ shape: value }),
  send: (value) => commands.playerSetShape(value),
  what: "change the picture’s shape",
});

const audioDelay = wanted<number>({
  type: "audioDelay",
  from: (change) => (change.type === "audioDelay" ? change.seconds : undefined),
  show: (value) => usePlayer.setState({ audioDelay: value }),
  send: (value) => commands.playerSetAudioDelay(value),
  what: "move the sound",
});

const subtitleDelay = wanted<number>({
  type: "subtitleDelay",
  from: (change) => (change.type === "subtitleDelay" ? change.seconds : undefined),
  show: (value) => usePlayer.setState({ subtitleDelay: value }),
  send: (value) => commands.playerSetSubtitleDelay(value),
  what: "move the subtitles",
});

/** The furthest sound or subtitles can be moved against the picture, in seconds: `MAX_DELAY` in the backend. */
export const MAX_DELAY = 30;

/**
 * The furthest subtitles can be moved, in seconds: `MAX_SUBTITLE_DELAY` in
 * the backend. Further than sound, since a subtitle file made for another
 * release of a film can be a minute or more out.
 */
export const MAX_SUBTITLE_DELAY = 600;

function withinDelay(seconds: number, reach = MAX_DELAY): number {
  // Whole milliseconds, as the backend keeps them.
  return Math.round(Math.min(reach, Math.max(-reach, seconds)) * 1000) / 1000;
}

/** Turns, cuts or stretches the picture of the open file. */
export function setShape(next: Shape): void {
  shape.want(next);
}

/** Plays the sound this much later than the picture; negative, earlier. */
export function setAudioDelay(seconds: number): void {
  audioDelay.want(withinDelay(seconds));
}

/** Shows subtitles this much later than they are timed; negative, earlier. */
export function setSubtitleDelay(seconds: number): void {
  subtitleDelay.want(withinDelay(seconds, MAX_SUBTITLE_DELAY));
}

/** A delay as it is read: "+120 ms", "−1.25 s", "0 ms". The minus is a real minus. */
export function delayText(seconds: number): string {
  const sign = seconds > 0 ? "+" : seconds < 0 ? "−" : "";
  const size = Math.abs(seconds);
  if (size < 1) {
    return `${sign}${Math.round(size * 1000)} ms`;
  }
  // No more decimals than it has: "1 s", "1.5 s", "1.25 s".
  return `${sign}${Number(size.toFixed(2))} s`;
}

/** A delay in words: "120 milliseconds later", "1.25 seconds earlier", "no delay". */
export function delaySpoken(seconds: number): string {
  if (seconds === 0) {
    return "no delay";
  }
  const size = Math.abs(seconds);
  const amount =
    size < 1
      ? `${Math.round(size * 1000)} milliseconds`
      : `${Number(size.toFixed(2))} ${size === 1 ? "second" : "seconds"}`;
  return `${amount} ${seconds > 0 ? "later" : "earlier"}`;
}
