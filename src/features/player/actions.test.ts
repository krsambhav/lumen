import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action } from "@/actions/registry";
import { mockCommands } from "@/ipc/bindings";
import { playerActions } from "./actions";
import { showOsd, useOsd } from "./osd";
import { IDLE_SNAPSHOT, usePlayer } from "./store";
import { useWindowState } from "./window";

function action(id: string): Action {
  const found = playerActions.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`no action ${id}`);
  }
  return found;
}

/** How an action is run from the keyboard. */
const KEYS = { source: "keyboard" } as const;

function osd() {
  const message = useOsd.getState().message;
  return message ? { label: message.label, value: message.value } : null;
}

const FILM = {
  ...IDLE_SNAPSHOT,
  status: "paused" as const,
  source: "/films/a.mkv",
  title: "a.mkv",
  position: 2537,
  duration: 7305,
};

beforeEach(() => {
  usePlayer.setState({ ...FILM, positionAt: 0, failure: null });
  useWindowState.setState({ fullscreen: false, keptOnTop: false });
});

afterEach(() => {
  useOsd.getState().clear();
  usePlayer.setState({ ...IDLE_SNAPSHOT, positionAt: 0, failure: null });
  clearMocks();
});

describe("every action", () => {
  it("has a unique id, a name and at least one shortcut", () => {
    const ids = playerActions.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const candidate of playerActions) {
      expect(candidate.name.length).toBeGreaterThan(0);
      expect(candidate.shortcuts.length).toBeGreaterThan(0);
    }
  });

  it("claims no chord that another action also claims", () => {
    const chords = playerActions.flatMap((candidate) => candidate.shortcuts);
    expect(new Set(chords).size).toBe(chords.length);
  });
});

describe("volume", () => {
  it("steps to the next multiple of five in either direction", () => {
    const playerSetVolume = vi.fn(() => null);
    mockCommands({ playerSetVolume });

    usePlayer.setState({ volume: 63 });
    void action("audio.volumeUp").run(KEYS);
    expect(playerSetVolume).toHaveBeenLastCalledWith({ percent: 65 });
    void action("audio.volumeDown").run(KEYS);
    expect(playerSetVolume).toHaveBeenLastCalledWith({ percent: 60 });

    usePlayer.setState({ volume: 65 });
    void action("audio.volumeUp").run(KEYS);
    expect(playerSetVolume).toHaveBeenLastCalledWith({ percent: 70 });
    usePlayer.setState({ volume: 65 });
    void action("audio.volumeDown").run(KEYS);
    expect(playerSetVolume).toHaveBeenLastCalledWith({ percent: 60 });
  });

  it("starts each step from the one before, however quickly they come", () => {
    const playerSetVolume = vi.fn(() => null);
    mockCommands({ playerSetVolume });

    // Three steps before the player has answered the first: three steps, not one.
    usePlayer.setState({ volume: 100 });
    void action("audio.volumeDown").run(KEYS);
    void action("audio.volumeDown").run(KEYS);
    void action("audio.volumeDown").run(KEYS);
    expect(playerSetVolume.mock.calls).toEqual([
      [{ percent: 95 }],
      [{ percent: 90 }],
      [{ percent: 85 }],
    ]);
    // The needle is already there, and the display says the same.
    expect(usePlayer.getState().volume).toBe(85);
    expect(osd()).toEqual({ label: "Volume", value: "85%" });
  });

  it("stops at silence and at 200 percent", () => {
    const playerSetVolume = vi.fn(() => null);
    mockCommands({ playerSetVolume });

    usePlayer.setState({ volume: 200 });
    void action("audio.volumeUp").run(KEYS);
    expect(playerSetVolume).toHaveBeenLastCalledWith({ percent: 200 });
    usePlayer.setState({ volume: 0 });
    void action("audio.volumeDown").run(KEYS);
    expect(playerSetVolume).toHaveBeenLastCalledWith({ percent: 0 });
  });

  it("confirms the new level on screen, on the same scale as the control bar", () => {
    mockCommands({ playerSetVolume: () => null });
    usePlayer.setState({ volume: 100 });
    void action("audio.volumeUp").run(KEYS);
    expect(useOsd.getState().message).toMatchObject({
      label: "Volume",
      value: "105%",
      // 100% is three quarters of the way along; 105% is a twentieth of the last quarter further.
      scale: { at: 0.7625, mark: 0.75 },
    });
  });

  it("turns the sound back on, because nobody raises the volume to hear nothing", () => {
    const playerSetMuted = vi.fn(() => null);
    const playerSetVolume = vi.fn(() => null);
    mockCommands({ playerSetMuted, playerSetVolume });

    usePlayer.setState({ volume: 100, muted: true });
    void action("audio.volumeUp").run(KEYS);
    expect(playerSetMuted).toHaveBeenCalledWith({ muted: false });
    expect(playerSetVolume).toHaveBeenCalledWith({ percent: 105 });

    playerSetMuted.mockClear();
    usePlayer.setState({ muted: false });
    void action("audio.volumeDown").run(KEYS);
    expect(playerSetMuted).not.toHaveBeenCalled();
  });

  it("works with nothing open, and repeats while the key is held", () => {
    usePlayer.setState({ ...IDLE_SNAPSHOT });
    expect(action("audio.volumeUp").unavailable?.()).toBeUndefined();
    expect(action("audio.volumeUp").repeats).toBe(true);
    expect(action("audio.volumeDown").repeats).toBe(true);
  });
});

