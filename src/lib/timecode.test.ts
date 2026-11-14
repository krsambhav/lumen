import { describe, expect, it } from "vitest";
import {
  formatTimecode,
  parseTime,
  readTimes,
  shortDuration,
  spokenDuration,
  spokenPosition,
  wholeSecond,
} from "./timecode";

describe("formatTimecode", () => {
  it("shows minutes and seconds for short media", () => {
    expect(formatTimecode(0)).toBe("0:00");
    expect(formatTimecode(5)).toBe("0:05");
    expect(formatTimecode(65.9)).toBe("1:05");
    expect(formatTimecode(3599)).toBe("59:59");
  });

  it("shows hours once the time reaches one", () => {
    expect(formatTimecode(3600)).toBe("1:00:00");
    expect(formatTimecode(2 * 3600 + 1 * 60 + 45)).toBe("2:01:45");
  });

  it("keeps the shape of the media's length, so the display does not change width", () => {
    expect(formatTimecode(5, 7305)).toBe("0:00:05");
    expect(formatTimecode(42 * 60 + 17, 7305)).toBe("0:42:17");
    expect(formatTimecode(5, 600)).toBe("0:05");
  });

  it("counts a frame a thousandth short of a second as that second", () => {
    // Asked for 5:00, a player lands on the frame nearest it.
    expect(formatTimecode(299.998958)).toBe("5:00");
    expect(wholeSecond(296.998958)).toBe(297);
    // Anything further off is still the second before.
    expect(formatTimecode(299.99)).toBe("4:59");
    expect(wholeSecond(299.5)).toBe(299);
    expect(wholeSecond(-1)).toBe(0);
  });

  it("treats nonsense as zero", () => {
    expect(formatTimecode(-3)).toBe("0:00");
    expect(formatTimecode(Number.NaN)).toBe("0:00");
    expect(formatTimecode(Number.POSITIVE_INFINITY, 100)).toBe("0:00");
  });
});

describe("spokenDuration", () => {
  it("spells out the parts that are not zero", () => {
    expect(spokenDuration(0)).toBe("0 seconds");
    expect(spokenDuration(1)).toBe("1 second");
    expect(spokenDuration(61)).toBe("1 minute 1 second");
    expect(spokenDuration(42 * 60 + 17)).toBe("42 minutes 17 seconds");
  });

  it("drops seconds from times of an hour or more", () => {
    expect(spokenDuration(2 * 3600 + 60 + 45)).toBe("2 hours 1 minute");
    expect(spokenDuration(3600)).toBe("1 hour");
  });
});

describe("spokenPosition", () => {
  it("gives the position within the whole", () => {
    expect(spokenPosition(42 * 60, 2 * 3600 + 60)).toBe("42 minutes of 2 hours 1 minute");
  });

  it("gives just the position when the length is unknown", () => {
    expect(spokenPosition(90, null)).toBe("1 minute 30 seconds");
    expect(spokenPosition(90, 0)).toBe("1 minute 30 seconds");
  });
});

describe("shortDuration", () => {
  it("is short enough for a line of metadata", () => {
    expect(shortDuration(58)).toBe("58 s");
    expect(shortDuration(60)).toBe("1 min");
    expect(shortDuration(42 * 60 + 20)).toBe("42 min");
    expect(shortDuration(3600)).toBe("1 h");
    expect(shortDuration(4768)).toBe("1 h 19 min");
    expect(shortDuration(7305)).toBe("2 h 2 min");
  });

  it("rounds up into the next hour rather than writing sixty minutes", () => {
    expect(shortDuration(3599)).toBe("1 h");
    expect(shortDuration(2 * 3600 - 20)).toBe("2 h");
  });

  it("treats nonsense as nothing", () => {
    expect(shortDuration(-5)).toBe("0 s");
    expect(shortDuration(Number.NaN)).toBe("0 s");
  });
});

