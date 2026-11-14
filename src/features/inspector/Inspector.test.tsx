import { clearMocks } from "@tauri-apps/api/mocks";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appActions } from "@/actions/all";
import { clearActions, registerActions } from "@/actions/registry";
import { DEFAULT_SESSION } from "@/app/boot";
import { IDLE_SNAPSHOT, usePlayer } from "@/features/player/store";
import { EMPTY_QUEUE, useQueue } from "@/features/playlist/store";
import { usePlaylistUi } from "@/features/playlist/ui";
import { useInterface } from "@/features/shell/interface";
import { mockCommands } from "@/ipc/bindings";
import { renderUi } from "@/test/render";
import { Inspector } from "./Inspector";

const CHAPTERS = [
  { title: "The Station", time: 0 },
  { title: null, time: 1260 },
  { title: "Morning", time: 6300 },
];

beforeEach(() => {
  registerActions(appActions);
  useInterface.setState({ ...DEFAULT_SESSION.interface, panelOpen: true });
  usePlayer.setState({
    ...IDLE_SNAPSHOT,
    source: "/films/a.mkv",
    status: "paused",
    duration: 7305,
    position: 1300,
    chapters: CHAPTERS,
  });
  useQueue.setState(
    {
      ...EMPTY_QUEUE,
      items: [{ id: 1, source: "/films/a.mkv", title: "a.mkv", duration: 7305, failed: null }],
      current: 1,
    },
    true,
  );
});

afterEach(() => {
  clearActions();
  clearMocks();
});

