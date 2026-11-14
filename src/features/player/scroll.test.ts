import { describe, expect, it, vi } from "vitest";
import type { Scrolled } from "@/ipc";
import {
  createScrollHandler,
  type ScrollDeps,
  SEEK_SECONDS_PER_PX,
  VOLUME_STEP_PX,
} from "./scroll";

function rig(overrides: Partial<ScrollDeps> = {}) {
  let clock = 1000;
  // What the tests look at: these stay the mocks they are, whatever is overridden.
  const mocks = {
    volume: vi.fn<(direction: 1 | -1) => void>(),
    step: vi.fn<(direction: 1 | -1) => void>(),
    seekRoughly: vi.fn<(seconds: number) => void>(),
    seekExactly: vi.fn<(seconds: number) => void>(),
    say: vi.fn<ScrollDeps["say"]>(),
  };
  const handle = createScrollHandler({
    overPicture: () => true,
    position: () => 600,
    duration: () => 7305,
    now: () => clock,
    ...mocks,
    ...overrides,
  });
  const scroll = (event: Partial<Scrolled>) => {
    clock += 40;
    handle({ x: 400, y: 300, right: 0, up: 0, precise: true, phase: "moved", ...event });
  };
  return { deps: mocks, scroll };
}

describe("fingers moving up and down", () => {
  it("change the volume a step for each stretch of travel", () => {
    const { deps, scroll } = rig();
    scroll({ phase: "began" });
    scroll({ up: VOLUME_STEP_PX });
    scroll({ up: VOLUME_STEP_PX * 2 });
    expect(deps.volume.mock.calls).toEqual([[1], [1], [1]]);
    // Back down past where they were takes the steps back, and one more.
    scroll({ up: -VOLUME_STEP_PX * 4 });
    expect(deps.volume.mock.calls.slice(3)).toEqual([[-1], [-1], [-1], [-1]]);
    expect(deps.seekRoughly).not.toHaveBeenCalled();
  });

  it("do nothing until they have really travelled", () => {
    const { deps, scroll } = rig();
    scroll({ phase: "began" });
    scroll({ up: 3 });
    expect(deps.volume).not.toHaveBeenCalled();
  });

  it("stay volume even if the swipe then wanders sideways", () => {
    const { deps, scroll } = rig();
    scroll({ phase: "began" });
    scroll({ up: 20 });
    scroll({ right: 200 });
    expect(deps.seekRoughly).not.toHaveBeenCalled();
    expect(deps.volume).toHaveBeenCalledTimes(1);
  });
});

describe("fingers moving sideways", () => {
  it("move through the film, roughly while moving and exactly on lifting", () => {
    const { deps, scroll } = rig();
    scroll({ phase: "began" });
    scroll({ right: 100 });
    const target = 600 + 100 * SEEK_SECONDS_PER_PX;
    expect(deps.seekRoughly).toHaveBeenLastCalledWith(target);
    expect(deps.say).toHaveBeenLastCalledWith({ label: "Forward 12 s", value: "0:10:12" });
    expect(deps.seekExactly).not.toHaveBeenCalled();

    scroll({ right: -150 });
    expect(deps.say).toHaveBeenLastCalledWith({ label: "Back 6 s", value: "0:09:54" });
    scroll({ phase: "ended" });
    expect(deps.seekExactly).toHaveBeenCalledWith(600 - 50 * SEEK_SECONDS_PER_PX);
    expect(deps.volume).not.toHaveBeenCalled();
  });

  it("stop at the start, and a second short of the end", () => {
    const { deps, scroll } = rig();
    scroll({ phase: "began" });
    scroll({ right: -1_000_000 });
    expect(deps.seekRoughly).toHaveBeenLastCalledWith(0);
    scroll({ phase: "ended" });
    scroll({ phase: "began" });
    scroll({ right: 1_000_000 });
    scroll({ phase: "ended" });
    expect(deps.seekExactly).toHaveBeenLastCalledWith(7304);
  });

  it("do nothing to something that cannot be moved through", () => {
    const { deps, scroll } = rig({ duration: () => null });
    scroll({ phase: "began" });
    scroll({ right: 100 });
    scroll({ phase: "ended" });
    expect(deps.seekRoughly).not.toHaveBeenCalled();
    expect(deps.seekExactly).not.toHaveBeenCalled();
  });
});

describe("where the gesture is", () => {
  it("must begin on the picture: over a control or a panel it is that thing's own", () => {
    const { deps, scroll } = rig({ overPicture: vi.fn(() => false) });
    scroll({ phase: "began" });
    scroll({ up: 100 });
    scroll({ phase: "ended" });
    expect(deps.volume).not.toHaveBeenCalled();
  });

  it("is judged where it began, not where the pointer drifts to", () => {
    const overPicture = vi.fn(() => true);
    const { deps, scroll } = rig({ overPicture });
    scroll({ phase: "began" });
    overPicture.mockReturnValue(false);
    scroll({ up: VOLUME_STEP_PX });
    expect(deps.volume).toHaveBeenCalledTimes(1);
  });
});

describe("a wheel that turns in notches", () => {
  it("gives one step of volume a notch", () => {
    const { deps, scroll } = rig();
    scroll({ precise: false, up: 1 });
    scroll({ precise: false, up: 3 });
    scroll({ precise: false, up: -1 });
    expect(deps.volume.mock.calls).toEqual([[1], [1], [-1]]);
  });

  it("steps through the film when turned sideways, if it can be moved through", () => {
    const { deps, scroll } = rig();
    scroll({ precise: false, right: 1 });
    scroll({ precise: false, right: -1 });
    expect(deps.step.mock.calls).toEqual([[1], [-1]]);

    const fixed = rig({ duration: () => null });
    fixed.scroll({ precise: false, right: 1 });
    expect(fixed.deps.step).not.toHaveBeenCalled();
  });

  it("does nothing off the picture", () => {
    const { deps, scroll } = rig({ overPicture: vi.fn(() => false) });
    scroll({ precise: false, up: 1 });
    expect(deps.volume).not.toHaveBeenCalled();
  });
});
