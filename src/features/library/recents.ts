import { create } from "zustand";
import { commands, events, type Recent, type Subscription, subscription } from "@/ipc";
import { send } from "@/lib/notify";

/**
 * Opens something from what was played: one played in a playlist brings
 * the whole playlist back, at that item, or at `play` when another of its
 * items was chosen; anything else opens alone. From where it was left,
 * unless `resume` is false.
 */
export function playRecent(source: string, resume = true, play: string | null = null): void {
  send("open that", commands.playlistOpenRecent(source, play, resume));
}

/** As many as two rows of tiles can show on the widest window worth planning for. */
export const RECENTS_WANTED = 24;

interface RecentsState {
  /** What was played, newest first. */
  entries: Recent[];
  /** The history has been read at least once. */
  loaded: boolean;
  /** Reads the history again. Never rejects: on failure the list stays as it was. */
  load: () => Promise<void>;
}

/**
 * What was played recently, for the home screen, the palette and the menu
 * bar. It is read at the start, and again whenever the backend says it has
 * changed (`connectRecents`); where each was left is read again on the way
 * back to the home screen, the one place that shows it.
 */
export const useRecents = create<RecentsState>((set) => ({
  entries: [],
  loaded: false,
  load: async () => {
    const result = await commands.historyRecent(RECENTS_WANTED).catch(() => null);
    if (result?.status === "ok") {
      set({ entries: result.data, loaded: true });
    } else {
      set({ loaded: true });
    }
  },
}));

/**
 * Reads what was played again whenever the backend says it is not what it
 * was: something was opened, forgotten or put back, or all of it was cleared.
 * Changes that come close together are read once, after the last of them.
 */
export function connectRecents(): Subscription {
  let reading = false;
  let stale = false;
  const read = async () => {
    if (reading) {
      // Whatever is being read may already be out of date: read once more after it.
      stale = true;
      return;
    }
    reading = true;
    do {
      stale = false;
      await useRecents.getState().load();
    } while (stale);
    reading = false;
  };
  return subscription(events.historyChanged.listen(() => void read()));
}

/** Posters are made in the background; each is put on its tile when it is ready. */
export function connectPosters(): Subscription {
  return subscription(
    events.posterReady.listen((event) => {
      const { source, url } = event.payload;
      useRecents.setState((state) => ({
        entries: state.entries.map((entry) =>
          entry.source === source ? { ...entry, poster: url } : entry,
        ),
      }));
    }),
  );
}
