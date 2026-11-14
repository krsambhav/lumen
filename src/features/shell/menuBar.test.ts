import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appActions } from "@/actions/all";
import { clearActions, registerActions } from "@/actions/registry";
import { DEFAULT_SETTINGS } from "@/app/boot";
import { useRecents } from "@/features/library/recents";
import { useOsd } from "@/features/player/osd";
import { IDLE_SNAPSHOT, usePlayer } from "@/features/player/store";
import { useWindowState } from "@/features/player/window";
import { useSaved } from "@/features/playlist/saved";
import { EMPTY_QUEUE, useQueue } from "@/features/playlist/store";
import { resetSettingsForTests, useSettings } from "@/features/settings/store";
import { useUpdates } from "@/features/updates/store";
import { commands, type MenuEntry, type Recent } from "@/ipc";
import {
  APP_MENU,
  actionsMissingFromTheMenuBar,
  appMenuItems,
  connectMenuBar,
  MENU_BAR,
  menuSections,
  NOT_IN_THE_MENU_BAR,
  placedActions,
  RECENT_ITEMS,
  runMenuItem,
  titleStyle,
} from "./menuBar";

/** What the backend would call when an item of the menu bar is chosen. */
let chooseFromTheMenuBar: (id: string) => void = () => {};

vi.mock("@/app/boot", async (original) => ({
  ...(await original<typeof import("@/app/boot")>()),
  isTauri: () => true,
}));

vi.mock("@/ipc", async (original) => {
  const actual = await original<typeof import("@/ipc")>();
  return {
    ...actual,
    events: {
      ...actual.events,
      menuAction: {
        listen: vi.fn(async (heard: (event: { payload: string }) => void) => {
          chooseFromTheMenuBar = (id) => heard({ payload: id });
          return () => {};
        }),
      },
    },
    commands: {
      ...actual.commands,
      menuSet: vi.fn(async () => ({ status: "ok", data: null })),
      playerSetSpeed: vi.fn(async () => ({ status: "ok", data: null })),
      playlistSetRepeat: vi.fn(async () => ({ status: "ok", data: null })),
      playlistOpen: vi.fn(async () => ({ status: "ok", data: null })),
      playlistOpenRecent: vi.fn(async () => ({ status: "ok", data: null })),
      playlistsOpen: vi.fn(async () => ({ status: "ok", data: null })),
      playerTogglePaused: vi.fn(async () => ({ status: "ok", data: null })),
    },
  };
});

function played(index: number, over: Partial<Recent> = {}): Recent {
  return {
    source: `/films/Film ${index}.mkv`,
    title: `Film ${index}.mkv`,
    position: 0,
    duration: 5400,
    playedAt: 1_000 - index,
    state: null,
    playlist: null,
    finished: false,
    available: true,
    poster: null,
    resumesAt: null,
    ...over,
  };
}

beforeEach(() => {
  registerActions(appActions);
  usePlayer.setState({ ...IDLE_SNAPSHOT, positionAt: 0, failure: null });
  useQueue.setState(EMPTY_QUEUE, true);
  useWindowState.setState({ fullscreen: false, keptOnTop: false });
  useRecents.setState({ entries: [], loaded: true });
  useSaved.setState({ entries: [] });
  useUpdates.setState({ status: { state: "idle" } });
  resetSettingsForTests(DEFAULT_SETTINGS);
  useOsd.getState().clear();
  vi.clearAllMocks();
});

afterEach(() => {
  clearActions();
});

type ActionEntry = Extract<MenuEntry, { kind: "action" }>;

/** Every item that does something, wherever in the menus it is. */
function flat(entries: readonly MenuEntry[]): ActionEntry[] {
  return entries.flatMap((entry) =>
    entry.kind === "action" ? [entry] : entry.kind === "submenu" ? flat(entry.items) : [],
  );
}

function item(id: string): ActionEntry {
  const found = menuSections()
    .flatMap((section) => flat(section.items))
    .find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`${id} is not in the menu bar`);
  }
  return found;
}

function submenu(name: string): MenuEntry[] {
  for (const section of menuSections()) {
    for (const entry of section.items) {
      if (entry.kind === "submenu" && entry.name === name) {
        return entry.items;
      }
    }
  }
  throw new Error(`there is no ${name} submenu`);
}

