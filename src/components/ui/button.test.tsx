import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderUi } from "@/test/render";
import { Button } from "./button";

describe("Button", () => {
  it("is a plain button by default, so it never submits a form by accident", () => {
    renderUi(<Button>Open file…</Button>);
    expect(screen.getByRole("button", { name: "Open file…" })).toHaveAttribute("type", "button");
  });

  it("calls its handler on click", async () => {
    const onClick = vi.fn();
    renderUi(<Button onClick={onClick}>Save</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("keeps its name while busy: the label is made transparent, never hidden", () => {
    renderUi(<Button busy>Download</Button>);
    const button = screen.getByRole("button", { name: "Download" });
    expect(button).toHaveAttribute("aria-busy", "true");
    const label = screen.getByText("Download");
    expect(label).toHaveClass("opacity-0");
    // `invisible` (visibility: hidden) would remove the accessible name.
    expect(label).not.toHaveClass("invisible");
  });

  it("ignores the pointer and the keyboard while busy", async () => {
    const onClick = vi.fn();
    renderUi(
      <Button busy onClick={onClick}>
        Download
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Download" });
    await userEvent.click(button);
    button.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onClick).not.toHaveBeenCalled();
    expect(button).toHaveAttribute("aria-disabled", "true");
  });

  it("does nothing when disabled", async () => {
    const onClick = vi.fn();
    renderUi(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
