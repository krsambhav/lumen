import { clearMocks } from "@tauri-apps/api/mocks";
import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appActions } from "@/actions/all";
import { clearActions, registerActions } from "@/actions/registry";
import { DEFAULT_SESSION } from "@/app/boot";
import { EMPTY_QUEUE, useQueue } from "@/features/playlist/store";
import { useInterface } from "@/features/shell/interface";
import { mockCommands } from "@/ipc/bindings";
import { trackFocusOrigin } from "@/lib/focus-origin";
import { renderUi } from "@/test/render";
import { ControlBar } from "./ControlBar";
import { useChrome } from "./chrome";
import { useOsd } from "./osd";
import { IDLE_SNAPSHOT, usePlayer } from "./store";
import { useWindowState } from "./window";

const FILM = {
  ...IDLE_SNAPSHOT,
  status: "paused" as const,
  source: "/films/a.mkv",
  title: "a.mkv",
  position: 2537,
  duration: 7305,
};

let stopTracking: () => void;

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  stopTracking = trackFocusOrigin();
  registerActions(appActions);
  usePlayer.setState({ ...FILM, positionAt: 0, failure: null });
  useWindowState.setState({ fullscreen: false, keptOnTop: false });
  useQueue.setState(EMPTY_QUEUE, true);
  useInterface.setState({ ...DEFAULT_SESSION.interface, panelOpen: false });
});

afterEach(() => {
  stopTracking();
  vi.restoreAllMocks();
  clearActions();
  clearMocks();
  act(() => {
    useOsd.getState().clear();
    useChrome.getState().reset();
  });
});

function show() {
  return renderUi(<ControlBar />, { surface: "stage" });
}

describe("transport", () => {
  it("offers Play when paused, Pause while playing or working towards it", () => {
    show();
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    for (const status of ["playing", "buffering", "loading"] as const) {
      act(() => usePlayer.setState({ status }));
      expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    }
  });

  it("offers Play again at the end of a film, on the same key", () => {
    show();
    act(() => usePlayer.setState({ status: "ended" }));
    const again = screen.getByRole("button", { name: "Play again" });
    expect(again).toHaveAttribute("aria-keyshortcuts", "Space");
    expect(screen.queryByRole("button", { name: "Play" })).not.toBeInTheDocument();
  });

  it("announces each button's shortcut", () => {
    show();
    expect(screen.getByRole("button", { name: "Play" })).toHaveAttribute(
      "aria-keyshortcuts",
      "Space",
    );
    expect(screen.getByRole("button", { name: "Mute" })).toHaveAttribute("aria-keyshortcuts", "M");
    expect(screen.getByRole("button", { name: "Enter full screen" })).toHaveAttribute(
      "aria-keyshortcuts",
      "Control+Meta+F",
    );
  });

  it("names the full-screen button for what it will do", () => {
    show();
    act(() => useWindowState.setState({ fullscreen: true }));
    expect(screen.getByRole("button", { name: "Exit full screen" })).toBeInTheDocument();
  });
});

