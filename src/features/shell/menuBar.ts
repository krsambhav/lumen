import { allActions, getAction, runAction } from "@/actions/registry";
import { isTauri } from "@/app/boot";
import { chooseAudio } from "@/features/audio/actions";
import { playRecent, useRecents } from "@/features/library/recents";
import { needsMedia, setSpeed } from "@/features/player/actions";
import { formatSpeed, isNormalSpeed, nearestSpeed, SPEEDS } from "@/features/player/speed";
import { usePlayer } from "@/features/player/store";
import {
  playingAudio,
  secondSubtitle,
  shownSubtitle,
  trackName,
  tracksOf,
} from "@/features/player/tracks";
import { useWindowState } from "@/features/player/window";
import { REPEAT_CHOICES, setRepeat } from "@/features/playlist/actions";
import { openSaved, useSaved } from "@/features/playlist/saved";
import { useQueue } from "@/features/playlist/store";
import { useSettings } from "@/features/settings/store";
import { chooseSubtitles } from "@/features/subtitles/actions";
import { setAspect, setCrop } from "@/features/video/actions";
import { RATIOS, sameRatio } from "@/features/video/shape";
import {
  commands,
  events,
  type MenuEntry,
  type MenuSection,
  type Subscription,
  subscription,
} from "@/ipc";
import { send as sendCommand } from "@/lib/notify";
import { useInterface } from "./interface";

/**
 * One of the things a submenu offers that is not a registered action: one
 * speed of several, one thing that was played. It has no key of its own.
 */
export interface MenuChoice {
  /**
   * Unique in the menu bar. Usually not the id of a registered action; when
   * it is one, the choice is that action's item (its key is shown, and
   * choosing it runs the action), listed among the choices it belongs with.
   */
  id: string;
  name: string;
  /** A name that is not Lumen's to recapitalise: a film's (DESIGN.md §10). */
  verbatim?: boolean;
  /** For one of several: whether it is the one in force. Every choice of the set has it. */
  checked?: boolean;
  /** False for a choice that cannot be made now. */
  enabled?: boolean;
  run: () => void;
}

/** An action's id, "-" for a separator, or a choice. */
type Item = string | MenuChoice;

/** A menu within a menu. What is in it can follow the app's state. */
interface Submenu {
  submenu: string;
  items: () => readonly Item[];
}

/** How many things File ▸ Open Recent lists (DESIGN.md §8). */
export const RECENT_ITEMS = 10;
/** A name longer than this is shortened in the middle: a menu is not a place to read a path. */
const LONGEST_NAME = 56;

/** Keeps both ends of a long name: the start says which film, the end which file. */
function shortened(name: string): string {
  if (name.length <= LONGEST_NAME) {
    return name;
  }
  const tail = 16;
  return `${name.slice(0, LONGEST_NAME - tail - 1).trimEnd()}…${name.slice(-tail).trimStart()}`;
}

function recentItems(): Item[] {
  const recents = useRecents.getState().entries.slice(0, RECENT_ITEMS);
  const items: Item[] = recents.map((entry, index) => ({
    // By place, so the menus are only touched up when the list moves along.
    id: `recent:${index}`,
    name: shortened(entry.title),
    verbatim: true,
    enabled: entry.available,
    run: () => playRecent(entry.source),
  }));
  return recents.length > 0 ? [...items, "-", "history.clear"] : ["history.clear"];
}

function speedItems(): Item[] {
  const marked = nearestSpeed(usePlayer.getState().speed);
  const enabled = needsMedia() === undefined;
  const speeds = SPEEDS.map(
    (speed): MenuChoice => ({
      // Normal speed is an action with a key of its own: it is listed here,
      // among the speeds, as the one it is, and not a second time beside them.
      id: isNormalSpeed(speed) ? "playback.normalSpeed" : `speed:${speed}`,
      name: isNormalSpeed(speed) ? "Normal" : formatSpeed(speed),
      checked: speed === marked,
      enabled,
      run: () => setSpeed({ source: "menu" }, speed),
    }),
  );
  return ["playback.faster", "playback.slower", "-", ...speeds];
}

function playlistItems(): Item[] {
  const saved = useSaved.getState().entries;
  if (saved.length === 0) {
    // A submenu with nothing in it would open on nothing.
    return [{ id: "playlists:none", name: "No saved playlists", enabled: false, run: () => {} }];
  }
  return saved.map((playlist) => ({
    id: `playlist:${playlist.id}`,
    name: shortened(playlist.name),
    verbatim: true,
    run: () => openSaved(playlist),
  }));
}

