import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action } from "@/actions/registry";
import { DEFAULT_SESSION, DEFAULT_SETTINGS } from "@/app/boot";
import { MAX_DELAY } from "@/features/player/adjust";
import { useOsd } from "@/features/player/osd";
import { IDLE_SNAPSHOT, usePlayer } from "@/features/player/store";
import { resetSettingsForTests, useSettings } from "@/features/settings/store";
import { useInterface } from "@/features/shell/interface";
import type { Track } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import { AUDIO_DELAY_STEP, audioActions } from "./actions";

const KEYS = { source: "keyboard" } as const;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function action(id: string): Action {
  const found = audioActions.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`no action ${id}`);
  }
  return found;
}

function osd() {
  const message = useOsd.getState().message;
  return message ? { label: message.label, value: message.value } : null;
}

function audio(id: number, given: Partial<Track> = {}): Track {
  return {
    id,
    kind: "audio",
    title: null,
    language: null,
    codec: "aac",
    selected: false,
    default: false,
    forced: false,
    external: false,
    file: null,
    secondary: false,
    channels: 2,
    ...given,
  };
}

const TRACKS = [
  audio(1, { language: "eng", codec: "ac3", channels: 6, selected: true }),
  audio(2, { language: "fre", title: "Version française" }),
];

const playerSelectTrack = vi.fn((_: { kind: string; id: number | null }) => null);
const playerSetAudioDelay = vi.fn((_: { seconds: number }) => null);
const settingsSet = vi.fn(() => null);

beforeEach(() => {
  playerSelectTrack.mockClear();
  playerSetAudioDelay.mockClear();
  settingsSet.mockClear();
  mockCommands({ playerSelectTrack, playerSetAudioDelay, settingsSet });
  resetSettingsForTests(DEFAULT_SETTINGS);
  useInterface.setState({ ...DEFAULT_SESSION.interface, panelOpen: false });
  usePlayer.setState({
    ...IDLE_SNAPSHOT,
    source: "/films/a.mkv",
    status: "paused",
    tracks: TRACKS,
    audioDelay: 0,
  });
});

afterEach(async () => {
  await flush();
  useOsd.getState().clear();
  usePlayer.setState({ ...IDLE_SNAPSHOT, positionAt: 0, failure: null });
  clearMocks();
});

describe("every audio action", () => {
  it("has a unique id and claims no chord another claims", () => {
    const ids = audioActions.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
    const chords = audioActions.flatMap((candidate) => candidate.shortcuts);
    expect(new Set(chords).size).toBe(chords.length);
  });

  it("has the documented shortcuts", () => {
    const keys = Object.fromEntries(audioActions.map((each) => [each.id, each.shortcuts]));
    expect(keys).toMatchObject({
      "audio.nextTrack": ["a"],
      "audio.later": ["Ctrl+="],
      "audio.earlier": ["Ctrl+-"],
      "audio.equaliser": ["e"],
      "view.audio": ["Shift+Cmd+a"],
    });
  });

  it("needs something open with sound, except the equaliser, which is about the room", () => {
    usePlayer.setState({ ...IDLE_SNAPSHOT });
    expect(action("audio.later").unavailable?.()).toBe("Nothing is open");
    expect(action("view.audio").unavailable?.()).toBe("Nothing is open");
    expect(action("audio.equaliser").unavailable).toBeUndefined();
    usePlayer.setState({ source: "/films/silent.mkv", tracks: [] });
    expect(action("audio.later").unavailable?.()).toBe("This file has no sound");
    expect(action("audio.nextTrack").unavailable?.()).toBe("This file has no sound");
  });
});

describe("audio tracks", () => {
  it("go to the next, round to the first, and say which", async () => {
    await action("audio.nextTrack").run(KEYS);
    expect(playerSelectTrack).toHaveBeenLastCalledWith({ kind: "audio", id: 2 });
    expect(osd()).toEqual({ label: "Audio", value: "French · Version française" });

    usePlayer.setState({
      tracks: [audio(1, { language: "eng" }), audio(2, { language: "fre", selected: true })],
    });
    await action("audio.nextTrack").run(KEYS);
    expect(playerSelectTrack).toHaveBeenLastCalledWith({ kind: "audio", id: 1 });
    expect(osd()?.value).toBe("English");
  });

  it("cannot change with only one", () => {
    usePlayer.setState({ tracks: [audio(1, { selected: true })] });
    expect(action("audio.nextTrack").unavailable?.()).toBe("There is only one audio track");
  });
});

describe("the sound's delay", () => {
  it("steps later and earlier, and reads with its sign", async () => {
    await action("audio.later").run(KEYS);
    expect(usePlayer.getState().audioDelay).toBe(AUDIO_DELAY_STEP);
    expect(osd()).toEqual({ label: "Audio delay", value: "+25 ms" });
    await flush();
    await action("audio.earlier").run(KEYS);
    await flush();
    await action("audio.earlier").run(KEYS);
    expect(usePlayer.getState().audioDelay).toBe(-AUDIO_DELAY_STEP);
    expect(osd()?.value).toBe("−25 ms");
    await flush();
    expect(playerSetAudioDelay).toHaveBeenLastCalledWith({ seconds: -AUDIO_DELAY_STEP });
  });

  it("stops at either end, and resets only when it is moved", async () => {
    expect(action("audio.resetDelay").unavailable?.()).toBe("The sound is not delayed");
    usePlayer.setState({ audioDelay: MAX_DELAY });
    expect(action("audio.later").unavailable?.()).toBe("This is as late as it goes");
    expect(action("audio.resetDelay").unavailable?.()).toBeUndefined();
    usePlayer.setState({ audioDelay: -MAX_DELAY });
    expect(action("audio.earlier").unavailable?.()).toBe("This is as early as it goes");
    await action("audio.resetDelay").run(KEYS);
    expect(usePlayer.getState().audioDelay).toBe(0);
    expect(osd()).toEqual({ label: "Audio delay", value: "0 ms" });
  });
});

describe("the equaliser", () => {
  it("switches on and off from its key, keeping its gains, and is checked while on", async () => {
    const gains = [3, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        audio: { ...DEFAULT_SETTINGS.audio, equaliser: { enabled: false, gains } },
      },
    });
    expect(action("audio.equaliser").checked?.()).toBe(false);
    await action("audio.equaliser").run(KEYS);
    expect(useSettings.getState().settings.audio.equaliser).toEqual({ enabled: true, gains });
    expect(action("audio.equaliser").checked?.()).toBe(true);
    expect(osd()).toEqual({ label: "Equaliser", value: "On" });
    await flush();
    await action("audio.equaliser").run(KEYS);
    expect(osd()).toEqual({ label: "Equaliser", value: "Off" });
    await flush();
    expect(settingsSet).toHaveBeenLastCalledWith({
      settings: expect.objectContaining({
        audio: expect.objectContaining({ equaliser: { enabled: false, gains } }),
      }),
    });
  });
});

describe("the Audio tab", () => {
  it("opens and closes from its action, named for what it will do", async () => {
    expect(action("view.audio").label?.()).toBe("Show audio adjustments");
    await action("view.audio").run({ source: "palette" });
    expect(useInterface.getState()).toMatchObject({
      panelOpen: true,
      inspectorTab: "audio",
      panelWantsKeyboard: false,
    });
    expect(action("view.audio").label?.()).toBe("Hide audio adjustments");
  });
});