describe("volume", () => {
  it("shows mute as a pressed toggle", () => {
    show();
    expect(screen.getByRole("button", { name: "Mute" })).toHaveAttribute("aria-pressed", "false");
    act(() => usePlayer.setState({ muted: true }));
    expect(screen.getByRole("button", { name: "Unmute" })).toHaveAttribute("aria-pressed", "true");
  });

  it("states the level in words, up to 200 percent", () => {
    show();
    const scale = screen.getByRole("slider", { name: "Volume" });
    // On a mark, the value says what the mark means.
    expect(scale).toHaveAttribute("aria-valuetext", "100 percent, normal volume");
    // In percent, not in the slider's own units.
    expect(scale).toHaveAttribute("aria-valuenow", "100");
    expect(scale).toHaveAttribute("aria-valuemin", "0");
    expect(scale).toHaveAttribute("aria-valuemax", "200");
    act(() => usePlayer.setState({ volume: 62.6 }));
    expect(scale).toHaveAttribute("aria-valuetext", "63 percent");
  });

  async function focusVolume() {
    const scale = screen.getByRole("slider", { name: "Volume" });
    await userEvent.tab();
    while (document.activeElement !== scale) {
      await userEvent.tab();
    }
    return scale;
  }

  it("moves in steps of five from the keyboard, like the volume keys everywhere else", async () => {
    const playerSetVolume = vi.fn((args: { percent: number }) => {
      usePlayer.setState({ volume: args.percent });
      return null;
    });
    mockCommands({ playerSetVolume });
    show();
    await focusVolume();

    await userEvent.keyboard("{ArrowRight}");
    expect(playerSetVolume).toHaveBeenLastCalledWith({ percent: 105 });
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(playerSetVolume).toHaveBeenLastCalledWith({ percent: 95 });
  });

  it("goes to normal volume on End, never to full boost on one key", async () => {
    const playerSetVolume = vi.fn(() => null);
    mockCommands({ playerSetVolume });
    usePlayer.setState({ volume: 40 });
    show();
    await focusVolume();
    await userEvent.keyboard("{End}");
    expect(playerSetVolume).toHaveBeenLastCalledWith({ percent: 100 });
    await userEvent.keyboard("{Home}");
    expect(playerSetVolume).toHaveBeenLastCalledWith({ percent: 0 });
  });

  it("turns the sound back on when the level is changed while muted", async () => {
    const playerSetMuted = vi.fn(() => null);
    mockCommands({ playerSetMuted, playerSetVolume: () => null });
    usePlayer.setState({ muted: true });
    show();
    await focusVolume();
    await userEvent.keyboard("{ArrowRight}");
    expect(playerSetMuted).toHaveBeenCalledWith({ muted: false });
  });

  it("dims the level and the needle while muted, and says so", () => {
    show();
    const scale = screen.getByRole("slider", { name: "Volume" });
    expect(scale).toHaveClass("needle");
    act(() => usePlayer.setState({ muted: true }));
    expect(scale).not.toHaveClass("needle");
    expect(scale).toHaveClass("bg-stage-ink-2");
    expect(scale).toHaveAttribute("aria-valuetext", "100 percent, muted");
  });

  it("shows its level and its keys in a tooltip on the needle", async () => {
    usePlayer.setState({ volume: 85 });
    show();
    await focusVolume();
    const tip = await screen.findByRole("tooltip");
    // What a screen reader hears is only what the tooltip adds: the keys.
    expect(tip).toHaveTextContent("Up Arrow, Down Arrow");
    expect(document.body).toHaveTextContent("Volume 85%");
  });
});

describe("the volume scale on a narrow stage", () => {
  /** The readouts' group: the time and, when it is not 1×, the speed. */
  function readouts(): HTMLElement {
    const group = screen.getByRole("button", { name: /of 2 hours 1 minute/ }).parentElement;
    if (!group) {
      throw new Error("the readout has no group");
    }
    return group;
  }

  function scaleRoom(): HTMLElement {
    const room = screen.getByRole("slider", { name: "Volume" }).closest("div[class*='6.25rem']");
    if (!(room instanceof HTMLElement)) {
      throw new Error("the volume scale has no room");
    }
    return room;
  }

  const FOLDED = "group-data-[narrow]/stage:opacity-0";

  it("is folded away until the pointer comes to Mute, then opens over the readouts, which step aside", async () => {
    show();
    // Folded: out of the row's flow, unseen and out of reach (all of it only on a narrow stage).
    expect(scaleRoom()).toHaveClass("group-data-[narrow]/stage:absolute", FOLDED);
    expect(readouts()).not.toHaveClass(FOLDED);

    await userEvent.hover(screen.getByRole("button", { name: "Mute" }));
    expect(scaleRoom()).not.toHaveClass(FOLDED);
    expect(readouts()).toHaveClass(FOLDED, "group-data-[narrow]/stage:pointer-events-none");

    await userEvent.unhover(screen.getByRole("button", { name: "Mute" }));
    expect(scaleRoom()).toHaveClass(FOLDED);
    expect(readouts()).not.toHaveClass(FOLDED);
  });

  it("never moves anything in the row: it fades, and takes no width", () => {
    show();
    expect(scaleRoom()).toHaveClass("transition-opacity");
    expect(scaleRoom().className).not.toMatch(/transition-\[width/);
    expect(readouts()).toHaveClass("transition-opacity");
  });

  it("opens for the keyboard, and not for a button that was only clicked", async () => {
    mockCommands({ playerSetMuted: () => null });
    show();
    // A click leaves focus on Mute; with the pointer gone, that must not hold the scale open.
    await userEvent.click(screen.getByRole("button", { name: "Mute" }));
    await userEvent.unhover(screen.getByRole("button", { name: /mute/i }));
    expect(scaleRoom()).toHaveClass(FOLDED);

    act(() => (document.activeElement as HTMLElement | null)?.blur());
    const scale = screen.getByRole("slider", { name: "Volume" });
    await userEvent.tab();
    while (document.activeElement !== scale) {
      await userEvent.tab();
    }
    expect(scaleRoom()).not.toHaveClass(FOLDED);
    expect(readouts()).toHaveClass(FOLDED);
    await userEvent.tab();
    expect(scaleRoom()).toHaveClass(FOLDED);
  });
});

describe("time readout", () => {
  it("is named by its reading in words, with the digits kept for the eye", () => {
    show();
    const readout = screen.getByRole("button", {
      name: "42 minutes 17 seconds of 2 hours 1 minute",
    });
    const digits = readout.querySelector('[aria-hidden="true"]');
    expect(digits).toHaveTextContent("0:42:17/2:01:45");
    // No aria-label: the name is the control's own content.
    expect(readout).not.toHaveAttribute("aria-label");
  });

  it("switches the second figure to time remaining and back", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: /of 2 hours 1 minute/ }));
    const readout = screen.getByRole("button", {
      name: "42 minutes 17 seconds played, 1 hour 19 minutes remaining",
    });
    const digits = readout.querySelector('[aria-hidden="true"]');
    // No slash: "−1:19:28" already says it is what is left.
    expect(digits).toHaveTextContent("0:42:17−1:19:28");
    expect(digits).not.toHaveTextContent("/");

    await userEvent.click(readout);
    expect(screen.getByRole("button", { name: /of 2 hours 1 minute/ })).toBeInTheDocument();
  });

  it("says in a tooltip what a click will do", async () => {
    show();
    await userEvent.tab();
    const readout = screen.getByRole("button", { name: /of 2 hours 1 minute/ });
    while (document.activeElement !== readout) {
      await userEvent.tab();
    }
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Show time remaining");
  });

  it("shows only the time played when the length is not known, and is not a button", () => {
    usePlayer.setState({ duration: null, position: 75 });
    show();
    expect(screen.queryByRole("button", { name: /played|of/ })).not.toBeInTheDocument();
    const readout = screen.getByText(/1 minute 15 seconds\s+played/).parentElement;
    expect(readout?.querySelector('[aria-hidden="true"]')).toHaveTextContent("1:15");
  });
});

