import type { TorrentResult } from "@/ipc";

/** The picture heights release names are labelled with, tallest first. */
export type Resolution = 2160 | 1080 | 720 | 480;

/** What is wanted when nothing says otherwise: sharp, and quick to start. */
const USUAL: Resolution = 1080;

/** "2160p", "4K", "UHD"; "1080p"/"1080i"; "720p"; "576p", "480p", "SD". */
const LABELS: readonly [RegExp, Resolution][] = [
  [/\b(2160p|4k|uhd)\b/i, 2160],
  [/\b1080[pi]\b/i, 1080],
  [/\b720p\b/i, 720],
  [/\b(576p|480p|360p|sd|dvdrip|xvid)\b/i, 480],
];

/** The resolution a release or file name says it is, if it says. */
export function resolutionOf(name: string | null | undefined): Resolution | null {
  if (!name) {
    return null;
  }
  // Dots and underscores separate words in release names.
  const text = name.replace(/[._]+/g, " ");
  for (const [label, resolution] of LABELS) {
    if (label.test(text)) {
      return resolution;
    }
  }
  return null;
}

/**
 * The resolution class a picture of that height belongs to. A film cropped
 * to 2.39:1 in a 1080p release is about 800 lines tall, so each class
 * reaches well below its label.
 */
export function resolutionOfHeight(height: number): Resolution {
  if (height >= 1500) {
    return 2160;
  }
  if (height >= 780) {
    return 1080;
  }
  if (height >= 560) {
    return 720;
  }
  return 480;
}

/**
 * The resolution to look for in the next episode: the one being watched
 * (from the picture itself, else from its name), or 1080p.
 */
export function wantedResolution(
  playing: { height?: number | null; name?: string | null } = {},
): Resolution {
  if (playing.height && playing.height > 0) {
    return resolutionOfHeight(playing.height);
  }
  return resolutionOf(playing.name) ?? USUAL;
}

/**
 * How far a release is from what is wanted; lower is better. The wanted
 * resolution first, then 1080p, 720p and 2160p (4K last of the three: it is
 * several times the size, and slower to start and to seek over a stream),
 * then a release that does not say, then anything lower.
 */
function distance(resolution: Resolution | null, wanted: Resolution): number {
  if (resolution === wanted) {
    return 0;
  }
  switch (resolution) {
    case 1080:
      return 1;
    case 720:
      return 2;
    case 2160:
      return 3;
    case null:
      return 4;
    default:
      return 5;
  }
}

/**
 * The releases with the wanted resolution first (see `distance`). Within a
 * resolution they keep the order they came in: ready to play, then the most
 * shared.
 */
export function byResolution(
  results: readonly TorrentResult[],
  wanted: Resolution,
): TorrentResult[] {
  return results
    .map((result, index) => ({ result, index, rank: distance(resolutionOf(result.name), wanted) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ result }) => result);
}
