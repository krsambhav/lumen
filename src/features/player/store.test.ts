import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayerSnapshot } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import {
  currentPosition,
  hasMedia,
  IDLE_SNAPSHOT,
  reduce,
  usePlayer,
  VOLUME_ANSWER_MS,
  wantVolume,
} from "./store";

const PLAYING: PlayerSnapshot = {
  ...IDLE_SNAPSHOT,
  status: "playing",
  source: "/films/a.mkv",
  title: "a.mkv",
  position: 10,
  duration: 100,
};

describe("reduce", () => {
  it("folds each kind of change into the snapshot", () => {
    expect(reduce(IDLE_SNAPSHOT, { type: "status", status: "paused" })).toEqual({
      status: "paused",
    });
    // Opening something new puts what went wrong before behind us.
    expect(reduce(IDLE_SNAPSHOT, { type: "media", source: "/a.mkv", title: "a.mkv" })).toEqual({
      source: "/a.mkv",
      title: "a.mkv",
      failure: null,
    });
    // Going back to nothing does not: that is how a failed attempt ends.
    expect(reduce(IDLE_SNAPSHOT, { type: "media", source: null, title: null })).toEqual({
      source: null,
      title: null,
    });
    expect(reduce(IDLE_SNAPSHOT, { type: "duration", seconds: null })).toEqual({ duration: null });
    expect(reduce(IDLE_SNAPSHOT, { type: "volume", percent: 150 })).toEqual({ volume: 150 });
    expect(reduce(IDLE_SNAPSHOT, { type: "muted", muted: true })).toEqual({ muted: true });
    expect(reduce(IDLE_SNAPSHOT, { type: "video", video: null })).toEqual({ video: null });
    expect(reduce(IDLE_SNAPSHOT, { type: "tracks", tracks: [] })).toEqual({ tracks: [] });
    expect(reduce(IDLE_SNAPSHOT, { type: "chapters", chapters: [] })).toEqual({ chapters: [] });
  });

  it("stamps a position with the time it arrived", () => {
    vi.spyOn(performance, "now").mockReturnValue(5000);
    expect(reduce(IDLE_SNAPSHOT, { type: "position", seconds: 12.5 })).toEqual({
      position: 12.5,
      positionAt: 5000,
    });
  });

  it("re-stamps the position when the speed changes", () => {
    vi.spyOn(performance, "now").mockReturnValue(9000);
    expect(reduce(PLAYING, { type: "speed", rate: 2 })).toEqual({
      speed: 2,
      position: 10,
      positionAt: 9000,
    });
  });

  it("records a failure without touching the rest", () => {
    expect(
      reduce(PLAYING, {
        type: "failed",
        source: "/films/x.mkv",
        reason: { kind: "missing" },
        reveal: "/films",
      }),
    ).toEqual({
      failure: { source: "/films/x.mkv", reason: { kind: "missing" }, reveal: "/films" },
    });
  });
});

describe("currentPosition", () => {
  const base = { ...PLAYING, positionAt: 1000 };

  it("advances with the clock while playing", () => {
    expect(currentPosition(base, 1500)).toBeCloseTo(10.5);
  });

  it("advances faster or slower with the speed", () => {
    expect(currentPosition({ ...base, speed: 2 }, 1500)).toBeCloseTo(11);
    expect(currentPosition({ ...base, speed: 0.5 }, 3000)).toBeCloseTo(11);
  });

  it("stands still in every other state", () => {
    for (const status of ["paused", "buffering", "loading", "ended", "idle"] as const) {
      expect(currentPosition({ ...base, status }, 9000)).toBe(10);
    }
  });

  it("never runs past the end", () => {
    expect(currentPosition({ ...base, position: 99.9 }, 60_000)).toBe(100);
  });

  it("keeps advancing when the length is unknown", () => {
    expect(currentPosition({ ...base, duration: null }, 3000)).toBeCloseTo(12);
  });
});

