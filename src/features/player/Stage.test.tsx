import { clearMocks } from "@tauri-apps/api/mocks";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { appActions } from "@/actions/all";
import { clearActions, registerActions } from "@/actions/registry";
import { TooltipProvider } from "@/components/ui/tooltip";
import { mockCommands } from "@/ipc/bindings";
import { trackFocusOrigin } from "@/lib/focus-origin";
import { useChrome } from "./chrome";
import { useOsd } from "./osd";
import { Stage } from "./Stage";
import { IDLE_SNAPSHOT, usePlayer } from "./store";

const FILM = {
  ...IDLE_SNAPSHOT,
  status: "playing" as const,
  source: "/films/a.mkv",
  title: "a.mkv",
  position: 60,
  duration: 7305,
};

const startDragging = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging }),
}));

/** The grace a single click waits, and a little more. */
const AFTER_GRACE = 160;

let toggles: Mock<() => null>;
let fullscreen: Mock<() => null>;

beforeEach(() => {
  vi.useFakeTimers();
  // A click only counts when the window already had focus.
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  toggles = vi.fn<() => null>(() => {
    const playing = usePlayer.getState().status === "playing";
    usePlayer.setState({ status: playing ? "paused" : "playing" });
    return null;
  });
  fullscreen = vi.fn<() => null>(() => null);
  mockCommands({
    playerTogglePaused: toggles,
    windowToggleFullscreen: fullscreen,
    windowSetChromeVisible: () => null,
  });
  registerActions(appActions);
  usePlayer.setState({ ...FILM, positionAt: 0, failure: null });
});

