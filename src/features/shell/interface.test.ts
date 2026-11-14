import { readFileSync } from "node:fs";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SESSION } from "@/app/boot";
import { mockCommands } from "@/ipc/bindings";
import { INSPECTOR_WIDTH, RECENT_ACTIONS, rememberInterface, useInterface } from "./interface";

beforeEach(() => {
  useInterface.setState({ ...DEFAULT_SESSION.interface, panelOpen: false });
});

afterEach(() => {
  vi.useRealTimers();
  clearMocks();
});

describe("the panel beside the picture", () => {
  it("starts closed, on the tab it last showed", () => {
    const state = useInterface.getState();
    expect(state.panelOpen).toBe(false);
    expect(state.inspectorTab).toBe("playlist");
  });

  it("opens on a tab, and the same request again closes it", () => {
    const { togglePanel } = useInterface.getState();
    togglePanel("chapters");
    expect(useInterface.getState()).toMatchObject({ panelOpen: true, inspectorTab: "chapters" });
    // Asking for the other tab while open switches; it does not close.
    togglePanel("playlist");
    expect(useInterface.getState()).toMatchObject({ panelOpen: true, inspectorTab: "playlist" });
    togglePanel("playlist");
    expect(useInterface.getState().panelOpen).toBe(false);
    // Closed, it still knows which tab it was on.
    expect(useInterface.getState().inspectorTab).toBe("playlist");
  });

  it("opens on the tab it had when no tab is asked for", () => {
    useInterface.getState().setTab("chapters");
    useInterface.getState().showPanel();
    expect(useInterface.getState()).toMatchObject({ panelOpen: true, inspectorTab: "chapters" });
  });
});

describe("recently used actions", () => {
  it("are kept newest first, once each, and only so many", () => {
    const { noteAction } = useInterface.getState();
    noteAction("a");
    noteAction("b");
    noteAction("a");
    expect(useInterface.getState().recentActions).toEqual(["a", "b"]);
    for (let index = 0; index < 20; index += 1) {
      noteAction(`action.${index}`);
    }
    const recent = useInterface.getState().recentActions;
    expect(recent).toHaveLength(RECENT_ACTIONS);
    expect(recent[0]).toBe("action.19");
  });
});

describe("rememberInterface", () => {
  it("stores what is remembered a moment after it changes, once", () => {
    vi.useFakeTimers();
    const stored = vi.fn(() => null);
    mockCommands({ sessionSetInterface: stored });
    // The mock makes this a Tauri window.
    const stop = rememberInterface();

    useInterface.getState().setTimeRemaining(true);
    useInterface.getState().setTab("chapters");
    expect(stored).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(stored).toHaveBeenCalledTimes(1);
    expect(stored).toHaveBeenCalledWith({
      layout: { timeRemaining: true, inspectorTab: "chapters", recentActions: [] },
    });
    stop();
  });

  it("does not store what lasts only as long as the window", () => {
    vi.useFakeTimers();
    const stored = vi.fn(() => null);
    mockCommands({ sessionSetInterface: stored });
    const stop = rememberInterface();
    useInterface.getState().showPanel("playlist");
    useInterface.getState().hidePanel();
    vi.advanceTimersByTime(1000);
    expect(stored).not.toHaveBeenCalled();
    stop();
  });
});

describe("the panel's width", () => {
  it("is the same in the script, which asks the window for room, as in the design tokens", () => {
    const tokens = readFileSync("src/design/tokens.css", "utf8");
    expect(tokens).toContain(`--inspector-w: ${INSPECTOR_WIDTH}px;`);
  });
});
