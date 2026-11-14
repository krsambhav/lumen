import { describe, expect, it } from "vitest";
import {
  episodeOf,
  firstOfNextSeason,
  isEpisode,
  lookAt,
  nextInSeason,
  searchFor,
} from "./episode";

describe("reading an episode from a name", () => {
  it("cuts a release name at its episode number", () => {
    expect(
      episodeOf("MobLand S02E09 Nervous Breakdown 720p AMZN WEB-DL DDP5 1 H 264-RAWR[EZTVx.to]"),
    ).toEqual({
      show: "MobLand",
      season: 2,
      episode: 9,
    });
    expect(episodeOf("The.Americans.2013.S02E04.A.Little.Night.Music.720p")).toEqual({
      show: "The Americans 2013",
      season: 2,
      episode: 4,
    });
    expect(episodeOf("severance_s1e10_the_we_we_are")).toEqual({
      show: "severance",
      season: 1,
      episode: 10,
    });
    expect(episodeOf("Fargo - 3x07 - The Law of Inevitability")).toEqual({
      show: "Fargo",
      season: 3,
      episode: 7,
    });
  });

  it("finds none in a film, a season pack, or a name with nothing before the number", () => {
    expect(episodeOf("The Long Take 2019 1080p BluRay x264")).toBeNull();
    expect(episodeOf("MobLand S02 Complete 1080p")).toBeNull();
    expect(episodeOf("S02E09")).toBeNull();
    expect(episodeOf(null)).toBeNull();
  });

  it("searches for the next one, and the next season's first", () => {
    const playing = { show: "MobLand", season: 2, episode: 9 };
    expect(searchFor(nextInSeason(playing))).toBe("MobLand S02E10");
    expect(searchFor(firstOfNextSeason(playing))).toBe("MobLand S03E01");
  });

  it("leaves a year after the show's name out of the search, unless it is the name", () => {
    const at = (show: string) => searchFor({ show, season: 2, episode: 7 });
    expect(at("The Americans (2013)")).toBe("The Americans S02E07");
    expect(at("The Americans 2013")).toBe("The Americans S02E07");
    expect(at("Doctor Who [2005]")).toBe("Doctor Who S02E07");
    expect(at("1883")).toBe("1883 S02E07");
    expect(at("Blade Runner 2049 Black Lotus")).toBe("Blade Runner 2049 Black Lotus S02E07");
  });
});

describe("matching a release to the episode wanted", () => {
  const wanted = { show: "The Americans 2013", season: 2, episode: 5 };

  it("takes that episode of that show, written any way", () => {
    expect(isEpisode("The.Americans.2013.S02E05.720p.WEB-DL", wanted)).toBe(true);
    expect(isEpisode("The Americans S02E05 1080p", wanted)).toBe(true);
  });

  it("leaves out other episodes, season packs and other shows", () => {
    expect(isEpisode("The Americans S02E06 1080p", wanted)).toBe(false);
    expect(isEpisode("The Americans S02 Complete", wanted)).toBe(false);
    expect(isEpisode("The Americans Revisited S02E05", wanted)).toBe(false);
  });
});

describe("when to look for the next episode", () => {
  it("is a minute before the end, or 30 s before the end credits", () => {
    expect(lookAt([], 2800)).toBe(2740);
    const chapters = [
      { title: "Opening credits", time: 0 },
      { title: "Episode", time: 60 },
      { title: "End Credits", time: 2700 },
    ];
    expect(lookAt(chapters, 2800)).toBe(2670);
  });

  it("is never for something too short to be an episode, or of unknown length", () => {
    expect(lookAt([], 120)).toBeNull();
    expect(lookAt([], null)).toBeNull();
  });
});
