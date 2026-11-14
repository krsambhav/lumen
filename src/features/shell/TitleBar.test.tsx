import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderUi } from "@/test/render";
import { TitleBar } from "./TitleBar";

describe("TitleBar", () => {
  it("shows the title as the window's heading", () => {
    renderUi(<TitleBar title="Lumen" />);
    expect(screen.getByRole("heading", { level: 1, name: "Lumen" })).toBeInTheDocument();
  });

  it("drags the window from the bar and from the title", () => {
    renderUi(<TitleBar title="Lumen" />);
    expect(screen.getByRole("banner")).toHaveAttribute("data-tauri-drag-region");
    expect(screen.getByRole("heading")).toHaveAttribute("data-tauri-drag-region");
  });

  it("centres the title between two equal columns and keeps the traffic lights clear", () => {
    renderUi(<TitleBar title="Lumen" actions={<button type="button">Pin</button>} />);
    const bar = screen.getByRole("banner");
    // Equal 1fr side columns; padding must stay inside the cells or the title drifts.
    expect(bar).toHaveClass("grid-cols-[1fr_minmax(0,auto)_1fr]");
    const [leading, , trailing] = Array.from(bar.children);
    expect(leading).toHaveClass("min-w-titlebar-lead");
    expect(trailing).toHaveClass("min-w-titlebar-lead");
    expect(trailing?.className).not.toMatch(/\bp[xrl]?-/);
    expect(screen.getByRole("button", { name: "Pin" })).toBeInTheDocument();
  });

  it("uses the stage's colours and scrim when drawn over video", () => {
    renderUi(<TitleBar title="Film.mkv" overVideo />);
    expect(screen.getByRole("banner")).toHaveClass(
      "stage",
      "before:bg-scrim-top",
      "before:h-scrim-top",
    );
  });

  it("names a long file in full for assistive technology", () => {
    const name = "A.Very.Long.Series.Name.S01E03.1080p.mkv";
    renderUi(<TitleBar title={name} />);
    expect(screen.getByRole("heading", { name })).toBeInTheDocument();
  });
});
