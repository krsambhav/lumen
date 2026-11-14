import { clearMocks } from "@tauri-apps/api/mocks";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavedPlaylist } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import { undoNewest } from "@/lib/notify";
import { clearUndo } from "@/lib/undo";
import { connectSaved, countOf, deleteSaved, openSaved, useSaved } from "./saved";

const EVENING: SavedPlaylist = { id: 7, name: "Evening", count: 12, duration: 0, updatedAt: 1 };
const MORNING: SavedPlaylist = { id: 8, name: "Morning", count: 3, duration: 0, updatedAt: 2 };

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  toast.dismiss();
  clearUndo();
  useSaved.setState({ entries: [] });
  clearMocks();
});

describe("the saved playlists", () => {
  it("are read once, and then follow whatever the backend says is saved", async () => {
    const { emit } = await import("@tauri-apps/api/event");
    const list = vi.fn(() => [EVENING]);
    mockCommands({ playlistsList: list });
    const connection = connectSaved();
    await connection.ready;
    await useSaved.getState().load();
    expect(useSaved.getState().entries).toEqual([EVENING]);

    // Saved somewhere else: nothing here asked.
    await emit("playlists-changed", [EVENING, MORNING]);
    expect(useSaved.getState().entries).toEqual([EVENING, MORNING]);
    await emit("playlists-changed", []);
    expect(useSaved.getState().entries).toEqual([]);
    expect(list).toHaveBeenCalledOnce();

    connection.stop();
    await settled();
    await emit("playlists-changed", [MORNING]);
    expect(useSaved.getState().entries).toEqual([]);
  });

  it("keep what the backend said while the first reading was on its way", async () => {
    const { emit } = await import("@tauri-apps/api/event");
    let release: (saved: SavedPlaylist[]) => void = () => {};
    mockCommands({
      playlistsList: () => new Promise<SavedPlaylist[]>((resolve) => (release = resolve)),
    });
    const connection = connectSaved();
    await connection.ready;
    const reading = useSaved.getState().load();
    await settled();
    await emit("playlists-changed", [EVENING, MORNING]);
    // What was read is older than what was just heard.
    release([EVENING]);
    await reading;
    expect(useSaved.getState().entries).toEqual([EVENING, MORNING]);
    connection.stop();
  });

  it("stay as they were when they cannot be read", async () => {
    useSaved.setState({ entries: [EVENING] });
    mockCommands({
      playlistsList: () => {
        throw { kind: "internal", message: "the database is locked" };
      },
    });
    await useSaved.getState().load();
    expect(useSaved.getState().entries).toEqual([EVENING]);
  });
});

describe("a saved playlist", () => {
  it("is opened by its id", async () => {
    const opened = vi.fn((_: { id: number }) => null);
    mockCommands({ playlistsOpen: opened });
    openSaved(EVENING);
    await settled();
    expect(opened).toHaveBeenCalledWith({ id: 7 });
  });

  it("says how much is in it", () => {
    expect(countOf(1)).toBe("1 item");
    expect(countOf(12)).toBe("12 items");
  });

  it("is deleted with an Undo that brings it back, and asks for nothing else", async () => {
    const removed = vi.fn((_: { id: number }) => true);
    const restored = vi.fn((_: { id: number }) => EVENING);
    const list = vi.fn(() => [EVENING]);
    mockCommands({
      playlistsDelete: removed,
      playlistsUndelete: restored,
      playlistsList: list,
    });
    deleteSaved(EVENING);
    await settled();
    expect(removed).toHaveBeenCalledWith({ id: 7 });
    expect(toast.getToasts()).toHaveLength(1);

    expect(undoNewest()).toBe(true);
    await settled();
    expect(restored).toHaveBeenCalledWith({ id: 7 });
    // The backend says what is saved after each: the list is never asked for.
    expect(list).not.toHaveBeenCalled();
  });

  it("says so when it cannot be deleted, and offers no Undo", async () => {
    mockCommands({
      playlistsDelete: () => {
        throw { kind: "internal", message: "the database is locked" };
      },
    });
    deleteSaved(EVENING);
    await settled();
    expect(undoNewest()).toBe(false);
    expect(toast.getToasts()).toHaveLength(1);
  });
});
