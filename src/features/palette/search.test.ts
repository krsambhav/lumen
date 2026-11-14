import { describe, expect, it } from "vitest";
import { best, ranked, score } from "./search";

describe("score", () => {
  it("is nothing for a name that does not answer, or for nothing typed", () => {
    expect(score("xyz", "Open file…")).toBe(0);
    expect(score("", "Open file…")).toBe(0);
    expect(score("   ", "Open file…")).toBe(0);
  });

  it("puts the start of the name above the start of a word above the inside of one", () => {
    const start = score("vol", "Volume up");
    const word = score("up", "Volume up");
    const inside = score("lum", "Volume up");
    expect(start).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(0);
  });

  it("needs every word typed to be found", () => {
    expect(score("open folder", "Open folder…")).toBeGreaterThan(0);
    expect(score("open playlist", "Open folder…")).toBe(0);
  });

  it("takes the beginnings of several words, in order, for one word typed", () => {
    expect(score("sp", "Show playlist")).toBeGreaterThan(0);
    expect(score("gtt", "Go to time…")).toBeGreaterThan(0);
    expect(score("fscr", "Enter or exit full screen")).toBeGreaterThan(0);
    expect(score("tlt", "The Long Take (2019)")).toBeGreaterThan(0);
    // In order: the playlist is not shown before it is "played".
    expect(score("ps", "Show playlist")).toBe(0);
    // And less than the start of a single word would be.
    expect(score("sp", "Show playlist")).toBeLessThan(score("sp", "Normal speed"));
  });

  it("does not find letters scattered through a name", () => {
    expect(score("mute", "Back 1 minute")).toBe(0);
    expect(score("next", "Enter or exit full screen")).toBe(0);
    expect(score("delete", "The Crossing S01E03 A Very Long Episode Title That Goes On")).toBe(0);
    expect(score("help", "The Crossing S01E03 A Very Long Episode Title")).toBe(0);
  });

  it("finds a thing by the other words for it, for less than by its name", () => {
    const loop = score("loop", "Repeat", ["loop", "again"]);
    expect(loop).toBeGreaterThan(0);
    expect(loop).toBeLessThan(score("rep", "Repeat", ["loop", "again"]));
    expect(score("louder", "Volume up", ["louder"])).toBeGreaterThan(0);
    // A word typed may be found in the name and another in a keyword.
    expect(score("volume louder", "Volume up", ["louder"])).toBeGreaterThan(0);
    // Only at the start of a keyword's word: inside one it would be a guess.
    expect(score("oop", "Repeat", ["loop"])).toBe(0);
    expect(score("quiet", "Volume up", ["louder"])).toBe(0);
  });

  it("does not care about case, and finds words after punctuation", () => {
    expect(score("LONG", "The.Long.Take.(2019).mkv")).toBeGreaterThan(0);
    expect(score("2019", "The Long Take (2019).mkv")).toBeGreaterThan(0);
    expect(score("s01e03", "The Crossing S01E03 Low Water.mkv")).toBeGreaterThan(0);
  });

  it("prefers the shorter of two names that answer equally", () => {
    expect(score("play", "Play or pause")).toBeGreaterThan(
      score("play", "Play from the beginning of it all"),
    );
  });
});

describe("best", () => {
  const names = ["Volume up", "Volume down", "Mute", "Play or pause", "Open file…"];

  it("returns the best answers first, and only as many as asked for", () => {
    expect(best("vol", names, (name) => name, 5)).toEqual(["Volume up", "Volume down"]);
    expect(best("vol", names, (name) => name, 1)).toEqual(["Volume up"]);
    expect(best("zzz", names, (name) => name, 5)).toEqual([]);
  });

  it("keeps the given order among equals", () => {
    const tied = ["Episode 2", "Episode 1", "Episode 3"];
    expect(best("episode", tied, (name) => name, 3)).toEqual(tied);
  });
});

describe("ranked", () => {
  it("gives each answer its score, best first", () => {
    const found = ranked(
      "sp",
      [
        { name: "Show playlist", words: [] },
        { name: "Faster", words: ["speed"] },
        { name: "Normal speed", words: [] },
        { name: "Mute", words: [] },
      ],
      (item) => item.name,
      (item) => item.words,
    );
    expect(found.map((entry) => entry.item.name)).toEqual([
      "Normal speed",
      "Show playlist",
      "Faster",
    ]);
    expect(found[0]?.score).toBeGreaterThan(found[1]?.score ?? 0);
  });
});
