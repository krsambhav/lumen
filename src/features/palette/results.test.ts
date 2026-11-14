import { describe, expect, it, vi } from "vitest";
import type { Action } from "@/actions/registry";
import { EMPTY_QUEUE } from "@/features/playlist/store";
import type { QueueSnapshot, Recent } from "@/ipc";
import { type PaletteRunners, type PaletteSources, paletteGroups } from "./results";
import type { PaletteMode } from "./store";

function action(id: string, name: string, extra: Partial<Action> = {}): Action {
  return { id, name, category: "playback", shortcuts: [], run: () => {}, ...extra };
}

const ACTIONS: Action[] = [
  action("file.open", "Open file…", { category: "file", shortcuts: ["Cmd+o"] }),
  action("playback.toggle", "Play or pause", { shortcuts: ["Space"], label: () => "Pause" }),
  action("playlist.next", "Next item", { unavailable: () => "This is the last item" }),
  action("playback.backMinute", "Back 1 minute"),
  action("playback.forwardMinute", "Forward 1 minute"),
  action("playback.faster", "Faster", { keywords: ["speed up", "speed"] }),
  action("playback.normalSpeed", "Normal speed", {
    keywords: ["speed"],
    unavailable: () => "Already at normal speed",
  }),
  action("playlist.repeat", "Repeat", { keywords: ["loop"] }),
  action("audio.mute", "Mute", { category: "audio" }),
  action("audio.volumeUp", "Volume up", { category: "audio", keywords: ["louder"] }),
  action("view.fullscreen", "Enter or exit full screen", {
    category: "view",
    label: () => "Enter full screen",
  }),
  action("view.exitFullscreen", "Exit full screen", { category: "view", unlisted: true }),
  action("view.playlist", "Show playlist", { category: "view" }),
  action("view.palette", "Command palette…", { category: "view" }),
];

const QUEUE: QueueSnapshot = {
  ...EMPTY_QUEUE,
  items: [
    { id: 1, source: "/s/Episode 1.mkv", title: "Episode 1.mkv", duration: 1500, failed: null },
    { id: 2, source: "/s/Episode 2.mkv", title: "Episode 2.mkv", duration: null, failed: null },
  ],
  current: 1,
};

function recent(title: string, extra: Partial<Recent> = {}): Recent {
  return {
    source: `/films/${title}`,
    title,
    duration: 7305,
    position: 0,
    finished: false,
    playedAt: 1,
    state: null,
    available: true,
    poster: null,
    resumesAt: null,
    ...extra,
  };
}

const SOURCES: PaletteSources = {
  actions: ACTIONS,
  recentActions: [],
  queue: QUEUE,
  chapters: [
    { title: "The Station", time: 0 },
    { title: null, time: 1260 },
  ],
  duration: 7305,
  position: 600,
  hasMedia: true,
  history: [
    recent("Solaris (1972).mkv", { position: 5200, duration: 9960, resumesAt: 5197 }),
    recent("Stalker (1979).mkv", { finished: true }),
    recent("Gone.mkv", { available: false }),
  ],
  saved: [
    { id: 7, name: "Evening", count: 12, duration: 0, updatedAt: 1 },
    { id: 8, name: "Friday night", count: 1, duration: 0, updatedAt: 2 },
  ],
};

function runners(): PaletteRunners {
  return {
    action: vi.fn(),
    goTo: vi.fn(),
    speed: vi.fn(),
    playItem: vi.fn(),
    chapter: vi.fn(),
    openSaved: vi.fn(),
    openRecent: vi.fn(),
    openAddress: vi.fn(),
    addAddress: vi.fn(),
  };
}

function headings(query: string, sources = SOURCES, mode: PaletteMode = "all") {
  return paletteGroups(query, mode, sources, runners()).map((group) => group.heading);
}

function rows(query: string, heading: string, sources = SOURCES, run = runners()) {
  const group = paletteGroups(query, "all", sources, run).find((each) => each.heading === heading);
  return group?.rows ?? [];
}

/** The name of the row Return would run: the first that can be chosen. */
function first(query: string, sources = SOURCES): string | undefined {
  return paletteGroups(query, "all", sources, runners())
    .flatMap((group) => group.rows)
    .find((row) => row.unavailable === undefined)?.name;
}

