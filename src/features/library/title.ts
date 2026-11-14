import { episodeOf } from "@/features/torrents/episode";

/** A title as a person would write it, from a file or release name. */
export interface ReadTitle {
  /** The film or the show: "MobLand", "A Quiet Hour (1962)". */
  name: string;
  /** Which episode, for a show: "S2 E5". */
  episode: string | null;
}

/** The words a release name adds after the title: quality, source, codecs. */
const RELEASE =
  /\b(2160p|1080p|720p|576p|480p|4k|uhd|web[\s-]?dl|webrip|web|bluray|blu[\s-]ray|brrip|bdrip|hdtv|dvdrip|remux|x26[45]|h[\s-]?26[45]|hevc|avc|aac|ddp?\s?[257]\s?[01]|atmos|10bit|hdr10?|proper|repack)\b/i;
const YEAR = /^(.*?)[\s([-]*\b((?:19|20)\d{2})\b/;

function tidy(raw: string): string {
  return raw
    .replace(/[\s\-[(]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The name to show for something played. A release name
 * ("MobLand.S02E05.1080p.WEB.H264-RAWR") reads as the show and its episode;
 * a film's ("A.Quiet.Hour.1962.1080p.BluRay.x264") as its title and year.
 * Anything else, like a file someone named themselves, is left as it is.
 */
export function readTitle(title: string): ReadTitle {
  const found = episodeOf(title);
  if (found) {
    return { name: found.show, episode: `S${found.season} E${found.episode}` };
  }
  const text = title.replace(/[._]+/g, " ");
  if (!RELEASE.test(text)) {
    return { name: title, episode: null };
  }
  const dated = YEAR.exec(text);
  const before = tidy(dated?.[1] ?? "");
  if (dated && before !== "") {
    return { name: `${before} (${dated[2]})`, episode: null };
  }
  const cut = tidy(text.slice(0, text.search(RELEASE)));
  return { name: cut === "" ? title : cut, episode: null };
}
