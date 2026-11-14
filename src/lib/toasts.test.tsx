import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/toaster";
import { renderUi } from "@/test/render";
import { dismissFrontToast, TWO_LINES_MS, undoable, undoNewest } from "./notify";
import { canUndo, clearUndo } from "./undo";

afterEach(() => {
  act(() => {
    toast.dismiss();
  });
  clearUndo();
});

describe("a toast that offers Undo", () => {
  it("says what happened in a few words, with the name on a line of its own, cut to fit", async () => {
    renderUi(<Toaster />);
    act(() =>
      undoable("Removed from the playlist", { id: "removed", name: "A film", undo: vi.fn() }),
    );
    expect(await screen.findByText("Removed from the playlist")).toBeInTheDocument();
    expect(screen.getByText("A film")).toHaveClass("truncate");
    // Two lines take longer to read.
    const shown = toast.getToasts().at(-1);
    expect(shown && "duration" in shown ? shown.duration : null).toBe(TWO_LINES_MS);
  });

  it("undoes from its button, and then has nothing left to offer", async () => {
    const undo = vi.fn();
    renderUi(<Toaster />);
    act(() => undoable("Cleared recently played", { id: "cleared", undo }));
    expect(canUndo()).toBe(true);
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledOnce();
    expect(canUndo()).toBe(false);
    expect(undoNewest()).toBe(false);
  });

  it("undoes from the keyboard, and closes", async () => {
    const undo = vi.fn();
    renderUi(<Toaster />);
    act(() => undoable("Cleared recently played", { id: "cleared", undo }));
    await screen.findByText("Cleared recently played");
    let undone = false;
    act(() => {
      undone = undoNewest();
    });
    expect(undone).toBe(true);
    expect(undo).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByText("Cleared recently played")).not.toBeInTheDocument(),
    );
  });

  it("withdraws its offer when it is closed", async () => {
    renderUi(<Toaster />);
    act(() => undoable("Cleared recently played", { id: "cleared", undo: vi.fn() }));
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(canUndo()).toBe(false);
  });
});

describe("closing the toast in front", () => {
  it("closes the newest, one at a time, and says when there was none", async () => {
    renderUi(<Toaster />);
    expect(dismissFrontToast()).toBe(false);
    act(() => {
      toast("First", { id: "first" });
      toast("Second", { id: "second" });
    });
    await screen.findByText("Second");
    let closed = false;
    act(() => {
      closed = dismissFrontToast();
    });
    expect(closed).toBe(true);
    await waitFor(() => expect(screen.queryByText("Second")).not.toBeInTheDocument());
    expect(toast.getToasts().map((each) => each.id)).toEqual(["first"]);
    act(() => {
      dismissFrontToast();
    });
    expect(toast.getToasts()).toEqual([]);
    expect(dismissFrontToast()).toBe(false);
  });
});

describe("where the toasts are", () => {
  function list(): HTMLElement {
    const found = document.querySelector<HTMLElement>("[data-sonner-toaster]");
    if (!found) {
      throw new Error("no toasts are showing");
    }
    return found;
  }

  it("is the top right, under the title bar", async () => {
    renderUi(<Toaster />);
    act(() => {
      toast("Hello");
    });
    await screen.findByText("Hello");
    expect(list()).toHaveAttribute("data-y-position", "top");
    expect(list()).toHaveAttribute("data-x-position", "right");
    expect(list().style.getPropertyValue("--offset-top")).toBe("calc(var(--titlebar-h) + 0.5rem)");
    expect(list().style.getPropertyValue("--offset-right")).toBe("var(--gutter)");
    expect(list().style.getPropertyValue("--width")).toBe(
      "min(356px, calc(100vw - 2 * var(--gutter)))",
    );
  });

  it("is below the on-screen display's line on the stage, and at the picture's corner beside the panel", async () => {
    renderUi(<Toaster onStage besidePanel />);
    act(() => {
      toast("Hello");
    });
    await screen.findByText("Hello");
    expect(list().style.getPropertyValue("--offset-top")).toContain("2.3 * var(--osd-size)");
    expect(list().style.getPropertyValue("--offset-right")).toBe(
      "calc(var(--inspector-w) + var(--gutter))",
    );
    expect(list().style.getPropertyValue("--width")).toContain("var(--inspector-w)");
    expect(list()).toHaveClass("stage");
  });

  it("steps out of sight when told to, and is there again afterwards", async () => {
    const view = renderUi(<Toaster quiet />);
    act(() => {
      toast("Hello");
    });
    await screen.findByText("Hello");
    expect(list()).toHaveClass("invisible");
    view.rerender(<Toaster />);
    expect(list()).not.toHaveClass("invisible");
  });
});