/** A row for a set of choices that has none to offer: a submenu with nothing in it would open on nothing. */
function nothing(id: string, name: string): MenuChoice {
  return { id, name, enabled: false, run: () => {} };
}

function audioTrackItems(): Item[] {
  const tracks = tracksOf(usePlayer.getState().tracks, "audio");
  if (tracks.length === 0) {
    return [nothing("audio:none", "No audio tracks")];
  }
  const playing = playingAudio(tracks)?.id;
  return tracks.map((track) => ({
    id: `audio:${track.id}`,
    name: shortened(trackName(track)),
    verbatim: true,
    checked: track.id === playing,
    run: () => chooseAudio({ source: "menu" }, track),
  }));
}

function subtitleTrackItems(): Item[] {
  const all = usePlayer.getState().tracks;
  const tracks = tracksOf(all, "subtitle");
  if (tracks.length === 0) {
    return [nothing("subtitle:none", "No subtitle tracks")];
  }
  const shown = shownSubtitle(all)?.id;
  return [
    {
      id: "subtitle:off",
      name: "Off",
      checked: shown === undefined,
      run: () => chooseSubtitles({ source: "menu" }, null),
    },
    "-",
    ...tracks.map(
      (track): MenuChoice => ({
        id: `subtitle:${track.id}`,
        name: shortened(trackName(track)),
        verbatim: true,
        checked: track.id === shown,
        run: () => chooseSubtitles({ source: "menu" }, track),
      }),
    ),
  ];
}

function secondSubtitleItems(): Item[] {
  const all = usePlayer.getState().tracks;
  const first = shownSubtitle(all);
  // Any track but the one already showing can be shown with it.
  const others = tracksOf(all, "subtitle").filter((track) => track.id !== first?.id);
  if (first === undefined || others.length === 0) {
    return [nothing("second:unavailable", "No other subtitle tracks")];
  }
  const second = secondSubtitle(all)?.id;
  const choose = (id: number | null) =>
    sendCommand("change the second subtitles", commands.playerSelectSecondSubtitle(id));
  return [
    { id: "second:none", name: "None", checked: second === undefined, run: () => choose(null) },
    "-",
    ...others.map(
      (track): MenuChoice => ({
        id: `second:${track.id}`,
        name: shortened(trackName(track)),
        verbatim: true,
        checked: track.id === second,
        run: () => choose(track.id),
      }),
    ),
  ];
}

/** The shapes a picture can be shown in, or cut to: the file's own first. */
function ratioItems(kind: "aspect" | "crop"): Item[] {
  const { shape, video } = usePlayer.getState();
  const current = kind === "aspect" ? shape.aspect : shape.crop;
  const enabled = needsMedia() === undefined && video !== null;
  const choose = kind === "aspect" ? setAspect : setCrop;
  return [
    {
      id: `${kind}:own`,
      name: kind === "aspect" ? "Original" : "None",
      checked: current === null,
      enabled,
      run: () => choose({ source: "menu" }, null),
    },
    "-",
    ...RATIOS.map(
      (named): MenuChoice => ({
        id: `${kind}:${named.name}`,
        name: named.name,
        verbatim: true,
        checked: sameRatio(current, named.ratio),
        enabled,
        run: () => choose({ source: "menu" }, named.ratio),
      }),
    ),
  ];
}

function repeatItems(): Item[] {
  const { repeat } = useQueue.getState();
  return REPEAT_CHOICES.map((choice) => ({
    id: `repeat:${choice.value}`,
    name: choice.name,
    checked: choice.value === repeat,
    run: () => setRepeat({ source: "menu" }, choice.value),
  }));
}

/**
 * The menu bar's menus that hold actions, in order (DESIGN.md §8): each a
 * list of action ids, with "-" for a separator and a submenu where there is
 * one of several to choose. The backend adds the app's own menu, Edit,
 * Window and Help around them.
 */
