import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "@/test/render";
import { Scale, type ScaleProps, ScaleRow } from "./scale";

function Harness(props: Partial<ScaleProps> & { initial?: number }) {
  const { initial = 50, ...rest } = props;
  const [value, setValue] = useState(initial);
  return (
    <Scale
      label="Volume"
      min={0}
      max={100}
      valueText={`${value} percent`}
      {...rest}
      value={value}
      onChange={(next) => {
        setValue(next);
        rest.onChange?.(next);
      }}
    />
  );
}

/** jsdom has no layout, so give the scale a width: 1 px per unit on a 0–200 range. */
function layOut(width: number) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: 24,
    width,
    height: 24,
    toJSON: () => ({}),
  });
}

function rootOf(slider: HTMLElement): HTMLElement {
  const root = slider.parentElement?.closest<HTMLElement>("[data-orientation]");
  if (!root) {
    throw new Error("slider has no root");
  }
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Scale", () => {
  it("is a named slider that reports its value in words", () => {
    renderUi(<Harness />);
    const slider = screen.getByRole("slider", { name: "Volume" });
    expect(slider).toHaveAttribute("aria-valuenow", "50");
    expect(slider).toHaveAttribute("aria-valuetext", "50 percent");
  });

  it("reads out a mark's own name while the needle rests on it", () => {
    renderUi(<Harness initial={100} max={200} marks={[{ value: 100, label: "Normal volume" }]} />);
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "Normal volume");
  });

  it("steps with the arrow keys and ten times as far with Shift", async () => {
    renderUi(<Harness step={1} />);
    const slider = screen.getByRole("slider");
    slider.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(slider).toHaveAttribute("aria-valuenow", "51");
    await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect(slider).toHaveAttribute("aria-valuenow", "41");
  });

  it("jumps to the ends with Home and End", async () => {
    renderUi(<Harness />);
    const slider = screen.getByRole("slider");
    slider.focus();
    await userEvent.keyboard("{End}");
    expect(slider).toHaveAttribute("aria-valuenow", "100");
    await userEvent.keyboard("{Home}");
    expect(slider).toHaveAttribute("aria-valuenow", "0");
  });

  it("lets the keyboard reach every value around a mark, in both directions", async () => {
    layOut(200);
    renderUi(<Harness initial={98} max={200} marks={[{ value: 100 }]} />);
    const slider = screen.getByRole("slider");
    slider.focus();
    const seen: string[] = [];
    for (let press = 0; press < 4; press += 1) {
      await userEvent.keyboard("{ArrowRight}");
      seen.push(slider.getAttribute("aria-valuenow") ?? "");
    }
    expect(seen).toEqual(["99", "100", "101", "102"]);
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    expect(slider).toHaveAttribute("aria-valuenow", "99");
  });

  it("snaps a dragged needle to a mark within six pixels, and not beyond", () => {
    layOut(200);
    const onChange = vi.fn();
    renderUi(<Harness initial={20} max={200} marks={[{ value: 100 }]} onChange={onChange} />);
    const root = rootOf(screen.getByRole("slider"));

    fireEvent.pointerDown(root, { clientX: 95, pointerId: 1, button: 0 });
    expect(onChange).toHaveBeenLastCalledWith(100);
    fireEvent.pointerUp(root, { clientX: 95, pointerId: 1, button: 0 });

    fireEvent.pointerDown(root, { clientX: 92, pointerId: 2, button: 0 });
    expect(onChange).toHaveBeenLastCalledWith(92);
  });

  it("measures the snap distance in pixels, whatever the range", () => {
    // 1000 px wide over two hours: six pixels is about 43 seconds, not minutes.
    layOut(1000);
    const onChange = vi.fn();
    renderUi(<Harness initial={0} max={7200} marks={[{ value: 3600 }]} onChange={onChange} />);
    const root = rootOf(screen.getByRole("slider"));
    fireEvent.pointerDown(root, { clientX: 490, pointerId: 1, button: 0 });
    expect(onChange).toHaveBeenLastCalledWith(3528);
    fireEvent.pointerUp(root, { clientX: 490, pointerId: 1, button: 0 });
    fireEvent.pointerDown(root, { clientX: 496, pointerId: 2, button: 0 });
    expect(onChange).toHaveBeenLastCalledWith(3600);
  });

  it("gives keyboard focus back after it is used with the pointer", () => {
    layOut(200);
    renderUi(<Harness max={200} />);
    const slider = screen.getByRole("slider");
    const root = rootOf(slider);
    fireEvent.pointerDown(root, { clientX: 120, pointerId: 1, button: 0 });
    expect(slider).toHaveFocus();
    fireEvent.pointerUp(root, { clientX: 120, pointerId: 1, button: 0 });
    expect(slider).not.toHaveFocus();
  });

  it("resets to its default when the needle is double-clicked", () => {
    const onCommit = vi.fn();
    renderUi(<Harness initial={20} defaultValue={100} onCommit={onCommit} />);
    const slider = screen.getByRole("slider");
    fireEvent.doubleClick(slider);
    expect(slider).toHaveAttribute("aria-valuenow", "100");
    expect(onCommit).toHaveBeenCalledWith(100);
  });

  it("does not reset when the track is double-clicked", () => {
    const onCommit = vi.fn();
    renderUi(<Harness initial={20} defaultValue={100} onCommit={onCommit} />);
    const slider = screen.getByRole("slider");
    fireEvent.doubleClick(rootOf(slider));
    expect(slider).toHaveAttribute("aria-valuenow", "20");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("ignores input when disabled", async () => {
    const onChange = vi.fn();
    renderUi(<Harness disabled onChange={onChange} />);
    const slider = screen.getByRole("slider");
    slider.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("draws one tick per mark and per division", () => {
    const { container } = renderUi(<Harness marks={[{ value: 50 }]} divisions={10} />);
    // 11 graduations and 1 mark; all decoration.
    const ticks = container.querySelectorAll('span[aria-hidden="true"]');
    expect(ticks).toHaveLength(12);
  });
});

describe("a scale in its own values", () => {
  it("reports its range and value as given, not in the slider's own units", () => {
    renderUi(<Harness initial={150} max={200} />);
    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("aria-valuemin", "0");
    expect(slider).toHaveAttribute("aria-valuemax", "200");
    expect(slider).toHaveAttribute("aria-valuenow", "150");
  });

  it("lands a dragged needle on the step grid", () => {
    layOut(200);
    const onChange = vi.fn();
    renderUi(<Harness initial={20} max={200} step={5} onChange={onChange} />);
    const root = rootOf(screen.getByRole("slider"));
    fireEvent.pointerDown(root, { clientX: 92, pointerId: 1, button: 0 });
    expect(onChange).toHaveBeenLastCalledWith(90);
    fireEvent.pointerUp(root, { clientX: 92, pointerId: 1, button: 0 });
    fireEvent.pointerDown(root, { clientX: 93, pointerId: 2, button: 0 });
    expect(onChange).toHaveBeenLastCalledWith(95);
  });

  it("moves ten steps on the Page keys", async () => {
    const onChange = vi.fn();
    renderUi(<Harness initial={50} onChange={onChange} />);
    await userEvent.tab();
    await userEvent.keyboard("{PageUp}");
    expect(onChange).toHaveBeenLastCalledWith(60);
    await userEvent.keyboard("{PageDown}{PageDown}");
    expect(onChange).toHaveBeenLastCalledWith(40);
  });

  it("can send End somewhere short of the maximum", async () => {
    const onChange = vi.fn();
    renderUi(<Harness initial={40} max={200} end={100} onChange={onChange} />);
    await userEvent.tab();
    await userEvent.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith(100);
  });

  it("leaves chords with Command, Control or Option alone", async () => {
    const onChange = vi.fn();
    renderUi(<Harness onChange={onChange} />);
    await userEvent.tab();
    await userEvent.keyboard("{Meta>}{ArrowRight}{/Meta}{Alt>}{ArrowLeft}{/Alt}");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("a mark as a detent", () => {
  it("is six pixels wide where steps are too fine for the pointer to pick out", () => {
    // 1000 px for 7200 values: no pointer lands on 3600 by itself.
    layOut(1000);
    const onChange = vi.fn();
    renderUi(<Harness initial={0} max={7200} marks={[{ value: 3600 }]} onChange={onChange} />);
    const root = rootOf(screen.getByRole("slider"));
    fireEvent.pointerDown(root, { clientX: 505, pointerId: 1, button: 0 });
    expect(onChange).toHaveBeenLastCalledWith(3600);
  });

  it("never hides the values beside it where the pointer can land on each", () => {
    // 200 px for 40 steps of 5: every step has 5 px to itself.
    layOut(200);
    const onChange = vi.fn();
    renderUi(
      <Harness initial={0} max={200} step={5} marks={[{ value: 100 }]} onChange={onChange} />,
    );
    const root = rootOf(screen.getByRole("slider"));
    const landOn = (x: number, pointerId: number) => {
      fireEvent.pointerDown(root, { clientX: x, pointerId, button: 0 });
      fireEvent.pointerUp(root, { clientX: x, pointerId, button: 0 });
      return onChange.mock.calls.at(-1)?.[0];
    };
    expect(landOn(95, 1)).toBe(95);
    expect(landOn(105, 2)).toBe(105);
    expect(landOn(99, 3)).toBe(100);
    expect(landOn(102, 4)).toBe(100);
  });
});

describe("a scale that is not a straight line", () => {
  // The first half of the values takes three quarters of the track.
  const curve = {
    toFraction: (value: number) =>
      value <= 100 ? (value / 100) * 0.75 : 0.75 + ((value - 100) / 100) * 0.25,
    fromFraction: (fraction: number) =>
      fraction <= 0.75 ? (fraction / 0.75) * 100 : 100 + ((fraction - 0.75) / 0.25) * 100,
  };

  it("places a dragged needle by the curve", () => {
    layOut(200);
    const onChange = vi.fn();
    renderUi(<Harness initial={0} max={200} step={5} curve={curve} onChange={onChange} />);
    const root = rootOf(screen.getByRole("slider"));
    // Three eighths of the way along is half of the first zone: 50.
    fireEvent.pointerDown(root, { clientX: 75, pointerId: 1, button: 0 });
    expect(onChange).toHaveBeenLastCalledWith(50);
    fireEvent.pointerUp(root, { clientX: 75, pointerId: 1, button: 0 });
    // Seven eighths along is half of the second: 150.
    fireEvent.pointerDown(root, { clientX: 175, pointerId: 2, button: 0 });
    expect(onChange).toHaveBeenLastCalledWith(150);
  });

  it("still steps evenly in values from the keyboard", async () => {
    const onChange = vi.fn();
    renderUi(<Harness initial={95} max={200} step={5} curve={curve} onChange={onChange} />);
    await userEvent.tab();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([100, 105, 110]);
  });

  it("puts its mark where the curve puts the value", () => {
    const { container } = renderUi(
      <Harness initial={0} max={200} curve={curve} marks={[{ value: 100 }]} />,
    );
    const mark = container.querySelector<HTMLElement>("[data-mark]");
    // Three quarters along, less the inset that keeps a tick under the needle's left half.
    expect(mark?.style.left).toBe("calc(75% - 1.5px)");
  });
});

describe("a mark and the needle", () => {
  function mark(container: HTMLElement) {
    return container.querySelector("[data-mark]");
  }

  it("the mark steps aside while the needle is within five pixels of it", () => {
    layOut(200);
    const { container, unmount } = renderUi(
      <Harness initial={103} max={200} marks={[{ value: 100 }]} />,
    );
    expect(mark(container)).toHaveClass("opacity-0");
    unmount();

    const far = renderUi(<Harness initial={110} max={200} marks={[{ value: 100 }]} />);
    expect(mark(far.container)).not.toHaveClass("opacity-0");
  });

  it("stays put when nothing can be measured", () => {
    // No layout: better a mark beside the needle than no mark anywhere.
    const { container } = renderUi(<Harness initial={100} max={200} marks={[{ value: 100 }]} />);
    expect(mark(container)).not.toHaveClass("opacity-0");
  });
});

describe("a scale whose value is not in effect", () => {
  it("dims its level and its needle but keeps the needle's place", () => {
    const { container, rerender } = renderUi(<Harness initial={60} />);
    const slider = screen.getByRole("slider");
    expect(slider).toHaveClass("needle");
    const before = slider.parentElement?.getAttribute("style");

    rerender(<Harness initial={60} dimmed />);
    expect(slider).not.toHaveClass("needle");
    expect(container.querySelector(".bg-ink-1")).toHaveClass("opacity-0");
    expect(slider.parentElement?.getAttribute("style")).toBe(before);
  });
});

describe("a scale on the stage", () => {
  it("outlines its track, so it is drawn over any picture", () => {
    const { container } = renderUi(<Harness marks={[{ value: 50 }]} />, { surface: "stage" });
    expect(container.querySelector(".bg-stage-track")).toHaveClass(
      "shadow-[0_0_0_1px_var(--stage-edge)]",
    );
    // The needle's outline comes with being a needle: see `.needle` in styles.css.
    expect(screen.getByRole("slider")).toHaveClass("needle");
  });
});

describe("a scale with a tooltip", () => {
  it("shows its reading and its keys when the needle has keyboard focus", async () => {
    renderUi(<Harness tooltip={{ label: "Volume 50%", shortcut: ["Up", "Down"] }} />);
    await userEvent.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Up Arrow, Down Arrow");
    expect(document.body).toHaveTextContent("Volume 50%");
  });

  it("keeps it open while the needle is dragged, and lets it go afterwards", async () => {
    layOut(200);
    renderUi(<Harness max={200} tooltip={{ label: "Volume" }} />);
    const root = rootOf(screen.getByRole("slider"));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.pointerDown(root, { clientX: 60, pointerId: 1, button: 0 });
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    fireEvent.pointerUp(root, { clientX: 60, pointerId: 1, button: 0 });
    await vi.waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });

  it("opens after the pointer has rested on the scale for half a second, not on a pass", () => {
    vi.useFakeTimers();
    try {
      renderUi(<Harness tooltip={{ label: "Volume" }} />);
      const root = rootOf(screen.getByRole("slider"));
      fireEvent.pointerEnter(root);
      act(() => vi.advanceTimersByTime(300));
      fireEvent.pointerLeave(root);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

      fireEvent.pointerEnter(root);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ScaleRow", () => {
  it("keeps the name and the value from wrapping or shrinking, and lets the scale stretch", () => {
    renderUi(
      <ScaleRow
        label="Noise reduction"
        display="+12 dB"
        min={-12}
        max={12}
        value={12}
        valueText="plus 12 decibels"
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("Noise reduction")).toHaveClass("flex-none", "truncate");
    expect(screen.getByText("+12 dB")).toHaveClass("flex-none", "whitespace-nowrap", "tabular");
    expect(rootOf(screen.getByRole("slider", { name: "Noise reduction" }))).toHaveClass(
      "min-w-0",
      "flex-1",
    );
  });
});

describe("a scale that goes both ways from a neutral value", () => {
  function level(): HTMLElement {
    const found = document.querySelector<HTMLElement>("[data-level]");
    if (!found) {
      throw new Error("no level");
    }
    return found;
  }

  it("is lit from its origin to the needle, either way", () => {
    const view = renderUi(
      <Scale
        label="Hue"
        min={-100}
        max={100}
        origin={0}
        value={50}
        valueText=""
        onChange={() => {}}
      />,
    );
    expect(level().style.left).toMatch(/\b50%/);
    expect(level().style.right).toMatch(/\b75%/);

    view.rerender(
      <Scale
        label="Hue"
        min={-100}
        max={100}
        origin={0}
        value={-50}
        valueText=""
        onChange={() => {}}
      />,
    );
    expect(level().style.left).toMatch(/\b25%/);
    expect(level().style.right).toMatch(/\b50%/);
  });

  it("has no level at all while the needle stands on its origin", () => {
    renderUi(
      <Scale
        label="Hue"
        min={-100}
        max={100}
        origin={0}
        value={0}
        valueText=""
        onChange={() => {}}
      />,
    );
    // Both edges at the same place: a level of no width.
    expect(level().style.left).toMatch(/\b50%/);
    expect(level().style.right).toMatch(/\b50%/);
  });

  it("is lit from the minimum when it has no origin", () => {
    renderUi(
      <Scale label="Sharpness" min={0} max={100} value={30} valueText="" onChange={() => {}} />,
    );
    expect(document.querySelector("[data-level]")).toBeNull();
  });

  it("dims its level while it is not in effect", () => {
    renderUi(
      <Scale
        label="Hue"
        min={-100}
        max={100}
        origin={0}
        value={20}
        dimmed
        valueText=""
        onChange={() => {}}
      />,
    );
    expect(level()).toHaveClass("opacity-0");
  });
});

function BrightnessRow({ value }: { value: number }) {
  return (
    <ScaleRow
      label="Brightness"
      min={-100}
      max={100}
      value={value}
      defaultValue={0}
      origin={0}
      display={value > 0 ? `+${value}` : value < 0 ? `−${-value}` : "0"}
      valueText={String(value)}
      onChange={() => {}}
    />
  );
}

describe("a ScaleRow's reading", () => {
  function reading(): HTMLElement {
    const found = document.querySelector<HTMLElement>("[data-reading]");
    if (!found) {
      throw new Error("no reading");
    }
    return found;
  }

  it("is in tertiary ink at the neutral value and in full ink when it differs", () => {
    const view = renderUi(<BrightnessRow value={0} />);
    expect(reading()).toHaveTextContent("0");
    expect(reading()).toHaveClass("text-ink-3");
    expect(reading()).not.toHaveClass("text-ink-1");
    view.rerender(<BrightnessRow value={12} />);
    expect(reading()).toHaveTextContent("+12");
    expect(reading()).toHaveClass("text-ink-1");
    view.rerender(<BrightnessRow value={-30} />);
    expect(reading()).toHaveTextContent("−30");
    expect(reading()).toHaveClass("text-ink-1");
  });

  it("is in full ink when the scale has no neutral to differ from", () => {
    renderUi(
      <ScaleRow
        label="Level"
        min={0}
        max={10}
        value={0}
        display="0"
        valueText="0"
        onChange={() => {}}
      />,
    );
    expect(reading()).toHaveClass("text-ink-1");
  });

  it("returns to the neutral value on a double-click on the needle", () => {
    const onChange = vi.fn();
    renderUi(
      <ScaleRow
        label="Brightness"
        min={-100}
        max={100}
        value={40}
        defaultValue={0}
        origin={0}
        display="+40"
        valueText="plus 40"
        onChange={onChange}
      />,
    );
    fireEvent.doubleClick(screen.getByRole("slider", { name: "Brightness" }));
    expect(onChange).toHaveBeenCalledWith(0);
  });
});