describe("seeking", () => {
  it("moves five seconds, quietly: the picture jumping is the answer", () => {
    const playerSeekBy = vi.fn(() => null);
    mockCommands({ playerSeekBy });

    void action("playback.forward").run(KEYS);
    expect(playerSeekBy).toHaveBeenLastCalledWith({ seconds: 5 });
    expect(osd()).toBeNull();

    void action("playback.back").run(KEYS);
    expect(playerSeekBy).toHaveBeenLastCalledWith({ seconds: -5 });
    expect(osd()).toBeNull();
  });

  it("has a ten-second step on J and L, and a minute on Shift with the arrows", () => {
    const playerSeekBy = vi.fn(() => null);
    mockCommands({ playerSeekBy });

    expect(action("playback.forward10").shortcuts).toEqual(["l"]);
    expect(action("playback.back10").shortcuts).toEqual(["j"]);
    void action("playback.forward10").run(KEYS);
    expect(playerSeekBy).toHaveBeenLastCalledWith({ seconds: 10 });
    expect(osd()).toBeNull();

    expect(action("playback.forwardMinute").shortcuts).toEqual(["Shift+Right"]);
    expect(action("playback.forwardMinute").name).toBe("Forward 1 minute");
    void action("playback.backMinute").run(KEYS);
    expect(playerSeekBy).toHaveBeenLastCalledWith({ seconds: -60 });
    expect(osd()).toBeNull();
  });

  it("says why only when a step can do nothing", () => {
    mockCommands({ playerSeekBy: () => null });
    // Two seconds from the end there are only two seconds to go forward.
    usePlayer.setState({ position: 7303 });
    void action("playback.forward").run(KEYS);
    expect(osd()).toBeNull();

    usePlayer.setState({ position: 7305 });
    void action("playback.forward").run(KEYS);
    expect(osd()).toEqual({ label: "At the end", value: "2:01:45" });

    usePlayer.setState({ position: 0 });
    void action("playback.back").run(KEYS);
    expect(osd()).toEqual({ label: "At the start", value: "0:00:00" });
  });

  it("goes to a tenth of the way through on 0–9, quietly", () => {
    const playerSeekTo = vi.fn(() => null);
    mockCommands({ playerSeekTo });
    expect(action("playback.tenth3").shortcuts).toEqual(["3"]);
    void action("playback.tenth3").run(KEYS);
    expect(playerSeekTo).toHaveBeenLastCalledWith({ seconds: 7305 * 0.3, exact: false });
    expect(osd()).toBeNull();
    void action("playback.tenth0").run(KEYS);
    expect(playerSeekTo).toHaveBeenLastCalledWith({ seconds: 0, exact: false });
  });

  it("goes back to the beginning on Home", () => {
    const playerSeekTo = vi.fn(() => null);
    mockCommands({ playerSeekTo });
    void action("playback.start").run(KEYS);
    expect(playerSeekTo).toHaveBeenCalledWith({ seconds: 0, exact: true });
    expect(osd()).toEqual({ label: "Beginning", value: "0:00:00" });
  });

  it("needs something open", () => {
    usePlayer.setState({ ...IDLE_SNAPSHOT });
    for (const id of [
      "playback.forward",
      "playback.back",
      "playback.forward10",
      "playback.start",
    ]) {
      expect(action(id).unavailable?.(), id).toBe("Nothing is open");
    }
    expect(action("playback.toggle").unavailable?.()).toBe("Nothing is open");
  });
});

