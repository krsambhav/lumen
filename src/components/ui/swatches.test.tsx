import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderUi } from "@/test/render";
import { Swatches } from "./swatches";

const COLOURS = [
  { value: "#FFFFFF", name: "White" },
  { value: "#FFE14D", name: "Yellow" },
  { value: "#9FE8FF", name: "Pale blue" },
];

const RING = "shadow-[0_0_0_2px_var(--surface-1),0_0_0_4px_var(--ink-1)]";

describe("Swatches", () => {
  it("is a radio group of named circles 20 px across, 8 px apart", () => {
    renderUi(
      <Swatches label="Subtitle colour" value="#FFFFFF" swatches={COLOURS} onChange={() => {}} />,
    );
    const group = screen.getByRole("radiogroup", { name: "Subtitle colour" });
    expect(group).toHaveClass("gap-2");
    const circles = screen.getAllByRole("radio");
    expect(circles.map((circle) => circle.getAttribute("aria-label"))).toEqual([
      "White",
      "Yellow",
      "Pale blue",
    ]);
    for (const circle of circles) {
      expect(circle).toHaveClass("size-5", "rounded-full", "flex-none");
    }
    expect(circles[1]).toHaveStyle({ backgroundColor: "#FFE14D" });
  });

  it("rings the chosen one, whatever the case of its value", () => {
    renderUi(
      <Swatches label="Subtitle colour" value="#ffe14d" swatches={COLOURS} onChange={() => {}} />,
    );
    const yellow = screen.getByRole("radio", { name: "Yellow" });
    expect(yellow).toHaveAttribute("aria-checked", "true");
    expect(yellow).toHaveClass(RING);
    expect(screen.getByRole("radio", { name: "White" })).not.toHaveClass(RING);
  });

  it("says which was chosen", async () => {
    const onChange = vi.fn();
    renderUi(
      <Swatches label="Subtitle colour" value="#FFFFFF" swatches={COLOURS} onChange={onChange} />,
    );
    await userEvent.click(screen.getByRole("radio", { name: "Pale blue" }));
    expect(onChange).toHaveBeenCalledWith("#9FE8FF");
  });

  it("ends with one that opens the system's colour panel for any other", () => {
    const onChange = vi.fn();
    renderUi(
      <Swatches label="Subtitle colour" value="#FFFFFF" swatches={COLOURS} onChange={onChange} />,
    );
    const other = screen.getByLabelText("Subtitle colour: another colour");
    expect(other).toHaveAttribute("type", "color");
    fireEvent.change(other, { target: { value: "#12ab34" } });
    expect(onChange).toHaveBeenCalledWith("#12AB34");
  });

  it("rings the last circle, drawn in the colour, when the colour is none of the few", () => {
    renderUi(
      <Swatches label="Subtitle colour" value="#12AB34" swatches={COLOURS} onChange={() => {}} />,
    );
    for (const circle of screen.getAllByRole("radio")) {
      expect(circle).toHaveAttribute("aria-checked", "false");
    }
    const last = screen.getByLabelText("Subtitle colour: another colour").closest("label");
    expect(last).toHaveClass(RING);
    expect(last).toHaveStyle({ backgroundColor: "#12AB34" });
    expect(last?.querySelector("svg")).toBeNull();
  });
});
