import { clearMocks } from "@tauri-apps/api/mocks";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearActions, registerActions } from "@/actions/registry";
import { DEFAULT_SESSION } from "@/app/boot";
import { useRecents } from "@/features/library/recents";
import { useChrome } from "@/features/player/chrome";
import { IDLE_SNAPSHOT, usePlayer } from "@/features/player/store";
import { useSaved } from "@/features/playlist/saved";
import { EMPTY_QUEUE, useQueue } from "@/features/playlist/store";
import { useInterface } from "@/features/shell/interface";
import { mockCommands } from "@/ipc/bindings";
import { trackFocusOrigin } from "@/lib/focus-origin";
import { renderUi } from "@/test/render";
import { Palette } from "./Palette";
import { usePalette } from "./store";

const mute = vi.fn();
const open = vi.fn();
const seek = vi.fn((_: { seconds: number; exact: boolean }) => null);
const play = vi.fn((_: { id: number }) => null);

let stopTracking: () => void;

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  stopTracking = trackFocusOrigin();
  mute.mockClear();
  open.mockClear();
  seek.mockClear();
  play.mockClear();
  registerActions([
    { id: "file.open", name: "Open file…", category: "file", shortcuts: ["Cmd+o"], run: open },
    { id: "audio.mute", name: "Mute", category: "audio", shortcuts: ["m"], run: mute },
    {
      id: "playlist.next",
      name: "Next item",
      category: "playback",
      shortcuts: ["Cmd+Right"],
      unavailable: () => "This is the last item",
      run: vi.fn(),
    },
  ]);
  mockCommands({
    playlistsList: () => [],
    playerSeekTo: seek,
    playlistPlay: play,
    windowSetBackdropBlur: () => null,
    torrentsSearch: () => [],
  });
  useInterface.setState({ ...DEFAULT_SESSION.interface, panelOpen: false });
  usePlayer.setState({
    ...IDLE_SNAPSHOT,
    source: "/s/Episode 1.mkv",
    status: "paused",
    duration: 7305,
    position: 100,
  });
  useQueue.setState(
    {
      ...EMPTY_QUEUE,
      items: [
        { id: 1, source: "/s/Episode 1.mkv", title: "Episode 1.mkv", duration: 7305, failed: null },
        { id: 2, source: "/s/Episode 2.mkv", title: "Episode 2.mkv", duration: 7305, failed: null },
      ],
      current: 1,
    },
    true,
  );
  useRecents.setState({ entries: [], loaded: true });
  useSaved.setState({ entries: [] });
});

afterEach(() => {
  act(() => {
    usePalette.setState({ open: false, mode: "all", returnTo: null });
    useChrome.getState().reset();
  });
  stopTracking();
  clearActions();
  clearMocks();
});

function show(mode: "all" | "time" = "all") {
  const view = renderUi(<Palette />);
  act(() => usePalette.getState().show(mode));
  return view;
}

