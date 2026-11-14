import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "@/test/render";
import { MiddleTruncate } from "./middle-truncate";

const LONG = "A.Very.Long.Series.Name.S01E03.1080p.mkv";

/** What is shown: the head and, when the text is split, the tail. */
function visibleParts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-part]"), (part) => part.textContent ?? "");
}

/** jsdom has no layout; pretend the head does not fit. */
function overflow() {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(120);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MiddleTruncate", () => {
  it("renders short text in one piece", () => {
    const { container } = renderUi(<MiddleTruncate text="Lumen" />);
    expect(visibleParts(container)).toEqual(["Lumen"]);
  });

  it("keeps the tail of a long name out of the truncating part", () => {
    const { container } = renderUi(<MiddleTruncate text={LONG} tail={10} />);
    const [head, tail] = Array.from(container.querySelectorAll("[data-part]"));
    expect(head).toHaveTextContent("A.Very.Long.Series.Name.S01E03");
    expect(head).toHaveClass("truncate", "min-w-0");
    expect(tail).toHaveTextContent(".1080p.mkv");
    expect(tail).toHaveClass("flex-none");
  });

  it("keeps the last ten characters unless told otherwise: the end is where episodes differ", () => {
    const { container } = renderUi(
      <MiddleTruncate text="The Crossing S01E02 The Ferryman and the Long Night" />,
    );
    const [head, tail] = Array.from(container.querySelectorAll("[data-part]"));
    expect(head).toHaveTextContent("The Crossing S01E02 The Ferryman and the");
    expect(tail?.textContent).toBe("Long Night");
  });

  it("does not split a name too short to need it", () => {
    const { container } = renderUi(<MiddleTruncate text="Night Drive" />);
    expect(visibleParts(container)).toEqual(["Night Drive"]);
  });

  it("clips rather than spills when there is no room even for the tail", () => {
    const { container } = renderUi(<MiddleTruncate text={LONG} />);
    expect(container.firstElementChild).toHaveClass("overflow-hidden", "min-w-0");
  });

  it("exposes the full text exactly once to assistive technology", () => {
    const { container } = renderUi(<MiddleTruncate text={LONG} />);
    expect(container.querySelectorAll(".sr-only")).toHaveLength(1);
    expect(container.querySelector(".sr-only")).toHaveTextContent(LONG);
  });

  it("never cuts an emoji or a combined character in half", () => {
    // 👨‍👩‍👧 is one character made of five code points; the split must not land inside it.
    const name = `Holiday film ${"👨‍👩‍👧".repeat(12)} final cut.mov`;
    const { container } = renderUi(<MiddleTruncate text={name} tail={10} />);
    const [head, tail] = visibleParts(container);
    expect(`${head}${tail}`).toBe(name);
    expect(tail).toBe("nal cut.mov".slice(-10));
    for (const part of [head ?? "", tail ?? ""]) {
      // A lone surrogate would show as U+FFFD once re-encoded.
      expect(new TextDecoder().decode(new TextEncoder().encode(part))).toBe(part);
    }

    const { container: conjunct } = renderUi(
      <MiddleTruncate text={"क्षत्रिय ".repeat(6)} tail={3} />,
    );
    const [devHead, devTail] = visibleParts(conjunct);
    expect(`${devHead}${devTail}`).toBe("क्षत्रिय ".repeat(6));
    // The tail starts on a base letter, not on a combining mark.
    expect(devTail).not.toMatch(/^\p{M}/u);
  });

  it("lets a right-to-left name keep its own reading order", () => {
    const { container } = renderUi(<MiddleTruncate text="فيلم طويل جدا عن رحلة في الصحراء.mkv" />);
    expect(container.firstElementChild).toHaveAttribute("dir", "auto");
  });

  it("shows the full text in a tooltip only when something is cut off", async () => {
    const { unmount } = renderUi(<MiddleTruncate text={LONG} />);
    await userEvent.hover(screen.getAllByText(/A\.Very/)[1] as HTMLElement);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    unmount();

    overflow();
    renderUi(<MiddleTruncate text={LONG} />);
    await userEvent.hover(screen.getAllByText(/A\.Very/)[1] as HTMLElement);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(LONG);
  });

  it("keeps the same element when truncation starts, so its measurement stays valid", () => {
    const { container, rerender } = renderUi(<MiddleTruncate text={LONG} />);
    const before = container.querySelector(".invisible");
    overflow();
    rerender(<MiddleTruncate text={`${LONG} `} />);
    expect(container.querySelector(".invisible")).toBe(before);
  });

  it("keeps an unseen copy of the whole text, which sets its width and is what gets measured", () => {
    const { container } = renderUi(<MiddleTruncate text={LONG} />);
    const copy = container.querySelector(".invisible");
    expect(copy).toHaveTextContent(LONG);
    expect(copy).toHaveAttribute("aria-hidden", "true");
    // In the same grid cell as what is shown, so the two are one width.
    expect(copy).toHaveClass("col-start-1", "row-start-1");
    expect(container.querySelector("[data-part]")?.parentElement).toHaveClass(
      "col-start-1",
      "row-start-1",
    );
  });

  it("falls back to a CSS ellipsis where text cannot be measured", () => {
    // jsdom lays nothing out, so nothing can be measured: the head truncates by CSS.
    overflow();
    const { container } = renderUi(<MiddleTruncate text={LONG} />);
    expect(container.querySelector('[data-part="head"]')).toHaveClass("truncate");
    expect(container.querySelector('[data-part="fitted"]')).toBeNull();
  });

  it("can drag the window from every part of the text", () => {
    const { container } = renderUi(<MiddleTruncate text={LONG} dragRegion />);
    const wrapper = container.firstElementChild;
    expect(wrapper).toHaveAttribute("data-tauri-drag-region");
    // Everything the pointer can land on. (The unseen copies cannot be hit.)
    const parts = container.querySelectorAll("[data-part]");
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      expect(part).toHaveAttribute("data-tauri-drag-region");
      expect(part.parentElement).toHaveAttribute("data-tauri-drag-region");
    }
    for (const unseen of container.querySelectorAll(".invisible")) {
      expect(unseen).not.toHaveAttribute("data-tauri-drag-region");
    }
  });
});
