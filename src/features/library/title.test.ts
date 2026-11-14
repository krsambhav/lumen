import { describe, expect, it } from "vitest";
import { readEpisodeTitle, readTitle } from "./title";

describe("readTitle", () => {
  it("reads a show's release name as the show and its episode", () => {
    expect(readTitle("MobLand.S02E05.1080p.WEB.H264-RAWR")).toEqual({
      name: "MobLand",
      episode: "S2 E5",
    });
    expect(readTitle("The Americans 2013 s1e10 720p")).toEqual({
      name: "The Americans 2013",
      episode: "S1 E10",
    });
  });

  it("reads a film's release name as its title and year", () => {
    expect(readTitle("A.Quiet.Hour.1962.1080p.BluRay.x264-GRP")).toEqual({
      name: "A Quiet Hour (1962)",
      episode: null,
    });
    expect(readTitle("Solaris (1972) [2160p] REMUX")).toEqual({
      name: "Solaris (1972)",
      episode: null,
    });
    expect(readTitle("Some.Clip.1080p.WEB")).toEqual({ name: "Some Clip", episode: null });
  });

  it("leaves a name someone wrote themselves as it is", () => {
    for (const title of ["The Long Take (2019)", "Night Drive", "2001: A Space Odyssey"]) {
      expect(readTitle(title)).toEqual({ name: title, episode: null });
    }
  });

  it("reads a playlist row as the episode and its own name", () => {
    expect(readEpisodeTitle("The Crossing S01E02 The Ferryman.mkv")).toEqual({
      episode: "S1 E2",
      name: "The Ferryman",
    });
    expect(
      readEpisodeTitle(
        "The Americans (2013) - S02E06 - Behind the Red Door (1080p AMZN WEB-DL x265 Silence)",
      ),
    ).toEqual({ episode: "S2 E6", name: "Behind the Red Door" });
    expect(readEpisodeTitle("MobLand.S02E05.1080p.WEB.H264-RAWR")).toEqual({
      episode: "S2 E5",
      name: "",
    });
    expect(readEpisodeTitle("A Quiet Hour (1962)")).toBeNull();
  });
});
