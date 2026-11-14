/**
 * Where keyboard focus came from: a key press, or the pointer.
 *
 * Three things depend on the answer and must always agree (DESIGN.md §8): the
 * focus ring, whether a focused control keeps its own keys or leaves them to
 * the global shortcuts, and whether the stage chrome stays up.
 *
 * `:focus-visible` is the engine's guess at the same question, but engines
 * guess differently: Chromium starts matching it for a clicked control as soon
 * as any key is pressed, and WebKit on macOS 12.0 to 12.2 does not have it at
 * all. So the answer is recorded here instead, at the moment focus moves,
 * from the kind of input that moved it. A control that has the keyboard and
 * is then pressed with the pointer is being used with the pointer from then
 * on, though focus has not moved: that is recorded too. The record is
 * published as `data-focus-origin` on the root element for the stylesheet.
 */

export type FocusOrigin = "keyboard" | "pointer";

/** The kind of the most recent input. Focus moved by script inherits it. */
let lastInput: FocusOrigin = "keyboard";
/** The element the record below is about. */
let holder: Element | null = null;
let origin: FocusOrigin = "pointer";

function record(next: FocusOrigin): void {
  origin = next;
  document.documentElement.dataset.focusOrigin = next;
}

/** How the element that has focus now came to have it. */
export function focusOrigin(): FocusOrigin {
  return origin;
}

/** True when `target` has focus and a key press put it there. */
export function focusedFromKeyboard(target: EventTarget | null): boolean {
  return (
    origin === "keyboard" &&
    target instanceof Element &&
    target !== document.body &&
    target === document.activeElement
  );
}

/**
 * Starts recording. Call once, before anything can take focus. Returns a
 * function that stops it.
 */
export function trackFocusOrigin(): () => void {
  const onKeyDown = () => {
    lastInput = "keyboard";
  };
  const onPointerDown = (event: PointerEvent) => {
    lastInput = "pointer";
    // Pressed where the keyboard already was: no focus event will say so.
    if (
      origin === "keyboard" &&
      holder !== null &&
      event.target instanceof Node &&
      holder.contains(event.target)
    ) {
      record("pointer");
    }
  };
  const onFocusIn = (event: FocusEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target !== null && target === holder) {
      // Focus is back where it already was: the window was reactivated.
      // Nothing moved it, so how it got there has not changed.
      return;
    }
    holder = target;
    record(lastInput);
  };
  const onFocusOut = () => {
    // When the window is deactivated the element is blurred too, but focus
    // will return to it; only forget it when focus really left.
    if (document.hasFocus()) {
      holder = null;
    }
  };

  // Whatever has focus already got it without the pointer.
  const active = document.activeElement;
  holder = active !== null && active !== document.body ? active : null;
  lastInput = "keyboard";
  record(holder === null ? "pointer" : "keyboard");

  const capture = { capture: true } as const;
  window.addEventListener("keydown", onKeyDown, capture);
  window.addEventListener("pointerdown", onPointerDown, capture);
  window.addEventListener("focusin", onFocusIn, capture);
  window.addEventListener("focusout", onFocusOut, capture);
  return () => {
    window.removeEventListener("keydown", onKeyDown, capture);
    window.removeEventListener("pointerdown", onPointerDown, capture);
    window.removeEventListener("focusin", onFocusIn, capture);
    window.removeEventListener("focusout", onFocusOut, capture);
    holder = null;
    delete document.documentElement.dataset.focusOrigin;
  };
}