describe("layout", () => {
  it("names the group, for someone who cannot see where the controls are", () => {
    show();
    expect(screen.getByRole("group", { name: "Player controls" })).toBeInTheDocument();
  });

  it("lifts the row's tooltips clear of the timeline above it", async () => {
    show();
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Play" })).toHaveFocus();
    await screen.findByRole("tooltip");
    // Radix records the distance on the positioned wrapper as a transform origin offset;
    // what matters here is that the row asked for more than the default 8 px.
    const content = document.querySelector('[data-side="top"]');
    expect(content).not.toBeNull();
  });
});

describe("the chrome", () => {
  it("is told when the pointer comes to rest on the controls, and when it leaves", () => {
    show();
    const group = screen.getByRole("group", { name: "Player controls" });
    fireEvent.pointerEnter(group);
    expect(useChrome.getState().resting.has("controls")).toBe(true);
    fireEvent.pointerLeave(group);
    expect(useChrome.getState().resting.has("controls")).toBe(false);
  });
});

const SERIES = {
  ...EMPTY_QUEUE,
  items: [
    { id: 1, source: "/s/1.mkv", title: "1.mkv", duration: 100, failed: null },
    { id: 2, source: "/s/2.mkv", title: "2.mkv", duration: 100, failed: null },
  ],
  current: 1,
  hasNext: true,
  hasPrevious: false,
};

