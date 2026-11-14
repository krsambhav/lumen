import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderUi } from "@/test/render";
import { EqualiserBands } from "./EqualiserBands";

const GAINS = [6, 5, 4, 2, 0, 0, 0, 0, 0, -1.5];

describe("EqualiserBands", () => {
  it("is a group of ten bands named by frequency, each reading its gain in words", () => {
    renderUi(
      <EqualiserBands
        equaliser={{ enabled: true, gains: GAINS }}
        dimmed={false}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("group", { name: "Equaliser bands" })).toBeInTheDocument();
    const bands = screen.getAllByRole("slider");
    expect(bands.map((band) => band.getAttribute("aria-label"))).toEqual([
      "31 hertz",
      "62 hertz",
      "125 hertz",
      "250 hertz",
      "500 hertz",
      "1 kilohertz",
      "2 kilohertz",
      "4 kilohertz",
      "8 kilohertz",
      "16 kilohertz",
    ]);
    expect(bands[0]).toHaveAttribute("aria-valuetext", "plus 6 decibels");
    expect(bands[4]).toHaveAttribute("aria-valuetext", "0 decibels");
    expect(bands[9]).toHaveAttribute("aria-valuetext", "minus 1.5 decibels");
    expect(bands[0]).toHaveAttribute("aria-valuemin", "-12");
    expect(bands[0]).toHaveAttribute("aria-valuemax", "12");
    for (const caption of ["31", "1k", "16k"]) {
      expect(screen.getByText(caption)).toHaveClass("text-caption");
    }
  });

  it("moves one band, keeping the others, in half decibels", async () => {
    const onChange = vi.fn();
    renderUi(
      <EqualiserBands
        equaliser={{ enabled: true, gains: GAINS }}
        dimmed={false}
        onChange={onChange}
      />,
    );
    screen.getByRole("slider", { name: "250 hertz" }).focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(onChange).toHaveBeenLastCalledWith({
      enabled: true,
      gains: [6, 5, 4, 2.5, 0, 0, 0, 0, 0, -1.5],
    });
  });

  it("dims every band when not in effect, keeping their places", () => {
    renderUi(
      <EqualiserBands equaliser={{ enabled: false, gains: GAINS }} dimmed onChange={() => {}} />,
    );
    for (const band of screen.getAllByRole("slider")) {
      expect(band).toHaveClass("bg-ink-3");
    }
    expect(screen.getByRole("slider", { name: "31 hertz" })).toHaveAttribute("aria-valuenow", "6");
  });
});
