import {
  BookOpen,
  Clock,
  Gauge,
  History,
  Link,
  ListMusic,
  ListPlus,
  ListVideo,
} from "lucide-react";
import { type Action, CATEGORIES } from "@/actions/registry";
import { chapterName } from "@/features/player/chapters";
import { formatSpeed, isNormalSpeed, SPEEDS } from "@/features/player/speed";
import { readAddress, shortAddress } from "@/features/playlist/address";
import type { Chapter, QueueSnapshot, Recent, SavedPlaylist } from "@/ipc";
import { formatTimecode, parseTime, readTimes, shortDuration } from "@/lib/timecode";
import { ranked, score } from "./search";
import type { PaletteMode } from "./store";

/** One row of the palette. */
export interface PaletteRow {
  /** Unique among the rows shown. */
  key: string;
  name: string;
  icon?: Action["icon"];
  /** Chord text, shown at the trailing edge. */
  shortcut?: string | undefined;
  /** A short value at the trailing edge, where there is no shortcut. */
  detail?: string | undefined;
  /** Why the row cannot be chosen now. It is shown in place of the shortcut. */
  unavailable?: string | undefined;
  /** The registered action the row runs, for "recently used". */
  action?: string;
  run: () => void;
}

export interface PaletteGroup {
  heading: string;
  rows: PaletteRow[];
}

/** Everything the palette can find, as it is at this moment. */
export interface PaletteSources {
  actions: readonly Action[];
  /** Ids of the actions last run from the palette, newest first. */
  recentActions: readonly string[];
  queue: QueueSnapshot;
  chapters: readonly Chapter[];
  /** The open film's length, or `null` if nothing is open or it has none. */
  duration: number | null;
  /** Where the open film is, in seconds: what a step ("+30") is taken from. */
  position: number;
  hasMedia: boolean;
  history: readonly Recent[];
  saved: readonly SavedPlaylist[];
}

/** What choosing a row does. Passed in, so the rows can be made and tested without the app. */
export interface PaletteRunners {
  action: (id: string) => void;
  goTo: (seconds: number) => void;
  speed: (rate: number) => void;
  playItem: (id: number) => void;
  chapter: (index: number) => void;
  openSaved: (id: number) => void;
  openRecent: (source: string) => void;
  /** Plays an address in place of the playlist. */
  openAddress: (address: string) => void;
  /** Adds an address to the end of the playlist. */
  addAddress: (address: string) => void;
}

/** The palette's own action is not offered inside the palette. */
const NOT_LISTED = new Set(["view.palette"]);

const ACTIONS_SHOWN = 8;
const OTHERS_SHOWN = 6;
const RECENTLY_USED_SHOWN = 5;
/** With nothing typed, this many saved playlists and this many things played lately (DESIGN.md §7). */
const AT_HAND_SHOWN = 3;

/** How well a row answers when what was typed names its kind ("chapters"), not the row itself. */
const OF_THE_KIND = 30;
/** A time typed is a time: nothing else could have been meant. */
const A_TIME = 200;
/** So is an address. */
const AN_ADDRESS = 200;

/** A row, with how well it answers what was typed. */
interface Answer {
  row: PaletteRow;
  score: number;
}

/** The rows of one kind that answer, and how many of them to show. */
interface Answers {
  heading: string;
  answers: Answer[];
  limit: number;
}

function actionRow(action: Action, run: PaletteRunners, group: string): PaletteRow {
  return {
    key: `${group}:${action.id}`,
    // The name it has now: what choosing it will do.
    name: action.label?.() ?? action.name,
    icon: action.icon,
    shortcut: action.shortcuts[0],
    unavailable: action.unavailable?.(),
    action: action.id,
    run: () => run.action(action.id),
  };
}

function timeRow(
  seconds: number,
  key: string,
  sources: PaletteSources,
  run: PaletteRunners,
): PaletteRow {
  const { duration, hasMedia } = sources;
  const unavailable = !hasMedia
    ? "Nothing is open"
    : duration === null
      ? "This cannot be moved through"
      : seconds > duration
        ? `It is ${formatTimecode(duration)} long`
        : undefined;
  return {
    key,
    name: `Go to ${formatTimecode(seconds, duration ?? seconds)}`,
    icon: Clock,
    unavailable,
    run: () => run.goTo(seconds),
  };
}

/** The places in the film that what was typed could mean. */
function timeAnswers(
  query: string,
  mode: PaletteMode,
  sources: PaletteSources,
  run: PaletteRunners,
): Answers[] {
  // Asked for a time alone, a bare number is one, and is offered both ways.
  // Among everything else it is as likely to be part of a name.
  const strict = parseTime(query, sources.duration);
  const times =
    mode === "time" || /^[+\-−]/.test(query.trim())
      ? readTimes(query, { duration: sources.duration, position: sources.position })
      : strict === null
        ? []
        : [strict];
  if (times.length === 0) {
    return [];
  }
  const rows = times.map((seconds, index) => timeRow(seconds, `time:${index}`, sources, run));
  // Of two readings, one that is past the end is not worth offering beside one that is not.
  const possible = rows.filter((row) => row.unavailable === undefined);
  const shown = possible.length > 0 ? possible : rows.slice(0, 1);
  return [
    {
      heading: "Go to",
      answers: shown.map((row, index) => ({ row, score: A_TIME - index })),
      limit: shown.length,
    },
  ];
}

