import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderUi } from "@/test/render";
import { Tooltip } from "./tooltip";

function content(): HTMLElement {
  // The visible box; `role="tooltip"` is the hidden copy assistive technology reads.
  const box = document.querySelector<HTMLElement>("[data-side]");
  if (!box) {
    throw new Error("no tooltip is open");
  }
  return box;
}

describe("Tooltip", () => {
  it("opens on keyboard focus and names the control's shortcut for assistive technology", async () => {
    renderUi(
      <Tooltip label="Mute" shortcut="m">
        <button type="button">Mute</button>
      </Tooltip>,
    );
    await userEvent.tab();
    // The trigger already carries the name: the tooltip adds only the key.
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/^M$/);
    expect(content()).toHaveTextContent("Mute");
  });

  it("never takes the pointer: a click on it goes to whatever is beneath", async () => {
    renderUi(
      <Tooltip label="Play">
        <button type="button">Play</button>
      </Tooltip>,
    );
    await userEvent.tab();
    await screen.findByRole("tooltip");
    expect(content()).toHaveClass("pointer-events-none");
  });

  it("shows every key that works a control", async () => {
    renderUi(
      <Tooltip label="Volume 85%" shortcut={["Up", "Down"]}>
        <button type="button">Volume</button>
      </Tooltip>,
    );
    await userEvent.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Up Arrow, Down Arrow");
    expect(content().querySelectorAll("kbd")).toHaveLength(2);
  });

  it("says why a control is unavailable before it says how to reach it", async () => {
    renderUi(
      <Tooltip label="Cast" detail="No devices found on this network" shortcut="Cmd+Shift+c">
        <button type="button">Cast</button>
      </Tooltip>,
    );
    await userEvent.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "No devices found on this network, Shift Command C",
    );
  });

  it("can be held open whatever the pointer is doing, and can be switched off", () => {
    const { rerender } = renderUi(
      <Tooltip label="Volume 85%" held>
        <button type="button">Volume</button>
      </Tooltip>,
    );
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    rerender(
      <Tooltip label="Volume 85%" held disabled>
        <button type="button">Volume</button>
      </Tooltip>,
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