describe("play and pause", () => {
  it("toggles without words on screen, and clears any that were there", () => {
    const playerTogglePaused = vi.fn(() => null);
    mockCommands({ playerTogglePaused });

    for (const status of ["paused", "playing", "ended"] as const) {
      showOsd({ label: "Volume" });
      usePlayer.setState({ status });
      void action("playback.toggle").run(KEYS);
      expect(osd()).toBeNull();
    }
    expect(playerTogglePaused).toHaveBeenCalledTimes(3);
  });
});

describe("mute", () => {
  it("flips the current state and says so", () => {
    const playerSetMuted = vi.fn(() => null);
    mockCommands({ playerSetMuted });

    void action("audio.mute").run(KEYS);
    expect(playerSetMuted).toHaveBeenLastCalledWith({ muted: true });
    expect(osd()?.label).toBe("Muted");

    usePlayer.setState({ muted: true });
    void action("audio.mute").run(KEYS);
    expect(playerSetMuted).toHaveBeenLastCalledWith({ muted: false });
    expect(osd()?.label).toBe("Sound on");
  });
});

describe("confirmation on screen", () => {
  it("is given for changes made from the keyboard, the picture, a menu or the palette", () => {
    mockCommands({ playerSetMuted: () => null });
    for (const source of ["keyboard", "pointer", "menu", "palette", "system"] as const) {
      useOsd.getState().clear();
      void action("audio.mute").run({ source });
      expect(osd(), source).not.toBeNull();
    }
  });

  it("is cleared by a control, whose change has made it out of date", () => {
    mockCommands({ playerSetMuted: () => null });
    void action("audio.mute").run(KEYS);
    expect(osd()?.label).toBe("Muted");
    // The Mute button is clicked while "Muted" is still on screen.
    usePlayer.setState({ muted: true });
    void action("audio.mute").run({ source: "control" });
    expect(osd()).toBeNull();
  });

  it("is not repeated for a change made with a control that shows it", () => {
    mockCommands({
      playerSetMuted: () => null,
      playerTogglePaused: () => null,
      playerSetVolume: () => null,
      playerSeekBy: () => null,
    });
    const control = { source: "control" } as const;
    void action("audio.mute").run(control);
    void action("playback.toggle").run(control);
    void action("audio.volumeUp").run(control);
    void action("playback.forward").run(control);
    expect(osd()).toBeNull();
  });
});

describe("full screen", () => {
  it("toggles from F, and Escape only ever leaves it", () => {
    const windowToggleFullscreen = vi.fn(() => null);
    const windowSetFullscreen = vi.fn(() => null);
    mockCommands({ windowToggleFullscreen, windowSetFullscreen });

    void action("view.fullscreen").run(KEYS);
    expect(windowToggleFullscreen).toHaveBeenCalledOnce();

    const leave = action("view.exitFullscreen");
    expect(leave.shortcuts).toEqual(["Escape"]);
    expect(leave.unavailable?.()).toBe("Not in full screen");
    useWindowState.setState({ fullscreen: true });
    expect(leave.unavailable?.()).toBeUndefined();
    void leave.run(KEYS);
    expect(windowSetFullscreen).toHaveBeenCalledWith({ fullscreen: false });
  });
});

describe("one frame at a time", () => {
  it("steps forward on the full stop and back on the comma, while a key is held too", () => {
    const step = vi.fn((_: { forward: boolean }) => null);
    mockCommands({ playerStepFrame: step });
    expect(action("playback.nextFrame").shortcuts).toEqual(["."]);
    expect(action("playback.previousFrame").shortcuts).toEqual([","]);
    expect(action("playback.nextFrame").repeats).toBe(true);
    void action("playback.nextFrame").run(KEYS);
    expect(step).toHaveBeenLastCalledWith({ forward: true });
    expect(osd()).toEqual({ label: "Next frame", value: undefined });
    void action("playback.previousFrame").run(KEYS);
    expect(step).toHaveBeenLastCalledWith({ forward: false });
  });
});

