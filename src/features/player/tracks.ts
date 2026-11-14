import type { Track } from "@/ipc";

/**
 * Files written before 1998 name some languages by their English names
 * (ISO 639-2/B); everything else knows them by their own (639-2/T and 639-1).
 */
const BIBLIOGRAPHIC: Readonly<Record<string, string>> = {
  alb: "sq",
  arm: "hy",
  baq: "eu",
  bur: "my",
  chi: "zh",
  cze: "cs",
  dut: "nl",
  fre: "fr",
  geo: "ka",
  ger: "de",
  gre: "el",
  ice: "is",
  mac: "mk",
  mao: "mi",
  may: "ms",
  per: "fa",
  rum: "ro",
  slo: "sk",
  tib: "bo",
  wel: "cy",
};

let names: Intl.DisplayNames | null | undefined;

/** A language tag from a file ("eng", "fr", "pt-BR") as its name in English, or `null` if it says nothing. */
export function languageName(tag: string | null): string | null {
  const code = tag?.trim().toLowerCase();
  // "und" is "undetermined", and "zxx" "no linguistic content": neither is a language.
  if (!code || code === "und" || code === "zxx" || code === "mis" || code === "mul") {
    return null;
  }
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
    } catch {
      names = null;
    }
  }
  try {
    return names?.of(BIBLIOGRAPHIC[code] ?? code) ?? null;
  } catch {
    // Not a well-formed tag at all.
    return null;
  }
}

const CODECS: Readonly<Record<string, string>> = {
  ac3: "Dolby Digital",
  eac3: "Dolby Digital Plus",
  truehd: "Dolby TrueHD",
  dts: "DTS",
  aac: "AAC",
  mp3: "MP3",
  mp2: "MP2",
  flac: "FLAC",
  alac: "Apple Lossless",
  opus: "Opus",
  vorbis: "Vorbis",
  wmav2: "WMA",
  wmapro: "WMA Pro",
  pcm: "PCM",
  subrip: "SubRip",
  srt: "SubRip",
  ass: "ASS",
  ssa: "SSA",
  webvtt: "WebVTT",
  mov_text: "Text",
  text: "Text",
  sami: "SAMI",
  hdmv_pgs_subtitle: "PGS",
  dvd_subtitle: "DVD",
  dvb_subtitle: "DVB",
  eia_608: "Closed captions",
};

/** A codec as people know it: "Dolby Digital" for "ac3". Unknown ones are shown in capitals. */
export function codecName(codec: string | null): string | null {
  if (!codec) {
    return null;
  }
  const known = CODECS[codec] ?? (codec.startsWith("pcm_") ? "PCM" : undefined);
  return known ?? codec.replace(/_/g, " ").toUpperCase();
}

/** How many channels, as people say it: "Stereo", "5.1". */
export function channelName(channels: number | null): string | null {
  switch (channels) {
    case null:
      return null;
    case 1:
      return "Mono";
    case 2:
      return "Stereo";
    case 6:
      return "5.1";
    case 8:
      return "7.1";
    default:
      return `${channels} channels`;
  }
}

function fileName(path: string): string {
  return path.split("/").pop() || path;
}

/**
 * What a person would call a track (DESIGN.md §7, "Track list"): its
 * language in words, then its title if it has one; a track from a separate
 * file by that file's name; failing all of that, its number.
 */
export function trackName(track: Track): string {
  const language = languageName(track.language);
  // A title that only repeats the language adds nothing.
  const title =
    track.title && track.title.toLowerCase() !== language?.toLowerCase() ? track.title : null;
  if (track.external && track.file) {
    // The file's name usually says more than a language guessed from it.
    return language ? `${language} · ${fileName(track.file)}` : fileName(track.file);
  }
  if (language && title) {
    return `${language} · ${title}`;
  }
  return language ?? title ?? `Track ${track.id}`;
}

/** A track's format, for the trailing end of its row: "5.1 · Dolby Digital", "SubRip · Forced". */
export function trackFormat(track: Track): string {
  const parts = [
    track.kind === "audio" ? channelName(track.channels) : null,
    codecName(track.codec),
    track.forced ? "Forced" : null,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

/** The tracks of one kind, in the file's order. */
export function tracksOf(tracks: readonly Track[], kind: Track["kind"]): Track[] {
  return tracks.filter((track) => track.kind === kind);
}

/** The subtitle track that is showing as the first, if any. */
export function shownSubtitle(tracks: readonly Track[]): Track | undefined {
  return tracks.find((track) => track.kind === "subtitle" && track.selected && !track.secondary);
}

/** The subtitle track that is showing as the second, if any. */
export function secondSubtitle(tracks: readonly Track[]): Track | undefined {
  return tracks.find((track) => track.kind === "subtitle" && track.selected && track.secondary);
}

/** The audio track that is playing, if any. */
export function playingAudio(tracks: readonly Track[]): Track | undefined {
  return tracks.find((track) => track.kind === "audio" && track.selected);
}
