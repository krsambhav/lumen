import { skippableKind } from "@/features/player/chapters";
import type { Chapter } from "@/ipc";

/** An episode of a show, as a release or file name gives it. */
export interface Episode {
  /** The show's name as written before the episode number: "MobLand", "The Americans 2013". */
  show: string;
  season: number;
  episode: number;
}

/** "S02E09", "s2e9", "S02.E09", "S02 E09". */
const SEASON_EPISODE = /^(.*?)[\s._\-[(]*\bS(\d{1,2})[\s._-]?E(\d{1,3})(?!\d)/i;
/** "2x09". */
const CROSS = /^(.*?)[\s._\-[(]*\b(\d{1,2})x(\d{2,3})(?!\d)/i;

/** The show's name with the dots and underscores of a release name turned back into spaces. */
function cleanShow(raw: string): string {
  return raw
    .replace(/[._]+/g, " ")
    .replace(/[\s\-[(]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** What episode a title names, or `null` if it names none. */
export function episodeOf(title: string | null | undefined): Episode | null {
  if (!title) {
    return null;
  }
  // Dots and underscores separate words in release names; read them as spaces,
  // so that "show_s1e10" is seen as a word and a number.
  const text = title.replace(/[._]+/g, " ");
  const found = SEASON_EPISODE.exec(text) ?? CROSS.exec(text);
  if (!found) {
    return null;
  }
  const show = cleanShow(found[1] ?? "");
  const season = Number(found[2]);
  const episode = Number(found[3]);
  if (show === "" || !Number.isFinite(season) || !Number.isFinite(episode)) {
    return null;
  }
  return { show, season, episode };
}

const two = (n: number) => String(n).padStart(2, "0");

/** The search for an episode: "MobLand S02E10". */
export function searchFor(episode: Episode): string {
  return `${episode.show} S${two(episode.season)}E${two(episode.episode)}`;
}

/** The episode after this one, in the same season. */
export function nextInSeason(episode: Episode): Episode {
  return { ...episode, episode: episode.episode + 1 };
}

/** The first episode of the next season, for after a season's last. */
export function firstOfNextSeason(episode: Episode): Episode {
  return { ...episode, season: episode.season + 1, episode: 1 };
}

/** A show's name reduced to what tells it apart: letters and digits, no year, lower case. */
function key(show: string): string {
  return show
    .toLowerCase()
    .replace(/\b(19|20)\d{2}\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/** Whether a release is that very episode of that show (not a season pack, not another episode). */
export function isEpisode(name: string, wanted: Episode): boolean {
  const found = episodeOf(name);
  return (
    found !== null &&
    found.season === wanted.season &&
    found.episode === wanted.episode &&
    key(found.show) !== "" &&
    key(found.show) === key(wanted.show)
  );
}

/** A chapter that holds the end credits: not the opening ones, and in the second half. */
const CREDITS = /\b(credits|outro|ending|closing|end titles)\b/i;

/** How long before the end (or before the end credits) the next episode is looked for, in seconds. */
export const LOOK_BEFORE_END = 60;
export const LOOK_BEFORE_CREDITS = 30;

/**
 * When to look for the next episode: 30 s before the end credits start, if
 * a chapter says where they are; else a minute before the end. `null` for
 * something too short to be an episode.
 */
export function lookAt(chapters: readonly Chapter[], duration: number | null): number | null {
  if (duration === null || duration < 300) {
    return null;
  }
  const credits = chapters.find(
    (chapter) =>
      chapter.time > duration / 2 &&
      CREDITS.test(chapter.title ?? "") &&
      skippableKind(chapter.title) !== "intro",
  );
  if (credits) {
    return Math.max(0, credits.time - LOOK_BEFORE_CREDITS);
  }
  return Math.max(0, duration - LOOK_BEFORE_END);
}
