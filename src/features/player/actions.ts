import {
  ChevronFirst,
  ChevronLast,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  FastForward,
  Gauge,
  Maximize,
  Minimize,
  Pin,
  Play,
  Rewind,
  SkipBack,
  Square,
  StepBack,
  StepForward,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { Action, ActionContext } from "@/actions/registry";
import { usePalette } from "@/features/palette/store";
import { commands, type PlaybackStatus } from "@/ipc";
import { send } from "@/lib/notify";
import { formatTimecode } from "@/lib/timecode";
import { chapterName, nextChapter, previousChapter, skippableAt } from "./chapters";
import { type OsdMessage, showOsd, useOsd } from "./osd";
import { formatSpeed, isNormalSpeed, NORMAL_SPEED, SPEEDS, stepSpeed } from "./speed";
import { currentPosition, hasMedia, usePlayer, wantVolume } from "./store";
import { formatVolume, NORMAL_VOLUME, stepVolume, volumeToFraction } from "./volume";
import { useWindowState } from "./window";

export const NOTHING_OPEN = "Nothing is open";

export function needsMedia(): string | undefined {
  return hasMedia(usePlayer.getState()) ? undefined : NOTHING_OPEN;
}

/** Needs something open whose length is known, so that there is somewhere to go in it. */
function needsSeekable(): string | undefined {
  const state = usePlayer.getState();
  if (!hasMedia(state)) {
    return NOTHING_OPEN;
  }
  return state.duration === null ? "This cannot be moved through" : undefined;
}

function needsChapters(): string | undefined {
  const state = usePlayer.getState();
  if (!hasMedia(state)) {
    return NOTHING_OPEN;
  }
  return state.chapters.length === 0 ? "This has no chapters" : undefined;
}

/**
 * Confirms a change on the on-screen display, unless it was made with a
 * control, which shows the new state itself (DESIGN.md §7). A control also
 * clears whatever the display was saying, which its change has just made
 * out of date.
 */
export function confirm(context: ActionContext, message: OsdMessage) {
  if (context.source === "control") {
    useOsd.getState().clear();
  } else {
    showOsd(message);
  }
}

function seekBy(context: ActionContext, seconds: number) {
  const state = usePlayer.getState();
  const now = currentPosition(state);
  const length = state.duration ?? Number.POSITIVE_INFINITY;
  const target = Math.min(length, Math.max(0, now + seconds));
  send("seek", commands.playerSeekBy(seconds));
  // Say what actually happened: near either end there may be less to move, or nothing.
  const moved = Math.round(Math.abs(target - now));
  const label = moved === 0 ? (seconds > 0 ? "At the end" : "At the start") : null;
  if (label === null) {
    // The picture jumping is the answer: no words in the corner for a step (asked for, 2026-11-14).
    useOsd.getState().clear();
    return;
  }
  // A key that could do nothing still says why (DESIGN.md §7).
  confirm(context, { label, value: formatTimecode(target, state.duration ?? target) });
}

/** A step as it is shown: "5 s", "1 min". */
function spokenStep(seconds: number): string {
  return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

/**
 * Sets the volume. Changing the volume by any means turns the sound back on:
 * nobody raises the volume in order to keep hearing nothing.
 */
export function setVolume(percent: number): void {
  if (usePlayer.getState().muted) {
    send("turn the sound back on", commands.playerSetMuted(false));
  }
  // Shown at once: the next step, however soon it comes, starts from here.
  wantVolume(percent);
  send("change the volume", commands.playerSetVolume(percent));
}

function changeVolume(context: ActionContext, direction: 1 | -1) {
  const next = stepVolume(usePlayer.getState().volume, direction);
  setVolume(next);
  confirm(context, {
    label: "Volume",
    value: formatVolume(next),
    scale: { at: volumeToFraction(next), mark: volumeToFraction(NORMAL_VOLUME) },
  });
}

/** Sets the speed and says so. */
export function setSpeed(context: ActionContext, rate: number): void {
  send("change the speed", commands.playerSetSpeed(rate));
  confirm(context, {
    label: isNormalSpeed(rate) ? "Normal speed" : "Speed",
    ...(isNormalSpeed(rate) ? {} : { value: formatSpeed(rate) }),
  });
}

function changeSpeed(context: ActionContext, direction: 1 | -1) {
  setSpeed(context, stepSpeed(usePlayer.getState().speed, direction));
}

/** What Play or pause will do now, as its button and the menu bar name it. */
export function playLabel(status: PlaybackStatus): string {
  if (status === "ended") {
    return "Play again";
  }
  return status === "playing" || status === "buffering" || status === "loading" ? "Pause" : "Play";
}

/** Goes to a time in what is open, and says where. */
export function goTo(context: ActionContext, seconds: number, label = "Go to"): void {
  const { duration } = usePlayer.getState();
  const target = Math.max(0, duration === null ? seconds : Math.min(seconds, duration));
  // The needle moves now, not when the seek has finished.
  usePlayer.setState({ position: target, positionAt: performance.now() });
  send("seek", commands.playerSeekTo(target, true));
  confirm(context, { label, value: formatTimecode(target, duration ?? target) });
}

/** Goes to the start of a chapter, by its place in the list. */
export function goToChapter(context: ActionContext, index: number): void {
  const chapter = usePlayer.getState().chapters[index];
  if (chapter) {
    goTo(context, chapter.time, chapterName(chapter, index));
  }
}

function seekAction(
  id: string,
  seconds: number,
  shortcuts: readonly string[],
  icon: NonNullable<Action["icon"]>,
): Action {
  const size = spokenStep(Math.abs(seconds)).replace(" s", " seconds").replace("1 min", "1 minute");
  return {
    id,
    name: `${seconds > 0 ? "Forward" : "Back"} ${size}`,
    keywords: seconds > 0 ? ["skip", "seek", "ahead"] : ["rewind", "seek", "skip"],
    category: "playback",
    icon,
    shortcuts,
    repeats: true,
    unavailable: needsSeekable,
    run: (context) => seekBy(context, seconds),
  };
}

/**
 * 0–9 go to that tenth of the way through, as on the web's video sites: 3
 * is 30%. Quietly, like a step: the picture jumping is the answer.
 */
function tenthAction(tenth: number): Action {
  return {
    id: `playback.tenth${tenth}`,
    name: `Go to ${tenth * 10}%`,
    keywords: ["seek", "jump", "percent", "through"],
    category: "playback",
    shortcuts: [String(tenth)],
    // Ten of them would crowd the palette; "Go to time…" takes "30%" too.
    unlisted: true,
    unavailable: needsSeekable,
    run: () => {
      const { duration } = usePlayer.getState();
      if (duration === null) {
        return;
      }
      const target = (duration * tenth) / 10;
      usePlayer.setState({ position: target, positionAt: performance.now() });
      send("seek", commands.playerSeekTo(target, false));
      useOsd.getState().clear();
    },
  };
}

/** The recap or intro playing now, if there is one worth skipping. */
export function skippableNow() {
  const state = usePlayer.getState();
  return hasMedia(state)
    ? skippableAt(state.chapters, currentPosition(state), state.duration)
    : null;
}

/** The actions of the player itself. */
export const playerActions: readonly Action[] = [
  {
    id: "playback.stop",
    name: "Stop",
    keywords: ["stop", "close", "home", "end", "quit playing"],
    category: "playback",
    icon: Square,
    // ⌘. is the Mac's own "stop".
    shortcuts: ["Cmd+."],
    unavailable: needsMedia,
    // Stops and closes what is open; the window goes back to Home.
    run: () => send("stop", commands.playlistClose()),
  },
  {
    id: "playback.skipSegment",
    name: "Skip intro",
    // Named for what it will skip now; Netflix's wording, which people know.
    label: () => (skippableNow()?.kind === "recap" ? "Skip recap" : "Skip intro"),
    keywords: ["recap", "intro", "opening", "previously", "titles", "skip"],
    category: "playback",
    icon: ChevronsRight,
    shortcuts: ["Shift+s"],
    unavailable: () => (skippableNow() === null ? "Not in a recap or an intro" : undefined),
    run: () => {
      const part = skippableNow();
      if (part === null) {
        return;
      }
      usePlayer.setState({ position: part.end, positionAt: performance.now() });
      send("skip that", commands.playerSeekTo(part.end, true));
      // The button going and the picture jumping say it.
      useOsd.getState().clear();
    },
  },
  ...Array.from({ length: 10 }, (_, tenth) => tenthAction(tenth)),
  {
    id: "playback.toggle",
    name: "Play or pause",
    label: () => playLabel(usePlayer.getState().status),
    keywords: ["play", "pause", "resume", "stop"],
    category: "playback",
    icon: Play,
    shortcuts: ["Space", "k"],
    unavailable: needsMedia,
    run: () => {
      send("play or pause", commands.playerTogglePaused());
      // The picture moving or stopping says it; no words in the corner (DESIGN.md §7).
      useOsd.getState().clear();
    },
  },
  seekAction("playback.forward", 5, ["Right"], FastForward),
  seekAction("playback.back", -5, ["Left"], Rewind),
  seekAction("playback.forward10", 10, ["l"], FastForward),
  seekAction("playback.back10", -10, ["j"], Rewind),
  seekAction("playback.forwardMinute", 60, ["Shift+Right"], ChevronsRight),
  seekAction("playback.backMinute", -60, ["Shift+Left"], ChevronsLeft),
  {
    id: "playback.start",
    name: "Go to the beginning",
    keywords: ["restart", "start over", "rewind", "from the beginning"],
    category: "playback",
    icon: SkipBack,
    shortcuts: ["Home"],
    unavailable: needsSeekable,
    run: (context) => goTo(context, 0, "Beginning"),
  },
  {
    id: "playback.goToTime",
    name: "Go to time…",
    keywords: ["jump", "seek", "timecode"],
    category: "playback",
    icon: Clock,
    shortcuts: ["Cmd+j"],
    unavailable: needsSeekable,
    run: () => usePalette.getState().show("time"),
  },
  {
    id: "playback.nextFrame",
    name: "Next frame",
    keywords: ["step", "frame by frame", "advance"],
    category: "playback",
    icon: StepForward,
    shortcuts: ["."],
    repeats: true,
    unavailable: needsMedia,
    run: (context) => {
      send("show the next frame", commands.playerStepFrame(true));
      confirm(context, { label: "Next frame" });
    },
  },
  {
    id: "playback.previousFrame",
    name: "Previous frame",
    keywords: ["step back", "frame by frame"],
    category: "playback",
    icon: StepBack,
    shortcuts: [","],
    repeats: true,
    unavailable: needsMedia,
    run: (context) => {
      send("show the previous frame", commands.playerStepFrame(false));
      confirm(context, { label: "Previous frame" });
    },
  },
  {
    id: "playback.nextChapter",
    name: "Next chapter",
    keywords: ["skip", "scene"],
    category: "playback",
    icon: ChevronLast,
    shortcuts: ["Shift+Cmd+Right", "Shift+n"],
    unavailable: () => {
      const blocked = needsChapters();
      if (blocked) {
        return blocked;
      }
      const state = usePlayer.getState();
      return nextChapter(state.chapters, currentPosition(state)) === null
        ? "This is the last chapter"
        : undefined;
    },
    run: (context) => {
      const state = usePlayer.getState();
      const index = nextChapter(state.chapters, currentPosition(state));
      if (index !== null) {
        goToChapter(context, index);
      }
    },
  },
  {
    id: "playback.previousChapter",
    name: "Previous chapter",
    keywords: ["scene"],
    category: "playback",
    icon: ChevronFirst,
    shortcuts: ["Shift+Cmd+Left", "Shift+p"],
    unavailable: needsChapters,
    run: (context) => {
      const state = usePlayer.getState();
      goToChapter(context, previousChapter(state.chapters, currentPosition(state)) ?? 0);
    },
  },
  {
    id: "playback.faster",
    name: "Faster",
    keywords: ["speed up", "speed", "rate", "quicker"],
    category: "playback",
    icon: Gauge,
    shortcuts: ["]"],
    unavailable: () =>
      needsMedia() ??
      (usePlayer.getState().speed >= (SPEEDS[SPEEDS.length - 1] ?? NORMAL_SPEED) - 0.005
        ? "This is the fastest"
        : undefined),
    run: (context) => changeSpeed(context, 1),
  },
  {
    id: "playback.slower",
    name: "Slower",
    keywords: ["slow down", "speed", "rate"],
    category: "playback",
    icon: Gauge,
    shortcuts: ["["],
    unavailable: () =>
      needsMedia() ??
      (usePlayer.getState().speed <= (SPEEDS[0] ?? NORMAL_SPEED) + 0.005
        ? "This is the slowest"
        : undefined),
    run: (context) => changeSpeed(context, -1),
  },
  {
    id: "playback.normalSpeed",
    name: "Normal speed",
    keywords: ["speed", "rate", "1x", "reset"],
    category: "playback",
    icon: Gauge,
    shortcuts: ["="],
    unavailable: () =>
      needsMedia() ??
      (isNormalSpeed(usePlayer.getState().speed) ? "Already at normal speed" : undefined),
    run: (context) => setSpeed(context, NORMAL_SPEED),
  },
  {
    id: "audio.volumeUp",
    name: "Volume up",
    keywords: ["louder", "sound", "increase"],
    category: "audio",
    icon: Volume2,
    shortcuts: ["Up"],
    repeats: true,
    run: (context) => changeVolume(context, 1),
  },
  {
    id: "audio.volumeDown",
    name: "Volume down",
    keywords: ["quieter", "softer", "sound", "decrease", "lower"],
    category: "audio",
    icon: Volume1,
    shortcuts: ["Down"],
    repeats: true,
    run: (context) => changeVolume(context, -1),
  },
  {
    id: "audio.mute",
    name: "Mute",
    label: () => (usePlayer.getState().muted ? "Unmute" : "Mute"),
    keywords: ["silence", "sound off", "unmute"],
    category: "audio",
    icon: VolumeX,
    shortcuts: ["m"],
    checked: () => usePlayer.getState().muted,
    run: (context) => {
      const muted = !usePlayer.getState().muted;
      send(muted ? "mute the sound" : "turn the sound back on", commands.playerSetMuted(muted));
      confirm(context, { label: muted ? "Muted" : "Sound on" });
    },
  },
  {
    id: "view.fullscreen",
    name: "Enter or exit full screen",
    label: () => (useWindowState.getState().fullscreen ? "Exit full screen" : "Enter full screen"),
    keywords: ["fullscreen", "maximise", "maximize", "whole screen"],
    category: "view",
    icon: Maximize,
    shortcuts: ["Ctrl+Cmd+f", "f"],
    run: () => send("change full screen", commands.windowToggleFullscreen()),
  },
  {
    id: "view.exitFullscreen",
    name: "Exit full screen",
    // Escape's last step: the palette offers full screen under its one item.
    unlisted: true,
    category: "view",
    icon: Minimize,
    shortcuts: ["Escape"],
    unavailable: () => (useWindowState.getState().fullscreen ? undefined : "Not in full screen"),
    run: () => send("leave full screen", commands.windowSetFullscreen(false)),
  },
  {
    id: "window.keepOnTop",
    name: "Keep on top",
    keywords: ["float", "pin", "always on top", "above"],
    // With the other things that change how the window shows the film, where the menu bar has it.
    category: "view",
    icon: Pin,
    shortcuts: ["Ctrl+Cmd+t"],
    checked: () => useWindowState.getState().keptOnTop,
    run: (context) => {
      const keptOnTop = !useWindowState.getState().keptOnTop;
      // Shown as done at once; put back if the window refuses.
      useWindowState.setState({ keptOnTop });
      const asked = commands.windowSetAlwaysOnTop(keptOnTop);
      send("change whether the window stays on top", asked);
      void asked.then((result) => {
        if (result.status === "error") {
          useWindowState.setState({ keptOnTop: !keptOnTop });
        }
      });
      if (hasMedia(usePlayer.getState())) {
        confirm(context, { label: keptOnTop ? "Kept on top" : "No longer kept on top" });
      }
    },
  },
];
