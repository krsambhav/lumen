import type { Chapter } from "@/ipc";

/** The index of the chapter being played at `position`, or -1 before the first. */
export function chapterIndexAt(chapters: readonly Chapter[], position: number): number {
  let found = -1;
  for (const [index, chapter] of chapters.entries()) {
    if (chapter.time <= position + 0.001) {
      found = index;
    }
  }
  return found;
}

/** What to call a chapter: its own title, or its number. */
export function chapterName(chapter: Chapter, index: number): string {
  return chapter.title?.trim() || `Chapter ${index + 1}`;
}

/**
 * Where "next chapter" goes from `position`, or `null` if there is none.
 */
export function nextChapter(chapters: readonly Chapter[], position: number): number | null {
  const index = chapterIndexAt(chapters, position) + 1;
  return index < chapters.length ? index : null;
}

/**
 * Where "previous chapter" goes from `position`: the start of this chapter
 * if it has been playing a moment, else the one before. `null` if there is
 * nowhere to go.
 */
export function previousChapter(chapters: readonly Chapter[], position: number): number | null {
  const index = chapterIndexAt(chapters, position);
  if (index < 0) {
    return null;
  }
  const started = chapters[index]?.time ?? 0;
  // Within the first three seconds, "previous" means the one before.
  if (position - started > 3 || index === 0) {
    return index;
  }
  return index - 1;
}

/** A part of an episode that a person may want past: what came before, or the titles. */
export type SkippableKind = "recap" | "intro";

export interface Skippable {
  kind: SkippableKind;
  /** Where it ends: the next chapter's start, or the end of the film. */
  end: number;
}

const RECAP = /^(recap|previously(\s+on\b.*)?|last\s+time(\s+on\b.*)?)$/i;
const INTRO =
  /^(intro(duction)?|opening(\s+(credits|titles|theme|sequence))?|title\s+sequence|main\s+titles|theme\s+song|op)$/i;

/** What kind of part a chapter's title names, if one to skip. */
export function skippableKind(title: string | null): SkippableKind | null {
  const name = title?.trim().replace(/[.:!-]+$/, "") ?? "";
  if (RECAP.test(name)) {
    return "recap";
  }
  return INTRO.test(name) ? "intro" : null;
}

/** How near its end a part stops offering to be skipped: nothing is left to skip. */
const NEAR_THE_END = 1.5;

/**
 * The recap or intro being played at `position`, if it is one and there is
 * enough of it left to be worth skipping.
 */
export function skippableAt(
  chapters: readonly Chapter[],
  position: number,
  duration: number | null,
): Skippable | null {
  const index = chapterIndexAt(chapters, position);
  const chapter = chapters[index];
  if (!chapter) {
    return null;
  }
  const kind = skippableKind(chapter.title);
  if (kind === null) {
    return null;
  }
  const end = chapters[index + 1]?.time ?? duration;
  if (end === null || end - position < NEAR_THE_END) {
    return null;
  }
  return { kind, end };
}