export const MENU_BAR: readonly { name: string; items: readonly (string | Submenu)[] }[] = [
  {
    name: "File",
    items: [
      "file.open",
      "file.openFolder",
      "file.openAddress",
      "file.searchTorrents",
      "file.nextEpisode",
      { submenu: "Open recent", items: recentItems },
      { submenu: "Open playlist", items: playlistItems },
      "file.add",
      "-",
      "file.close",
      "file.reveal",
      "-",
      "playlist.save",
      "playlist.clear",
    ],
  },
  {
    name: "Playback",
    items: [
      "playback.toggle",
      "playback.stop",
      "-",
      "playback.forward",
      "playback.back",
      "playback.forward10",
      "playback.back10",
      "playback.forwardMinute",
      "playback.backMinute",
      "playback.start",
      "playback.goToTime",
      // 0–9: a tenth of the way through each, with its digit as the key.
      {
        submenu: "Jump to",
        items: () => Array.from({ length: 10 }, (_, tenth) => `playback.tenth${tenth}`),
      },
      "-",
      "playback.nextFrame",
      "playback.previousFrame",
      "-",
      { submenu: "Speed", items: speedItems },
      "-",
      "playlist.next",
      "playlist.previous",
      "playback.nextChapter",
      "playback.previousChapter",
      "playback.skipSegment",
      "-",
      { submenu: "Repeat", items: repeatItems },
      "playlist.shuffle",
      "-",
      "cast.devices",
      "cast.stop",
    ],
  },
  {
    name: "Audio",
    items: [
      "audio.volumeUp",
      "audio.volumeDown",
      "audio.mute",
      "-",
      { submenu: "Audio track", items: audioTrackItems },
      "audio.nextTrack",
      "-",
      "audio.later",
      "audio.earlier",
      "audio.resetDelay",
      "-",
      "audio.equaliser",
    ],
  },
  {
    name: "Video",
    items: [
      { submenu: "Aspect", items: () => ratioItems("aspect") },
      { submenu: "Crop", items: () => ratioItems("crop") },
      "-",
      "video.zoomIn",
      "video.zoomOut",
      "-",
      "video.rotate",
      "video.rotateBack",
      "video.mirror",
      "video.flip",
      "-",
      "video.deinterlace",
      "-",
      "video.resetFrame",
      "video.resetPicture",
    ],
  },
  {
    name: "Subtitles",
    items: [
      "subtitles.toggle",
      { submenu: "Subtitle track", items: subtitleTrackItems },
      "subtitles.next",
      { submenu: "Second track", items: secondSubtitleItems },
      "-",
      "subtitles.add",
      "-",
      "subtitles.later",
      "subtitles.earlier",
      "subtitles.resetDelay",
      "subtitles.sync",
    ],
  },
  {
    name: "View",
    items: [
      "view.palette",
      "-",
      "view.playlist",
      "view.chapters",
      "view.video",
      "view.audio",
      "view.subtitles",
      "-",
      "view.fullscreen",
      "window.keepOnTop",
      "-",
      "view.notifications",
    ],
  },
];

/**
 * Actions that have no item of their own in the menu bar, and why. Escape
 * leaves full screen, which the item for full screen in View already does.
 * The key that steps through the repeat modes has the Repeat submenu, which
 * names all three, in its place. Undo is in the Edit menu, which is the
 * system's own: its item there is what makes ⌘Z work in a text field, and
 * outside one the page hears the key first.
 */
export const NOT_IN_THE_MENU_BAR: readonly string[] = [
  "view.exitFullscreen",
  "playlist.repeat",
  "edit.undo",
];

/** Words that stay small inside a name in the system's title style. */
const SMALL_WORDS = new Set([
  ..."a an the and but for nor or so yet as at by in of on per to via".split(" "),
]);

/**
 * A name in the title style of the menu bar (DESIGN.md §10): every word
 * capitalised, except an article, conjunction or short preposition inside
 * the name. A word with a capital already in it ("AirPlay", "macOS") is left
 * exactly as it is written.
 */
export function titleStyle(name: string): string {
  const words = name.split(" ");
  return words
    .map((word, index) => {
      if (/\p{Lu}/u.test(word)) {
        return word;
      }
      const inside = index > 0 && index < words.length - 1;
      if (inside && SMALL_WORDS.has(word.replace(/[^\p{L}]/gu, ""))) {
        return word;
      }
      return word.replace(/\p{L}/u, (letter) => letter.toUpperCase());
    })
    .join(" ");
}