describe("with nothing typed", () => {
  it("lists what is at hand to open, then every action that can be done now, by category", () => {
    expect(headings("")).toEqual([
      "Playlists",
      "Recently played",
      "File",
      "Playback",
      "Audio",
      "View",
    ]);
    // Not the palette itself, nor what works by its key alone, nor what cannot be done now.
    expect(rows("", "View").map((row) => row.name)).toEqual(["Enter full screen", "Show playlist"]);
    expect(rows("", "Playback").map((row) => row.name)).toEqual([
      "Pause",
      "Back 1 minute",
      "Forward 1 minute",
      "Faster",
      "Repeat",
    ]);
  });

  it("offers saved playlists and what was played lately, three of each, and only what is there", () => {
    const run = runners();
    expect(rows("", "Playlists", SOURCES, run).map((row) => [row.name, row.detail])).toEqual([
      ["Evening", "12 items"],
      ["Friday night", "1 item"],
    ]);
    rows("", "Playlists", SOURCES, run)[1]?.run();
    expect(run.openSaved).toHaveBeenCalledWith(8);
    // A file that has gone is not offered where nobody asked for it.
    expect(rows("", "Recently played").map((row) => row.name)).toEqual([
      "Solaris (1972).mkv",
      "Stalker (1979).mkv",
    ]);
    const many = {
      ...SOURCES,
      history: Array.from({ length: 9 }, (_, index) => recent(`Film ${index}.mkv`)),
    };
    expect(rows("", "Recently played", many)).toHaveLength(3);
    // What is open now leads the history: it is not something to go back to.
    const playing = {
      ...SOURCES,
      history: [recent("Episode 1.mkv", { source: "/s/Episode 1.mkv" }), ...SOURCES.history],
    };
    expect(rows("", "Recently played", playing).map((row) => row.name)).toEqual([
      "Solaris (1972).mkv",
      "Stalker (1979).mkv",
    ]);
    // Typed for by name it is found, like anything else that was played.
    expect(rows("episode 1", "Recently played", playing).map((row) => row.name)).toEqual([
      "Episode 1.mkv",
    ]);
    // With nothing saved or played there is nothing to head.
    expect(headings("", { ...SOURCES, saved: [], history: [] })).toEqual([
      "File",
      "Playback",
      "Audio",
      "View",
    ]);
  });

  it("leads with the actions used lately, newest first", () => {
    const sources = { ...SOURCES, recentActions: ["audio.mute", "gone.action", "file.open"] };
    expect(headings("", sources)[0]).toBe("Recently used");
    expect(rows("", "Recently used", sources).map((row) => row.name)).toEqual([
      "Mute",
      "Open file…",
    ]);
  });

  it("shows an action under the name it has now, with its shortcut", () => {
    const [toggle] = rows("", "Playback");
    expect(toggle?.name).toBe("Pause");
    expect(toggle?.shortcut).toBe("Space");
    expect(toggle?.unavailable).toBeUndefined();
  });

  it("does not list the playlist's items or the chapters until something is typed", () => {
    expect(headings("")).not.toContain("Playlist");
    expect(headings("")).not.toContain("Chapters");
  });
});

