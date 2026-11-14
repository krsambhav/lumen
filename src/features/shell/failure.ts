import type { FailureReason } from "@/ipc";

/** The file name from a path; an address is shown whole. */
export function nameOf(source: string): string {
  if (source.includes("://")) {
    return source;
  }
  return source.split("/").pop() || source;
}

/**
 * Why something would not open, as one sentence that says what happened and
 * what to do about it (DESIGN.md §10).
 */
export function describeFailure(source: string, reason: FailureReason): string {
  const name = `“${nameOf(source)}”`;
  switch (reason.kind) {
    case "missing":
      return `Lumen could not find ${name}: it may have been moved or renamed, or its disk is not connected.`;
    case "noPermission":
      return `macOS will not let Lumen read ${name}: check who may read it in its Get Info window in the Finder.`;
    case "folder":
      return `${name} is a folder with nothing in it that Lumen can play.`;
    case "notMedia":
      return `${name} is not a video or audio file that Lumen can read.`;
    case "nothingPlayable":
      return `${name} has no picture or sound that can be played; the file may be incomplete.`;
    case "unreachable":
      return `Lumen could not reach ${name}: check the address and your connection.`;
    case "other":
      return `${name} would not play. The playback engine reported: ${reason.message.replace(/[.\s]+$/, "")}.`;
  }
}

/**
 * Why an item of the playlist would not play, in two or three words: what
 * its row says in place of its length (DESIGN.md §7, "Playlist").
 */
export function failedLabel(reason: FailureReason): string {
  switch (reason.kind) {
    case "missing":
      return "Not found";
    case "noPermission":
      return "No access";
    case "folder":
      return "Empty folder";
    case "unreachable":
      return "Unreachable";
    case "notMedia":
    case "nothingPlayable":
    case "other":
      return "Would not play";
  }
}

/**
 * What the playlist did about an item that would not play, as a toast's
 * first line: what happened and why, without the name, which has the line
 * under it (DESIGN.md §7, "Toast").
 */
export function skippedBecause(reason: FailureReason): string {
  switch (reason.kind) {
    case "missing":
      return "Skipped a file that is no longer there";
    case "noPermission":
      return "Skipped a file Lumen may not read";
    case "folder":
      return "Skipped a folder with nothing to play";
    case "notMedia":
      return "Skipped a file that is not video or sound";
    case "nothingPlayable":
      return "Skipped a file with nothing in it to play";
    case "unreachable":
      return "Skipped an address that could not be reached";
    case "other":
      return "Skipped an item that would not play";
  }
}
