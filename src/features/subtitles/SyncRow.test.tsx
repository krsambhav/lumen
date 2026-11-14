import { clearMocks } from "@tauri-apps/api/mocks";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_SNAPSHOT, usePlayer } from "@/features/player/store";
import type { SyncStatus, Track } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import { renderUi } from "@/test/render";
import { SyncRow } from "./SyncRow";
import { speedText, syncedText, syncView, useSubtitleSync } from "./sync";

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const SOURCE = "/films/a.mkv";

function subtitle(id: number, given: Partial<Track> = {}): Track {
  return {
    id,
    kind: "subtitle",
    title: null,
    language: "eng",
    codec: "subrip",
    selected: false,
    default: false,
    forced: false,
    external: false,
    file: null,
    secondary: false,
    channels: null,
    ...given,
  };
}

const ADDED = subtitle(2, { external: true, file: "/films/a.srt", selected: true });

function synced(given: Partial<Extract<SyncStatus, { state: "synced" }>> = {}): SyncStatus {
  return {
    state: "synced",
    source: SOURCE,
    track: 2,
    speed: 1,
    delay: -7.47,
    byWords: true,
    agreeing: 7,
    heard: 8,
    speedBefore: 1,
    delayBefore: 0,
    ...given,
  };
}

const subtitlesSync = vi.fn(() => null);
const subtitlesSyncCancel = vi.fn(() => null);
const subtitlesSyncUndo = vi.fn(() => null);

beforeEach(() => {
  subtitlesSync.mockClear();
  subtitlesSyncCancel.mockClear();
  subtitlesSyncUndo.mockClear();
  mockCommands({ subtitlesSync, subtitlesSyncCancel, subtitlesSyncUndo });
  usePlayer.setState({ ...IDLE_SNAPSHOT, source: SOURCE, tracks: [subtitle(1), ADDED] });
  useSubtitleSync.setState({ status: { state: "idle", installed: false } });
});

afterEach(async () => {
  await flush();
  clearMocks();
});

describe("SyncRow", () => {
  it("offers to sync, saying the model is downloaded the first time", async () => {
    renderUi(<SyncRow />);
    expect(screen.getByText(/downloads a 60 MB speech model/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sync" }));
    expect(subtitlesSync).toHaveBeenCalledTimes(1);
  });

  it("says nothing of a download once the model is here", () => {
    useSubtitleSync.setState({ status: { state: "idle", installed: true } });
    renderUi(<SyncRow />);
    expect(screen.queryByText(/60 MB/)).toBeNull();
  });

  it("shows the download and the listening as they go, and can be cancelled", async () => {
    useSubtitleSync.setState({
      status: { state: "installing", source: SOURCE, track: 2, progress: 0.42, size: 59_707_625 },
    });
    renderUi(<SyncRow />);
    expect(screen.getByRole("status")).toHaveTextContent("Downloading the speech model… 42%");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(subtitlesSyncCancel).toHaveBeenCalledTimes(1);

    act(() =>
      useSubtitleSync.setState({
        status: { state: "listening", source: SOURCE, track: 2, done: 3, total: 8 },
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Listening… 3 of 8");
  });

  it("says what a sync did and offers to undo it", async () => {
    useSubtitleSync.setState({ status: synced() });
    renderUi(<SyncRow />);
    expect(screen.getByText("Shown 7.47 s earlier")).toBeInTheDocument();
    expect(screen.getByText("7 of 8 samples agree")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(subtitlesSyncUndo).toHaveBeenCalledTimes(1);
  });

  it("forgets a sync of another file or track", () => {
    useSubtitleSync.setState({ status: synced({ track: 9 }) });
    renderUi(<SyncRow />);
    expect(screen.getByRole("button", { name: "Sync" })).toBeEnabled();
  });

  it("cannot sync subtitles that came inside the film", () => {
    usePlayer.setState({
      tracks: [subtitle(1, { selected: true }), { ...ADDED, selected: false }],
    });
    renderUi(<SyncRow />);
    expect(screen.getByRole("button", { name: "Sync" })).toBeDisabled();
    expect(screen.getByText("Subtitles inside the film are already timed with it")).toBeVisible();
  });

  it("says why a sync failed and offers another try", () => {
    useSubtitleSync.setState({
      status: { state: "failed", source: SOURCE, track: 2, message: "No speech was heard." },
    });
    renderUi(<SyncRow />);
    expect(screen.getByText("No speech was heard.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });
});

describe("sync wording", () => {
  it("names a frame-rate correction by its rates", () => {
    expect(speedText(1)).toBeNull();
    expect(speedText(25 / (24000 / 1001))).toBe("retimed from 25 to 23.976 fps");
    expect(speedText(24 / 25)).toBe("retimed from 24 to 25 fps");
    expect(speedText(1.013)).toBe("running at 101.3% speed");
  });

  it("puts the delay as a direction", () => {
    expect(syncedText(synced({ delay: 0.12 }) as never)).toBe("Shown 120 ms later");
    expect(syncedText(synced({ delay: 0 }) as never)).toBe("In time as they were");
    expect(syncedText(synced({ delay: 3, speed: 25 / 24 }) as never)).toBe(
      "Shown 3 s later, retimed from 25 to 24 fps",
    );
  });

  it("keeps showing a sync that is running when the track changes under it", () => {
    const listening: SyncStatus = {
      state: "listening",
      source: SOURCE,
      track: 2,
      done: 1,
      total: 8,
    };
    expect(syncView(listening, SOURCE, 3, undefined).state).toBe("listening");
    expect(syncView(listening, "/other.mkv", undefined, "Nothing is open").state).toBe(
      "unavailable",
    );
  });
});