describe("the menu bar", () => {
  it("has a place for every action, or a reason it has none", () => {
    expect(actionsMissingFromTheMenuBar()).toEqual([]);
    expect(NOT_IN_THE_MENU_BAR).toEqual(["view.exitFullscreen", "playlist.repeat", "edit.undo"]);
  });

  it("names only actions that exist, each once", () => {
    const ids = placedActions();
    expect(new Set(ids).size).toBe(ids.length);
    const known = new Set(appActions.map((action) => action.id));
    expect(ids.filter((id) => !known.has(id))).toEqual([]);
    // One excused from the bar is not also in it.
    expect(ids.filter((id) => NOT_IN_THE_MENU_BAR.includes(id))).toEqual([]);
  });

  it("gives every item its own id, in the menus and in their submenus", () => {
    useRecents.setState({ entries: [played(1), played(2)] });
    const ids = menuSections()
      .flatMap((section) => flat(section.items))
      .map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never starts or ends a menu with a separator, or has two together", () => {
    useRecents.setState({ entries: [played(1)] });
    const check = (entries: readonly MenuEntry[]) => {
      expect(entries[0]?.kind).not.toBe("separator");
      expect(entries[entries.length - 1]?.kind).not.toBe("separator");
      entries.forEach((entry, index) => {
        if (entry.kind === "separator") {
          expect(entries[index + 1]?.kind).not.toBe("separator");
        }
        if (entry.kind === "submenu") {
          check(entry.items);
        }
      });
    };
    for (const section of menuSections()) {
      check(section.items);
    }
    expect(MENU_BAR).toHaveLength(6);
  });

  it("is File, Playback, Audio, Video, Subtitles and View, in that order", () => {
    expect(menuSections().map((section) => section.name)).toEqual([
      "File",
      "Playback",
      "Audio",
      "Video",
      "Subtitles",
      "View",
    ]);
  });

  it("keeps Check for Updates and its switch in Lumen's own menu, as a Mac app does", () => {
    expect(APP_MENU).toEqual(["app.update", "app.checkForUpdates", "app.automaticUpdates"]);
    // None of them is also in a menu of the bar.
    const inTheBar = menuSections()
      .flatMap((section) => flat(section.items))
      .map((entry) => entry.id);
    expect(inTheBar.filter((id) => APP_MENU.includes(id))).toEqual([]);

    expect(appMenuItems()).toEqual([
      {
        kind: "action",
        id: "app.checkForUpdates",
        name: "Check for Updates",
        shortcut: null,
        enabled: true,
        checked: null,
      },
      {
        kind: "action",
        id: "app.automaticUpdates",
        name: "Check for Updates Automatically",
        shortcut: null,
        enabled: true,
        checked: true,
      },
    ]);
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, general: { checkForUpdates: false } },
    });
    expect(flat(appMenuItems()).find((entry) => entry.id === "app.automaticUpdates")).toMatchObject(
      { checked: false },
    );
  });

  it("lists the update in Lumen's own menu only while there is one to choose", () => {
    const first = () => flat(appMenuItems())[0];
    // Nothing found, or nothing looked for: no standing promise of an update.
    expect(first()?.id).toBe("app.checkForUpdates");
    useUpdates.setState({ status: { state: "current", version: "1.4.0" } });
    expect(first()?.id).toBe("app.checkForUpdates");

    useUpdates.setState({ status: { state: "available", version: "1.5.0", current: "1.4.0" } });
    expect(first()).toMatchObject({ id: "app.update", name: "Update to 1.5.0", enabled: true });

    // On its way in: there is nothing to choose until it is in place.
    useUpdates.setState({
      status: { state: "downloading", version: "1.5.0", received: 10, total: 100 },
    });
    expect(first()?.id).toBe("app.checkForUpdates");
    useUpdates.setState({ status: { state: "installing", version: "1.5.0" } });
    expect(first()?.id).toBe("app.checkForUpdates");

    useUpdates.setState({ status: { state: "ready", version: "1.5.0" } });
    expect(first()).toMatchObject({ id: "app.update", name: "Restart to Update", enabled: true });
  });

  it("shows each action's name, in the system's title style, and its first shortcut", () => {
    expect(item("file.open")).toMatchObject({ name: "Open File…", shortcut: "Cmd+o" });
    expect(item("file.add")).toMatchObject({ name: "Add to Playlist…" });
    expect(item("playlist.save")).toMatchObject({ name: "Save Playlist As…" });
    expect(item("playback.start")).toMatchObject({ name: "Go to the Beginning" });
    expect(item("playback.forward")).toMatchObject({ name: "Forward 5 Seconds" });
    expect(item("window.keepOnTop")).toMatchObject({ name: "Keep on Top" });
    expect(item("audio.volumeUp")).toMatchObject({ name: "Volume Up" });
    expect(item("playback.toggle")).toMatchObject({ shortcut: "Space" });
  });

  it("dims what cannot be done now", () => {
    expect(item("playback.toggle").enabled).toBe(false);
    expect(item("file.open").enabled).toBe(true);
    usePlayer.setState({ source: "/films/a.mkv", status: "paused", duration: 100 });
    expect(item("playback.toggle").enabled).toBe(true);
    expect(item("playlist.next").enabled).toBe(false);
  });

  it("ticks what is switched on, and leaves plain actions without a tick box", () => {
    expect(item("playlist.shuffle").checked).toBe(false);
    useQueue.setState({ shuffle: true });
    expect(item("playlist.shuffle").checked).toBe(true);
    expect(item("file.open").checked).toBeNull();
  });

  it("names an action after what choosing it will do now", () => {
    expect(item("view.fullscreen").name).toBe("Enter Full Screen");
    useWindowState.setState({ fullscreen: true });
    expect(item("view.fullscreen").name).toBe("Exit Full Screen");

    expect(item("playback.toggle").name).toBe("Play");
    usePlayer.setState({ source: "/films/a.mkv", status: "playing", duration: 100 });
    expect(item("playback.toggle").name).toBe("Pause");
    usePlayer.setState({ status: "paused" });
    expect(item("playback.toggle").name).toBe("Play");
    usePlayer.setState({ status: "ended" });
    expect(item("playback.toggle").name).toBe("Play Again");
  });
});

