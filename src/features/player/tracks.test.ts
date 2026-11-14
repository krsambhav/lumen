import { describe, expect, it } from "vitest";
import type { Track } from "@/ipc";
import {
  channelName,
  codecName,
  languageName,
  playingAudio,
  secondSubtitle,
  shownSubtitle,
  trackFormat,
  trackName,
  tracksOf,
} from "./tracks";

function track(kind: Track["kind"], id: number, given: Partial<Track> = {}): Track {
  return {
    id,
    kind,
    title: null,
    language: null,
    codec: null,
    selected: false,
    default: false,
    forced: false,
    external: false,
    file: null,
    secondary: false,
    channels: null,
    ...given,
  };
}

describe("languageName", () => {
  it("names a language in words, from any of the tags files use", () => {
    expect(languageName("eng")).toBe("English");
    expect(languageName("en")).toBe("English");
    expect(languageName("fra")).toBe("French");
    // The older, bibliographic codes are known too.
    expect(languageName("fre")).toBe("French");
    expect(languageName("ger")).toBe("German");
    expect(languageName(" ENG ")).toBe("English");
    expect(languageName("pt-BR")).toMatch(/Portuguese/);
  });

  it("says nothing for tags that are not a language", () => {
    for (const tag of [null, "", "und", "zxx", "mis", "mul", "not a tag!"]) {
      expect(languageName(tag)).toBeNull();
    }
  });
});

describe("codecName and channelName", () => {
  it("call formats what people call them", () => {
    expect(codecName("ac3")).toBe("Dolby Digital");
    expect(codecName("eac3")).toBe("Dolby Digital Plus");
    expect(codecName("subrip")).toBe("SubRip");
    expect(codecName("hdmv_pgs_subtitle")).toBe("PGS");
    expect(codecName("pcm_s24le")).toBe("PCM");
    expect(codecName("some_new_codec")).toBe("SOME NEW CODEC");
    expect(codecName(null)).toBeNull();
  });

  it("call channel counts what people call them", () => {
    expect(channelName(1)).toBe("Mono");
    expect(channelName(2)).toBe("Stereo");
    expect(channelName(6)).toBe("5.1");
    expect(channelName(8)).toBe("7.1");
    expect(channelName(4)).toBe("4 channels");
    expect(channelName(null)).toBeNull();
  });
});

describe("trackName", () => {
  it("is the language in words, then the title", () => {
    expect(trackName(track("audio", 2, { language: "eng", title: "Version française" }))).toBe(
      "English · Version française",
    );
  });

  it("drops a title that only repeats the language", () => {
    expect(trackName(track("audio", 1, { language: "eng", title: "english" }))).toBe("English");
  });

  it("is the title alone when the language is not known, and the number when nothing is", () => {
    expect(trackName(track("audio", 3, { language: "und", title: "Commentary" }))).toBe(
      "Commentary",
    );
    expect(trackName(track("audio", 4))).toBe("Track 4");
  });

  it("names a track from a separate file by that file", () => {
    expect(
      trackName(
        track("subtitle", 5, { external: true, file: "/Users/me/Films/The Long Take.en.srt" }),
      ),
    ).toBe("The Long Take.en.srt");
    expect(
      trackName(
        track("subtitle", 6, {
          external: true,
          language: "fre",
          title: "ignored",
          file: "/Users/me/Films/film.fr.srt",
        }),
      ),
    ).toBe("French · film.fr.srt");
  });
});

describe("trackFormat", () => {
  it("is the channels and the codec for sound", () => {
    expect(trackFormat(track("audio", 1, { codec: "ac3", channels: 6 }))).toBe(
      "5.1 · Dolby Digital",
    );
    expect(trackFormat(track("audio", 1, { codec: "aac", channels: 2 }))).toBe("Stereo · AAC");
  });

  it("is the codec for subtitles, and says when they are forced", () => {
    expect(trackFormat(track("subtitle", 1, { codec: "subrip" }))).toBe("SubRip");
    // Channels mean nothing for subtitles, whatever the file says.
    expect(trackFormat(track("subtitle", 1, { codec: "subrip", channels: 2 }))).toBe("SubRip");
    expect(trackFormat(track("subtitle", 1, { codec: "hdmv_pgs_subtitle", forced: true }))).toBe(
      "PGS · Forced",
    );
    expect(trackFormat(track("subtitle", 1))).toBe("");
  });
});

describe("finding tracks", () => {
  const tracks = [
    track("video", 1, { selected: true }),
    track("audio", 1),
    track("audio", 2, { selected: true }),
    track("subtitle", 1, { selected: true, secondary: true }),
    track("subtitle", 2, { selected: true }),
    track("subtitle", 3),
  ];

  it("lists the tracks of one kind in the file's order", () => {
    expect(tracksOf(tracks, "subtitle").map((each) => each.id)).toEqual([1, 2, 3]);
    expect(tracksOf(tracks, "audio").map((each) => each.id)).toEqual([1, 2]);
  });

  it("tells the first subtitles from the second, and finds the sound playing", () => {
    expect(shownSubtitle(tracks)?.id).toBe(2);
    expect(secondSubtitle(tracks)?.id).toBe(1);
    expect(playingAudio(tracks)?.id).toBe(2);
    expect(shownSubtitle([])).toBeUndefined();
    expect(playingAudio([track("audio", 1)])).toBeUndefined();
  });
});
