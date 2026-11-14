import { clearMocks } from "@tauri-apps/api/mocks";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OWN_SHAPE } from "@/features/video/shape";
import type { Shape } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import {
  delaySpoken,
  delayText,
  MAX_DELAY,
  setAudioDelay,
  setShape,
  setSubtitleDelay,
} from "./adjust";
import { IDLE_SNAPSHOT, usePlayer } from "./store";

/** Lets every promise that is ready settle, the mocked backend's included. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  usePlayer.setState({ ...IDLE_SNAPSHOT, source: "/films/a.mkv", status: "paused" });
});

afterEach(() => {
  clearMocks();
  usePlayer.setState({ ...IDLE_SNAPSHOT, positionAt: 0, failure: null });
});

describe("delays as they are read", () => {
  it("carry their sign, a real minus and their unit", () => {
    expect(delayText(0.12)).toBe("+120 ms");
    expect(delayText(-0.25)).toBe("−250 ms");
    expect(delayText(0)).toBe("0 ms");
    expect(delayText(1)).toBe("+1 s");
    expect(delayText(-1.25)).toBe("−1.25 s");
    expect(delayText(1.5)).toBe("+1.5 s");
  });

  it("are spoken in words, saying which way", () => {
    expect(delaySpoken(0)).toBe("no delay");
    expect(delaySpoken(0.12)).toBe("120 milliseconds later");
    expect(delaySpoken(-1)).toBe("1 second earlier");
    expect(delaySpoken(-1.25)).toBe("1.25 seconds earlier");
  });
});

describe("values a scale drags", () => {
  it("are shown at once and sent to the player", async () => {
    const playerSetAudioDelay = vi.fn(() => null);
    const playerSetSubtitleDelay = vi.fn(() => null);
    const playerSetShape = vi.fn(() => null);
    mockCommands({ playerSetAudioDelay, playerSetSubtitleDelay, playerSetShape });

    setAudioDelay(0.125);
    expect(usePlayer.getState().audioDelay).toBe(0.125);
    setSubtitleDelay(-0.5);
    expect(usePlayer.getState().subtitleDelay).toBe(-0.5);
    const zoomed: Shape = { ...OWN_SHAPE, zoom: 2 };
    setShape(zoomed);
    expect(usePlayer.getState().shape).toEqual(zoomed);
    await flush();

    expect(playerSetAudioDelay).toHaveBeenCalledWith({ seconds: 0.125 });
    expect(playerSetSubtitleDelay).toHaveBeenCalledWith({ seconds: -0.5 });
    expect(playerSetShape).toHaveBeenCalledWith({ shape: zoomed });
  });

  it("keep delays within the backend's reach, in whole milliseconds", async () => {
    const playerSetAudioDelay = vi.fn((_: { seconds: number }) => null);
    mockCommands({ playerSetAudioDelay });
    setAudioDelay(MAX_DELAY + 5);
    await flush();
    setAudioDelay(-MAX_DELAY - 5);
    await flush();
    setAudioDelay(0.12345);
    await flush();
    expect(playerSetAudioDelay.mock.calls.map(([args]) => args.seconds)).toEqual([
      MAX_DELAY,
      -MAX_DELAY,
      0.123,
    ]);
  });

  it("are sent one at a time, and after each only the newest asked for meanwhile", async () => {
    const answers: (() => void)[] = [];
    const playerSetAudioDelay = vi.fn(
      () => new Promise<null>((resolve) => answers.push(() => resolve(null))),
    );
    mockCommands({ playerSetAudioDelay });

    setAudioDelay(0.1);
    setAudioDelay(0.2);
    setAudioDelay(0.3);
    expect(usePlayer.getState().audioDelay).toBe(0.3);
    await flush();
    expect(playerSetAudioDelay).toHaveBeenCalledTimes(1);

    // The player reports the first while the newest is still on its way: it is not shown.
    usePlayer.getState().apply({ type: "audioDelay", seconds: 0.1 });
    expect(usePlayer.getState().audioDelay).toBe(0.3);

    answers.shift()?.();
    await flush();
    expect(playerSetAudioDelay).toHaveBeenCalledTimes(2);
    expect(playerSetAudioDelay).toHaveBeenLastCalledWith({ seconds: 0.3 });
    answers.shift()?.();
    await flush();
    expect(playerSetAudioDelay).toHaveBeenCalledTimes(2);
    // Nothing is waiting any more: what the player says is taken again.
    usePlayer.getState().apply({ type: "audioDelay", seconds: 0.25 });
    expect(usePlayer.getState().audioDelay).toBe(0.25);
  });

  it("say so when the player refuses, and show what the player has instead", async () => {
    const failure = vi.spyOn(toast, "error");
    mockCommands({
      playerSetSubtitleDelay: () => {
        throw { kind: "engine", message: "no" };
      },
      playerSnapshot: () => ({ ...IDLE_SNAPSHOT, source: "/films/a.mkv", subtitleDelay: 0.05 }),
    });
    setSubtitleDelay(2);
    expect(usePlayer.getState().subtitleDelay).toBe(2);
    await flush();
    await flush();
    expect(failure).toHaveBeenCalledWith("Lumen could not move the subtitles", expect.anything());
    expect(usePlayer.getState().subtitleDelay).toBe(0.05);
  });
});