describe("the menu bar's submenus", () => {
  it("offers the speeds, with a tick on the one nearest to how fast it is going", () => {
    usePlayer.setState({ source: "/films/a.mkv", status: "playing", duration: 100, speed: 1 });
    const all = flat(submenu("Speed"));
    // The two steps lead, with their keys; then every speed by its figure.
    expect(all.slice(0, 2)).toMatchObject([
      { id: "playback.faster", name: "Faster", shortcut: "]" },
      { id: "playback.slower", name: "Slower", shortcut: "[" },
    ]);
    expect(submenu("Speed")[2]?.kind).toBe("separator");
    const speeds = all.slice(2);
    expect(speeds.map((entry) => entry.name)).toEqual([
      "0.25×",
      "0.5×",
      "0.75×",
      "Normal",
      "1.25×",
      "1.5×",
      "1.75×",
      "2×",
      "3×",
      "4×",
    ]);
    expect(speeds.filter((entry) => entry.checked).map((entry) => entry.name)).toEqual(["Normal"]);
    // A speed set some other way lies between two steps: the nearer has the tick.
    usePlayer.setState({ speed: 1.4 });
    expect(
      flat(submenu("Speed"))
        .filter((entry) => entry.checked)
        .map((entry) => entry.name),
    ).toEqual(["1.5×"]);
    // Every one of them can be ticked, so the menus are never rebuilt when the tick moves.
    expect(speeds.every((entry) => entry.checked !== null)).toBe(true);
  });

  it("lists normal speed once: among the speeds, as the action it is, with its key", () => {
    usePlayer.setState({ source: "/films/a.mkv", status: "playing", duration: 100, speed: 1 });
    const normal = flat(submenu("Speed")).filter((entry) => entry.name === "Normal");
    expect(normal).toEqual([
      {
        kind: "action",
        id: "playback.normalSpeed",
        name: "Normal",
        shortcut: "=",
        // Ticked and still to be chosen at normal speed, where the action alone has nothing to do.
        enabled: true,
        checked: true,
      },
    ]);
    // Chosen from another speed, it goes back to normal.
    usePlayer.setState({ speed: 2 });
    runMenuItem("playback.normalSpeed");
    expect(commands.playerSetSpeed).toHaveBeenCalledWith(1);
  });

  it("lists the saved playlists under Open Playlist, by their own names", () => {
    expect(flat(submenu("Open Playlist"))).toMatchObject([
      { id: "playlists:none", name: "No Saved Playlists", enabled: false },
    ]);
    useSaved.setState({
      entries: [
        { id: 7, name: "friday night", count: 12, duration: 0, updatedAt: 2 },
        { id: 9, name: "Kurosawa", count: 4, duration: 0, updatedAt: 1 },
      ],
    });
    expect(flat(submenu("Open Playlist"))).toMatchObject([
      { id: "playlist:7", name: "friday night", enabled: true },
      { id: "playlist:9", name: "Kurosawa", enabled: true },
    ]);
    runMenuItem("playlist:9");
    expect(commands.playlistsOpen).toHaveBeenCalledWith(9);
  });

  it("sets the speed that is chosen, and says so", () => {
    usePlayer.setState({ source: "/films/a.mkv", status: "playing", duration: 100 });
    runMenuItem("speed:1.5");
    expect(commands.playerSetSpeed).toHaveBeenCalledWith(1.5);
    expect(useOsd.getState().message).toMatchObject({ label: "Speed", value: "1.5×" });
  });

  it("has no speed to choose while nothing is open", () => {
    expect(flat(submenu("Speed")).every((entry) => !entry.enabled)).toBe(true);
    runMenuItem("speed:2");
    expect(commands.playerSetSpeed).not.toHaveBeenCalled();
  });

  it("offers the three repeat modes by name, in place of the key that steps through them", () => {
    const names = () => flat(submenu("Repeat")).map((entry) => [entry.name, entry.checked]);
    expect(names()).toEqual([
      ["Off", true],
      ["All", false],
      ["One", false],
    ]);
    useQueue.setState({ repeat: "one" });
    expect(names()).toEqual([
      ["Off", false],
      ["All", false],
      ["One", true],
    ]);
    runMenuItem("repeat:all");
    expect(commands.playlistSetRepeat).toHaveBeenCalledWith("all");
    expect(useOsd.getState().message?.label).toBe("Repeat all");
  });

  it("lists the last ten things played under Open Recent, newest first, by their own names", () => {
    useRecents.setState({
      entries: [
        played(1, { title: "the long take (2019).mkv" }),
        ...Array.from({ length: 14 }, (_, index) => played(index + 2)),
      ],
    });
    const recent = submenu("Open Recent");
    const films = flat(recent).filter((entry) => entry.id.startsWith("recent:"));
    expect(films).toHaveLength(RECENT_ITEMS);
    // A film's name is never recapitalised.
    expect(films[0]).toMatchObject({ id: "recent:0", name: "the long take (2019).mkv" });
    expect(films[9]).toMatchObject({ id: "recent:9", name: "Film 10.mkv" });
    // Then a separator, and the way to empty the list.
    expect(recent[RECENT_ITEMS]?.kind).toBe("separator");
    expect(recent[RECENT_ITEMS + 1]).toMatchObject({
      id: "history.clear",
      name: "Clear Recently Played",
      enabled: true,
    });

    runMenuItem("recent:0");
    // Through Recently played's own way in, which brings back a playlist whole.
    expect(commands.playlistOpenRecent).toHaveBeenCalledWith("/films/Film 1.mkv", null, true);
  });

  it("dims a film that is no longer where it was, and does not try to open it", () => {
    useRecents.setState({ entries: [played(1, { available: false })] });
    expect(item("recent:0").enabled).toBe(false);
    runMenuItem("recent:0");
    expect(commands.playlistOpenRecent).not.toHaveBeenCalled();
  });

  it("keeps Open Recent when nothing has been played, with only its dimmed way to clear it", () => {
    const recent = submenu("Open Recent");
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ id: "history.clear", enabled: false });
  });

  it("shortens a very long name in the middle, keeping the end that tells files apart", () => {
    const long =
      "The Long Take — Director’s Cut, Restored from the Original Camera Negative (2019) [2160p HDR10 Atmos].mp4";
    useRecents.setState({ entries: [played(1, { title: long })] });
    const { name } = item("recent:0");
    expect(name.length).toBeLessThanOrEqual(56);
    expect(name.startsWith("The Long Take — Director’s Cut")).toBe(true);
    expect(name.endsWith("HDR10 Atmos].mp4")).toBe(true);
    expect(name).toContain("…");
  });

  it("runs a registered action for an item that names one", () => {
    usePlayer.setState({ source: "/films/a.mkv", status: "paused", duration: 100 });
    runMenuItem("playback.toggle");
    expect(commands.playerTogglePaused).toHaveBeenCalledTimes(1);
    // An id nothing answers to is ignored.
    expect(() => runMenuItem("nothing:here")).not.toThrow();
  });
});