describe("the panel beside the picture", () => {
  it("is a named region with a tab, as an icon with a name, for each of its five views", () => {
    renderUi(<Inspector />);
    expect(screen.getByRole("complementary", { name: "Panel" })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "Playlist",
      "Chapters",
      "Video",
      "Audio",
      "Subtitles",
    ]);
    // Icons only: the words are in the tooltip and the accessible name.
    for (const tab of tabs) {
      expect(tab.textContent).toBe("");
    }
    expect(screen.getByRole("tab", { name: "Playlist" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("listbox", { name: "Playlist" })).toBeInTheDocument();
  });

  it("switches tab, remembers which, and takes the other out of the layout", async () => {
    renderUi(<Inspector />);
    await userEvent.click(screen.getByRole("tab", { name: "Chapters" }));
    expect(useInterface.getState().inspectorTab).toBe("chapters");
    expect(screen.getByRole("listbox", { name: "Chapters" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "Playlist" })).not.toBeInTheDocument();
    // The tab that is not showing must not keep its room: it is flex, which would undo `hidden`.
    const hidden = document.querySelector('[role="tabpanel"][data-state="inactive"]');
    expect(hidden).toHaveClass("data-[state=inactive]:hidden");
  });

  it("opens on the tab the interface asks for", () => {
    useInterface.setState({ inspectorTab: "chapters" });
    renderUi(<Inspector />);
    expect(screen.getByRole("tab", { name: "Chapters" })).toHaveAttribute("aria-selected", "true");
  });

  it("is closed from its own header, with the keys that opened the tab", async () => {
    renderUi(<Inspector />);
    const hide = screen.getByRole("button", { name: "Hide panel" });
    expect(hide).toHaveAttribute("aria-keyshortcuts", "Meta+P");
    act(() => useInterface.getState().setTab("chapters"));
    expect(screen.getByRole("button", { name: "Hide panel" })).toHaveAttribute(
      "aria-keyshortcuts",
      "Shift+Meta+C",
    );
    await userEvent.click(screen.getByRole("button", { name: "Hide panel" }));
    expect(useInterface.getState().panelOpen).toBe(false);
  });

  it("drags the window by its header, as the title bar does", () => {
    renderUi(<Inspector />);
    const header = screen.getByRole("tablist").parentElement;
    expect(header).toHaveAttribute("data-tauri-drag-region");
    expect(header).toHaveClass("h-titlebar");
  });
});

describe("the panel's colours, coming and going", () => {
  it("is drawn in the stage's dark tokens whatever the window's theme", () => {
    renderUi(<Inspector />);
    expect(screen.getByRole("complementary")).toHaveClass("stage", "bg-surface-1");
    // Ordinary controls, not the larger ones that sit over video.
    expect(screen.getByRole("button", { name: "Hide panel" })).toHaveClass("size-8");
  });

  it("opens what it opens in the same colours", async () => {
    renderUi(<Inspector />);
    await userEvent.click(screen.getByRole("button", { name: "Playlist menu" }));
    expect(screen.getByRole("menu")).toHaveClass("stage");
  });

  it("slides out when it is closed, and is out of reach meanwhile", () => {
    const left = vi.fn();
    const view = renderUi(<Inspector />);
    const panel = screen.getByRole("complementary");
    expect(panel).toHaveClass("animate-slide-in");
    view.rerender(<Inspector leaving onLeft={left} />);
    expect(panel).toHaveClass("animate-slide-out", "pointer-events-none");
    expect(panel).toHaveAttribute("aria-hidden", "true");
    // It says it has gone when the slide ends (the browser tests see that), not before.
    expect(left).not.toHaveBeenCalled();
  });

  it("still goes where nothing animates", () => {
    vi.useFakeTimers();
    const left = vi.fn();
    renderUi(<Inspector leaving onLeft={left} />);
    act(() => vi.advanceTimersByTime(400));
    expect(left).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("gives up the keyboard as it leaves", () => {
    const view = renderUi(<Inspector />);
    const hide = screen.getByRole("button", { name: "Hide panel" });
    hide.focus();
    expect(hide).toHaveFocus();
    view.rerender(<Inspector leaving />);
    expect(hide).not.toHaveFocus();
  });

  it("takes the keyboard to its list when it was opened from the keyboard", () => {
    useInterface.setState({ panelWantsKeyboard: true });
    renderUi(<Inspector />);
    expect(screen.getByRole("listbox", { name: "Playlist" })).toHaveFocus();
    // Asked once: the request is spent.
    expect(useInterface.getState().panelWantsKeyboard).toBe(false);
  });

  it("leaves the keyboard where it was when it was opened with the pointer", () => {
    renderUi(<Inspector />);
    expect(document.body).toHaveFocus();
  });

  it("forgets which row was selected when it is closed", () => {
    usePlaylistUi.setState({ selected: 1 });
    const view = renderUi(<Inspector />);
    expect(usePlaylistUi.getState().selected).toBe(1);
    view.rerender(<Inspector leaving />);
    expect(usePlaylistUi.getState().selected).toBeNull();
  });
});

describe("the chapters tab", () => {
  beforeEach(() => {
    useInterface.setState({ inspectorTab: "chapters" });
  });

  it("lists each chapter with where it starts, and marks the one playing", () => {
    renderUi(<Inspector />);
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAccessibleName("The Station, at 0 seconds");
    expect(options[1]).toHaveAccessibleName("Chapter 2, at 21 minutes, playing");
    expect(options[2]).toHaveAccessibleName("Morning, at 1 hour 45 minutes");
    expect(options[1]).toHaveAttribute("aria-current", "true");
    expect(options[2]).toHaveTextContent("1:45:00");
    // Written in the shape the film's length calls for.
    expect(options[0]).toHaveTextContent("0:00:00");
  });

  it("goes to a chapter on a click", async () => {
    const seek = vi.fn((_: { seconds: number; exact: boolean }) => null);
    mockCommands({ playerSeekTo: seek });
    renderUi(<Inspector />);
    await userEvent.click(screen.getByRole("option", { name: /Morning/ }));
    expect(seek).toHaveBeenCalledWith({ seconds: 6300, exact: true });
    // The click did its work: no fill is left on a chapter that may not be the one playing.
    expect(screen.queryByRole("option", { selected: true })).not.toBeInTheDocument();
  });

  it("moves the lamp as the film goes from one chapter to the next", () => {
    renderUi(<Inspector />);
    act(() => usePlayer.setState({ position: 6400 }));
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-current", "true");
  });

  it("says so when the film has no chapters", () => {
    usePlayer.setState({ chapters: [] });
    renderUi(<Inspector />);
    expect(screen.getByText("This file has no chapters.")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
