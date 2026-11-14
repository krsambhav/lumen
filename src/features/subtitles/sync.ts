import { create } from "zustand";
import { delaySpoken, delayText } from "@/features/player/adjust";
import { usePlayer } from "@/features/player/store";
import { shownSubtitle } from "@/features/player/tracks";
import {
  commands,
  events,
  type Subscription,
  type SyncStatus,
  subscription,
  type Track,
} from "@/ipc";
import { notifyFailure } from "@/lib/notify";

/**
 * Syncing an added subtitle file to the film's speech (DESIGN.md §7,
 * "Sync to speech"). The backend does the work and says how it goes; this
 * keeps what it last said.
 */
export const useSubtitleSync = create<{ status: SyncStatus }>(() => ({
  status: { state: "idle", installed: false },
}));

/** Follows the backend's word on the sync. */
export function connectSubtitleSync(): Subscription {
  const changes = subscription(
    events.subtitleSyncChanged.listen((event) => {
      useSubtitleSync.setState({ status: event.payload });
    }),
  );
  void Promise.resolve(commands.subtitlesSyncStatus()).then((status) => {
    useSubtitleSync.setState({ status });
  });
  return changes;
}

/** What the row shows: the status, if it is about the file and track showing now. */
export type SyncView =
  | { state: "unavailable"; reason: string }
  | { state: "ready"; installed: boolean }
  | { state: "installing"; progress: number; size: number }
  | { state: "listening"; done: number; total: number }
  | Extract<SyncStatus, { state: "synced" }>
  | { state: "failed"; message: string };

/** Why the subtitles showing cannot be synced, if they cannot. */
export function syncUnavailable(
  source: string | null = usePlayer.getState().source,
  tracks: readonly Track[] = usePlayer.getState().tracks,
): string | undefined {
  if (source === null) {
    return "Nothing is open";
  }
  const shown = shownSubtitle(tracks);
  if (!shown) {
    return "No subtitles are showing";
  }
  if (!shown.external) {
    return "Subtitles inside the film are already timed with it";
  }
  return undefined;
}

/** The sync as it concerns what is showing now. */
export function syncView(
  status: SyncStatus,
  source: string | null,
  track: number | undefined,
  unavailable: string | undefined,
): SyncView {
  const busy = status.state === "installing" || status.state === "listening";
  const mine = status.state !== "idle" && status.source === source && status.track === track;
  // A sync that is running is shown even if the track has just changed:
  // it will end by saying the subtitles changed.
  if (busy && (mine || unavailable === undefined)) {
    return status.state === "installing"
      ? { state: "installing", progress: status.progress, size: status.size }
      : { state: "listening", done: status.done, total: status.total };
  }
  if (unavailable !== undefined) {
    return { state: "unavailable", reason: unavailable };
  }
  if (mine && status.state === "synced") {
    return status;
  }
  if (mine && status.state === "failed") {
    return { state: "failed", message: status.message };
  }
  return { state: "ready", installed: status.state === "idle" ? status.installed : true };
}

/** Starts a sync of the subtitles showing. */
export function startSync(): void {
  void commands.subtitlesSync().then((result) => {
    if (result.status === "error") {
      notifyFailure("sync the subtitles", result.error);
    }
  });
}

export function cancelSync(): void {
  void commands.subtitlesSyncCancel();
}

export function undoSync(): void {
  void commands.subtitlesSyncUndo().then((result) => {
    if (result.status === "error") {
      notifyFailure("undo the sync", result.error);
    }
  });
}

/** The frame rates a speed is the ratio of, as people name them. */
const RATES: readonly [number, string][] = [
  [24000 / 1001, "23.976"],
  [24, "24"],
  [25, "25"],
];

/**
 * A speed in words: "timed for 25 fps, retimed to 23.976". `null` for 1.
 * A cue timed `t` is shown at `t × speed`, so subtitles timed for a faster
 * copy of the film (25 fps against 23.976) have a speed above 1.
 */
export function speedText(speed: number): string | null {
  if (Math.abs(speed - 1) < 1e-6) {
    return null;
  }
  for (const [timed, timedName] of RATES) {
    for (const [film, filmName] of RATES) {
      if (Math.abs(timed / film - speed) < 1e-5) {
        return `retimed from ${timedName} to ${filmName} fps`;
      }
    }
  }
  return `running at ${Number((speed * 100).toFixed(2))}% speed`;
}

/** A delay as a direction: "7.47 s earlier", "120 ms later". */
function shiftText(seconds: number): string {
  const size = delayText(Math.abs(seconds)).replace(/^\+/, "");
  return `${size} ${seconds < 0 ? "earlier" : "later"}`;
}

/** What a finished sync did, in one line: "Shown 7.47 s earlier, retimed from 25 to 23.976 fps". */
export function syncedText(synced: Extract<SyncStatus, { state: "synced" }>): string {
  const parts = [synced.delay === 0 ? "In time as they were" : `Shown ${shiftText(synced.delay)}`];
  const speed = speedText(synced.speed);
  if (speed) {
    parts.push(speed);
  }
  return parts.join(", ");
}

/** The same, for VoiceOver. */
export function syncedSpoken(synced: Extract<SyncStatus, { state: "synced" }>): string {
  const speed = speedText(synced.speed);
  return `Synced: ${delaySpoken(synced.delay)}${speed ? `, ${speed}` : ""}`;
}

/** How a finished sync was found and how sure it is. */
export function syncedDetail(synced: Extract<SyncStatus, { state: "synced" }>): string {
  const agree = `${synced.agreeing} of ${synced.heard} samples agree`;
  return synced.byWords ? agree : `Matched by when people speak; ${agree}`;
}

/** The size of a download, as it is read: "60 MB". */
export function sizeText(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}
