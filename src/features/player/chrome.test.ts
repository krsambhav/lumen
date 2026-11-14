import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHROME_IDLE_MS, CHROME_REST_MS, useChrome } from "./chrome";

beforeEach(() => {
  vi.useFakeTimers();
  useChrome.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("chrome visibility", () => {
  it("dims two seconds after the pointer last moved", () => {
    useChrome.getState().wake();
    vi.advanceTimersByTime(CHROME_IDLE_MS - 1);
    expect(useChrome.getState().visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(useChrome.getState().visible).toBe(false);
  });

  it("restarts the wait on every movement", () => {
    useChrome.getState().wake();
    vi.advanceTimersByTime(CHROME_IDLE_MS * 0.75);
    useChrome.getState().wake();
    vi.advanceTimersByTime(CHROME_IDLE_MS * 0.75);
    expect(useChrome.getState().visible).toBe(true);
    vi.advanceTimersByTime(CHROME_IDLE_MS * 0.25);
    expect(useChrome.getState().visible).toBe(false);
  });

  it("comes back on movement", () => {
    useChrome.getState().wake();
    vi.advanceTimersByTime(CHROME_IDLE_MS);
    useChrome.getState().wake();
    expect(useChrome.getState().visible).toBe(true);
  });

  it("stays while anything holds it, and waits again once released", () => {
    const chrome = useChrome.getState();
    chrome.wake();
    chrome.hold("menu");
    chrome.hold("pointer");
    vi.advanceTimersByTime(CHROME_IDLE_MS * 3);
    expect(useChrome.getState().visible).toBe(true);

    chrome.release("menu");
    vi.advanceTimersByTime(CHROME_IDLE_MS * 3);
    expect(useChrome.getState().visible).toBe(true);

    chrome.release("pointer");
    vi.advanceTimersByTime(CHROME_IDLE_MS - 1);
    expect(useChrome.getState().visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(useChrome.getState().visible).toBe(false);
  });

  it("a hold brings hidden chrome back", () => {
    useChrome.getState().wake();
    vi.advanceTimersByTime(CHROME_IDLE_MS);
    useChrome.getState().hold("focus");
    expect(useChrome.getState().visible).toBe(true);
  });

  it("ignores a release that was never held", () => {
    useChrome.getState().wake();
    useChrome.getState().release("nothing");
    vi.advanceTimersByTime(CHROME_IDLE_MS);
    expect(useChrome.getState().visible).toBe(false);
  });

  it("a hold outlasts whatever the pointer is doing", () => {
    const chrome = useChrome.getState();
    chrome.setPlaying(true);
    chrome.hold("drag");
    chrome.rest("controls", true);
    chrome.rest("controls", false);
    vi.advanceTimersByTime(CHROME_REST_MS * 3);
    expect(useChrome.getState().visible).toBe(true);
  });
});

describe("a pointer resting on the chrome", () => {
  it("keeps it for as long as it rests there while the film is paused", () => {
    const chrome = useChrome.getState();
    chrome.wake();
    chrome.rest("controls", true);
    vi.advanceTimersByTime(60_000);
    expect(useChrome.getState().visible).toBe(true);

    // Leaving it is ordinary idleness again.
    chrome.rest("controls", false);
    vi.advanceTimersByTime(CHROME_IDLE_MS);
    expect(useChrome.getState().visible).toBe(false);
  });

  it("keeps it three seconds, not for the whole film, while it plays", () => {
    const chrome = useChrome.getState();
    chrome.setPlaying(true);
    chrome.wake();
    chrome.rest("controls", true);
    vi.advanceTimersByTime(CHROME_REST_MS - 1);
    expect(useChrome.getState().visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(useChrome.getState().visible).toBe(false);
  });

  it("starts the three seconds again whenever the pointer moves", () => {
    const chrome = useChrome.getState();
    chrome.setPlaying(true);
    chrome.rest("controls", true);
    vi.advanceTimersByTime(CHROME_REST_MS - 500);
    chrome.wake();
    vi.advanceTimersByTime(CHROME_REST_MS - 500);
    expect(useChrome.getState().visible).toBe(true);
    vi.advanceTimersByTime(500);
    expect(useChrome.getState().visible).toBe(false);
  });

  it("lets the chrome go once playback starts under a pointer that was resting", () => {
    const chrome = useChrome.getState();
    chrome.rest("controls", true);
    vi.advanceTimersByTime(30_000);
    expect(useChrome.getState().visible).toBe(true);

    // Play is clicked and the hand leaves the mouse where it is.
    chrome.setPlaying(true);
    vi.advanceTimersByTime(CHROME_REST_MS);
    expect(useChrome.getState().visible).toBe(false);
  });

  it("counts the title bar as chrome too, each part on its own", () => {
    const chrome = useChrome.getState();
    chrome.rest("titlebar", true);
    chrome.rest("controls", true);
    chrome.rest("controls", false);
    vi.advanceTimersByTime(60_000);
    expect(useChrome.getState().visible).toBe(true);
    chrome.rest("titlebar", false);
    vi.advanceTimersByTime(CHROME_IDLE_MS);
    expect(useChrome.getState().visible).toBe(false);
  });
});