describe("the command palette", () => {
  it("is not there until it is asked for", () => {
    renderUi(<Palette />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens as a dialog with its field ready for typing", () => {
    show();
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveFocus();
    expect(screen.getByRole("combobox")).toHaveAttribute(
      "placeholder",
      "Search actions, the playlist and what was played",
    );
  });

  it("lists every action that can be done now, by category, before anything is typed", () => {
    show();
    const names = screen
      .getAllByRole("option")
      .map((option) => option.querySelector(".truncate")?.textContent);
    // "Next item" cannot be done on the last item: it is found by typing its name.
    expect(names).toEqual(["Open file…", "Mute"]);
    // Each with its shortcut, read out in words.
    expect(screen.getByRole("option", { name: /Open file…/ })).toHaveTextContent("Command O");
    expect(screen.getByText("File")).toBeInTheDocument();
    expect(screen.getByText("Audio")).toBeInTheDocument();
  });

  it("offers the saved playlists and what was played lately before anything is typed", async () => {
    const opened = vi.fn((_: { id: number }) => null);
    mockCommands({ playlistsOpen: opened });
    useSaved.setState({
      entries: [{ id: 7, name: "Evening", count: 12, duration: 0, updatedAt: 1 }],
    });
    show();
    await userEvent.click(await screen.findByRole("option", { name: /Evening/ }));
    expect(opened).toHaveBeenCalledWith({ id: 7 });
  });

  it("runs the action chosen with Return, closes, and remembers it was used", async () => {
    show();
    await userEvent.keyboard("mut{Enter}");
    expect(mute).toHaveBeenCalledWith({ source: "palette" });
    expect(usePalette.getState().open).toBe(false);
    expect(useInterface.getState().recentActions).toEqual(["audio.mute"]);
  });

  it("runs the row that is clicked", async () => {
    show();
    await userEvent.click(screen.getByRole("option", { name: /Open file…/ }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("lists an action that cannot run with the reason, and does not run it", async () => {
    show();
    await userEvent.keyboard("next");
    const next = screen.getByRole("option", { name: /Next item/ });
    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(next).toHaveTextContent("This is the last item");
    await userEvent.click(next);
    expect(usePalette.getState().open).toBe(true);
  });

  it("finds items of the playlist once something is typed", async () => {
    show();
    expect(screen.queryByRole("option", { name: /Episode 2/ })).not.toBeInTheDocument();
    await userEvent.keyboard("episode 2{Enter}");
    expect(play).toHaveBeenCalledWith({ id: 2 });
  });

  it("offers to go to a time that is typed", async () => {
    show();
    await userEvent.keyboard("1:30:00");
    expect(screen.getByRole("option", { name: "Go to 1:30:00" })).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(seek).toHaveBeenCalledWith({ seconds: 5400, exact: true });
  });

  it("says when nothing matches", async () => {
    show();
    await userEvent.keyboard("qq");
    expect(screen.getByText("Nothing matches “qq”.")).toBeInTheDocument();
  });

  it("offers to search torrents for what was typed", async () => {
    show();
    await userEvent.keyboard("qqqq");
    expect(screen.getByRole("option", { name: "Search torrents for “qqqq”" })).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    show();
    await userEvent.keyboard("{Escape}");
    expect(usePalette.getState().open).toBe(false);
  });

  it("keeps the stage chrome up while it is open", () => {
    show();
    expect(useChrome.getState().holds.has("palette")).toBe(true);
    act(() => usePalette.getState().hide());
    expect(useChrome.getState().holds.has("palette")).toBe(false);
  });
});

describe("opened to go to a time", () => {
  it("asks for a time and finds nothing else", async () => {
    show("time");
    expect(screen.getByRole("dialog", { name: "Go to time" })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveAttribute(
      "placeholder",
      "A time, like 1:23:45, 90m, 25% or +30",
    );
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/Type where to go/)).toBeInTheDocument();
    await userEvent.keyboard("mute");
    expect(
      screen.getByText("“mute” is not a time. Try 1:23:45, 90m, 25% or +30."),
    ).toBeInTheDocument();
  });

  it("takes a bare number both ways, the likelier first", async () => {
    show("time");
    await userEvent.keyboard("90");
    // A film of two hours: ninety minutes before ninety seconds.
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Go to 1:30:00",
      "Go to 0:01:30",
    ]);
    await userEvent.keyboard("{Enter}");
    expect(seek).toHaveBeenCalledWith({ seconds: 5400, exact: true });
  });

  it("takes a step from where the film is", async () => {
    show("time");
    await userEvent.keyboard("+30{Enter}");
    expect(seek).toHaveBeenCalledWith({ seconds: 130, exact: true });
  });

  it("goes there", async () => {
    show("time");
    await userEvent.keyboard("25%{Enter}");
    expect(seek).toHaveBeenCalledWith({ seconds: 7305 / 4, exact: true });
    expect(usePalette.getState().open).toBe(false);
  });

  it("starts with an empty field when the palette changes what it is for", async () => {
    show();
    await userEvent.keyboard("mut");
    act(() => usePalette.getState().show("time"));
    expect(screen.getByRole("combobox")).toHaveValue("");
  });
});

describe("where the keyboard goes when it closes", () => {
  it("goes back to a control that had the keyboard", async () => {
    renderUi(
      <>
        <button type="button">Mute</button>
        <Palette />
      </>,
    );
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Mute" })).toHaveFocus();
    act(() => usePalette.getState().show());
    expect(screen.getByRole("combobox")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Mute" })).toHaveFocus();
  });

  it("does not go to a control that was only clicked: the keyboard was the player's", async () => {
    renderUi(
      <>
        <button type="button">Mute</button>
        <Palette />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Mute" }));
    act(() => usePalette.getState().show());
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Mute" })).not.toHaveFocus();
  });
});