describe("speed", () => {
  function speeds() {
    const speed = vi.fn((_: { rate: number }) => null);
    mockCommands({ playerSetSpeed: speed });
    return speed;
  }

  it("steps up and down on the bracket keys and says the new speed", () => {
    const speed = speeds();
    void action("playback.faster").run(KEYS);
    expect(speed).toHaveBeenLastCalledWith({ rate: 1.25 });
    expect(osd()).toEqual({ label: "Speed", value: "1.25×" });
    void action("playback.slower").run(KEYS);
    expect(speed).toHaveBeenLastCalledWith({ rate: 0.75 });
  });

  it("returns to normal on its own key, and says so in words", () => {
    const speed = speeds();
    usePlayer.setState({ speed: 2 });
    void action("playback.normalSpeed").run(KEYS);
    expect(speed).toHaveBeenLastCalledWith({ rate: 1 });
    expect(osd()).toEqual({ label: "Normal speed", value: undefined });
  });

  it("says when there is no further to go", () => {
    expect(action("playback.normalSpeed").unavailable?.()).toBe("Already at normal speed");
    usePlayer.setState({ speed: 4 });
    expect(action("playback.faster").unavailable?.()).toBe("This is the fastest");
    expect(action("playback.slower").unavailable?.()).toBeUndefined();
    usePlayer.setState({ speed: 0.25 });
    expect(action("playback.slower").unavailable?.()).toBe("This is the slowest");
  });
});

describe("chapters", () => {
  const CHAPTERS = [
    { title: "The Station", time: 0 },
    { title: null, time: 1260 },
    { title: "Morning", time: 6300 },
  ];

  function seeks() {
    const seek = vi.fn((_: { seconds: number; exact: boolean }) => null);
    mockCommands({ playerSeekTo: seek });
    return seek;
  }

  it("goes to the next one and names it", () => {
    const seek = seeks();
    usePlayer.setState({ chapters: CHAPTERS });
    void action("playback.nextChapter").run(KEYS);
    expect(seek).toHaveBeenCalledWith({ seconds: 6300, exact: true });
    expect(osd()).toEqual({ label: "Morning", value: "1:45:00" });
    // The needle is there at once.
    expect(usePlayer.getState().position).toBe(6300);
  });

  it("goes back to the start of this one, calling an untitled chapter by its number", () => {
    const seek = seeks();
    usePlayer.setState({ chapters: CHAPTERS });
    void action("playback.previousChapter").run(KEYS);
    expect(seek).toHaveBeenCalledWith({ seconds: 1260, exact: true });
    expect(osd()).toEqual({ label: "Chapter 2", value: "0:21:00" });
  });

  it("cannot be used in a film without them, or past the last", () => {
    expect(action("playback.nextChapter").unavailable?.()).toBe("This has no chapters");
    expect(action("playback.previousChapter").unavailable?.()).toBe("This has no chapters");
    usePlayer.setState({ chapters: CHAPTERS, position: 7000 });
    expect(action("playback.nextChapter").unavailable?.()).toBe("This is the last chapter");
    expect(action("playback.previousChapter").unavailable?.()).toBeUndefined();
  });
});

describe("going to a time", () => {
  it("opens the palette to ask where", async () => {
    const { usePalette } = await import("@/features/palette/store");
    void action("playback.goToTime").run(KEYS);
    expect(usePalette.getState()).toMatchObject({ open: true, mode: "time" });
    usePalette.setState({ open: false, mode: "all" });
  });

  it("needs something whose length is known", () => {
    usePlayer.setState({ duration: null });
    expect(action("playback.goToTime").unavailable?.()).toBe("This cannot be moved through");
    expect(action("playback.forward").unavailable?.()).toBe("This cannot be moved through");
    // Play and pause need only something open.
    expect(action("playback.toggle").unavailable?.()).toBeUndefined();
  });
});

describe("keeping the window on top", () => {
  it("is switched at once, and says so over a film", () => {
    const onTop = vi.fn((_: { onTop: boolean }) => null);
    mockCommands({ windowSetAlwaysOnTop: onTop });
    const keep = action("window.keepOnTop");
    expect(keep.checked?.()).toBe(false);
    void keep.run(KEYS);
    expect(onTop).toHaveBeenCalledTimes(1);
    expect(onTop).toHaveBeenCalledWith({ onTop: true });
    expect(keep.checked?.()).toBe(true);
    expect(osd()?.label).toBe("Kept on top");
  });

  it("is put back if the window refuses", async () => {
    mockCommands({
      windowSetAlwaysOnTop: () => {
        throw { kind: "internal", message: "no" };
      },
    });
    void action("window.keepOnTop").run(KEYS);
    expect(useWindowState.getState().keptOnTop).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useWindowState.getState().keptOnTop).toBe(false);
  });
});