function entries(items: readonly (Item | Submenu)[]): MenuEntry[] {
  return items.flatMap((item): MenuEntry[] => {
    if (item === "-") {
      return [{ kind: "separator" }];
    }
    if (typeof item === "string") {
      const action = getAction(item);
      if (!action) {
        return [];
      }
      return [
        {
          kind: "action",
          id: item,
          name: titleStyle(action.label?.() ?? action.name),
          shortcut: action.shortcuts[0] ?? null,
          enabled: action.unavailable?.() === undefined,
          checked: action.checked?.() ?? null,
        },
      ];
    }
    if ("submenu" in item) {
      return [{ kind: "submenu", name: titleStyle(item.submenu), items: entries(item.items()) }];
    }
    return [
      {
        kind: "action",
        id: item.id,
        name: item.verbatim ? item.name : titleStyle(item.name),
        // A choice that stands for an action is chosen by that action's key too.
        shortcut: getAction(item.id)?.shortcuts[0] ?? null,
        enabled: item.enabled ?? true,
        checked: item.checked ?? null,
      },
    ];
  });
}

/** The menu bar as it should stand right now. */
export function menuSections(): MenuSection[] {
  return MENU_BAR.map((menu) => ({ name: menu.name, items: entries(menu.items) }));
}

/** Everything in the menus' submenus, as they stand right now. */
function submenuItems(): Item[] {
  return MENU_BAR.flatMap((menu) =>
    menu.items.flatMap((item) => (typeof item === "string" ? [] : item.items())),
  );
}

/** Does what the chosen item of the menu bar is for. */
export function runMenuItem(id: string): void {
  // A choice first: one that stands for an action does what the choice says
  // (the menu shows "Normal" ticked and enabled at normal speed, where the
  // action alone would have nothing to do).
  for (const item of submenuItems()) {
    if (typeof item !== "string" && item.id === id) {
      if (item.enabled ?? true) {
        item.run();
      }
      return;
    }
  }
  if (getAction(id)) {
    runAction(id, "menu");
  }
}

/** How long after the last change the menu bar is brought up to date. */
const SETTLE_MS = 80;
/**
 * How often it is looked at again while only the film's position moves. The
 * position is reported ten times a second, and the one thing in the menus
 * that follows it (whether there is a next chapter) changes a few times in
 * a film.
 */
const WHILE_PLAYING_MS = 1000;

/** Whether two states of the player differ in nothing but where the film is. */
function onlyTimeMoved(
  now: ReturnType<typeof usePlayer.getState>,
  before: ReturnType<typeof usePlayer.getState>,
): boolean {
  for (const key of Object.keys(now) as (keyof typeof now)[]) {
    if (key !== "position" && key !== "positionAt" && now[key] !== before[key]) {
      return false;
    }
  }
  return true;
}

/**
 * Keeps the menu bar in step with the registry (names, shortcuts, ticks and
 * what is available all follow the app's state), and runs the action of an
 * item that is chosen.
 */
export function connectMenuBar(): Subscription {
  if (!isTauri()) {
    return { ready: Promise.resolve(), stop: () => {} };
  }
  const listening = subscription(
    events.menuAction.listen((event) => {
      runMenuItem(event.payload);
    }),
  );

  let sent = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let slow: ReturnType<typeof setTimeout> | undefined;
  const send = () => {
    clearTimeout(slow);
    slow = undefined;
    const sections = menuSections();
    const next = JSON.stringify(sections);
    if (next !== sent) {
      sent = next;
      // A menu bar that cannot be made is not worth interrupting anyone for; the keys still work.
      void commands.menuSet(sections);
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(send, SETTLE_MS);
  };
  const eventually = () => {
    slow ??= setTimeout(send, WHILE_PLAYING_MS);
  };
  send();
  // Everything an action's name, tick or availability can depend on.
  const unsubscribes = [
    usePlayer.subscribe((now, before) => (onlyTimeMoved(now, before) ? eventually() : later())),
    ...[useQueue, useWindowState, useInterface, useRecents, useSaved, useSettings].map((store) =>
      store.subscribe(later),
    ),
  ];

  return {
    ready: listening.ready,
    stop: () => {
      clearTimeout(timer);
      clearTimeout(slow);
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      listening.stop();
    },
  };
}

/** The id of every action the menu bar has an item for, in a menu or in a submenu of one. */
export function placedActions(): string[] {
  const top = MENU_BAR.flatMap((menu) => menu.items);
  return [...top, ...submenuItems()]
    .map((item) => (typeof item === "string" ? item : "submenu" in item ? "-" : item.id))
    .filter((id) => id !== "-" && getAction(id) !== undefined);
}

/** Ids of registered actions that are neither in the menu bar nor excused from it. For a test. */
export function actionsMissingFromTheMenuBar(): string[] {
  const placed = new Set(placedActions());
  return allActions()
    .map((action) => action.id)
    .filter((id) => !placed.has(id) && !NOT_IN_THE_MENU_BAR.includes(id));
}