describe("parseTime", () => {
  const FILM = 7305;

  it("reads a clock time, with or without hours", () => {
    expect(parseTime("1:23:45", FILM)).toBe(5025);
    expect(parseTime("83:45", FILM)).toBe(5025);
    expect(parseTime(" 0:05 ", FILM)).toBe(5);
  });

  it("reads hours, minutes and seconds written with their units", () => {
    expect(parseTime("90m", FILM)).toBe(5400);
    expect(parseTime("1h20m", FILM)).toBe(4800);
    expect(parseTime("1h 20m 5s", FILM)).toBe(4805);
    expect(parseTime("45s", FILM)).toBe(45);
    expect(parseTime("15 min", FILM)).toBe(900);
    expect(parseTime("2H", FILM)).toBe(7200);
  });

  it("reads a share of the film's length", () => {
    expect(parseTime("25%", 8000)).toBe(2000);
    expect(parseTime("12.5 %", 8000)).toBe(1000);
    expect(parseTime("12,5%", 8000)).toBe(1000);
    // A share of something whose length is not known is not a time.
    expect(parseTime("25%", null)).toBeNull();
    expect(parseTime("140%", 8000)).toBeNull();
  });

  it("does not take a bare number, a name or a malformed time for one", () => {
    expect(parseTime("90", FILM)).toBeNull();
    expect(parseTime("", FILM)).toBeNull();
    expect(parseTime("episode 4", FILM)).toBeNull();
    expect(parseTime("1:75", FILM)).toBeNull();
    expect(parseTime("1:75:00", FILM)).toBeNull();
    expect(parseTime("h", FILM)).toBeNull();
  });
});

describe("times written loosely", () => {
  const FILM = 7305;

  it("reads a fraction of an hour or a minute", () => {
    expect(parseTime("1.5h", FILM)).toBe(5400);
    expect(parseTime("1,5 h", FILM)).toBe(5400);
    expect(parseTime("2.5m", FILM)).toBe(150);
    expect(parseTime("0.5 min", FILM)).toBe(30);
  });

  it("takes a figure with no unit after hours for minutes, and after minutes for seconds", () => {
    expect(parseTime("1h30", FILM)).toBe(5400);
    expect(parseTime("1h 5", FILM)).toBe(3900);
    expect(parseTime("2m30", FILM)).toBe(150);
    expect(parseTime("1h20m5", FILM)).toBe(4805);
    // With its unit written, the last figure is what the unit says.
    expect(parseTime("1h30s", FILM)).toBe(3630);
  });

  it("reads the units spelled out", () => {
    expect(parseTime("90 minutes", FILM)).toBe(5400);
    expect(parseTime("2 hours", FILM)).toBe(7200);
    expect(parseTime("45 sec", FILM)).toBe(45);
  });
});

describe("readTimes", () => {
  const two = { duration: 7305, position: 600 };

  it("reads whatever parseTime does, as the one thing it can mean", () => {
    expect(readTimes("1:23:45", two)).toEqual([5025]);
    expect(readTimes("90m", two)).toEqual([5400]);
    expect(readTimes("25%", { duration: 8000, position: 0 })).toEqual([2000]);
    expect(readTimes("mute", two)).toEqual([]);
    expect(readTimes("", two)).toEqual([]);
  });

  it("offers a bare number both ways, minutes first in a film of an hour or more", () => {
    expect(readTimes("90", two)).toEqual([5400, 90]);
    expect(readTimes("5", two)).toEqual([300, 5]);
    // In something shorter, seconds are the likelier.
    expect(readTimes("90", { duration: 1200, position: 0 })).toEqual([90, 5400]);
    // Of unknown length: as a film.
    expect(readTimes("90", { duration: null, position: 0 })).toEqual([5400, 90]);
    // Nought is nought either way, once.
    expect(readTimes("0", two)).toEqual([0]);
  });

  it("takes a signed figure as a step from where the film is", () => {
    expect(readTimes("+30", two)).toEqual([630]);
    expect(readTimes("-30", two)).toEqual([570]);
    expect(readTimes("−30", two)).toEqual([570]);
    expect(readTimes("+2m", two)).toEqual([720]);
    expect(readTimes("+1:30", two)).toEqual([690]);
    expect(readTimes("- 1h", two)).toEqual([0]);
    expect(readTimes("+soon", two)).toEqual([]);
  });
});
