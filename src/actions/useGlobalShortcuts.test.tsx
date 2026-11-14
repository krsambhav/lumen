import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackFocusOrigin } from "@/lib/focus-origin";
import { clearActions, registerActions } from "./registry";
import { type ShortcutOptions, shortcutApplies, useGlobalShortcuts } from "./useGlobalShortcuts";

/** What the app around the dispatcher is asked for; a test sets what it wants to hear. */
let options: ShortcutOptions = {};

function Host() {
  useGlobalShortcuts(options);
  return (
    <div>
      <input aria-label="Search" />
      <button type="button">Mute</button>
      <div role="slider" tabIndex={0} aria-label="Position" aria-valuenow={0} />
      <div role="menu" aria-label="Speed">
        <div role="menuitem" tabIndex={-1}>
          Normal
        </div>
      </div>
    </div>
  );
}

interface Overrides {
  repeats?: boolean;
  unavailable?: () => string | undefined;
  /** Whether the Escape action can run. */
  fullscreen?: boolean;
}

function setup({ fullscreen = false, ...overrides }: Overrides = {}) {
  const toggle = vi.fn();
  const open = vi.fn();
  const forward = vi.fn();
  const mute = vi.fn();
  const leave = vi.fn();
  registerActions([
    {
      id: "playback.toggle",
      name: "Play or pause",
      category: "playback",
      shortcuts: ["Space"],
      run: toggle,
      ...overrides,
    },
    { id: "file.open", name: "Open file…", category: "file", shortcuts: ["Cmd+o"], run: open },
    {
      id: "playback.forward",
      name: "Forward",
      category: "playback",
      shortcuts: ["Right"],
      repeats: true,
      run: forward,
    },
    { id: "audio.mute", name: "Mute", category: "audio", shortcuts: ["m"], run: mute },
    {
      id: "view.exitFullscreen",
      name: "Exit full screen",
      category: "view",
      shortcuts: ["Escape"],
      unavailable: () => (fullscreen ? undefined : "Not in full screen"),
      run: leave,
    },
  ]);
  render(<Host />);
  return { toggle, open, forward, mute, leave };
}

let stopTracking: () => void;

beforeEach(() => {
  // See focus-origin.test.ts: jsdom misreports this while focus moves.
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  stopTracking = trackFocusOrigin();
});

afterEach(() => {
  stopTracking();
  vi.restoreAllMocks();
  clearActions();
  options = {};
});

describe("global shortcuts", () => {
  it("runs the action for a chord", async () => {
    const { toggle } = setup();
    await userEvent.keyboard(" ");
    expect(toggle).toHaveBeenCalledOnce();
  });

  it("leaves plain keys to a text field but still honours command chords there", async () => {
    const { toggle, open } = setup();
    await userEvent.click(screen.getByRole("textbox"));
    await userEvent.keyboard("a b");
    expect(toggle).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("a b");

    await userEvent.keyboard("{Meta>}o{/Meta}");
    expect(open).toHaveBeenCalledOnce();
  });

  it("lets a button with keyboard focus keep Space, and nothing else", async () => {
    const { toggle, forward, mute } = setup();
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByRole("button")).toHaveFocus();

    await userEvent.keyboard(" ");
    expect(toggle).not.toHaveBeenCalled();
    // A button has no use for the arrows or for letters: they stay global.
    await userEvent.keyboard("{ArrowRight}m");
    expect(forward).toHaveBeenCalledOnce();
    expect(mute).toHaveBeenCalledOnce();
  });

  it("does not let a button that was clicked keep Space", async () => {
    const { toggle } = setup();
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(toggle).toHaveBeenCalledOnce();
  });

  it("lets a slider with keyboard focus keep the arrows, but not Space", async () => {
    const { toggle, forward } = setup();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByRole("slider")).toHaveFocus();

    await userEvent.keyboard("{ArrowRight}");
    expect(forward).not.toHaveBeenCalled();
    await userEvent.keyboard(" ");
    expect(toggle).toHaveBeenCalledOnce();
  });

  it("leaves every plain key to an open menu", async () => {
    const { toggle, forward, mute, open, leave } = setup({ fullscreen: true });
    screen.getByRole("menuitem").focus();
    await userEvent.keyboard(" {ArrowRight}m{Escape}");
    expect(toggle).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
    expect(mute).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();

    await userEvent.keyboard("{Meta>}o{/Meta}");
    expect(open).toHaveBeenCalledOnce();
  });

  it("does nothing for an unavailable action, but still claims the key", async () => {
    const { toggle } = setup({ unavailable: () => "Nothing is open" });
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    await userEvent.keyboard(" ");
    expect(toggle).not.toHaveBeenCalled();
    // Stopped in the capture phase: no later listener hears it.
    expect(seen).not.toHaveBeenCalled();
    window.removeEventListener("keydown", seen);
  });

  it("repeats only the actions that ask for it", () => {
    const { toggle, forward } = setup();
    const held = (key: string, code: string) =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key, code, repeat: true, bubbles: true }),
      );
    held(" ", "Space");
    held("ArrowRight", "ArrowRight");
    expect(toggle).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledOnce();
  });
});

