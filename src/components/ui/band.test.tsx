import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderUi } from "@/test/render";
import { Band } from "./band";

function Harness({
  initial = 0,
  dimmed,
  onChange,
}: {
  initial?: number;
  dimmed?: boolean;
  onChange?: (value: number) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Band
      label="250 hertz"
      caption="250"
      value={value}
      min={-12}
      max={12}
      step={0.5}
      origin={0}
      valueText={`${value} decibels`}
      display={`${value} dB`}
      {...(dimmed === undefined ? {} : { dimmed })}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

function level(): HTMLElement {
  const found = document.querySelector<HTMLElement>("[data-level]");
  if (!found) {
    throw new Error("no level");
  }
  return found;
}

describe("Band", () => {
  it("is a vertical slider named in words, with its frequency beneath", () => {
    renderUi(<Harness initial={4.5} />);
    const slider = screen.getByRole("slider", { name: "250 hertz" });
    expect(slider).toHaveAttribute("aria-orientation", "vertical");
    expect(slider).toHaveAttribute("aria-valuetext", "4.5 decibels");
    expect(screen.getByText("250")).toHaveClass("text-caption", "tabular");
    // The caption is for the eye: the name already says it.
    expect(screen.getByText("250")).toHaveAttribute("aria-hidden", "true");
  });

  it("steps by its step with the arrow keys", async () => {
    const onChange = vi.fn();
    renderUi(<Harness onChange={onChange} />);
    screen.getByRole("slider").focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(onChange).toHaveBeenLastCalledWith(0.5);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(onChange).toHaveBeenLastCalledWith(-0.5);
  });

  it("is lit from 0 to the needle, up or down", () => {
    const view = renderUi(<Harness initial={6} />);
    // 0 is half-way; +6 is three quarters of the way up.
    expect(level().style.bottom).toBe("50%");
    expect(level().style.top).toBe("25%");
    view.unmount();
    renderUi(<Harness initial={-12} />);
    expect(level().style.bottom).toBe("0%");
    expect(level().style.top).toBe("50%");
  });

  it("goes back to 0 on a double-click on the needle", () => {
    const onChange = vi.fn();
    renderUi(<Harness initial={6} onChange={onChange} />);
    fireEvent.doubleClick(screen.getByRole("slider"));
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it("keeps its place and steps back when it is not in effect", () => {
    renderUi(<Harness initial={6} dimmed />);
    expect(level()).toHaveClass("opacity-0");
    expect(screen.getByRole("slider")).toHaveClass("bg-ink-3");
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "6");
  });
});