/** What can be done with an address that was typed or pasted: play it, or add it to the playlist. */
function addressAnswers(query: string, sources: PaletteSources, run: PaletteRunners): Answers[] {
  const address = readAddress(query);
  if (address === null) {
    return [];
  }
  const rows: PaletteRow[] = [
    {
      key: "address:play",
      name: `Play ${shortAddress(address)}`,
      icon: Link,
      run: () => run.openAddress(address),
    },
  ];
  // Adding is only different from playing when there is a playlist to add to.
  if (sources.queue.items.length > 0) {
    rows.push({
      key: "address:add",
      name: "Add to playlist",
      icon: ListPlus,
      run: () => run.addAddress(address),
    });
  }
  return [
    {
      heading: "Address",
      answers: rows.map((row, index) => ({ row, score: AN_ADDRESS - index })),
      limit: rows.length,
    },
  ];
}

function left(entry: Recent): string | undefined {
  if (!entry.available) {
    return "Not found";
  }
  if (entry.duration === null) {
    return undefined;
  }
  return entry.resumesAt === null
    ? shortDuration(entry.duration)
    : `${shortDuration(entry.duration - entry.position)} left`;
}

function savedRow(playlist: SavedPlaylist, run: PaletteRunners): PaletteRow {
  return {
    key: `saved:${playlist.id}`,
    name: playlist.name,
    icon: ListMusic,
    detail: playlist.count === 1 ? "1 item" : `${playlist.count} items`,
    run: () => run.openSaved(playlist.id),
  };
}

function recentRow(entry: Recent, run: PaletteRunners): PaletteRow {
  return {
    key: `recent:${entry.source}`,
    name: entry.title,
    icon: History,
    detail: left(entry),
    unavailable: entry.available ? undefined : "Not found",
    run: () => run.openRecent(entry.source),
  };
}

/**
 * The things of one kind that answer `typed`: each by its own name, or all
 * of them, a little, when what was typed is the name of the kind
 * ("chapters", "saved").
 */
function ofAKind<T>(
  typed: string,
  items: readonly T[],
  name: (item: T) => string,
  kind: readonly string[],
): { item: T; score: number }[] {
  const found = ranked(typed, items, name);
  if (found.length > 0 || score(typed, kind.join(" ")) === 0) {
    return found;
  }
  return items.map((item) => ({ item, score: OF_THE_KIND }));
}

/** How well a speed answers: by its figure as typed, or a little for the word "speed" alone. */
function speedScore(typed: string, rate: number): number {
  const figure = String(rate);
  let found = 0;
  for (const word of typed.toLowerCase().split(/\s+/).filter(Boolean)) {
    const number = /^(\d+(?:[.,]\d*)?)[x×]?$/.exec(word)?.[1]?.replace(",", ".");
    if (number !== undefined) {
      // The figure as typed: "1.5" is that speed and no other, "1." any that starts so.
      const exact = Number(number) === rate && !number.endsWith(".");
      if (!exact && !figure.startsWith(number)) {
        return 0;
      }
      found = Math.max(found, exact ? 100 : 80);
    } else if (word.length >= 2 && "speed".startsWith(word)) {
      found = Math.max(found, OF_THE_KIND);
    } else {
      return 0;
    }
  }
  return found;
}

/**
 * Puts what was found in order (DESIGN.md §7): within a kind the best
 * answer first, and what cannot be done now after what can; among kinds,
 * the one with the best answer that can be done first. Return then runs the
 * best thing that is possible.
 */
function arrange(found: readonly Answers[]): PaletteGroup[] {
  const possible = (answer: Answer) => answer.row.unavailable === undefined;
  const groups = found
    .filter((group) => group.answers.length > 0)
    .map((group, index) => {
      // A stable sort: equal answers keep the order they were given in.
      const answers = [...group.answers].sort(
        (a, b) => Number(possible(b)) - Number(possible(a)) || b.score - a.score,
      );
      const first = answers[0];
      return {
        index,
        heading: group.heading,
        rows: answers.slice(0, group.limit).map((answer) => answer.row),
        possible: first !== undefined && possible(first),
        score: first?.score ?? 0,
      };
    });
  groups.sort(
    (a, b) => Number(b.possible) - Number(a.possible) || b.score - a.score || a.index - b.index,
  );
  return groups.map(({ heading, rows }) => ({ heading, rows }));
}