describe("a key that can do nothing just now", () => {
  it("is answered with the reason, once for a key held down", async () => {
    const refused = vi.fn();
    options = { refused };
    const { toggle } = setup({ unavailable: () => "Nothing is open" });
    await userEvent.keyboard(" ");
    expect(toggle).not.toHaveBeenCalled();
    expect(refused).toHaveBeenCalledWith("Nothing is open");

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", code: "Space", repeat: true, bubbles: true }),
    );
    expect(refused).toHaveBeenCalledOnce();
  });

  it("is not answered when the key works", async () => {
    const refused = vi.fn();
    options = { refused };
    const { toggle } = setup();
    await userEvent.keyboard(" ");
    expect(toggle).toHaveBeenCalledOnce();
    expect(refused).not.toHaveBeenCalled();
  });

  it("is not asked about Escape, which has simply run out of things to leave", async () => {
    const refused = vi.fn();
    options = { refused };
    setup({ fullscreen: false });
    await userEvent.keyboard("{Escape}");
    expect(refused).not.toHaveBeenCalled();
  });

  it("is not answered for a key that was a field's to take", async () => {
    const refused = vi.fn();
    options = { refused };
    setup({ unavailable: () => "Nothing is open" });
    await userEvent.click(screen.getByRole("textbox"));
    await userEvent.keyboard(" ");
    expect(refused).not.toHaveBeenCalled();
  });
});

