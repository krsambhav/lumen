import { clearMocks } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { SurfaceProvider } from "@/components/ui/surface";
import { mockCommands } from "@/ipc/bindings";
import { useChrome } from "./chrome";
import { resetPreviews } from "./preview";
import { IDLE_SNAPSHOT, usePlayer } from "./store";
import { Timeline } from "./Timeline";

const FILM = {
  ...IDLE_SNAPSHOT,
  status: "paused" as const,
  source: "/films/a.mkv",
  title: "a.mkv",
  position: 2537,
  duration: 7305,
};

let seeks: Mock<(args: { seconds: number; exact: boolean }) => null>;

beforeEach(() => {
  seeks = vi.fn<(args: { seconds: number; exact: boolean }) => null>(() => null);
  mockCommands({ playerSeekTo: seeks });
  usePlayer.setState({ ...FILM, positionAt: 0, failure: null });
});

afterEach(() => {
  clearMocks();
  resetPreviews();
  act(() => useChrome.getState().reset());
  usePlayer.setState({ ...IDLE_SNAPSHOT, positionAt: 0, failure: null });
});

function show() {
  render(
    <SurfaceProvider value="stage">
      <Timeline />
    </SurfaceProvider>,
  );
  return screen.getByRole("slider", { name: "Position" });
}

function press(timeline: HTMLElement, key: string, shiftKey = false) {
  fireEvent.keyDown(timeline, { key, shiftKey });
  return seeks.mock.calls.at(-1)?.[0];
}

describe("Timeline", () => {
  it("says where the film is, in words", () => {
    const timeline = show();
    expect(timeline).toHaveAttribute("aria-valuetext", "42 minutes 17 seconds of 2 hours 1 minute");
    expect(timeline).toHaveAttribute("aria-valuemax", "7305");
    expect(timeline).toHaveAttribute("aria-valuenow", "2537");
  });

  it("moves five seconds on an arrow and a minute with Shift or a Page key", () => {
    const timeline = show();
    expect(press(timeline, "ArrowRight")).toEqual({ seconds: 2542, exact: true });
    expect(press(timeline, "ArrowLeft")).toEqual({ seconds: 2532, exact: true });
    expect(press(timeline, "ArrowRight", true)).toEqual({ seconds: 2597, exact: true });
    expect(press(timeline, "ArrowLeft", true)).toEqual({ seconds: 2477, exact: true });
    expect(press(timeline, "PageUp")).toEqual({ seconds: 2597, exact: true });
    expect(press(timeline, "PageDown")).toEqual({ seconds: 2477, exact: true });
  });

  it("goes to either end, and never past it", () => {
    const timeline = show();
    expect(press(timeline, "Home")).toEqual({ seconds: 0, exact: true });
    expect(press(timeline, "End")).toEqual({ seconds: 7305, exact: true });
    usePlayer.setState({ position: 7303 });
    expect(press(timeline, "ArrowRight")).toEqual({ seconds: 7305, exact: true });
    usePlayer.setState({ position: 2 });
    expect(press(timeline, "ArrowLeft")).toEqual({ seconds: 0, exact: true });
  });

  it("never takes the vertical arrows, which mean volume everywhere", () => {
    const timeline = show();
    fireEvent.keyDown(timeline, { key: "ArrowUp" });
    fireEvent.keyDown(timeline, { key: "ArrowDown" });
    expect(seeks).not.toHaveBeenCalled();
    // And says so to the shortcut dispatcher, which would otherwise leave them to a slider.
    expect(timeline.dataset.ownKeys?.split(" ")).toEqual([
      "Left",
      "Right",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ]);
  });

  it("leaves chords with Command, Control or Option to the shortcuts", () => {
    const timeline = show();
    fireEvent.keyDown(timeline, { key: "ArrowRight", metaKey: true });
    fireEvent.keyDown(timeline, { key: "ArrowRight", altKey: true });
    expect(seeks).not.toHaveBeenCalled();
  });

  it("draws its focus ring on the needle, not around the whole bar", () => {
    const timeline = show();
    expect(timeline).toHaveClass("ring-on-needle");
    expect(timeline.querySelector("[data-needle]")).toHaveClass("needle");
  });

  it("is outlined, so it is drawn over any picture", () => {
    const timeline = show();
    expect(timeline.querySelector(".bg-stage-track")).toHaveClass(
      "shadow-[0_0_0_1px_var(--stage-edge)]",
    );
  });

  it("is not a tab stop, and takes no keys, when the film cannot be sought", () => {
    usePlayer.setState({ duration: null });
    const timeline = show();
    expect(timeline).toHaveAttribute("tabindex", "-1");
    expect(timeline).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(timeline, { key: "ArrowRight" });
    expect(seeks).not.toHaveBeenCalled();
  });
});

const CHAPTERS = [
  { title: "The Station", time: 0 },
  { title: null, time: 1260 },
  { title: "Morning", time: 6300 },
];

const PICTURE = {
  width: 1920,
  height: 1080,
  fps: 24,
  codec: "hevc",
  dynamicRange: "sdr" as const,
  hardwareDecoder: null,
};

