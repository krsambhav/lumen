import { clearMocks } from "@tauri-apps/api/mocks";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action } from "@/actions/registry";
import { DEFAULT_SESSION } from "@/app/boot";
import { useOsd } from "@/features/player/osd";
import { IDLE_SNAPSHOT, usePlayer } from "@/features/player/store";
import { useInterface } from "@/features/shell/interface";
import type { QueueSnapshot } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import { undoNewest } from "@/lib/notify";
import { canUndo, clearUndo } from "@/lib/undo";
import {
  clearPlaylist,
  nextRepeat,
  openSources,
  playlistActions,
  REPEAT_CHOICES,
  REPEAT_NAMES,
  removeItem,
  setRepeat,
} from "./actions";
import { EMPTY_QUEUE, useQueue } from "./store";
import { usePlaylistUi } from "./ui";

const closeWindow = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close: closeWindow }),
}));

const shown = vi.hoisted(() => vi.fn());
vi.mock("sonner", async (original) => {
  const real = await original<typeof import("sonner")>();
  const toast = Object.assign((...args: Parameters<typeof real.toast>) => {
    shown(...args);
    return real.toast(...args);
  }, real.toast);
  return { ...real, toast };
});

function action(id: string): Action {
  const found = playlistActions.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`no action ${id}`);
  }
  return found;
}

const KEYS = { source: "keyboard" } as const;

const THREE: QueueSnapshot = {
  ...EMPTY_QUEUE,
  items: [
    { id: 1, source: "/s/1.mkv", title: "1.mkv", duration: 100, failed: null },
    { id: 2, source: "/s/2.mkv", title: "2.mkv", duration: 100, failed: null },
    { id: 3, source: "/s/3.mkv", title: "3.mkv", duration: 100, failed: null },
  ],
  current: 2,
  hasNext: true,
  hasPrevious: true,
};

/** Lets the promises a command's result goes through run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** What the toast last shown offers to undo, as its button would do it. */
function undo() {
  const options = shown.mock.calls.at(-1)?.[1] as { action: { onClick: () => void } };
  options.action.onClick();
}

beforeEach(() => {
  shown.mockClear();
  closeWindow.mockClear();
  usePlayer.setState({ ...IDLE_SNAPSHOT, source: "/s/2.mkv", status: "paused", positionAt: 0 });
  useQueue.setState(THREE, true);
  useInterface.setState({ ...DEFAULT_SESSION.interface, panelOpen: false });
  usePlaylistUi.setState({ selected: null, saving: false, renaming: null, dropIndex: null });
});

afterEach(() => {
  toast.dismiss();
  clearUndo();
  useOsd.getState().clear();
  clearMocks();
});

describe("every playlist action", () => {
  it("has a name and a shortcut of its own", () => {
    const chords = playlistActions.flatMap((candidate) => candidate.shortcuts);
    expect(new Set(chords).size).toBe(chords.length);
    for (const candidate of playlistActions) {
      expect(candidate.shortcuts.length, candidate.id).toBeGreaterThan(0);
    }
  });
});

