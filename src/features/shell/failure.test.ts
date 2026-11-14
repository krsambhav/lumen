import { describe, expect, it } from "vitest";
import type { FailureReason } from "@/ipc";
import { describeFailure, failedLabel, nameOf, skippedBecause } from "./failure";

describe("nameOf", () => {
  it("is the file name for a path and the whole thing for an address", () => {
    expect(nameOf("/Users/me/Films/The Long Take (2019).mkv")).toBe("The Long Take (2019).mkv");
    expect(nameOf("https://example.com/watch?v=1")).toBe("https://example.com/watch?v=1");
    expect(nameOf("film.mkv")).toBe("film.mkv");
  });
});

describe("describeFailure", () => {
  const source = "/Films/Solaris.mkv";
  const reasons: FailureReason[] = [
    { kind: "missing" },
    { kind: "noPermission" },
    { kind: "folder" },
    { kind: "notMedia" },
    { kind: "nothingPlayable" },
    { kind: "unreachable" },
    { kind: "other", message: "audio output initialization failed." },
  ];

  it.each(reasons)("names the file and ends as a sentence for $kind", (reason) => {
    const text = describeFailure(source, reason);
    expect(text).toContain("“Solaris.mkv”");
    expect(text.endsWith(".")).toBe(true);
    expect(text).not.toMatch(/\.\.$/);
    // DESIGN.md §10: no exclamation marks, no "Oops", no "successfully".
    expect(text).not.toMatch(/!|oops|successfully/i);
  });

  it("gives each reason its own words", () => {
    const texts = reasons.map((reason) => describeFailure(source, reason));
    expect(new Set(texts).size).toBe(reasons.length);
  });

  it("says what to do about a file that has gone or cannot be read", () => {
    expect(describeFailure(source, { kind: "missing" })).toMatch(/moved or renamed/);
    expect(describeFailure(source, { kind: "noPermission" })).toMatch(/Get Info/);
    expect(describeFailure("https://a.example/x", { kind: "unreachable" })).toMatch(
      /check the address and your connection/,
    );
  });

  it("passes on what the engine said when nothing better is known", () => {
    expect(
      describeFailure(source, { kind: "other", message: "audio output initialization failed." }),
    ).toBe(
      "“Solaris.mkv” would not play. The playback engine reported: audio output initialization failed.",
    );
  });
});

describe("an item of the playlist that would not play", () => {
  const reasons: FailureReason[] = [
    { kind: "missing" },
    { kind: "noPermission" },
    { kind: "folder" },
    { kind: "notMedia" },
    { kind: "nothingPlayable" },
    { kind: "unreachable" },
    { kind: "other", message: "decoder exploded" },
  ];

  it("says why on its row in two or three words", () => {
    expect(reasons.map(failedLabel)).toEqual([
      "Not found",
      "No access",
      "Empty folder",
      "Would not play",
      "Would not play",
      "Unreachable",
      "Would not play",
    ]);
    for (const reason of reasons) {
      expect(failedLabel(reason).length).toBeLessThanOrEqual(14);
    }
  });

  it("is said in a toast's first line without the name, which has the line under it", () => {
    for (const reason of reasons) {
      const line = skippedBecause(reason);
      expect(line).toMatch(/^Skipped /);
      expect(line).not.toMatch(/[“”"]/);
      expect(line.length).toBeLessThanOrEqual(48);
    }
    expect(skippedBecause({ kind: "missing" })).toBe("Skipped a file that is no longer there");
  });
});