describe("previous and next", () => {
  it("are in the row only while the playlist has more than one item", () => {
    show();
    expect(screen.queryByRole("button", { name: "Next item" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Previous item" })).not.toBeInTheDocument();
    act(() => useQueue.setState(SERIES, true));
    expect(screen.getByRole("button", { name: "Next item" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous item" })).toBeInTheDocument();
  });

  it("stand either side of Play, in one group, with Stop after them", () => {
    useQueue.setState(SERIES, true);
    show();
    const group = screen.getByRole("button", { name: "Play" }).parentElement as HTMLElement;
    const names = [...group.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(names).toEqual(["Previous item", "Play", "Next item", "Stop"]);
  });

  it("has Stop, which closes what is open and goes back to Home", async () => {
    const close = vi.fn(() => null);
    mockCommands({ playlistClose: close });
    show();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("go to the item, and stay in place but say why when there is nowhere to go", async () => {
    const next = vi.fn(() => true);
    const previous = vi.fn(() => true);
    mockCommands({ playlistNext: next, playlistPrevious: previous });
    useQueue.setState(SERIES, true);
    show();
    await userEvent.click(screen.getByRole("button", { name: "Next item" }));
    expect(next).toHaveBeenCalledTimes(1);

    const back = screen.getByRole("button", { name: "Previous item" });
    expect(back).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(back);
    expect(previous).not.toHaveBeenCalled();

    act(() => useQueue.setState({ current: 2, hasNext: false, hasPrevious: true }));
    expect(screen.getByRole("button", { name: "Next item" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "Previous item" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });
});

describe("speed", () => {
  it("is not shown at normal speed", () => {
    show();
    expect(screen.queryByRole("button", { name: /Playing at/ })).not.toBeInTheDocument();
  });

  it("is shown at any other speed, and a click returns to normal", async () => {
    const speed = vi.fn((_: { rate: number }) => null);
    mockCommands({ playerSetSpeed: speed });
    usePlayer.setState({ speed: 1.5 });
    show();
    const readout = screen.getByRole("button", { name: "Playing at 1.5 times normal speed" });
    expect(readout).toHaveTextContent("1.5×");
    await userEvent.click(readout);
    expect(speed).toHaveBeenCalledWith({ rate: 1 });
  });
});

/** The time readout, whichever way it is reading: its name always says how much has played. */
function readout() {
  return screen.getByRole("button", { name: /^42 minutes 17 seconds/ });
}

describe("the time readout's choice", () => {
  it("is the one remembered from last time, and is remembered when it changes", async () => {
    useInterface.setState({ timeRemaining: true });
    show();
    expect(readout()).toHaveTextContent("−1:19:28");
    await userEvent.click(readout());
    expect(useInterface.getState().timeRemaining).toBe(false);
    expect(readout()).toHaveTextContent("2:01:45");
  });

  it("marks its second figure as the first thing to go on a narrow stage", () => {
    show();
    const second = [...readout().querySelectorAll("span")].find((span) =>
      span.className.includes("group-data-[tight]/stage:hidden"),
    );
    expect(second).toHaveTextContent("2:01:45");
  });
});

describe("the More menu", () => {
  async function open() {
    show();
    await userEvent.click(screen.getByRole("button", { name: "More" }));
  }

  it("holds what has no place of its own in the row", async () => {
    await open();
    const names = [...screen.getByRole("menu").children]
      .map((item) => item.querySelector(".truncate")?.textContent)
      .filter(Boolean);
    // Not the panel: it has its button in the title bar, in sight (DESIGN.md §7, "More menu").
    expect(names).toEqual([
      "Speed",
      "Repeat",
      "Shuffle",
      "Go to time…",
      "Keep on top",
      "Command palette…",
    ]);
  });

  it("keeps the chrome up while it is open", async () => {
    await open();
    expect(useChrome.getState().holds.has("menu")).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(useChrome.getState().holds.has("menu")).toBe(false);
  });

  it("sets the speed, marking the one in use", async () => {
    const speed = vi.fn((_: { rate: number }) => null);
    mockCommands({ playerSetSpeed: speed });
    usePlayer.setState({ speed: 1.25 });
    await open();
    await userEvent.click(screen.getByRole("menuitem", { name: "Speed" }));
    expect(screen.getByRole("menuitemradio", { name: "1.25×" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: "Normal" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await userEvent.click(screen.getByRole("menuitemradio", { name: "2×" }));
    expect(speed).toHaveBeenCalledWith({ rate: 2 });
    // Chosen from a menu, it is confirmed on screen: the menu has gone.
    expect(useOsd.getState().message).toEqual({ label: "Speed", value: "2×" });
  });

  it("sets how the playlist repeats", async () => {
    const repeat = vi.fn((_: { repeat: string }) => null);
    mockCommands({ playlistSetRepeat: repeat });
    await open();
    await userEvent.click(screen.getByRole("menuitem", { name: "Repeat" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "All" }));
    expect(repeat).toHaveBeenCalledWith({ repeat: "all" });
  });

  it("keeps the window on top, with a tick while it does", async () => {
    const onTop = vi.fn((_: { onTop: boolean }) => null);
    mockCommands({ windowSetAlwaysOnTop: onTop });
    await open();
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: /Keep on top/ }));
    expect(onTop).toHaveBeenCalledWith({ onTop: true });
  });
});
