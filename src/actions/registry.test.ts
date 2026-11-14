import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Action,
  actionForChord,
  allActions,
  clearActions,
  conflicts,
  getAction,
  registerActions,
  runAction,
  shortcutFor,
} from "./registry";

function action(overrides: Partial<Action> & Pick<Action, "id">): Action {
  return {
    name: overrides.id,
    category: "playback",
    shortcuts: [],
    run: () => {},
    ...overrides,
  };
}

afterEach(() => {
  clearActions();
});

describe("action registry", () => {
  it("finds actions by id and by chord", () => {
    registerActions([action({ id: "playback.toggle", shortcuts: ["Space", "k"] })]);
    expect(getAction("playback.toggle")?.id).toBe("playback.toggle");
    expect(actionForChord("Space")?.id).toBe("playback.toggle");
    expect(actionForChord("k")?.id).toBe("playback.toggle");
    expect(actionForChord("j")).toBeUndefined();
  });

  it("shows the first shortcut as the action's own", () => {
    registerActions([
      action({ id: "view.fullscreen", shortcuts: ["Ctrl+Cmd+f", "f"] }),
      action({ id: "playback.stop" }),
    ]);
    expect(shortcutFor("view.fullscreen")).toBe("Ctrl+Cmd+f");
    expect(shortcutFor("playback.stop")).toBeUndefined();
    expect(shortcutFor("no.such")).toBeUndefined();
  });

  it("runs an action and reports whether it could", () => {
    const run = vi.fn();
    registerActions([
      action({ id: "a", run }),
      action({ id: "b", run, unavailable: () => "Nothing is open" }),
    ]);
    expect(runAction("a", "keyboard")).toBe(true);
    expect(runAction("b", "keyboard")).toBe(false);
    expect(runAction("no.such", "keyboard")).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it("replaces an action registered again under the same id", () => {
    registerActions([action({ id: "a", shortcuts: ["x"] })]);
    registerActions([action({ id: "a", shortcuts: ["y"] })]);
    expect(allActions()).toHaveLength(1);
    expect(actionForChord("x")).toBeUndefined();
    expect(actionForChord("y")?.id).toBe("a");
  });

  it("reports chords claimed twice and gives the chord to the first claimant", () => {
    registerActions([
      action({ id: "a", shortcuts: ["m"] }),
      action({ id: "b", shortcuts: ["m", "n"] }),
    ]);
    expect(conflicts()).toEqual(new Map([["m", ["a", "b"]]]));
    expect(actionForChord("m")?.id).toBe("a");
  });
});