/** The timeline laid out 1000 px wide from the window's left edge, as jsdom cannot do itself. */
function showWide() {
  const timeline = show();
  vi.spyOn(timeline, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 1000,
    bottom: 24,
    width: 1000,
    height: 24,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return timeline;
}

function loupe() {
  return document.querySelector<HTMLElement>("[data-loupe]");
}

/** The box the loupe keeps for a still: its first child, when a still is expected. */
function stillRoom(): HTMLElement {
  const room = loupe()?.firstElementChild;
  if (!(room instanceof HTMLElement)) {
    throw new Error("the loupe is not showing");
  }
  return room;
}

describe("chapters on the timeline", () => {
  it("cut the track where each one starts, but not at the very start", () => {
    usePlayer.setState({ chapters: CHAPTERS });
    const timeline = show();
    const gaps = [...timeline.querySelectorAll<HTMLElement>("[data-chapter-gap]")];
    expect(gaps).toHaveLength(2);
    expect(Number.parseFloat(gaps[0]?.style.left ?? "")).toBeCloseTo((1260 / 7305) * 100, 4);
    expect(Number.parseFloat(gaps[1]?.style.left ?? "")).toBeCloseTo((6300 / 7305) * 100, 4);
    // Inside the track, so they thicken with it.
    expect(gaps[0]?.parentElement).toHaveClass("bg-stage-track");
  });

  it("are not drawn on a timeline that cannot be sought", () => {
    usePlayer.setState({ chapters: CHAPTERS, duration: null });
    expect(show().querySelector("[data-chapter-gap]")).toBeNull();
  });
});

describe("the loupe", () => {
  beforeEach(() => {
    mockCommands({
      playerSeekTo: seeks,
      playerPreviewFrame: (args) => `data:image/gif;base64,still-${Math.round(args.seconds)}`,
    });
  });

  it("says the time under the pointer, and nothing else when there is nothing else to say", () => {
    const timeline = showWide();
    expect(loupe()).toBeNull();
    fireEvent.pointerMove(timeline, { clientX: 500 });
    expect(loupe()).toHaveTextContent("1:00:52");
    expect(loupe()?.querySelector("img")).toBeNull();
    // As wide as its longest reading, and no wider.
    expect(loupe()).toHaveClass("min-w-[3.75rem]");
    fireEvent.pointerLeave(timeline);
    expect(loupe()).toBeNull();
  });

  it("names the chapter under the pointer", () => {
    usePlayer.setState({ chapters: CHAPTERS });
    const timeline = showWide();
    fireEvent.pointerMove(timeline, { clientX: 100 });
    expect(loupe()).toHaveTextContent("The Station");
    fireEvent.pointerMove(timeline, { clientX: 500 });
    expect(loupe()).toHaveTextContent("Chapter 2");
    // With a name in it the loupe has one fixed width, so it can be kept inside the track.
    expect(loupe()).toHaveClass("w-[12.625rem]");
  });

  it("keeps room for a still from the start, and shows it when it arrives", async () => {
    usePlayer.setState({ video: PICTURE });
    const timeline = showWide();
    fireEvent.pointerMove(timeline, { clientX: 500 });
    const room = stillRoom();
    // 192 px wide at the picture's own shape.
    expect(room.style.height).toBe("108px");
    expect(room.querySelector("img")).toBeNull();
    await waitFor(() => expect(room.querySelector("img")).not.toBeNull());
    expect(room.querySelector("img")?.getAttribute("src")).toMatch(
      /^data:image\/gif;base64,still-/,
    );
    // Decoration, as far as a screen reader is concerned: the slider says where the film is.
    expect(loupe()).toHaveAttribute("aria-hidden", "true");
  });

  it("is no taller than it is wide for a picture that is", () => {
    usePlayer.setState({ video: { ...PICTURE, width: 1080, height: 1920 } });
    const timeline = showWide();
    fireEvent.pointerMove(timeline, { clientX: 500 });
    expect(stillRoom().style.height).toBe("192px");
  });

  it("shows no still for sound alone, or for something that is not a file on this Mac", () => {
    const timeline = showWide();
    fireEvent.pointerMove(timeline, { clientX: 500 });
    expect(loupe()?.querySelector("div[style]")).toBeNull();

    act(() => usePlayer.setState({ video: PICTURE, source: "https://example.com/a.mp4" }));
    fireEvent.pointerMove(timeline, { clientX: 510 });
    expect(loupe()).toHaveClass("min-w-[3.75rem]");
  });

  it("shows no still while the needle is dragged: the picture itself is following", () => {
    usePlayer.setState({ video: PICTURE });
    const timeline = showWide();
    fireEvent.pointerDown(timeline, { clientX: 500, button: 0, pointerId: 1 });
    fireEvent.pointerMove(timeline, { clientX: 520, pointerId: 1 });
    expect(loupe()).toHaveTextContent("1:03:18");
    expect(loupe()?.querySelector("div[style]")).toBeNull();
  });
});

describe("dragging to the end", () => {
  it("stops a second short while the button is down, so the film does not end under the pointer", () => {
    const timeline = showWide();
    fireEvent.pointerDown(timeline, { clientX: 1000, button: 0, pointerId: 1 });
    expect(seeks).toHaveBeenLastCalledWith({ seconds: 7304, exact: false });
  });

  it("lands just short of the end on letting go, which then plays out", () => {
    const timeline = showWide();
    fireEvent.pointerDown(timeline, { clientX: 900, button: 0, pointerId: 1 });
    fireEvent.pointerUp(timeline, { clientX: 1000, pointerId: 1 });
    expect(seeks).toHaveBeenLastCalledWith({ seconds: 7304.75, exact: true });
    // The needle is there at once, not when the seek has finished.
    expect(usePlayer.getState().position).toBe(7304.75);
  });

  it("lands exactly where it is dropped anywhere else", () => {
    const timeline = showWide();
    fireEvent.pointerDown(timeline, { clientX: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(timeline, { clientX: 250, pointerId: 1 });
    expect(seeks).toHaveBeenLastCalledWith({ seconds: 1826.25, exact: true });
  });
});
