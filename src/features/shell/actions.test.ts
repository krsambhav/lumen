import { clearMocks } from "@tauri-apps/api/mocks";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action } from "@/actions/registry";
import { DEFAULT_SESSION } from "@/app/boot";
import { useRecents } from "@/features/library/recents";
import { usePalette } from "@/features/palette/store";
import { IDLE_SNAPSHOT, usePlayer } from "@/features/player/store";
import type { Recent } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import { undoable } from "@/lib/notify";
import { clearUndo } from "@/lib/undo";
import { shellActions } from "./actions";
import { useInterface } from "./interface";

function action(id: string): Action {
  const found = shellActions.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`no action ${id}`);
  }
  return found;
}

const KEYS = { source: "keyboard" } as const;

const PLAYED: Recent = {
  source: "/films/a.mkv",
  title: "a.mkv",
  duration: 7305,
  position: 100,
  finished: false,
  playedAt: 1,
  state: null,
  playlist: null,
  available: true,
  poster: "asset://localhost/a.jpg",
  resumesAt: 97,
};

beforeEach(() => {
  usePlayer.setState({ ...IDLE_SNAPSHOT, source: "/films/a.mkv", status: "paused" });
  useInterface.setState({ ...DEFAULT_SESSION.interface, panelOpen: false });
  usePalette.setState({ open: false, mode: "all", returnTo: null });
  useRecents.setState({ entries: [PLAYED], loaded: true });
});

afterEach(() => {
  toast.dismiss();
  document.body.replaceChildren();
  clearMocks();
});

describe("the palette's own action", () => {
  it("opens it, and the same keys close it again", () => {
    void action("view.palette").run(KEYS);
    expect(usePalette.getState().open).toBe(true);
    void action("view.palette").run(KEYS);
    expect(usePalette.getState().open).toBe(false);
  });

  it("turns a palette that is asking for a time into the whole palette", () => {
    usePalette.getState().show("time");
    void action("view.palette").run(KEYS);
    expect(usePalette.getState()).toMatchObject({ open: true, mode: "all" });
  });
});

describe("the chapters panel", () => {
  it("opens on its tab, and needs something open", () => {
    const chapters = action("view.chapters");
    expect(chapters.label?.()).toBe("Show chapters");
    void chapters.run(KEYS);
    expect(useInterface.getState()).toMatchObject({
      panelOpen: true,
      inspectorTab: "chapters",
      // Opened by a key, so the keyboard goes with it.
      panelWantsKeyboard: true,
    });
    // Named for what choosing it will do now.
    expect(chapters.label?.()).toBe("Hide chapters");
    usePlayer.setState({ source: null });
    expect(chapters.unavailable?.()).toBe("Nothing is open");
  });
});

describe("undo", () => {
  afterEach(() => {
    clearUndo();
  });

  it("has nothing to do until something offers an undo, and says so", () => {
    expect(action("edit.undo").unavailable?.()).toBe("There is nothing to undo");
    expect(action("edit.undo").shortcuts).toEqual(["Cmd+z"]);
  });

  it("does what the newest Undo on show offers, once", () => {
    const first = vi.fn();
    const second = vi.fn();
    undoable("Removed from the playlist", { id: "removed", name: "A film", undo: first });
    undoable("Cleared recently played", { id: "cleared", undo: second });
    expect(action("edit.undo").unavailable?.()).toBeUndefined();
    void action("edit.undo").run(KEYS);
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    void action("edit.undo").run(KEYS);
    expect(first).toHaveBeenCalledOnce();
    expect(action("edit.undo").unavailable?.()).toBe("There is nothing to undo");
  });
});

describe("going to the notifications", () => {
  it("cannot be done when there are none", () => {
    expect(action("view.notifications").unavailable?.()).toBe("There are no notifications");
  });

  it("gives the list the keyboard, from where Tab reaches each one's controls", () => {
    // What Sonner draws: a list that can take focus, with a toast in it.
    const list = document.createElement("ol");
    list.setAttribute("data-sonner-toaster", "");
    list.tabIndex = -1;
    list.append(Object.assign(document.createElement("li"), { textContent: "Removed" }));
    list.firstElementChild?.setAttribute("data-sonner-toast", "");
    document.body.append(list);

    const go = action("view.notifications");
    expect(go.unavailable?.()).toBeUndefined();
    void go.run(KEYS);
    expect(list).toHaveFocus();
  });
});

describe("clearing what was played", () => {
  it("forgets everything, and can put it all back as it was", async () => {
    let history: Recent[] = [PLAYED];
    const clear = vi.fn(() => {
      history = [];
      return null;
    });
    const restore = vi.fn((_: { entry: unknown }) => null);
    mockCommands({
      historyClear: clear,
      historyRestore: restore,
      historyRecent: () => history,
    });
    void action("history.clear").run(KEYS);
    // Gone from the screen at once, before the backend has answered.
    expect(useRecents.getState().entries).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(useRecents.getState().entries).toEqual([]);
    expect(action("history.clear").unavailable?.()).toBe("Nothing has been played");

    // The toast's Undo: only what the history holds goes back.
    const undo = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Undo",
    );
    // No toaster is drawn here; the action it offered is reached through Sonner's own record.
    expect(undo).toBeUndefined();
    const [shown] = toast.getToasts() as unknown as {
      action?: { onClick: (event: never) => void };
    }[];
    shown?.action?.onClick(undefined as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restore).toHaveBeenCalledWith({
      entry: {
        source: "/films/a.mkv",
        title: "a.mkv",
        duration: 7305,
        position: 100,
        finished: false,
        playedAt: 1,
        state: null,
        playlist: null,
      },
    });
  });

  it("shows it all again, and says so, when it could not be cleared", async () => {
    mockCommands({
      historyClear: () => {
        throw { kind: "internal", message: "the database is locked" };
      },
      historyRecent: () => [PLAYED],
    });
    void action("history.clear").run(KEYS);
    expect(useRecents.getState().entries).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useRecents.getState().entries).toEqual([PLAYED]);
    // A complaint, with nothing to undo.
    expect(toast.getToasts()).toHaveLength(1);
    expect(action("edit.undo").unavailable?.()).toBe("There is nothing to undo");
  });
});
