import { describe, expect, it } from "vitest";
import type { Chapter } from "@/ipc";
import {
  chapterIndexAt,
  chapterName,
  nextChapter,
  previousChapter,
  skippableAt,
  skippableKind,
} from "./chapters";

const CHAPTERS: Chapter[] = [
  { title: "The Station", time: 0 },
  { title: "Night Train", time: 1260 },
  { title: null, time: 2400 },
  { title: "  ", time: 4020 },
];

describe("chapters", () => {
  it("finds the chapter being played", () => {
    expect(chapterIndexAt(CHAPTERS, 0)).toBe(0);
    expect(chapterIndexAt(CHAPTERS, 1259.9)).toBe(0);
    expect(chapterIndexAt(CHAPTERS, 1260)).toBe(1);
    expect(chapterIndexAt(CHAPTERS, 9000)).toBe(3);
    expect(chapterIndexAt([], 10)).toBe(-1);
    // Before the first chapter starts, none is playing.
    expect(chapterIndexAt([{ title: "Late", time: 30 }], 10)).toBe(-1);
  });

  it("calls a chapter by its title, or by its number when it has none", () => {
    expect(chapterName(CHAPTERS[1] as Chapter, 1)).toBe("Night Train");
    expect(chapterName(CHAPTERS[2] as Chapter, 2)).toBe("Chapter 3");
    expect(chapterName(CHAPTERS[3] as Chapter, 3)).toBe("Chapter 4");
  });

  it("goes on to the next chapter, and says when there is none", () => {
    expect(nextChapter(CHAPTERS, 100)).toBe(1);
    expect(nextChapter(CHAPTERS, 2400)).toBe(3);
    expect(nextChapter(CHAPTERS, 5000)).toBeNull();
    expect(nextChapter([{ title: "Late", time: 30 }], 10)).toBe(0);
  });

  it("goes back to the start of this chapter, or to the one before if it has only just begun", () => {
    expect(previousChapter(CHAPTERS, 1300)).toBe(1);
    expect(previousChapter(CHAPTERS, 1262)).toBe(0);
    // The first chapter has none before it: its own start is where back goes.
    expect(previousChapter(CHAPTERS, 1)).toBe(0);
    expect(previousChapter([{ title: "Late", time: 30 }], 10)).toBeNull();
  });
});

describe("parts to skip", () => {
  const chapters = [
    { title: "Previously on", time: 0 },
    { title: "Intro", time: 45 },
    { title: "Part One", time: 90 },
    { title: "Opening Credits", time: 1200 },
  ];

  it("knows a recap and an intro by their chapters' names", () => {
    expect(skippableKind("Recap")).toBe("recap");
    expect(skippableKind("Previously on The Americans")).toBe("recap");
    expect(skippableKind("Opening titles")).toBe("intro");
    expect(skippableKind("intro.")).toBe("intro");
    expect(skippableKind("Introducing the family")).toBeNull();
    expect(skippableKind("Chapter 2")).toBeNull();
    expect(skippableKind(null)).toBeNull();
  });

  it("offers to skip to where the part ends, while there is enough left of it", () => {
    expect(skippableAt(chapters, 10, 2700)).toEqual({ kind: "recap", end: 45 });
    expect(skippableAt(chapters, 50, 2700)).toEqual({ kind: "intro", end: 90 });
    expect(skippableAt(chapters, 89, 2700)).toBeNull();
    expect(skippableAt(chapters, 100, 2700)).toBeNull();
    // The last chapter ends where the film does.
    expect(skippableAt(chapters, 1300, 2700)).toEqual({ kind: "intro", end: 2700 });
    expect(skippableAt([], 10, 2700)).toBeNull();
  });
});