describe("the system's title style", () => {
  it("capitalises every word but the small ones inside a name", () => {
    expect(titleStyle("Open file…")).toBe("Open File…");
    expect(titleStyle("Add to playlist…")).toBe("Add to Playlist…");
    expect(titleStyle("Go to the beginning")).toBe("Go to the Beginning");
    expect(titleStyle("Play or pause")).toBe("Play or Pause");
    expect(titleStyle("Clear recently played")).toBe("Clear Recently Played");
  });

  it("capitalises the last word whatever it is, with or without an ellipsis", () => {
    expect(titleStyle("Save playlist as…")).toBe("Save Playlist As…");
    expect(titleStyle("Volume up")).toBe("Volume Up");
    expect(titleStyle("Keep on top")).toBe("Keep on Top");
  });

  it("leaves figures, and words that already have their capitals, as they are", () => {
    expect(titleStyle("Forward 5 seconds")).toBe("Forward 5 Seconds");
    expect(titleStyle("1.5×")).toBe("1.5×");
    expect(titleStyle("Cast to an AirPlay device")).toBe("Cast to an AirPlay Device");
    expect(titleStyle("Open in macOS Finder")).toBe("Open in macOS Finder");
    expect(titleStyle("Mute")).toBe("Mute");
  });
});

describe("keeping the menu bar in step", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const sent = () => vi.mocked(commands.menuSet).mock.calls.length;
  /** Whether the menu bar, as last sent, lets an action be chosen. */
  const offered = (id: string) => {
    const sections = vi.mocked(commands.menuSet).mock.calls.at(-1)?.[1] ?? [];
    return sections.flatMap((section) => flat(section.items)).find((entry) => entry.id === id)
      ?.enabled;
  };

  it("says what the menus are at once, and again shortly after something they show changes", async () => {
    const connection = connectMenuBar();
    await connection.ready;
    expect(sent()).toBe(1);

    useQueue.setState({ shuffle: true });
    expect(sent()).toBe(1);
    vi.advanceTimersByTime(80);
    expect(sent()).toBe(2);

    // A change the menus do not show sends nothing.
    usePlayer.setState({ volume: 40 });
    vi.advanceTimersByTime(80);
    expect(sent()).toBe(2);

    connection.stop();
    useQueue.setState({ shuffle: false });
    vi.advanceTimersByTime(1000);
    expect(sent()).toBe(2);
  });

  it("sends Lumen's own menu with the rest, and again when an update is found", async () => {
    const own = () => flat(vi.mocked(commands.menuSet).mock.calls.at(-1)?.[0] ?? []);
    const connection = connectMenuBar();
    await connection.ready;
    expect(own().map((entry) => entry.id)).toEqual(["app.checkForUpdates", "app.automaticUpdates"]);

    useUpdates.setState({ status: { state: "available", version: "1.5.0", current: "1.4.0" } });
    vi.advanceTimersByTime(80);
    expect(sent()).toBe(2);
    expect(own().map((entry) => entry.id)).toEqual([
      "app.update",
      "app.checkForUpdates",
      "app.automaticUpdates",
    ]);

    // The switch's tick follows the setting.
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, general: { checkForUpdates: false } },
    });
    vi.advanceTimersByTime(80);
    expect(sent()).toBe(3);
    expect(own().find((entry) => entry.id === "app.automaticUpdates")?.checked).toBe(false);
    connection.stop();
  });

  it("looks again once a second, not ten times, while only the film's position moves", async () => {
    usePlayer.setState({
      source: "/films/a.mkv",
      status: "paused",
      duration: 100,
      position: 10,
      chapters: [
        { title: "One", time: 0 },
        { title: "Two", time: 50 },
      ],
    });
    const connection = connectMenuBar();
    await connection.ready;
    expect(sent()).toBe(1);
    expect(offered("playback.nextChapter")).toBe(true);

    // Ten reports of the position, into the last chapter.
    for (let report = 1; report <= 9; report += 1) {
      usePlayer.setState({ position: 50 + report, positionAt: report });
      vi.advanceTimersByTime(100);
      expect(sent()).toBe(1);
    }
    usePlayer.setState({ position: 60, positionAt: 10 });
    vi.advanceTimersByTime(100);
    // The one thing that follows the position has changed, and is sent once.
    expect(sent()).toBe(2);
    expect(offered("playback.nextChapter")).toBe(false);

    // A change of any other kind does not wait for the slow look.
    usePlayer.setState({ position: 61, positionAt: 11 });
    usePlayer.setState({ status: "playing" });
    vi.advanceTimersByTime(80);
    expect(sent()).toBe(3);
    connection.stop();
  });

  it("does what a chosen item is for, whether an action or one of a submenu's choices", async () => {
    usePlayer.setState({ source: "/films/a.mkv", status: "paused", duration: 100 });
    const connection = connectMenuBar();
    await connection.ready;
    chooseFromTheMenuBar("playback.toggle");
    expect(commands.playerTogglePaused).toHaveBeenCalledTimes(1);
    chooseFromTheMenuBar("repeat:one");
    expect(commands.playlistSetRepeat).toHaveBeenCalledWith("one");
    connection.stop();
  });
});
