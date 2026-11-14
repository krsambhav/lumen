import { afterEach, describe, expect, it, vi } from "vitest";
import { canUndo, clearUndo, offerUndo, undoLast, withdrawUndo } from "./undo";

afterEach(() => {
  clearUndo();
});

describe("what ⌘Z would do", () => {
  it("is nothing until something offers an undo", () => {
    expect(canUndo()).toBe(false);
    expect(undoLast()).toBeNull();
  });

  it("is the newest offer, once, and says whose it was", () => {
    const first = vi.fn();
    const second = vi.fn();
    offerUndo("removed", first);
    offerUndo("cleared", second);
    expect(canUndo()).toBe(true);

    expect(undoLast()).toBe("cleared");
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();

    expect(undoLast()).toBe("removed");
    expect(first).toHaveBeenCalledOnce();
    expect(canUndo()).toBe(false);
  });

  it("forgets an offer that is withdrawn: its toast has gone", () => {
    const undo = vi.fn();
    offerUndo("removed", undo);
    withdrawUndo("removed");
    expect(canUndo()).toBe(false);
    expect(undoLast()).toBeNull();
    expect(undo).not.toHaveBeenCalled();
    // Withdrawing what was never offered is nothing.
    withdrawUndo("never");
  });

  it("keeps only the latest offer made under one name", () => {
    const earlier = vi.fn();
    const later = vi.fn();
    offerUndo("removed", earlier);
    offerUndo("other", vi.fn());
    offerUndo("removed", later);
    // The second removal is the newest thing done, and replaces the first.
    expect(undoLast()).toBe("removed");
    expect(later).toHaveBeenCalledOnce();
    expect(earlier).not.toHaveBeenCalled();
    expect(undoLast()).toBe("other");
    expect(undoLast()).toBeNull();
  });
});
