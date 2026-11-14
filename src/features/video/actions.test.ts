import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action } from "@/actions/registry";
import { DEFAULT_SESSION, DEFAULT_SETTINGS } from "@/app/boot";
import { useOsd } from "@/features/player/osd";
import { IDLE_SNAPSHOT, usePlayer } from "@/features/player/store";
import { resetSettingsForTests, useSettings } from "@/features/settings/store";
import { useInterface } from "@/features/shell/interface";
import type { Shape } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import { setAspect, setCrop, stepZoom, videoActions, ZOOMS } from "./actions";
import { NEUTRAL_PICTURE } from "./picture";
import { MAX_ZOOM, MIN_ZOOM, OWN_SHAPE } from "./shape";

const KEYS = { source: "keyboard" } as const;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function action(id: string): Action {
  const found = videoActions.find((candidate) => candidate.id === id);
  if (!found) {
    throw new Error(`no action ${id}`);
  }
  return found;
}

function osd() {
  const message = useOsd.getState().message;
  return message ? { label: message.label, value: message.value } : null;
}

const PICTURE = {
  width: 1920,
  height: 1080,
  fps: 24,
  codec: "hevc",
  dynamicRange: "sdr" as const,
  hardwareDecoder: null,
};

let sent: Shape[] = [];

beforeEach(() => {
  sent = [];
  mockCommands({
    playerSetShape: ({ shape }) => {
      sent.push(shape);
      return null;
    },
    settingsSet: () => null,
  });
  resetSettingsForTests(DEFAULT_SETTINGS);
  useInterface.setState({ ...DEFAULT_SESSION.interface, panelOpen: false });
  usePlayer.setState({
    ...IDLE_SNAPSHOT,
    source: "/films/a.mkv",
    status: "paused",
    video: PICTURE,
    shape: OWN_SHAPE,
  });
});

afterEach(async () => {
  // What is still on its way to the mocked backend goes before the next test.
  await flush();
  useOsd.getState().clear();
  usePlayer.setState({ ...IDLE_SNAPSHOT, positionAt: 0, failure: null });
  clearMocks();
});

describe("every video action", () => {
  it("has a unique id and claims no chord another claims", () => {
    const ids = videoActions.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
    const chords = videoActions.flatMap((candidate) => candidate.shortcuts);
    expect(new Set(chords).size).toBe(chords.length);
  });

  it("has the documented shortcuts", () => {
    const keys = Object.fromEntries(videoActions.map((each) => [each.id, each.shortcuts]));
    expect(keys).toMatchObject({
      "video.rotate": ["Cmd+r"],
      "video.rotateBack": ["Alt+Cmd+r"],
      "video.zoomIn": ["z"],
      "video.zoomOut": ["Shift+z"],
      "video.deinterlace": ["d"],
      "view.video": ["Shift+Cmd+v"],
    });
  });

  it("needs something open, and those of the frame something with a picture", () => {
    usePlayer.setState({ ...IDLE_SNAPSHOT });
    expect(action("video.rotate").unavailable?.()).toBe("Nothing is open");
    expect(action("view.video").unavailable?.()).toBe("Nothing is open");
    usePlayer.setState({ source: "/music/a.m4a", video: null });
    expect(action("video.rotate").unavailable?.()).toBe("This has no picture");
    expect(action("video.zoomIn").unavailable?.()).toBe("This has no picture");
    expect(action("view.video").unavailable?.()).toBeUndefined();
  });
});

