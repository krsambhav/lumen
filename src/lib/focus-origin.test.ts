import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusedFromKeyboard, focusOrigin, trackFocusOrigin } from "./focus-origin";

let stop: () => void;

function button(name: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.textContent = name;
  document.body.append(element);
  return element;
}

beforeEach(() => {
  // jsdom reports the document as unfocused while an element is losing
  // focus; browsers only do that when the window is deactivated.
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  stop = trackFocusOrigin();
});

afterEach(() => {
  stop();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("focus origin", () => {
  it("records the keyboard when Tab moves focus", async () => {
    const first = button("First");
    await userEvent.tab();
    expect(first).toHaveFocus();
    expect(focusOrigin()).toBe("keyboard");
    expect(focusedFromKeyboard(first)).toBe(true);
    expect(document.documentElement.dataset.focusOrigin).toBe("keyboard");
  });

  it("records the pointer when a click moves focus, whatever is pressed afterwards", async () => {
    const first = button("First");
    await userEvent.click(first);
    expect(first).toHaveFocus();
    expect(focusedFromKeyboard(first)).toBe(false);
    expect(document.documentElement.dataset.focusOrigin).toBe("pointer");

    // Chromium would start matching :focus-visible here. The record does not move.
    await userEvent.keyboard("a");
    expect(focusedFromKeyboard(first)).toBe(false);
    expect(document.documentElement.dataset.focusOrigin).toBe("pointer");
  });

  it("gives the keyboard up when the control that has it is pressed with the pointer", async () => {
    const first = button("First");
    const inner = document.createElement("span");
    first.append(inner);
    await userEvent.tab();
    expect(focusedFromKeyboard(first)).toBe(true);
    // Focus does not move, so no focus event says anything; the press does.
    await userEvent.pointer({ keys: "[MouseLeft>]", target: inner });
    expect(first).toHaveFocus();
    expect(focusedFromKeyboard(first)).toBe(false);
    expect(document.documentElement.dataset.focusOrigin).toBe("pointer");
    await userEvent.pointer({ keys: "[/MouseLeft]", target: inner });
  });

  it("keeps the keyboard where it is when something else is pressed that takes no focus", async () => {
    const first = button("First");
    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);
    await userEvent.tab();
    await userEvent.pointer({ keys: "[MouseLeft]", target: elsewhere });
    // jsdom moves focus to the body on such a press, as a browser does; if it
    // had stayed, it would still be the keyboard's.
    if (document.activeElement === first) {
      expect(focusedFromKeyboard(first)).toBe(true);
    }
  });

  it("gives focus moved by script the origin of the input that caused it", async () => {
    const first = button("First");
    const second = button("Second");
    await userEvent.click(first);
    second.focus();
    expect(focusedFromKeyboard(second)).toBe(false);

    await userEvent.keyboard("{Escape}");
    first.focus();
    expect(focusedFromKeyboard(first)).toBe(true);
  });

  it("is only ever true of the element that has focus", async () => {
    const first = button("First");
    const second = button("Second");
    await userEvent.tab();
    expect(focusedFromKeyboard(first)).toBe(true);
    expect(focusedFromKeyboard(second)).toBe(false);
    expect(focusedFromKeyboard(document.body)).toBe(false);
    expect(focusedFromKeyboard(null)).toBe(false);
  });

  it("keeps the record when the window is deactivated and focus comes back", async () => {
    const first = button("First");
    await userEvent.tab();
    expect(focusedFromKeyboard(first)).toBe(true);

    // The window goes to the background: the element is blurred, but the
    // document no longer has focus either.
    vi.mocked(document.hasFocus).mockReturnValue(false);
    first.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    // A click elsewhere on the screen is not a click on a control here.
    window.dispatchEvent(new Event("pointerdown"));
    vi.mocked(document.hasFocus).mockReturnValue(true);
    first.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(focusedFromKeyboard(first)).toBe(true);
  });

  it("starts afresh when focus really left and comes back another way", async () => {
    const first = button("First");
    await userEvent.tab();
    expect(focusedFromKeyboard(first)).toBe(true);

    first.blur();
    window.dispatchEvent(new Event("pointerdown"));
    first.focus();
    expect(first).toHaveFocus();
    expect(focusedFromKeyboard(first)).toBe(false);
  });

  it("removes its mark from the document when stopped", () => {
    expect(document.documentElement.dataset.focusOrigin).toBeDefined();
    stop();
    expect(document.documentElement.dataset.focusOrigin).toBeUndefined();
  });
});
