import { create } from "zustand";
import { OWN_SHAPE } from "@/features/video/shape";
import {
  commands,
  events,
  type FailureReason,
  type PlayerChange,
  type PlayerSnapshot,
  type Subscription,
  subscription,
} from "@/ipc";

/** Mirrors `PlayerSnapshot::default()` in src-tauri/src/engine/types.rs. */
export const IDLE_SNAPSHOT: PlayerSnapshot = {
  status: "idle",
  source: null,
  title: null,
  position: 0,
  duration: null,
  volume: 100,
  muted: false,
  speed: 1,
  video: null,
  tracks: [],
  chapters: [],
  audioDelay: 0,
  subtitleDelay: 0,
  subtitleSpeed: 1,
  shape: OWN_SHAPE,
  audioDevices: [],
  visualised: false,
};

/** Something that would not open, and why. */
export interface PlayerFailure {
  source: string;
  reason: FailureReason;
  /** What the Finder can show about it, if anything. */
  reveal: string | null;
}

interface PlayerState extends PlayerSnapshot {
  /**
   * `performance.now()` when `position` was reported. The backend reports
   * the position about ten times a second; the clock interpolates from here.
   */
  positionAt: number;
  /**
   * The most recent failure to open something. It stays until something else
   * is opened: it is said where the user is looking, not on a timer
   * (DESIGN.md §7, "Failure to open").
   */
  failure: PlayerFailure | null;
  /** Replaces everything with a fresh snapshot from the backend. */
  reset: (snapshot: PlayerSnapshot) => void;
  /** Folds one change from the backend into the state. */
  apply: (change: PlayerChange) => void;
}

/** The new state after a change. Kept pure so it can be tested on its own. */
export function reduce(state: PlayerSnapshot, change: PlayerChange): Partial<PlayerState> {
  switch (change.type) {
    case "status":
      return { status: change.status };
    case "media":
      // Something new is being opened: what went wrong before is history.
      return change.source === null
        ? { source: change.source, title: change.title }
        : { source: change.source, title: change.title, failure: null };
    case "position":
      return { position: change.seconds, positionAt: performance.now() };
    case "duration":
      return { duration: change.seconds };
    case "volume":
      return { volume: change.percent };
    case "muted":
      return { muted: change.muted };
    case "speed":
      // The position is re-stamped: interpolation from the old stamp would
      // otherwise apply the new speed to time that passed at the old one.
      return { speed: change.rate, position: state.position, positionAt: performance.now() };
    case "video":
      return { video: change.video };
    case "tracks":
      return { tracks: change.tracks };
    case "chapters":
      return { chapters: change.chapters };
    case "audioDelay":
      return { audioDelay: change.seconds };
    case "subtitleDelay":
      return { subtitleDelay: change.seconds };
    case "subtitleSpeed":
      return { subtitleSpeed: change.rate };
    case "shape":
      return { shape: change.shape };
    case "audioDevices":
      return { audioDevices: change.devices };
    case "visualised":
      return { visualised: change.visualised };
    case "resumed":
      // Something that happened, not a new value of the state: see notices.ts.
      return {};
    case "failed":
      return {
        failure: { source: change.source, reason: change.reason, reveal: change.reveal },
      };
  }
}

/**
 * A volume the interface has asked for and not yet heard back about.
 *
 * The needle goes there at once, and each step taken in quick succession (a
 * fast scroll, a held key) starts from the one before, not from what the
 * player last reported: otherwise two steps asked for within one answer's
 * time would both start from the same place and count as one. Answers to
 * older requests that arrive meanwhile are held back, so the needle never
 * runs backwards; the answer that matches, or whatever the player last said
 * once it has had time to answer, is the truth again.
 */
let wanted: { percent: number; heard: number | null } | null = null;
let settling: ReturnType<typeof setTimeout> | undefined;

/** How long the player is given to answer a request for a volume. */
export const VOLUME_ANSWER_MS = 400;

function settleVolume(): void {
  clearTimeout(settling);
  const waiting = wanted;
  wanted = null;
  if (waiting === null) {
    return;
  }
  if (waiting.heard !== null) {
    usePlayer.setState({ volume: waiting.heard });
    return;
  }
  // Not a word from the player: ask it where the volume really is.
  void commands
    .playerSnapshot()
    .then((snapshot) => {
      if (wanted === null) {
        usePlayer.setState({ volume: snapshot.volume });
      }
    })
    .catch(() => {});
}

/** Shows `percent` as the volume from now, ahead of the player's answer. */
export function wantVolume(percent: number): void {
  wanted = { percent, heard: null };
  clearTimeout(settling);
  settling = setTimeout(settleVolume, VOLUME_ANSWER_MS);
  usePlayer.setState({ volume: percent });
}

/** Whether a volume the player reports should be shown now. */
function volumeIsNews(percent: number): boolean {
  if (wanted === null) {
    return true;
  }
  if (percent === wanted.percent) {
    clearTimeout(settling);
    wanted = null;
    return true;
  }
  wanted.heard = percent;
  return false;
}

/**
 * Changes the interface has asked for itself and is still waiting to hear
 * back about, by the kind of change: see `adjust.ts`. A gate is shown each
 * change of its kind as it arrives and says whether to take it now.
 */
const gates = new Map<PlayerChange["type"], (change: PlayerChange) => boolean>();

/** Has `gate` decide whether a change of this kind from the player is taken as it arrives. */
export function gateChanges(type: PlayerChange["type"], gate: (change: PlayerChange) => boolean) {
  gates.set(type, gate);
}

export const usePlayer = create<PlayerState>((set, get) => ({
  ...IDLE_SNAPSHOT,
  positionAt: 0,
  failure: null,
  reset: (snapshot) => {
    clearTimeout(settling);
    wanted = null;
    set({ ...snapshot, positionAt: performance.now() });
  },
  apply: (change) => {
    if (change.type === "volume" && !volumeIsNews(change.percent)) {
      return;
    }
    if (gates.get(change.type)?.(change) === false) {
      return;
    }
    set(reduce(get(), change));
  },
}));

/** True when something is open, in any state. */
export function hasMedia(state: Pick<PlayerSnapshot, "source">): boolean {
  return state.source !== null;
}

/**
 * Where playback is right now. Between reports the position is advanced by
 * the time that has passed, at the current speed, while playing.
 */
export function currentPosition(
  state: Pick<PlayerState, "position" | "positionAt" | "speed" | "status" | "duration">,
  now: number = performance.now(),
): number {
  if (state.status !== "playing") {
    return state.position;
  }
  const advanced = state.position + ((now - state.positionAt) / 1000) * state.speed;
  return state.duration === null ? advanced : Math.min(advanced, state.duration);
}

/**
 * Loads the player's state and keeps it current.
 *
 * Events are subscribed to before the snapshot is requested, and changes that
 * arrive while it is on its way are replayed over it, so nothing is lost in
 * between.
 */
export function connectPlayer(): Subscription {
  let live = false;
  let stopped = false;
  const early: PlayerChange[] = [];

  const listening = subscription(
    events.playerChanged.listen((event) => {
      if (live) {
        usePlayer.getState().apply(event.payload);
      } else {
        early.push(event.payload);
      }
    }),
  );

  void commands.playerSnapshot().then((snapshot) => {
    if (stopped) {
      return;
    }
    const player = usePlayer.getState();
    player.reset(snapshot);
    for (const change of early) {
      player.apply(change);
    }
    live = true;
  });

  return {
    ready: listening.ready,
    stop: () => {
      stopped = true;
      listening.stop();
    },
  };
}
