import { describe, expect, it } from "vitest";
import type { TorrentResult } from "@/ipc";
import { byResolution, resolutionOf, resolutionOfHeight, wantedResolution } from "./quality";

function release(name: string, seeders = 10): TorrentResult {
  return {
    name,
    hash: name,
    magnet: `magnet:?xt=urn:btih:${name}`,
    size: "1 GB",
    seeders,
    leechers: 0,
    uploaded: null,
    category: null,
    trusted: false,
    ready: true,
  };
}

describe("the resolution a name gives", () => {
  it("reads the usual labels, with dots or spaces", () => {
    expect(resolutionOf("The.Americans.2013.S02E07.Arpanet.1080p.AMZN.WEB-DL")).toBe(1080);
    expect(resolutionOf("The Americans 2013 S02E07 Arpanet 720p DSNP WEB-DL")).toBe(720);
    expect(resolutionOf("Show S01E01 2160p WEB H265")).toBe(2160);
    expect(resolutionOf("Show S01E01 4K HDR")).toBe(2160);
    expect(resolutionOf("Show S01E01 1080i HDTV")).toBe(1080);
    expect(resolutionOf("Show S01E01 480p x264")).toBe(480);
  });

  it("says nothing when the name does not", () => {
    expect(resolutionOf("Show S01E01 WEB H264-GRP")).toBeNull();
    expect(resolutionOf(null)).toBeNull();
  });

  it("is not fooled by numbers that are not a resolution", () => {
    expect(resolutionOf("Show S10E80 Room 1080 Part 2 WEB")).toBeNull();
  });
});

describe("the resolution a picture's height belongs to", () => {
  it("counts a widescreen film cropped from 1080p as 1080p", () => {
    expect(resolutionOfHeight(1080)).toBe(1080);
    expect(resolutionOfHeight(804)).toBe(1080);
    expect(resolutionOfHeight(2160)).toBe(2160);
    expect(resolutionOfHeight(1606)).toBe(2160);
    expect(resolutionOfHeight(720)).toBe(720);
    expect(resolutionOfHeight(536)).toBe(480);
  });
});

describe("the resolution wanted next", () => {
  it("is the picture's own, then its name's, then 1080p", () => {
    expect(wantedResolution({ height: 720, name: "Show S01E01 1080p" })).toBe(720);
    expect(wantedResolution({ height: null, name: "Show S01E01 2160p" })).toBe(2160);
    expect(wantedResolution({ name: "Show S01E01 WEB" })).toBe(1080);
    expect(wantedResolution()).toBe(1080);
  });
});

describe("ranking releases by resolution", () => {
  const results = [
    release("Show S02E07 720p DSNP WEB-DL", 500),
    release("Show S02E07 WEB H264", 300),
    release("Show S02E07 2160p WEB", 200),
    release("Show S02E07 1080p AMZN WEB-DL", 40),
    release("Show S02E07 480p", 30),
    release("Show S02E07 1080p WEB H265", 20),
  ];
  const names = (ranked: TorrentResult[]) => ranked.map((result) => result.name);

  it("puts 1080p first, most shared first within it, even over a better shared 720p", () => {
    expect(names(byResolution(results, 1080))).toEqual([
      "Show S02E07 1080p AMZN WEB-DL",
      "Show S02E07 1080p WEB H265",
      "Show S02E07 720p DSNP WEB-DL",
      "Show S02E07 2160p WEB",
      "Show S02E07 WEB H264",
      "Show S02E07 480p",
    ]);
  });

  it("puts the resolution being watched first", () => {
    expect(names(byResolution(results, 2160))[0]).toBe("Show S02E07 2160p WEB");
    expect(names(byResolution(results, 720))[0]).toBe("Show S02E07 720p DSNP WEB-DL");
  });

  it("falls back to 720p, then 4K, when there is no 1080p", () => {
    const no1080 = results.filter((result) => resolutionOf(result.name) !== 1080);
    expect(names(byResolution(no1080, 1080)).slice(0, 2)).toEqual([
      "Show S02E07 720p DSNP WEB-DL",
      "Show S02E07 2160p WEB",
    ]);
  });
});
