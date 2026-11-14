import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnScreenDisplay } from "./OnScreenDisplay";
import { OSD_FADE_MS, OSD_MS, showOsd, useOsd } from "./osd";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => useOsd.getState().clear());
  vi.useRealTimers();
});

/**
 * The label as it is drawn. (It is in the page three times: once for
 * assistive technology, once unseen to be measured, and once to be read.)
 */
function label(text: string | RegExp): HTMLElement {
  const found = screen.queryAllByText(text).find((element) => element.hasAttribute("data-part"));
  if (!found) {
    throw new Error(`the display does not show ${text}`);
  }
  return found;
}

function shows(text: string): boolean {
  return screen.queryAllByText(text).length > 0;
}

describe("OnScreenDisplay", () => {
  it("is a polite live region that is empty until something changes", () => {
    const { container } = render(<OnScreenDisplay />);
    const region = container.firstElementChild;
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
    expect(region).toBeEmptyDOMElement();
  });

  it("shows the label and the value, fades, and then removes the words", () => {
    const { container } = render(<OnScreenDisplay />);
    act(() => showOsd({ label: "Forward 5 s", value: "0:42:22" }));
    const line = label("Forward 5 s").closest("div");
    expect(screen.getByText("0:42:22")).toBeInTheDocument();
    expect(line).not.toHaveClass("opacity-0");

    // Fading out: still in the tree, so the fade has something to fade.
    act(() => vi.advanceTimersByTime(OSD_MS));
    expect(line).toHaveClass("opacity-0");
    expect(shows("Forward 5 s")).toBe(true);

    // Gone, so the same message later is a change and is announced again.
    act(() => vi.advanceTimersByTime(OSD_FADE_MS));
    expect(container.firstElementChild).toBeEmptyDOMElement();
  });

  it("replaces one message with the next in place and restarts the clock", () => {
    render(<OnScreenDisplay />);
    act(() => showOsd({ label: "Paused" }));
    const line = label("Paused").closest("div");
    act(() => vi.advanceTimersByTime(OSD_MS - 100));
    act(() => showOsd({ label: "Playing" }));
    expect(shows("Paused")).toBe(false);
    // The same element: nothing remounts, so nothing fades in a second time.
    expect(label("Playing").closest("div")).toBe(line);

    act(() => vi.advanceTimersByTime(OSD_MS - 100));
    expect(line).not.toHaveClass("opacity-0");
    act(() => vi.advanceTimersByTime(100));
    expect(line).toHaveClass("opacity-0");
  });

  it("comes straight back if something changes while it is fading out", () => {
    render(<OnScreenDisplay />);
    act(() => showOsd({ label: "Volume", value: "60%" }));
    const line = label("Volume").closest("div");
    act(() => vi.advanceTimersByTime(OSD_MS + OSD_FADE_MS / 2));
    expect(line).toHaveClass("opacity-0");

    act(() => showOsd({ label: "Volume", value: "65%" }));
    expect(line).not.toHaveClass("opacity-0");
    // The removal that was pending must not take the new message with it.
    act(() => vi.advanceTimersByTime(OSD_FADE_MS));
    expect(screen.getByText("65%")).toBeInTheDocument();
  });

  it("lets a long label give way before the value does", () => {
    render(<OnScreenDisplay />);
    act(() => showOsd({ label: "Audio: English, DTS-HD Master Audio 7.1", value: "2 of 5" }));
    // The start of it is the part that gives way; its last ten characters and the value stay whole.
    expect(label(/^Audio: English/)).toHaveClass("truncate", "min-w-0");
    expect(label("Audio 7.1")).toHaveClass("flex-none");
    expect(screen.getByText("2 of 5")).toHaveClass("flex-none");
  });

  it("says its label to assistive technology once, whole", () => {
    const { container } = render(<OnScreenDisplay />);
    act(() => showOsd({ label: "Audio: English, DTS-HD Master Audio 7.1", value: "2 of 5" }));
    const spoken = Array.from(container.querySelectorAll("p *"))
      .filter((element) => element.closest('[aria-hidden="true"]') === null)
      .map((element) => (element.children.length === 0 ? element.textContent : ""))
      .join("");
    expect(spoken).toBe("Audio: English, DTS-HD Master Audio 7.12 of 5");
  });

  function parts(container: HTMLElement) {
    const scale = container.querySelector("svg");
    return {
      scale,
      level: scale?.querySelector('[data-part="level"]'),
      needle: scale?.querySelector('[data-part="needle"]'),
    };
  }

  it("draws a range as a scale that assistive technology does not read twice", () => {
    const { container } = render(<OnScreenDisplay />);
    act(() => showOsd({ label: "Volume", value: "150%", scale: { at: 0.75, mark: 0.5 } }));
    const { scale, level, needle } = parts(container);
    expect(scale).toHaveAttribute("aria-hidden", "true");
    // Sized in ems, so it grows with the type it sits under.
    expect(scale).toHaveClass("w-[9.6em]", "h-[0.7em]");
    // The level reaches three quarters of the way; the needle stands at its end,
    // three quarters along a 192-unit track less its own 2 units.
    expect(level).toHaveStyle({ transform: "scaleX(0.75)" });
    expect(needle).toHaveStyle({ transform: "translateX(142.5px)" });
  });

  it("tells the level by thickness as well as by the needle", () => {
    const { container } = render(<OnScreenDisplay />);
    act(() => showOsd({ label: "Volume", value: "50%", scale: { at: 0.25 } }));
    const { scale, level } = parts(container);
    const range = [...(scale?.querySelectorAll("rect.fill-stage-ink") ?? [])].find(
      (rect) => rect !== level,
    );
    expect(Number(level?.getAttribute("height"))).toBe(2 * Number(range?.getAttribute("height")));
  });

  it("outlines every shape of the scale, with all the outlines beneath all the shapes", () => {
    const { container } = render(<OnScreenDisplay />);
    act(() => showOsd({ label: "Volume", value: "150%", scale: { at: 0.75, mark: 0.5 } }));
    const rects = [...(parts(container).scale?.querySelectorAll("rect") ?? [])];
    const outlines = rects.filter((rect) => rect.classList.contains("fill-void"));
    const shapes = rects.filter((rect) => !rect.classList.contains("fill-void"));
    // The tick at 100%, the range, the level and the needle.
    expect(shapes).toHaveLength(4);
    expect(outlines).toHaveLength(4);
    expect(rects.slice(0, 4)).toEqual(outlines);
    // Each outline is its shape grown by one unit on every side, moving with it.
    outlines.forEach((outline, index) => {
      const shape = shapes[index];
      expect(Number(outline.getAttribute("width"))).toBe(Number(shape?.getAttribute("width")) + 2);
      expect(Number(outline.getAttribute("height"))).toBe(
        Number(shape?.getAttribute("height")) + 2,
      );
      expect(outline.getAttribute("style")).toBe(shape?.getAttribute("style"));
    });
  });

  function tickOf(container: HTMLElement) {
    return [...(parts(container).scale?.querySelectorAll("rect.fill-stage-ink") ?? [])].find(
      (rect) => rect.getAttribute("width") === "1",
    );
  }

  it("marks the normal level where the needle would stand at it", () => {
    const { container } = render(<OnScreenDisplay />);
    act(() => showOsd({ label: "Volume", value: "30%", scale: { at: 0.2, mark: 0.5 } }));
    // A needle at the mark would be at translateX(95) and 2 wide, so its
    // centre would be at 96; the tick is 1 wide.
    expect(Number(tickOf(container)?.getAttribute("x")) + 0.5).toBe(96);
  });

  it("lets the mark step aside when the needle is on it or right beside it", () => {
    const { container } = render(<OnScreenDisplay />);
    // On it, and one key press either side of it: the two would fuse into one shape.
    for (const at of [0.5, 0.48, 0.52]) {
      act(() => showOsd({ label: "Volume", value: "", scale: { at, mark: 0.5 } }));
      expect(tickOf(container), `needle at ${at}`).toBeUndefined();
    }
    // Clear of it again: the mark is back.
    act(() => showOsd({ label: "Volume", value: "", scale: { at: 0.54, mark: 0.5 } }));
    expect(tickOf(container)).toBeDefined();
  });

  it("keeps a scale inside its track for values past either end", () => {
    const { container } = render(<OnScreenDisplay />);
    act(() => showOsd({ label: "Volume", value: "250%", scale: { at: 1.25 } }));
    expect(parts(container).level).toHaveStyle({ transform: "scaleX(1)" });
    expect(parts(container).needle).toHaveStyle({ transform: "translateX(190px)" });
    act(() => showOsd({ label: "Volume", value: "0%", scale: { at: -0.025 } }));
    expect(parts(container).level).toHaveStyle({ transform: "scaleX(0)" });
    expect(parts(container).needle).toHaveStyle({ transform: "translateX(0px)" });
  });
});
