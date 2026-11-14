import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/app/boot";
import type { AppError, Settings } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import { resetSettingsForTests, useSettings } from "./store";

function withTheme(settings: Settings, theme: Settings["appearance"]["theme"]): Settings {
  return { ...settings, appearance: { ...settings.appearance, theme } };
}

describe("settings store", () => {
  beforeEach(() => {
    resetSettingsForTests(DEFAULT_SETTINGS);
  });

  afterEach(() => {
    clearMocks();
  });

  it("applies a change at once and sends the whole settings object to the backend", async () => {
    const settingsSet = vi.fn(() => null);
    mockCommands({ settingsSet });

    const pending = useSettings.getState().update((current) => withTheme(current, "light"));
    expect(useSettings.getState().settings.appearance.theme).toBe("light");
    await pending;

    expect(settingsSet).toHaveBeenCalledWith({ settings: withTheme(DEFAULT_SETTINGS, "light") });
    expect(useSettings.getState().saveError).toBeNull();
  });

  it("restores the previous settings when the backend refuses", async () => {
    const failure: AppError = { kind: "database", message: "disk is full" };
    mockCommands({
      settingsSet: () => {
        throw failure;
      },
    });

    await useSettings.getState().update((current) => withTheme(current, "light"));

    const state = useSettings.getState();
    expect(state.settings.appearance.theme).toBe("dark");
    expect(state.saveError?.kind).toBe("database");
    expect(state.saveError?.message).toBe("disk is full");
  });

  it("takes settings saved by another window", () => {
    useSettings.getState().receive(withTheme(DEFAULT_SETTINGS, "system"));
    expect(useSettings.getState().settings.appearance.theme).toBe("system");
  });

  /** A brightness, as a scale being dragged sets it. */
  function withBrightness(settings: Settings, brightness: number): Settings {
    return {
      ...settings,
      video: { ...settings.video, picture: { ...settings.video.picture, brightness } },
    };
  }

  it("sends one save at a time, and after it only the newest of what was changed meanwhile", async () => {
    const answers: ((value: null) => void)[] = [];
    const settingsSet = vi.fn(
      (_: { settings: Settings }) => new Promise<null>((resolve) => answers.push(resolve)),
    );
    mockCommands({ settingsSet });
    const brightness = () => useSettings.getState().settings.video.picture.brightness;
    const sent = () =>
      settingsSet.mock.calls.map(([args]) => args.settings.video.picture.brightness);

    // A scale dragged through four values before the first is answered.
    const update = useSettings.getState().update;
    void update((current) => withBrightness(current, 1));
    void update((current) => withBrightness(current, 2));
    void update((current) => withBrightness(current, 3));
    const last = update((current) => withBrightness(current, 4));
    // What is shown is always the newest.
    expect(brightness()).toBe(4);
    await Promise.resolve();
    expect(sent()).toEqual([1]);

    // The backend's word on the first save arrives while the rest wait: it
    // is older than what the scale shows, and is not taken.
    useSettings.getState().receive(withBrightness(DEFAULT_SETTINGS, 1));
    expect(brightness()).toBe(4);

    answers.shift()?.(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The values in between were never going to be seen: only the last goes.
    expect(sent()).toEqual([1, 4]);
    answers.shift()?.(null);
    await last;
    expect(sent()).toEqual([1, 4]);
    expect(brightness()).toBe(4);

    // With nothing on its way, the backend's word is taken again.
    useSettings.getState().receive(withBrightness(DEFAULT_SETTINGS, 9));
    expect(brightness()).toBe(9);
  });

  it("goes back to what was last accepted when a save in a run of them is refused", async () => {
    const failure: AppError = { kind: "database", message: "disk is full" };
    let refuse = false;
    mockCommands({
      settingsSet: () => {
        if (refuse) {
          throw failure;
        }
        return null;
      },
    });
    await useSettings.getState().update((current) => withBrightness(current, 10));
    refuse = true;
    await useSettings.getState().update((current) => withBrightness(current, 20));
    const state = useSettings.getState();
    expect(state.settings.video.picture.brightness).toBe(10);
    expect(state.saveError?.message).toBe("disk is full");

    // The next that is accepted clears the complaint.
    refuse = false;
    await useSettings.getState().update((current) => withBrightness(current, 30));
    expect(useSettings.getState().settings.video.picture.brightness).toBe(30);
    expect(useSettings.getState().saveError).toBeNull();
  });
});