describe("with something typed", () => {
  it("finds actions and runs the one chosen", () => {
    const run = runners();
    const [found] = rows("mute", "Actions", SOURCES, run);
    expect(found?.name).toBe("Mute");
    expect(found?.action).toBe("audio.mute");
    found?.run();
    expect(run.action).toHaveBeenCalledWith("audio.mute");
  });

  it("finds an action by the name it has now or the one it is listed under", () => {
    expect(rows("pause", "Actions")[0]?.name).toBe("Pause");
    expect(rows("play or", "Actions")[0]?.name).toBe("Pause");
    expect(rows("full", "Actions").map((row) => row.name)).toEqual(["Enter full screen"]);
  });

  it("lists an action that cannot run with the reason, after those that can", () => {
    const found = rows("speed", "Actions");
    expect(found.map((row) => row.name)).toEqual(["Faster", "Normal speed"]);
    expect(found[1]?.unavailable).toBe("Already at normal speed");
    expect(rows("next", "Actions")[0]?.unavailable).toBe("This is the last item");
  });

  it("finds the items of the playlist, marking the one playing", () => {
    const run = runners();
    const found = rows("episode", "Playlist", SOURCES, run);
    expect(found.map((row) => [row.name, row.detail])).toEqual([
      ["Episode 1.mkv", "Playing"],
      ["Episode 2.mkv", undefined],
    ]);
    found[1]?.run();
    expect(run.playItem).toHaveBeenCalledWith(2);
  });

  it("does not offer a playlist of one", () => {
    const alone = { ...SOURCES, queue: { ...QUEUE, items: QUEUE.items.slice(0, 1) } };
    expect(headings("episode", alone)).not.toContain("Playlist");
  });

  it("finds chapters by name or number, with where they start", () => {
    const run = runners();
    expect(rows("station", "Chapters")[0]?.detail).toBe("0:00:00");
    const [second] = rows("chapter 2", "Chapters", SOURCES, run);
    expect(second?.name).toBe("Chapter 2");
    expect(second?.detail).toBe("0:21:00");
    second?.run();
    expect(run.chapter).toHaveBeenCalledWith(1);
  });

  it("finds saved playlists and what was played, saying what is left of each", () => {
    const run = runners();
    const [evening] = rows("even", "Playlists", SOURCES, run);
    expect(evening?.detail).toBe("12 items");
    evening?.run();
    expect(run.openSaved).toHaveBeenCalledWith(7);

    expect(rows("solaris", "Recently played")[0]?.detail).toBe("1 h 19 min left");
    expect(rows("stalker", "Recently played")[0]?.detail).toBe("2 h 2 min");
    // One that has gone is found when asked for, and says why it cannot be opened.
    expect(rows("gone", "Recently played")[0]).toMatchObject({
      detail: "Not found",
      unavailable: "Not found",
    });
    const [solaris] = rows("solaris", "Recently played", SOURCES, run);
    solaris?.run();
    expect(run.openRecent).toHaveBeenCalledWith("/films/Solaris (1972).mkv");
  });

  it("lists everything of a kind when the kind itself is typed", () => {
    expect(rows("saved", "Playlists").map((row) => row.name)).toEqual(["Evening", "Friday night"]);
    expect(rows("chapters", "Chapters").map((row) => row.name)).toEqual([
      "The Station",
      "Chapter 2",
    ]);
    expect(rows("history", "Recently played")).toHaveLength(3);
  });

  it("offers a speed by its figure as typed, and no other", () => {
    const run = runners();
    const found = rows("1.5", "Speed", SOURCES, run);
    expect(found.map((row) => row.name)).toEqual(["Speed 1.5×"]);
    found[0]?.run();
    expect(run.speed).toHaveBeenCalledWith(1.5);
    expect(rows("2", "Speed").map((row) => row.name)).toEqual(["Speed 2×"]);
    expect(rows("2x", "Speed").map((row) => row.name)).toEqual(["Speed 2×"]);
    expect(rows("speed 0.5", "Speed").map((row) => row.name)).toEqual(["Speed 0.5×"]);
    // The start of a figure finds every speed that starts so.
    expect(rows("1.", "Speed").map((row) => row.name)).toEqual([
      "Speed 1.25×",
      "Speed 1.5×",
      "Speed 1.75×",
    ]);
    expect(rows("2x", "Speed", { ...SOURCES, hasMedia: false })[0]?.unavailable).toBe(
      "Nothing is open",
    );
  });

  it("says nothing when nothing answers", () => {
    expect(headings("qqqq")).toEqual([]);
  });
});

describe("what Return would run", () => {
  it("is the best answer that can be done, whatever kind it is", () => {
    // The saved playlist, not an action with those letters somewhere in it.
    expect(first("fri")).toBe("Friday night");
    expect(headings("fri")).toEqual(["Playlists"]);
    // The item of the playlist, not "Enter or exit full screen".
    expect(first("episode 2")).toBe("Episode 2.mkv");
    expect(first("solar")).toBe("Solaris (1972).mkv");
  });

  it("is a step of the speed for the word alone, with every speed listed under it", () => {
    expect(first("speed")).toBe("Faster");
    // Two letters could be the start of "speed" or of "Show playlist": the name leads its other words.
    expect(first("sp")).toBe("Show playlist");
    expect(rows("sp", "Actions").map((row) => row.name)).toEqual([
      "Show playlist",
      "Faster",
      "Normal speed",
    ]);
    const kinds = headings("speed");
    expect(kinds.indexOf("Actions")).toBeLessThan(kinds.indexOf("Speed"));
    expect(rows("speed", "Speed").map((row) => row.name)).toEqual([
      "Speed 0.25×",
      "Speed 0.5×",
      "Speed 0.75×",
      "Speed 1.25×",
      "Speed 1.5×",
      "Speed 1.75×",
      "Speed 2×",
      "Speed 3×",
      "Speed 4×",
    ]);
  });

  it("is never something found by letters scattered through its name", () => {
    expect(rows("mute", "Actions").map((row) => row.name)).toEqual(["Mute"]);
    expect(first("next")).toBeUndefined();
    expect(rows("next", "Actions").map((row) => row.name)).toEqual(["Next item"]);
    expect(headings("delete")).toEqual([]);
    expect(headings("help")).toEqual([]);
  });

  it("answers to the other words for an action, and to the beginnings of its words", () => {
    expect(first("loop")).toBe("Repeat");
    expect(first("louder")).toBe("Volume up");
    expect(rows("shp", "Actions").map((row) => row.name)).toEqual(["Show playlist"]);
  });

  it("puts a kind that can be done before one that cannot", () => {
    // Nothing is open: the speeds cannot be chosen, the saved playlist can.
    const nothing = {
      ...SOURCES,
      hasMedia: false,
      saved: [{ ...SOURCES.saved[0], name: "Speed runs" }],
    };
    const kinds = headings("speed", nothing as PaletteSources);
    expect(kinds.indexOf("Playlists")).toBeLessThan(kinds.indexOf("Speed"));
  });
});