/** With nothing typed: what was used lately, what is at hand to open, and what can be done now. */
function atRest(
  listed: readonly Action[],
  sources: PaletteSources,
  run: PaletteRunners,
): PaletteGroup[] {
  // What cannot be done now is found by typing its name; listed here it
  // would be most of the list on the home screen, all saying the same thing.
  const possible = listed.filter((action) => action.unavailable?.() === undefined);
  const groups: PaletteGroup[] = [];
  const recent = sources.recentActions
    .map((id) => possible.find((action) => action.id === id))
    .filter((action): action is Action => action !== undefined)
    .slice(0, RECENTLY_USED_SHOWN);
  if (recent.length > 0) {
    groups.push({
      heading: "Recently used",
      rows: recent.map((action) => actionRow(action, run, "recent")),
    });
  }
  if (sources.saved.length > 0) {
    groups.push({
      heading: "Playlists",
      rows: sources.saved.slice(0, AT_HAND_SHOWN).map((playlist) => savedRow(playlist, run)),
    });
  }
  // What is open now leads the history, and is not something to go back to.
  const open = sources.queue.items.find((item) => item.id === sources.queue.current)?.source;
  const played = sources.history
    .filter((entry) => entry.available && entry.source !== open)
    .slice(0, AT_HAND_SHOWN);
  if (played.length > 0) {
    groups.push({
      heading: "Recently played",
      rows: played.map((entry) => recentRow(entry, run)),
    });
  }
  for (const category of CATEGORIES) {
    const rows = possible
      .filter((action) => action.category === category.id)
      .map((action) => actionRow(action, run, "all"));
    if (rows.length > 0) {
      groups.push({ heading: category.name, rows });
    }
  }
  return groups;
}

/**
 * The rows to show for what has been typed (DESIGN.md §7, "Command
 * palette"). With nothing typed: what was used lately, what is at hand, and
 * every action that can be done now, by category. With something typed:
 * whatever answers it, of every kind, the best answer first.
 */
export function paletteGroups(
  query: string,
  mode: PaletteMode,
  sources: PaletteSources,
  run: PaletteRunners,
): PaletteGroup[] {
  const typed = query.trim();
  if (mode === "time") {
    return arrange(timeAnswers(typed, mode, sources, run));
  }
  if (mode === "address") {
    return arrange(addressAnswers(typed, sources, run));
  }
  const listed = sources.actions.filter((action) => !NOT_LISTED.has(action.id) && !action.unlisted);
  if (typed === "") {
    return atRest(listed, sources, run);
  }

  // An address pasted into the palette is something to play, whatever it was opened for.
  const found: Answers[] = [
    ...addressAnswers(typed, sources, run),
    ...timeAnswers(typed, mode, sources, run),
  ];

  found.push({
    heading: "Actions",
    limit: ACTIONS_SHOWN,
    answers: listed
      .map((action) => {
        // By the name it has now or the one it is listed under, whichever answers better.
        const keywords = action.keywords ?? [];
        const now = action.label?.();
        const byName = score(typed, action.name, keywords);
        const byLabel = now === undefined ? 0 : score(typed, now, keywords);
        return { row: actionRow(action, run, "found"), score: Math.max(byName, byLabel) };
      })
      .filter((answer) => answer.score > 0),
  });

  found.push({
    heading: "Speed",
    limit: SPEEDS.length,
    answers: SPEEDS.filter((rate) => !isNormalSpeed(rate))
      .map((rate) => ({
        row: {
          key: `speed:${rate}`,
          name: `Speed ${formatSpeed(rate)}`,
          icon: Gauge,
          unavailable: sources.hasMedia ? undefined : "Nothing is open",
          run: () => run.speed(rate),
        },
        score: speedScore(typed, rate),
      }))
      .filter((answer) => answer.score > 0),
  });

  if (sources.queue.items.length > 1) {
    found.push({
      heading: "Playlist",
      limit: OTHERS_SHOWN,
      answers: ranked(typed, sources.queue.items, (item) => item.title).map(
        ({ item, score: answers }) => ({
          score: answers,
          row: {
            key: `item:${item.id}`,
            name: item.title,
            icon: ListVideo,
            detail:
              item.id === sources.queue.current
                ? "Playing"
                : item.duration === null
                  ? undefined
                  : formatTimecode(item.duration),
            run: () => run.playItem(item.id),
          },
        }),
      ),
    });
  }

  found.push({
    heading: "Chapters",
    limit: OTHERS_SHOWN,
    answers: ofAKind(
      typed,
      sources.chapters.map((chapter, index) => ({ chapter, index })),
      (entry) => chapterName(entry.chapter, entry.index),
      ["chapters", "scenes"],
    ).map(({ item: { chapter, index }, score: answers }) => ({
      score: answers,
      row: {
        key: `chapter:${index}`,
        name: chapterName(chapter, index),
        icon: BookOpen,
        detail: formatTimecode(chapter.time, sources.duration ?? chapter.time),
        run: () => run.chapter(index),
      },
    })),
  });

  found.push({
    heading: "Playlists",
    limit: OTHERS_SHOWN,
    answers: ofAKind(typed, sources.saved, (playlist) => playlist.name, ["playlists", "saved"]).map(
      ({ item, score: answers }) => ({ score: answers, row: savedRow(item, run) }),
    ),
  });

  found.push({
    heading: "Recently played",
    limit: OTHERS_SHOWN,
    answers: ofAKind(typed, sources.history, (entry) => entry.title, [
      "recently played",
      "history",
      "watched",
    ]).map(({ item, score: answers }) => ({ score: answers, row: recentRow(item, run) })),
  });

  return arrange(found);
}
