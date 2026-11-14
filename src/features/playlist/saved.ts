import { create } from "zustand";
import { commands, events, type SavedPlaylist, type Subscription, subscription } from "@/ipc";
import { notifyFailure, send, undoable } from "@/lib/notify";

interface SavedState {
  /** The saved playlists, by name. */
  entries: SavedPlaylist[];
  /** Reads them. Never rejects: on failure the list stays as it was. */
  load: () => Promise<void>;
}

/** How many times the backend has said what is saved. */
let heard = 0;

/**
 * The playlists that have been saved, for everything that lists them: the
 * home screen, the menu bar, the palette and the panel's menu. They are read
 * once, at the start; after that the backend says what is saved whenever
 * that changes (`connectSaved`), so none of those has to ask.
 */
export const useSaved = create<SavedState>((set) => ({
  entries: [],
  load: async () => {
    const before = heard;
    const result = await commands.playlistsList().catch(() => null);
    // What the backend said while this was on its way is newer.
    if (result?.status === "ok" && heard === before) {
      set({ entries: result.data });
    }
  },
}));

/**
 * Keeps the saved playlists current. The backend sends all of them whenever
 * one is saved, renamed, deleted or brought back, so whichever arrives last
 * is the truth.
 */
export function connectSaved(): Subscription {
  return subscription(
    events.playlistsChanged.listen((event) => {
      heard += 1;
      useSaved.setState({ entries: event.payload });
    }),
  );
}

/** Opens a saved playlist in place of whatever is open. */
export function openSaved(playlist: Pick<SavedPlaylist, "id">): void {
  send("open that playlist", commands.playlistsOpen(playlist.id));
}

/** A playlist's size in words: "12 items · 9 h 20 min". */
export function countOf(items: number): string {
  return items === 1 ? "1 item" : `${items} items`;
}

/**
 * Deletes a saved playlist, with a toast that can bring it back
 * (DESIGN.md §8: Undo rather than a confirmation).
 */
export function deleteSaved(playlist: SavedPlaylist): void {
  void commands.playlistsDelete(playlist.id).then((result) => {
    if (result.status === "error") {
      notifyFailure("delete that playlist", result.error);
      return;
    }
    undoable("Deleted the playlist", {
      id: `playlist-deleted-${playlist.id}`,
      name: playlist.name,
      undo: () => {
        void commands.playlistsUndelete(playlist.id).then((undone) => {
          if (undone.status === "error") {
            notifyFailure("bring that playlist back", undone.error);
          }
        });
      },
    });
  });
}