describe("the store", () => {
  beforeEach(() => {
    usePlayer.getState().reset(IDLE_SNAPSHOT);
    usePlayer.setState({ failure: null });
  });

  afterEach(() => {
    clearMocks();
    vi.restoreAllMocks();
  });

  it("knows whether something is open", () => {
    expect(hasMedia(usePlayer.getState())).toBe(false);
    usePlayer.getState().apply({ type: "media", source: "/a.mkv", title: "a.mkv" });
    expect(hasMedia(usePlayer.getState())).toBe(true);
  });

  it("keeps the last failure until something else is opened", () => {
    const player = usePlayer.getState();
    // What the backend sends when a file will not open: the attempt, the
    // failure, and back to nothing.
    player.apply({ type: "media", source: "/a.mkv", title: "a.mkv" });
    player.apply({ type: "failed", source: "/a.mkv", reason: { kind: "notMedia" }, reveal: null });
    player.apply({ type: "media", source: null, title: null });
    expect(usePlayer.getState().failure?.reason).toEqual({ kind: "notMedia" });
    expect(hasMedia(usePlayer.getState())).toBe(false);

    player.apply({ type: "media", source: "/b.mkv", title: "b.mkv" });
    expect(usePlayer.getState().failure).toBeNull();
  });

  it("replays changes that arrive while the snapshot is loading", async () => {
    const { emit } = await import("@tauri-apps/api/event");
    const { connectPlayer } = await import("./store");

    let release: (snapshot: PlayerSnapshot) => void = () => {};
    mockCommands({
      playerSnapshot: () => new Promise<PlayerSnapshot>((resolve) => (release = resolve)),
    });

    const connection = connectPlayer();
    // The listener is registered asynchronously; `ready` says when it is.
    await connection.ready;
    await emit("player-changed", { type: "volume", percent: 42 });
    expect(usePlayer.getState().volume).toBe(100);

    release(PLAYING);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = usePlayer.getState();
    expect(state.status).toBe("playing");
    expect(state.volume).toBe(42);

    await emit("player-changed", { type: "status", status: "paused" });
    expect(usePlayer.getState().status).toBe("paused");
    connection.stop();
  });

  it("ignores a snapshot that arrives after it was disconnected", async () => {
    const { connectPlayer } = await import("./store");
    let release: (snapshot: PlayerSnapshot) => void = () => {};
    mockCommands({
      playerSnapshot: () => new Promise<PlayerSnapshot>((resolve) => (release = resolve)),
    });
    usePlayer.getState().reset(IDLE_SNAPSHOT);

    const connection = connectPlayer();
    await connection.ready;
    connection.stop();
    release(PLAYING);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(usePlayer.getState().status).toBe("idle");
  });
});

describe("a volume that has been asked for", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    usePlayer.getState().reset({ ...PLAYING, volume: 100 });
  });

  afterEach(() => {
    usePlayer.getState().reset(IDLE_SNAPSHOT);
    vi.useRealTimers();
    clearMocks();
  });

  const heard = (percent: number) => usePlayer.getState().apply({ type: "volume", percent });
  const volume = () => usePlayer.getState().volume;

  it("is shown at once, ahead of the player's answer", () => {
    wantVolume(95);
    expect(volume()).toBe(95);
    heard(95);
    expect(volume()).toBe(95);
  });

  it("never runs backwards while answers to older requests come in", () => {
    wantVolume(95);
    wantVolume(90);
    wantVolume(85);
    const seen: number[] = [];
    const stop = usePlayer.subscribe((state) => seen.push(state.volume));
    heard(95);
    heard(90);
    expect(volume()).toBe(85);
    heard(85);
    stop();
    expect(volume()).toBe(85);
    expect(seen.every((each) => each === 85)).toBe(true);
  });

  it("is the player's to say again once it has answered", () => {
    wantVolume(95);
    heard(95);
    // Changed from somewhere else: a media key, another window.
    heard(40);
    expect(volume()).toBe(40);
  });

  it("gives way to what the player last said, if the player never agrees", () => {
    // Asked for more than it will give.
    wantVolume(250);
    heard(200);
    expect(volume()).toBe(250);
    vi.advanceTimersByTime(VOLUME_ANSWER_MS);
    expect(volume()).toBe(200);
    // And from then on the player is believed at once.
    heard(180);
    expect(volume()).toBe(180);
  });

  it("asks the player where the volume is when it hears nothing at all", async () => {
    mockCommands({ playerSnapshot: () => ({ ...PLAYING, volume: 70 }) });
    wantVolume(95);
    await vi.advanceTimersByTimeAsync(VOLUME_ANSWER_MS);
    expect(volume()).toBe(70);
  });

  it("waits for the last of several, not the first", () => {
    wantVolume(95);
    vi.advanceTimersByTime(VOLUME_ANSWER_MS - 50);
    wantVolume(90);
    heard(95);
    // The first request's time is up, but a newer one is out.
    vi.advanceTimersByTime(100);
    expect(volume()).toBe(90);
    heard(90);
    expect(volume()).toBe(90);
  });

  it("is forgotten when the player's whole state is read afresh", () => {
    wantVolume(95);
    usePlayer.getState().reset({ ...PLAYING, volume: 60 });
    expect(volume()).toBe(60);
    heard(55);
    expect(volume()).toBe(55);
    vi.advanceTimersByTime(VOLUME_ANSWER_MS);
    expect(volume()).toBe(55);
  });
});