describe("a time", () => {
  it("is offered as somewhere to go, ahead of everything else", () => {
    const run = runners();
    const groups = paletteGroups("1:30:00", "all", SOURCES, run);
    expect(groups[0]?.heading).toBe("Go to");
    expect(groups[0]?.rows[0]?.name).toBe("Go to 1:30:00");
    groups[0]?.rows[0]?.run();
    expect(run.goTo).toHaveBeenCalledWith(5400);
  });

  it("is the only thing found when the palette was opened to go to a time", () => {
    expect(headings("90m", SOURCES, "time")).toEqual(["Go to"]);
    expect(headings("mute", SOURCES, "time")).toEqual([]);
    expect(headings("", SOURCES, "time")).toEqual([]);
  });

  it("takes a bare number both ways when a time is all that was asked for", () => {
    const names = (query: string, sources = SOURCES) =>
      paletteGroups(query, "time", sources, runners()).flatMap((group) =>
        group.rows.map((row) => row.name),
      );
    // In a film of two hours, minutes are the likelier.
    expect(names("90")).toEqual(["Go to 1:30:00", "Go to 0:01:30"]);
    // In a clip of five minutes, seconds are, and ninety minutes is past the end.
    expect(names("90", { ...SOURCES, duration: 300 })).toEqual(["Go to 1:30"]);
    expect(names("0")).toEqual(["Go to 0:00:00"]);
    // Among everything else a number is as likely part of a name.
    expect(headings("90")).not.toContain("Go to");
  });

  it("takes a step from where the film is, in either mode", () => {
    const run = runners();
    const forward = paletteGroups("+30", "time", SOURCES, run)[0]?.rows[0];
    expect(forward?.name).toBe("Go to 0:10:30");
    forward?.run();
    expect(run.goTo).toHaveBeenCalledWith(630);
    expect(paletteGroups("-2m", "all", SOURCES, run)[0]?.rows[0]?.name).toBe("Go to 0:08:00");
    // Never before the beginning.
    expect(paletteGroups("-1h", "time", SOURCES, run)[0]?.rows[0]?.name).toBe("Go to 0:00:00");
  });

  it("cannot be gone to past the end, or with nothing open", () => {
    const past = paletteGroups("3:00:00", "time", SOURCES, runners())[0]?.rows[0];
    expect(past?.unavailable).toBe("It is 2:01:45 long");
    const nothing = paletteGroups("1:00", "time", { ...SOURCES, hasMedia: false }, runners())[0]
      ?.rows[0];
    expect(nothing?.unavailable).toBe("Nothing is open");
  });
});

describe("addresses", () => {
  it("offers to play a pasted address first, and to add it to the playlist", () => {
    const run = runners();
    const groups = paletteGroups("https://vimeo.com/76979871", "all", SOURCES, run);
    expect(groups[0]?.heading).toBe("Address");
    expect(groups[0]?.rows.map((row) => row.name)).toEqual([
      "Play vimeo.com/76979871",
      "Add to playlist",
    ]);
    groups[0]?.rows[0]?.run();
    expect(run.openAddress).toHaveBeenCalledWith("https://vimeo.com/76979871");
    groups[0]?.rows[1]?.run();
    expect(run.addAddress).toHaveBeenCalledWith("https://vimeo.com/76979871");
  });

  it("does not offer to add when there is no playlist", () => {
    const empty = { ...SOURCES, queue: { ...SOURCES.queue, items: [] } };
    const groups = paletteGroups("youtube.com/watch?v=abc", "address", empty, runners());
    expect(groups.map((group) => group.rows.map((row) => row.name))).toEqual([
      ["Play youtube.com/watch?v=abc"],
    ]);
  });

  it("finds nothing else when opened for an address", () => {
    expect(headings("speed", SOURCES, "address")).toEqual([]);
    expect(headings("", SOURCES, "address")).toEqual([]);
  });

  it("is not offered for words", () => {
    expect(headings("solaris")).not.toContain("Address");
  });
});