describe("opening", () => {
  it("opens files from the panel, a folder from its own, and adds from a third", () => {
    const open = vi.fn((_: { folder: boolean }) => true);
    const add = vi.fn(() => 0);
    mockCommands({ playlistOpenDialog: open, playlistAddDialog: add });
    void action("file.open").run(KEYS);
    expect(open).toHaveBeenLastCalledWith({ folder: false });
    void action("file.openFolder").run(KEYS);
    expect(open).toHaveBeenLastCalledWith({ folder: true });
    void action("file.add").run(KEYS);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("opens what it is handed, resuming unless told to start over, and nothing for nothing", () => {
    const open = vi.fn((_: { sources: string[]; resume: boolean }) => null);
    mockCommands({ playlistOpen: open });
    openSources(["/a.mkv", "/b.mkv"]);
    expect(open).toHaveBeenLastCalledWith({ sources: ["/a.mkv", "/b.mkv"], resume: true });
    openSources(["/a.mkv"], false);
    expect(open).toHaveBeenLastCalledWith({ sources: ["/a.mkv"], resume: false });
    openSources([]);
    expect(open).toHaveBeenCalledTimes(2);
  });
});

describe("closing", () => {
  it("closes the film when one is open, and the window when none is, and says which", () => {
    const close = vi.fn(() => null);
    mockCommands({ playlistClose: close });
    expect(action("file.close").label?.()).toBe("Close file");
    void action("file.close").run(KEYS);
    expect(close).toHaveBeenCalledTimes(1);
    expect(closeWindow).not.toHaveBeenCalled();

    usePlayer.setState({ source: null });
    expect(action("file.close").label?.()).toBe("Close window");
    void action("file.close").run(KEYS);
    expect(closeWindow).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("showing the open file in the Finder", () => {
  it("shows a file on this Mac, and has nothing to show for an address", () => {
    const reveal = vi.fn((_: { path: string }) => null);
    mockCommands({ filesShowInFinder: reveal });
    expect(action("file.reveal").unavailable?.()).toBeUndefined();
    void action("file.reveal").run(KEYS);
    expect(reveal).toHaveBeenCalledWith({ path: "/s/2.mkv" });

    usePlayer.setState({ source: "https://example.com/live.m3u8" });
    expect(action("file.reveal").unavailable?.()).toBe("This is not a file on this Mac");
    usePlayer.setState({ source: null });
    expect(action("file.reveal").unavailable?.()).toBe("Nothing is open");
  });
});

describe("next and previous", () => {
  it("go to the item either side", () => {
    const next = vi.fn(() => true);
    const previous = vi.fn(() => true);
    mockCommands({ playlistNext: next, playlistPrevious: previous });
    void action("playlist.next").run(KEYS);
    void action("playlist.previous").run(KEYS);
    expect(next).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledTimes(1);
  });

  it("say why they cannot be used", () => {
    useQueue.setState({ hasNext: false });
    expect(action("playlist.next").unavailable?.()).toBe("This is the last item");
    expect(action("playlist.previous").unavailable?.()).toBeUndefined();
    useQueue.setState({ hasNext: true, hasPrevious: false });
    expect(action("playlist.previous").unavailable?.()).toBe("This is the first item");

    useQueue.setState({ items: THREE.items.slice(0, 1) });
    expect(action("playlist.next").unavailable?.()).toBe("The playlist has only this item");
    usePlayer.setState({ source: null });
    expect(action("playlist.next").unavailable?.()).toBe("Nothing is open");
  });
});

describe("repeat and shuffle", () => {
  it("step repeat through off, all and one, saying which", () => {
    expect(nextRepeat("off")).toBe("all");
    expect(nextRepeat("all")).toBe("one");
    expect(nextRepeat("one")).toBe("off");
    const repeat = vi.fn((_: { repeat: string }) => null);
    mockCommands({ playlistSetRepeat: repeat });
    void action("playlist.repeat").run(KEYS);
    expect(repeat).toHaveBeenCalledWith({ repeat: "all" });
    expect(useOsd.getState().message?.label).toBe(REPEAT_NAMES.all);
    expect(action("playlist.repeat").checked?.()).toBe(false);
    useQueue.setState({ repeat: "one" });
    expect(action("playlist.repeat").checked?.()).toBe(true);
    // Named for what it is whatever state it is in: "Repeat off" would read as a command.
    expect(action("playlist.repeat").label).toBeUndefined();
    expect(action("playlist.repeat").name).toBe("Repeat");
  });

  it("sets a repeat mode that is chosen by name, and says so", () => {
    const repeat = vi.fn((_: { repeat: string }) => null);
    mockCommands({ playlistSetRepeat: repeat });
    setRepeat({ source: "menu" }, "one");
    expect(repeat).toHaveBeenCalledWith({ repeat: "one" });
    expect(useOsd.getState().message?.label).toBe("Repeat one");
    expect(REPEAT_CHOICES.map((choice) => choice.name)).toEqual(["Off", "All", "One"]);
  });

  it("switch shuffle and say which way it went", () => {
    const shuffle = vi.fn((_: { shuffle: boolean }) => null);
    mockCommands({ playlistSetShuffle: shuffle });
    void action("playlist.shuffle").run(KEYS);
    expect(shuffle).toHaveBeenCalledWith({ shuffle: true });
    expect(useOsd.getState().message?.label).toBe("Shuffle on");
    useQueue.setState({ shuffle: true });
    void action("playlist.shuffle").run({ source: "control" });
    expect(shuffle).toHaveBeenLastCalledWith({ shuffle: false });
    // A control shows the new state itself.
    expect(useOsd.getState().message).toBeNull();
  });
});

describe("the panel", () => {
  it("shows the playlist, and the same again hides it, under the name of what it will do", () => {
    const show = action("view.playlist");
    expect(show.label?.()).toBe("Show playlist");
    void show.run({ source: "control" });
    expect(useInterface.getState()).toMatchObject({ panelOpen: true, inspectorTab: "playlist" });
    expect(show.label?.()).toBe("Hide playlist");
    // On the other tab the playlist is not showing: the same action shows it.
    useInterface.setState({ inspectorTab: "chapters" });
    expect(show.label?.()).toBe("Show playlist");
    useInterface.setState({ inspectorTab: "playlist" });
    void show.run({ source: "control" });
    expect(useInterface.getState().panelOpen).toBe(false);
  });

  it("takes the keyboard with it when it is opened by a key, and not otherwise", () => {
    const show = action("view.playlist");
    void show.run({ source: "control" });
    expect(useInterface.getState().panelWantsKeyboard).toBe(false);
    void show.run({ source: "control" });
    void show.run(KEYS);
    expect(useInterface.getState()).toMatchObject({ panelOpen: true, panelWantsKeyboard: true });
    // Closing it withdraws the request.
    void show.run(KEYS);
    expect(useInterface.getState()).toMatchObject({ panelOpen: false, panelWantsKeyboard: false });
  });

  it("opens with the form for a name when the playlist is to be saved", () => {
    void action("playlist.save").run(KEYS);
    expect(useInterface.getState()).toMatchObject({ panelOpen: true, inspectorTab: "playlist" });
    expect(usePlaylistUi.getState().saving).toBe(true);
  });
});

describe("removing an item", () => {
  it("says so, and can put it back where it was", async () => {
    const remove = vi.fn((_: { id: number }) => null);
    const add = vi.fn((_: { sources: string[]; index: number | null }) => 1);
    mockCommands({ playlistRemove: remove, playlistAdd: add });
    removeItem(THREE.items[2] as QueueSnapshot["items"][number]);
    await settle();
    expect(remove).toHaveBeenCalledWith({ id: 3 });
    // What happened in a few words; the name is on the line under it.
    expect(shown.mock.calls.at(-1)?.[0]).toBe("Removed from the playlist");
    expect(shown.mock.calls.at(-1)?.[1]).toMatchObject({ description: "3.mkv" });
    undo();
    expect(add).toHaveBeenCalledWith({ sources: ["/s/3.mkv"], index: 2 });
  });

  it("can be undone from the keyboard for as long as the toast is up", async () => {
    const add = vi.fn((_: { sources: string[]; index: number | null }) => 1);
    mockCommands({ playlistRemove: () => null, playlistAdd: add });
    expect(canUndo()).toBe(false);
    removeItem(THREE.items[2] as QueueSnapshot["items"][number]);
    await settle();
    expect(canUndo()).toBe(true);
    expect(undoNewest()).toBe(true);
    expect(add).toHaveBeenCalledWith({ sources: ["/s/3.mkv"], index: 2 });
    // Once is enough: the offer is gone with it.
    expect(undoNewest()).toBe(false);
  });

  it("says when the backend would not, and offers no undo of what did not happen", async () => {
    mockCommands({
      playlistRemove: () => {
        throw { kind: "internal", message: "no" };
      },
    });
    removeItem(THREE.items[0] as QueueSnapshot["items"][number]);
    await settle();
    expect(shown).not.toHaveBeenCalled();
  });
});

describe("clearing the playlist", () => {
  it("keeps what is playing, and can put the rest back either side of it", async () => {
    const clear = vi.fn(() => null);
    const add = vi.fn((_: { sources: string[]; index: number | null }) => 1);
    mockCommands({ playlistClear: clear, playlistAdd: add });
    clearPlaylist();
    await settle();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(shown.mock.calls.at(-1)?.[0]).toBe("Removed 2 items from the playlist");
    undo();
    await settle();
    expect(add.mock.calls.map(([args]) => args)).toEqual([
      { sources: ["/s/1.mkv"], index: 0 },
      { sources: ["/s/3.mkv"], index: null },
    ]);
  });

  it("has nothing to do when only the playing item is in it", () => {
    const clear = vi.fn(() => null);
    mockCommands({ playlistClear: clear });
    useQueue.setState({ items: THREE.items.slice(1, 2) });
    expect(action("playlist.clear").unavailable?.()).toBe("There is nothing else in the playlist");
    clearPlaylist();
    expect(clear).not.toHaveBeenCalled();
  });
});