afterEach(() => {
  // Unmounted while the backend is still mocked: leaving the stage tells it
  // to show the traffic lights again.
  cleanup();
  act(() => {
    useOsd.getState().clear();
    useChrome.getState().reset();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
  startDragging.mockClear();
  clearActions();
  clearMocks();
  usePlayer.setState({ ...IDLE_SNAPSHOT, positionAt: 0, failure: null });
});

function show() {
  const view = render(
    <TooltipProvider>
      <Stage />
    </TooltipProvider>,
  );
  // The picture is the first layer of the stage.
  const picture = view.container.querySelector(".stage > div") as HTMLElement;
  const click = (detail: number) => {
    fireEvent.pointerDown(picture, { button: 0, clientX: 300, clientY: 200 });
    fireEvent.click(picture, { detail });
  };
  return { ...view, picture, click };
}

describe("a click on the picture", () => {
  it("does nothing: Space, K and the Play button pause", () => {
    const { click } = show();
    click(1);
    act(() => vi.advanceTimersByTime(AFTER_GRACE));
    expect(toggles).not.toHaveBeenCalled();
    expect(fullscreen).not.toHaveBeenCalled();
  });

  it("drags the window instead, when the pointer moves with the button down", () => {
    const { picture } = show();
    fireEvent.pointerDown(picture, { button: 0, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(picture, { buttons: 1, clientX: 310, clientY: 200 });
    fireEvent.click(picture, { detail: 1 });
    expect(startDragging).toHaveBeenCalledOnce();
    expect(toggles).not.toHaveBeenCalled();
  });

  it("does not start a drag for the small tremor of an ordinary click", () => {
    const { picture } = show();
    fireEvent.pointerDown(picture, { button: 0, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(picture, { buttons: 1, clientX: 302, clientY: 201 });
    fireEvent.click(picture, { detail: 1 });
    expect(startDragging).not.toHaveBeenCalled();
  });
});

describe("a double-click on the picture", () => {
  it("goes to full screen and leaves the film playing", () => {
    const { click } = show();
    click(1);
    act(() => vi.advanceTimersByTime(300));
    click(2);
    expect(fullscreen).toHaveBeenCalledOnce();
    expect(toggles).not.toHaveBeenCalled();
    expect(usePlayer.getState().status).toBe("playing");
  });

  it("ignores a third click in a row", () => {
    const { click } = show();
    click(1);
    click(2);
    click(3);
    act(() => vi.advanceTimersByTime(AFTER_GRACE));
    expect(fullscreen).toHaveBeenCalledOnce();
    expect(toggles).not.toHaveBeenCalled();
  });
});

describe("pointer movement", () => {
  function move(stage: Element, x: number, y: number) {
    fireEvent.pointerMove(stage, { clientX: x, clientY: y });
  }

  it("raises the chrome only once the pointer has really travelled", () => {
    const { container } = show();
    const stage = container.querySelector(".stage") as HTMLElement;
    move(stage, 300, 200);
    act(() => vi.advanceTimersByTime(2500));
    expect(useChrome.getState().visible).toBe(false);

    // A nudge of the desk: a pixel or two, back and forth.
    move(stage, 301, 200);
    move(stage, 302, 201);
    move(stage, 300, 200);
    expect(useChrome.getState().visible).toBe(false);

    // Four pixels from where it last counted is movement.
    move(stage, 304, 200);
    expect(useChrome.getState().visible).toBe(true);
  });

  it("counts a slow drift once it adds up", () => {
    const { container } = show();
    const stage = container.querySelector(".stage") as HTMLElement;
    move(stage, 300, 200);
    act(() => vi.advanceTimersByTime(2500));
    for (const x of [301, 302, 303]) {
      move(stage, x, 200);
    }
    expect(useChrome.getState().visible).toBe(false);
    move(stage, 304, 200);
    expect(useChrome.getState().visible).toBe(true);
  });

  it("treats the title bar, where the traffic lights are, as chrome to rest on", () => {
    show();
    const bar = screen.getByRole("banner").parentElement as HTMLElement;
    fireEvent.pointerEnter(bar);
    expect(useChrome.getState().resting.has("titlebar")).toBe(true);
    fireEvent.pointerLeave(bar);
    expect(useChrome.getState().resting.has("titlebar")).toBe(false);
  });

  it("tells the chrome whether the film is running", () => {
    show();
    expect(useChrome.getState().playing).toBe(true);
    act(() => usePlayer.setState({ status: "paused" }));
    expect(useChrome.getState().playing).toBe(false);
  });
});

describe("the end of a film", () => {
  it("brings the chrome back and keeps it there", () => {
    show();
    act(() => vi.advanceTimersByTime(2500));
    expect(useChrome.getState().visible).toBe(false);

    act(() => usePlayer.setState({ status: "ended" }));
    expect(useChrome.getState().visible).toBe(true);
    act(() => vi.advanceTimersByTime(10_000));
    expect(useChrome.getState().visible).toBe(true);

    // Playing again lets it go as usual.
    act(() => usePlayer.setState({ status: "playing" }));
    act(() => vi.advanceTimersByTime(2500));
    expect(useChrome.getState().visible).toBe(false);
  });
});

describe("opening", () => {
  it("says nothing when a file opens at once", () => {
    usePlayer.setState({ status: "loading" });
    show();
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    act(() => vi.advanceTimersByTime(300));
    act(() => usePlayer.setState({ status: "playing" }));
    act(() => vi.advanceTimersByTime(500));
    expect(status).toBeEmptyDOMElement();
  });

  it("shows the working indicator, and says so, once it has taken a while", () => {
    usePlayer.setState({ status: "loading" });
    show();
    const status = screen.getByRole("status");
    act(() => vi.advanceTimersByTime(400));
    // Filled into a region that was already there, so it is announced.
    expect(status).toHaveTextContent("Opening");

    act(() => usePlayer.setState({ status: "playing" }));
    expect(status).toBeEmptyDOMElement();
  });
});

describe("keyboard focus on the stage", () => {
  it("keeps the chrome while any control has it, the title bar's included, and not after a click", () => {
    const stopTracking = trackFocusOrigin();
    show();
    act(() => useChrome.getState().reset());

    // Clicked: the keyboard is still the player's, and the chrome may go.
    const pause = screen.getByRole("button", { name: "Pause" });
    fireEvent.pointerDown(pause);
    act(() => pause.focus());
    expect(useChrome.getState().holds.has("focus")).toBe(false);
    act(() => pause.blur());

    // Reached with Tab: it stays for as long as the control has focus.
    fireEvent.keyDown(window, { key: "Tab", code: "Tab" });
    const panel = screen.getByRole("button", { name: "Show playlist" });
    act(() => panel.focus());
    expect(useChrome.getState().holds.has("focus")).toBe(true);

    act(() => panel.blur());
    expect(useChrome.getState().holds.has("focus")).toBe(false);
    stopTracking();
  });
});
