import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderUi } from "@/test/render";
import { IconButton } from "./icon-button";

function Icon() {
  return <svg aria-hidden="true" />;
}

describe("IconButton", () => {
  it("takes its accessible name from the label", () => {
    renderUi(
      <IconButton label="Full screen">
        <Icon />
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "Full screen" })).toBeInTheDocument();
  });

  it("shows the label and shortcut in a tooltip on keyboard focus", async () => {
    renderUi(
      <IconButton label="Full screen" shortcut="Ctrl+Cmd+f">
        <Icon />
      </IconButton>,
    );
    await userEvent.tab();
    const tooltip = await screen.findByRole("tooltip");
    // Assistive technology hears only what the tooltip adds to the button's name.
    expect(tooltip).toHaveTextContent("Control Command F");
    expect(tooltip).not.toHaveTextContent("Full screen");
    // Sighted users see the name and the keycap.
    expect(screen.getAllByText("Full screen").length).toBeGreaterThan(0);
  });

  it("announces its shortcut to assistive technology", () => {
    renderUi(
      <IconButton label="Full screen" shortcut="Ctrl+Cmd+f">
        <Icon />
      </IconButton>,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-keyshortcuts", "Control+Meta+F");
  });

  it("exposes toggle state and lights a lamp when on", () => {
    const { rerender } = renderUi(
      <IconButton label="Subtitles" pressed={false}>
        <Icon />
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "Subtitles" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button.className).not.toContain("after:bg-accent");
    rerender(
      <IconButton label="Subtitles" pressed>
        <Icon />
      </IconButton>,
    );
    expect(button).toHaveAttribute("aria-pressed", "true");
    // On is carried by form (full ink and a lamp), not by hue alone.
    expect(button).toHaveClass("text-ink-1", "after:bg-accent", "after:w-2");
  });

  it("is not a toggle unless told so", () => {
    renderUi(
      <IconButton label="Next">
        <Icon />
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "Next" })).not.toHaveAttribute("aria-pressed");
  });

  it("uses the larger stage size over video", () => {
    renderUi(
      <IconButton label="Play">
        <Icon />
      </IconButton>,
      { surface: "stage" },
    );
    expect(screen.getByRole("button", { name: "Play" })).toHaveClass("size-9");
  });

  it("stays reachable when unavailable, says why, and does nothing", async () => {
    const onClick = vi.fn();
    renderUi(
      <IconButton label="Cast" shortcut="c" unavailable="No devices found" onClick={onClick}>
        <Icon />
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "Cast" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();

    await userEvent.tab();
    expect(button).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("No devices found");

    await userEvent.click(button);
    await userEvent.keyboard("{Enter}");
    expect(onClick).not.toHaveBeenCalled();
  });
});
