import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderUi } from "@/test/render";
import { Switch, SwitchRow } from "./switch";

function Row({
  initial = false,
  onChange,
}: {
  initial?: boolean;
  onChange?: (on: boolean) => void;
}) {
  const [on, setOn] = useState(initial);
  return (
    <SwitchRow
      name="Visualiser"
      hint="Draws the sound of a file that has no picture."
      checked={on}
      onChange={(next) => {
        setOn(next);
        onChange?.(next);
      }}
    />
  );
}

describe("Switch", () => {
  it("is a switch named by its label, reporting whether it is on", () => {
    renderUi(<Switch label="Equaliser" checked onChange={() => {}} />);
    const control = screen.getByRole("switch", { name: "Equaliser" });
    expect(control).toHaveAttribute("aria-checked", "true");
    expect(control).toHaveAttribute("data-state", "checked");
  });

  it("is 28 × 16 and never shrinks in a row", () => {
    renderUi(<Switch label="Equaliser" checked={false} onChange={() => {}} />);
    expect(screen.getByRole("switch")).toHaveClass("h-4", "w-7", "flex-none");
  });

  it("toggles on a click and from the keyboard", async () => {
    const onChange = vi.fn();
    renderUi(<Switch label="Equaliser" checked={false} onChange={onChange} />);
    await userEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenLastCalledWith(true);
    screen.getByRole("switch").focus();
    await userEvent.keyboard(" ");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("does nothing when disabled", async () => {
    const onChange = vi.fn();
    renderUi(<Switch label="Equaliser" checked={false} disabled onChange={onChange} />);
    await userEvent.click(screen.getByRole("switch"));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("SwitchRow", () => {
  it("is named by its name, not its hint", () => {
    renderUi(<Row />);
    expect(screen.getByRole("switch", { name: "Visualiser" })).toBeInTheDocument();
    expect(screen.getByText("Draws the sound of a file that has no picture.")).toBeInTheDocument();
  });

  it("is worked by a click on its name", async () => {
    const onChange = vi.fn();
    renderUi(<Row onChange={onChange} />);
    await userEvent.click(screen.getByText("Visualiser"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByText("Visualiser"));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("is worked by a click on its hint too", async () => {
    renderUi(<Row />);
    await userEvent.click(screen.getByText("Draws the sound of a file that has no picture."));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("truncates its name and keeps the switch at the trailing end", () => {
    renderUi(<Row />);
    expect(screen.getByText("Visualiser")).toHaveClass("truncate");
    const row = screen.getByText("Visualiser").closest("label");
    expect(row).toHaveClass("min-h-8", "items-center");
    expect(row?.lastElementChild).toBe(screen.getByRole("switch"));
  });
});
