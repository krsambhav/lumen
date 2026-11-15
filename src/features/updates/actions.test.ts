import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearActions, getAction, registerActions, runAction } from "@/actions/registry";
import { DEFAULT_SETTINGS } from "@/app/boot";
import { useOsd } from "@/features/player/osd";
import { IDLE_SNAPSHOT, usePlayer } from "@/features/player/store";
import { resetSettingsForTests, useSettings } from "@/features/settings/store";
import type { Settings, UpdateStatus } from "@/ipc";
import { mockCommands } from "@/ipc/bindings";
import { updateActions, updateLabel, updateUnavailable } from "./actions";
import { useUpdates } from "./store";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const AVAILABLE: UpdateStatus = { state: "available", version: "1.5.0", current: "1.4.0" };
const READY: UpdateStatus = { state: "ready", version: "1.5.0" };

const updateCheck = vi.fn((): UpdateStatus => ({ state: "current", version: "1.4.0" }));
const updateInstall = vi.fn((): UpdateStatus => READY);
const updateRestart = vi.fn(() => null);
const settingsSet = vi.fn((_args: { settings: Settings }) => null);

function stands(status: UpdateStatus) {
  useUpdates.setState({ status });
}

beforeEach(() => {
  for (const mock of [updateCheck, updateInstall, updateRestart, settingsSet]) {
    mock.mockClear();
  }
  mockCommands({ updateCheck, updateInstall, updateRestart, settingsSet });
  registerActions(updateActions);
  stands({ state: "idle" });
  resetSettingsForTests(DEFAULT_SETTINGS);
  usePlayer.setState({ ...IDLE_SNAPSHOT, positionAt: 0, failure: null });
  useOsd.getState().clear();
});

afterEach(async () => {
  clearActions();
  await flush();
  clearMocks();
});

describe("the update action", () => {
  it("is named for what choosing it will do now", () => {
    expect(updateLabel()).toBe("Update Lumen");
    stands(AVAILABLE);
    expect(updateLabel()).toBe("Update to 1.5.0");
    stands(READY);
    expect(updateLabel()).toBe("Restart to update");
    expect(getAction("app.update")?.label?.()).toBe("Restart to update");
  });

  it("says why there is nothing to update to", () => {
    expect(updateUnavailable()).toBe("No newer version has been found");
    stands({ state: "current", version: "1.4.0" });
    expect(updateUnavailable()).toBe("Lumen is up to date");
    stands({ state: "downloading", version: "1.5.0", received: 1, total: 10 });
    expect(updateUnavailable()).toBe("The update is already on its way");
    stands({ state: "installing", version: "1.5.0" });
    expect(updateUnavailable()).toBe("The update is already on its way");
    stands(AVAILABLE);
    expect(updateUnavailable()).toBeUndefined();
    stands(READY);
    expect(updateUnavailable()).toBeUndefined();
  });

  it("does nothing while there is nothing to update to", async () => {
    expect(runAction("app.update", "palette")).toBe(false);
    await flush();
    expect(updateInstall).not.toHaveBeenCalled();
    expect(updateRestart).not.toHaveBeenCalled();
  });

  it("fetches the version that was found", async () => {
    stands(AVAILABLE);
    expect(runAction("app.update", "palette")).toBe(true);
    await flush();
    expect(updateInstall).toHaveBeenCalledOnce();
  });

  it("restarts for the version that is in place, without fetching anything", async () => {
    stands(READY);
    expect(runAction("app.update", "menu")).toBe(true);
    await flush();
    expect(updateRestart).toHaveBeenCalledOnce();
    expect(updateInstall).not.toHaveBeenCalled();
  });
});

describe("checking for updates", () => {
  it("can always be asked for, and asks the backend", async () => {
    expect(getAction("app.checkForUpdates")?.unavailable).toBeUndefined();
    expect(runAction("app.checkForUpdates", "menu")).toBe(true);
    await flush();
    expect(updateCheck).toHaveBeenCalledOnce();
  });

  it("by itself is a switch that is on until it is turned off", async () => {
    const action = getAction("app.automaticUpdates");
    expect(action?.checked?.()).toBe(true);

    runAction("app.automaticUpdates", "menu");
    await flush();
    expect(action?.checked?.()).toBe(false);
    expect(settingsSet).toHaveBeenCalledWith({
      settings: { ...DEFAULT_SETTINGS, general: { checkForUpdates: false, incognito: false } },
    });

    runAction("app.automaticUpdates", "menu");
    await flush();
    expect(action?.checked?.()).toBe(true);
    expect(useSettings.getState().settings.general.checkForUpdates).toBe(true);
  });

  it("confirms the switch over a film, where no menu's tick is in sight", async () => {
    runAction("app.automaticUpdates", "palette");
    await flush();
    // On the home screen there is nowhere to say it, and no need.
    expect(useOsd.getState().message).toBeNull();

    usePlayer.setState({ source: "/films/a.mkv", status: "playing", duration: 100 });
    runAction("app.automaticUpdates", "palette");
    await flush();
    expect(useOsd.getState().message?.label).toBe("Checks for updates by itself");
    runAction("app.automaticUpdates", "keyboard");
    await flush();
    expect(useOsd.getState().message?.label).toBe("Checks for updates only when asked");
  });
});

describe("Lumen's own actions", () => {
  it("are found in the palette by the words people use, and have no keys to collide", () => {
    for (const action of updateActions) {
      expect(action.category).toBe("app");
      expect(action.shortcuts).toEqual([]);
      expect(action.keywords?.length).toBeGreaterThan(0);
      expect(action.icon).toBeDefined();
    }
  });
});
