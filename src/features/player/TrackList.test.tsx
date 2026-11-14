import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Track } from "@/ipc";
import { renderUi } from "@/test/render";
import { TrackList } from "./TrackList";

function track(kind: Track["kind"], id: number, given: Partial<Track> = {}): Track {
  return {
    id,
    kind,
    title: null,
    language: null,
    codec: kind === "audio" ? "aac" : "subrip",
    selected: false,
    default: false,
    forced: false,
    external: false,
    file: null,
    secondary: false,
    channels: kind === "audio" ? 2 : null,
    ...given,
  };
}

const AUDIO = [
  track("audio", 1, { language: "eng", codec: "ac3", channels: 6 }),
  track("audio", 2, { language: "eng", title: "Version française" }),
];

const SUBTITLES = [
  track("subtitle", 1, { language: "eng" }),
  track("subtitle", 2, { language: "fre", codec: "hdmv_pgs_subtitle", forced: true }),
  track("subtitle", 3, { external: true, file: "/Users/me/Films/The Long Take.srt" }),
];

describe("TrackList", () => {
  it("is a radio group of tracks, each called what a person would call it, with its format", () => {
    renderUi(<TrackList label="Audio track" tracks={AUDIO} selected={1} onChoose={() => {}} />);
    expect(screen.getByRole("radiogroup", { name: "Audio track" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "English, 5.1 · Dolby Digital",
      "English · Version française, Stereo · AAC",
    ]);
    // The format is in tertiary ink at the trailing end, and never wraps.
    const format = screen.getByText("5.1 · Dolby Digital");
    expect(format).toHaveClass("text-ink-3", "whitespace-nowrap", "flex-none");
  });

  it("lights the track in use and checks it", () => {
    renderUi(<TrackList label="Audio track" tracks={AUDIO} selected={2} onChoose={() => {}} />);
    const [first, second] = screen.getAllByRole("radio");
    expect(second).toHaveAttribute("aria-checked", "true");
    expect(first).toHaveAttribute("aria-checked", "false");
    expect(second?.querySelector("[data-lamp]")).not.toBeNull();
    expect(first?.querySelector("[data-lamp]")).toBeNull();
  });

  it("keeps the lamp's place on every row, so names line up", () => {
    renderUi(<TrackList label="Audio track" tracks={AUDIO} selected={1} onChoose={() => {}} />);
    for (const row of screen.getAllByRole("radio")) {
      expect(row.firstElementChild).toHaveClass("w-1", "flex-none");
      expect(row).toHaveClass("h-7");
    }
  });

  it("leads subtitles with Off, chosen when none is showing", () => {
    renderUi(
      <TrackList
        label="Subtitle track"
        tracks={SUBTITLES}
        selected={null}
        off="Off"
        onChoose={() => {}}
      />,
    );
    const rows = screen.getAllByRole("radio");
    expect(rows[0]).toHaveTextContent("Off");
    expect(rows[0]).toHaveAttribute("aria-checked", "true");
    expect(rows[0]?.querySelector("[data-lamp]")).not.toBeNull();
    expect(rows.slice(1).map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "English, SubRip",
      "French, PGS · Forced",
      "The Long Take.srt, SubRip",
    ]);
  });

  it("chooses a track, or none, by click and by the arrow keys", async () => {
    const onChoose = vi.fn();
    renderUi(
      <TrackList
        label="Subtitle track"
        tracks={SUBTITLES}
        selected={1}
        off="Off"
        onChoose={onChoose}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: /^French/ }));
    expect(onChoose).toHaveBeenLastCalledWith(2);
    await userEvent.click(screen.getByRole("radio", { name: "Off" }));
    expect(onChoose).toHaveBeenLastCalledWith(null);
  });

  it("has no Off row unless asked for one", () => {
    renderUi(<TrackList label="Audio track" tracks={AUDIO} selected={1} onChoose={() => {}} />);
    expect(screen.queryByRole("radio", { name: "Off" })).not.toBeInTheDocument();
  });
});