describe("the frame", () => {
  it("turns a quarter at a time and says where it is", async () => {
    await action("video.rotate").run(KEYS);
    expect(usePlayer.getState().shape.turns).toBe(1);
    expect(osd()).toEqual({ label: "90° clockwise", value: undefined });
    await action("video.rotateBack").run(KEYS);
    await action("video.rotateBack").run(KEYS);
    expect(usePlayer.getState().shape.turns).toBe(3);
    expect(osd()?.label).toBe("90° anticlockwise");
    await flush();
    expect(sent.at(-1)?.turns).toBe(3);
  });

  it("mirrors and flips, and is checked while it does", async () => {
    expect(action("video.mirror").checked?.()).toBe(false);
    await action("video.mirror").run(KEYS);
    expect(usePlayer.getState().shape.mirrored).toBe(true);
    expect(action("video.mirror").checked?.()).toBe(true);
    expect(osd()?.label).toBe("Mirrored");
    await action("video.flip").run(KEYS);
    expect(usePlayer.getState().shape.flipped).toBe(true);
    expect(osd()?.label).toBe("Flipped");
    await action("video.flip").run(KEYS);
    expect(osd()?.label).toBe("Not flipped");
  });

  it("zooms through its sizes, and not past either end", async () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    // A zoom between sizes goes to the next one in that direction.
    expect(stepZoom(1.1, 1)).toBe(1.25);
    expect(stepZoom(1.1, -1)).toBe(1);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(ZOOMS[0]).toBe(MIN_ZOOM);
    expect(ZOOMS.at(-1)).toBe(MAX_ZOOM);

    await action("video.zoomIn").run(KEYS);
    expect(usePlayer.getState().shape.zoom).toBe(1.25);
    expect(osd()).toEqual({ label: "Zoom", value: "125%" });

    usePlayer.setState({ shape: { ...OWN_SHAPE, zoom: MAX_ZOOM } });
    expect(action("video.zoomIn").unavailable?.()).toBe("This is as large as it goes");
    usePlayer.setState({ shape: { ...OWN_SHAPE, zoom: MIN_ZOOM } });
    expect(action("video.zoomOut").unavailable?.()).toBe("This is as small as it goes");
  });

  it("deinterlaces on and off from its key", async () => {
    await action("video.deinterlace").run(KEYS);
    expect(usePlayer.getState().shape.deinterlace).toBe("on");
    expect(action("video.deinterlace").checked?.()).toBe(true);
    expect(osd()).toEqual({ label: "Deinterlace", value: "On" });
    await action("video.deinterlace").run(KEYS);
    expect(usePlayer.getState().shape.deinterlace).toBe("off");
  });

  it("sets the aspect and the crop, and names them", () => {
    setAspect(KEYS, { width: 4, height: 3 });
    expect(osd()).toEqual({ label: "Aspect", value: "4:3" });
    setAspect(KEYS, null);
    expect(osd()).toEqual({ label: "Aspect", value: "Original" });
    setCrop(KEYS, { width: 235, height: 100 });
    expect(usePlayer.getState().shape.crop).toEqual({ width: 235, height: 100 });
    expect(osd()).toEqual({ label: "Crop", value: "2.35:1" });
    setCrop(KEYS, null);
    expect(osd()).toEqual({ label: "Crop", value: "None" });
  });

  it("resets only when it has been changed", async () => {
    expect(action("video.resetFrame").unavailable?.()).toBe("The frame is as the file has it");
    usePlayer.setState({ shape: { ...OWN_SHAPE, zoom: 2, mirrored: true } });
    expect(action("video.resetFrame").unavailable?.()).toBeUndefined();
    await action("video.resetFrame").run(KEYS);
    expect(usePlayer.getState().shape).toEqual(OWN_SHAPE);
    expect(osd()?.label).toBe("Frame reset");
  });

  it("is not confirmed on screen when changed from a control that shows it", async () => {
    await action("video.mirror").run({ source: "control" });
    expect(osd()).toBeNull();
  });
});

describe("the picture", () => {
  it("resets only when it is adjusted, and saves the neutral levels", async () => {
    const settingsSet = vi.fn(() => null);
    mockCommands({ settingsSet, playerSetShape: () => null });
    expect(action("video.resetPicture").unavailable?.()).toBe("The picture is not adjusted");
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        video: { ...DEFAULT_SETTINGS.video, picture: { ...NEUTRAL_PICTURE, contrast: 15 } },
      },
    });
    expect(action("video.resetPicture").unavailable?.()).toBeUndefined();
    await action("video.resetPicture").run(KEYS);
    expect(useSettings.getState().settings.video.picture).toEqual(NEUTRAL_PICTURE);
    expect(osd()?.label).toBe("Picture reset");
    await flush();
    expect(settingsSet).toHaveBeenCalledWith({
      settings: expect.objectContaining({
        video: expect.objectContaining({ picture: NEUTRAL_PICTURE }),
      }),
    });
  });
});

describe("the Video tab", () => {
  it("opens and closes from its action, named for what it will do", async () => {
    expect(action("view.video").label?.()).toBe("Show video adjustments");
    await action("view.video").run(KEYS);
    expect(useInterface.getState()).toMatchObject({
      panelOpen: true,
      inspectorTab: "video",
      panelWantsKeyboard: true,
    });
    expect(action("view.video").label?.()).toBe("Hide video adjustments");
    await action("view.video").run(KEYS);
    expect(useInterface.getState().panelOpen).toBe(false);
  });
});
