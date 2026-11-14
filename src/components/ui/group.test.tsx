import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderUi } from "@/test/render";
import { Button } from "./button";
import { Group } from "./group";

describe("Group", () => {
  it("is a region named by its heading", () => {
    renderUi(
      <Group title="Frame">
        <p>Aspect</p>
      </Group>,
    );
    const region = screen.getByRole("region", { name: "Frame" });
    expect(screen.getByRole("heading", { level: 3, name: "Frame" })).toHaveClass(
      "label",
      "text-ink-3",
      "truncate",
    );
    expect(region).toHaveTextContent("Aspect");
  });

  it("keeps its heading row 28 px tall whether or not anything stands at its end", () => {
    const view = renderUi(
      <Group title="Frame">
        <p>Aspect</p>
      </Group>,
    );
    const row = () => screen.getByRole("heading", { name: "Frame" }).parentElement;
    expect(row()).toHaveClass("h-7", "items-center");
    expect(row()?.children).toHaveLength(1);

    view.rerender(
      <Group title="Frame" trailing={<Button size="sm">Reset</Button>}>
        <p>Aspect</p>
      </Group>,
    );
    expect(row()).toHaveClass("h-7");
    // What acts on the whole group is at the trailing end of the heading row.
    expect(row()?.lastElementChild).toBe(screen.getByRole("button", { name: "Reset" }));
    // The heading takes what room is left, and gives it up before the control does.
    expect(screen.getByRole("heading", { name: "Frame" })).toHaveClass("min-w-0", "flex-1");
  });
});