describe("Escape", () => {
  it("closes what is open elsewhere before it gives the keyboard back or leaves full screen", async () => {
    const open = { toasts: 2 };
    const dismiss = vi.fn(() => {
      if (open.toasts === 0) {
        return false;
      }
      open.toasts -= 1;
      return true;
    });
    options = { dismiss };
    const { leave } = setup({ fullscreen: true });
    await userEvent.tab();
    await userEvent.tab();
    const button = screen.getByRole("button");

    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Escape}");
    // Two toasts closed, one for each press; the button still has the keyboard.
    expect(open.toasts).toBe(0);
    expect(button).toHaveFocus();
    expect(leave).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(button).not.toHaveFocus();
    expect(leave).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(leave).toHaveBeenCalledOnce();
  });

  it("leaves a toast alone while a tooltip or a menu is the thing that is open", async () => {
    const dismiss = vi.fn(() => true);
    options = { dismiss };
    setup();
    await userEvent.tab();
    await userEvent.tab();
    screen.getByRole("button").setAttribute("data-state", "instant-open");
    await userEvent.keyboard("{Escape}");
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("gives the keyboard back first, and only then leaves full screen", async () => {
    const { leave } = setup({ fullscreen: true });
    await userEvent.tab();
    await userEvent.tab();
    const button = screen.getByRole("button");
    expect(button).toHaveFocus();

    // Focus on a control is the inner level: it holds the chrome up, and a
    // keyboard user must be able to let that go without leaving full screen.
    await userEvent.keyboard("{Escape}");
    expect(leave).not.toHaveBeenCalled();
    expect(button).not.toHaveFocus();

    await userEvent.keyboard("{Escape}");
    expect(leave).toHaveBeenCalledOnce();
  });

  it("gives the keyboard back when there is nothing else to leave, too", async () => {
    const { leave } = setup();
    await userEvent.tab();
    await userEvent.tab();
    const button = screen.getByRole("button");
    expect(button).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    expect(leave).not.toHaveBeenCalled();
    expect(button).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

  it("leaves full screen at once when no control has the keyboard", async () => {
    const { leave } = setup({ fullscreen: true });
    await userEvent.click(screen.getByRole("button"));
    await userEvent.keyboard("{Escape}");
    expect(leave).toHaveBeenCalledOnce();
  });

  it("first lets an open tooltip or popover close", async () => {
    const { leave } = setup({ fullscreen: true });
    await userEvent.tab();
    await userEvent.tab();
    const button = screen.getByRole("button");
    button.setAttribute("data-state", "instant-open");
    const seen = vi.fn();
    document.addEventListener("keydown", seen);

    await userEvent.keyboard("{Escape}");
    // Passed on untouched to whatever is open.
    expect(seen).toHaveBeenCalledOnce();
    expect(leave).not.toHaveBeenCalled();
    expect(button).toHaveFocus();
    document.removeEventListener("keydown", seen);
  });
});

describe("shortcutApplies", () => {
  it("treats sliders and checkboxes as controls, not text fields", () => {
    const range = document.createElement("input");
    range.type = "range";
    expect(shortcutApplies("m", range)).toBe(true);
    const text = document.createElement("input");
    expect(shortcutApplies("m", text)).toBe(false);
    expect(shortcutApplies("Cmd+k", text)).toBe(true);
    expect(shortcutApplies("F11", text)).toBe(true);
  });

  it("treats a list you pick from by typing like a text field", () => {
    const select = document.createElement("select");
    expect(shortcutApplies("m", select)).toBe(false);
    expect(shortcutApplies("Cmd+k", select)).toBe(true);

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inside = document.createElement("button");
    dialog.append(inside);
    expect(shortcutApplies("Space", inside)).toBe(false);
    expect(shortcutApplies("Left", inside)).toBe(false);
    expect(shortcutApplies("Cmd+o", inside)).toBe(true);
  });

  it("lets anything opt in to keeping its keys", () => {
    const scope = document.createElement("div");
    scope.dataset.keys = "own";
    const inside = document.createElement("div");
    scope.append(inside);
    expect(shortcutApplies("Space", inside)).toBe(false);
  });

  it("lets a control name the keys it takes, in place of its role's usual set", async () => {
    const stop = trackFocusOrigin();
    const timeline = document.createElement("div");
    timeline.setAttribute("role", "slider");
    timeline.tabIndex = 0;
    timeline.dataset.ownKeys = "Left Right Home End";
    document.body.append(timeline);
    await userEvent.tab();
    expect(timeline).toHaveFocus();

    expect(shortcutApplies("Left", timeline)).toBe(false);
    expect(shortcutApplies("Shift+Right", timeline)).toBe(false);
    // Not listed: the vertical arrows stay with the player, as volume.
    expect(shortcutApplies("Up", timeline)).toBe(true);
    expect(shortcutApplies("Down", timeline)).toBe(true);
    timeline.remove();
    stop();
  });

  it("applies when nothing in particular has focus", () => {
    expect(shortcutApplies("Space", document.body)).toBe(true);
    expect(shortcutApplies("Left", null)).toBe(true);
  });
});

/** A list of the kind a panel holds, a field, a dialog and a button, with the shortcuts on. */
function PanelHost({ onListKey }: { onListKey: (key: string) => void }) {
  useGlobalShortcuts();
  return (
    <div>
      <div
        role="listbox"
        tabIndex={0}
        aria-label="Playlist"
        data-own-keys="Up Down Enter Delete"
        onKeyDown={(event) => onListKey(event.key)}
      >
        <div role="option" aria-selected="true" tabIndex={-1}>
          Episode 1
        </div>
      </div>
      <input aria-label="Name" />
      <button type="button">Save</button>
      <div role="dialog" aria-label="Palette">
        <div tabIndex={-1} data-testid="in-dialog">
          A row
        </div>
      </div>
    </div>
  );
}

function panel() {
  const toggle = vi.fn();
  const down = vi.fn();
  const mute = vi.fn();
  const next = vi.fn();
  registerActions([
    {
      id: "playback.toggle",
      name: "Play",
      category: "playback",
      shortcuts: ["Space"],
      run: toggle,
    },
    { id: "audio.volumeDown", name: "Down", category: "audio", shortcuts: ["Down"], run: down },
    { id: "audio.mute", name: "Mute", category: "audio", shortcuts: ["m"], run: mute },
    {
      id: "playlist.next",
      name: "Next",
      category: "playback",
      shortcuts: ["Cmd+Right"],
      run: next,
    },
  ]);
  const listKeys: string[] = [];
  render(<PanelHost onListKey={(key) => listKeys.push(key)} />);
  return { toggle, down, mute, next, listKeys };
}

/** Presses a key on `target` as the browser would, and says whether anything claimed it. */
function press(target: Element, init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("a list in a panel", () => {
  it("keeps the keys that work a list while it has keyboard focus, and leaves the rest to the player", async () => {
    const { toggle, down, listKeys } = panel();
    await userEvent.tab();
    expect(screen.getByRole("listbox")).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(down).not.toHaveBeenCalled();
    expect(listKeys).toEqual(["ArrowDown", "Enter"]);
    // Space is not one of its keys: the film still pauses.
    await userEvent.keyboard(" ");
    expect(toggle).toHaveBeenCalledOnce();
  });

  it("keeps none of the player's keys after a click, but still gets Return and Delete", async () => {
    const { toggle, down, listKeys } = panel();
    await userEvent.click(screen.getByText("Episode 1"));
    await userEvent.keyboard("{ArrowDown} ");
    expect(down).toHaveBeenCalledOnce();
    expect(toggle).toHaveBeenCalledOnce();
    // Nobody's shortcut, so they reach the row that was selected.
    await userEvent.keyboard("{Enter}{Delete}");
    expect(listKeys).toEqual(["Enter", "Delete"]);
  });
});

describe("text fields and the chords that edit text", () => {
  it("leaves Command with an arrow to the field", async () => {
    const { next } = panel();
    await userEvent.click(screen.getByRole("textbox", { name: "Name" }));
    await userEvent.keyboard("{Meta>}{ArrowRight}{/Meta}");
    expect(next).not.toHaveBeenCalled();
    // Outside a field the same keys are the shortcut.
    screen.getByRole("textbox", { name: "Name" }).blur();
    await userEvent.keyboard("{Meta>}{ArrowRight}{/Meta}");
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("keys nothing in the page wanted", () => {
  // macOS offers the menu bar any key press the page leaves unhandled, and
  // the menu bar shows the same shortcuts as real key equivalents.
  it("are claimed when they are somebody's shortcut, so the menu bar does not run it", () => {
    const { mute } = panel();
    const claimed = press(screen.getByTestId("in-dialog"), { key: "m", code: "KeyM" });
    // Inside a dialog a plain key is the dialog's: the action must not run by either route.
    expect(mute).not.toHaveBeenCalled();
    expect(claimed).toBe(true);
  });

  it("are left alone when they are nobody's shortcut", () => {
    panel();
    expect(press(screen.getByTestId("in-dialog"), { key: "q", code: "KeyQ" })).toBe(false);
    expect(press(document.body, { key: "q", code: "KeyQ" })).toBe(false);
  });

  it("are left to a field, which is typing them", () => {
    const { mute } = panel();
    const field = screen.getByRole("textbox", { name: "Name" });
    expect(press(field, { key: "m", code: "KeyM" })).toBe(false);
    expect(mute).not.toHaveBeenCalled();
  });

  it("are left to a control whose own key it is", async () => {
    const { toggle } = panel();
    const save = screen.getByRole("button", { name: "Save" });
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    expect(save).toHaveFocus();
    // Space on a button that has the keyboard presses the button; it must stay unclaimed for that.
    expect(press(save, { key: " ", code: "Space" })).toBe(false);
    expect(toggle).not.toHaveBeenCalled();
  });
});
