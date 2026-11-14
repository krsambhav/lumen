import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackFocusOrigin } from "@/lib/focus-origin";
import { renderUi } from "@/test/render";
import { ListBox } from "./list-box";

interface Film {
  id: number;
  title: string;
}

const FILMS: Film[] = [
  { id: 11, title: "Blue" },
  { id: 12, title: "White" },
  { id: 13, title: "Red" },
];

const handlers = {
  activate: vi.fn<(film: Film) => void>(),
  remove: vi.fn<(film: Film) => void>(),
  move: vi.fn<(film: Film, index: number) => void>(),
};

function List({
  films = FILMS,
  activateOnClick = false,
  current = null,
}: {
  films?: Film[];
  activateOnClick?: boolean;
  current?: number | null;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <ListBox
      label="Playlist"
      items={films}
      getId={(film) => film.id}
      getLabel={(film, index) => `${index + 1}, ${film.title}`}
      rowHeight={28}
      selected={selected}
      onSelect={setSelected}
      onActivate={handlers.activate}
      onRemove={handlers.remove}
      onMove={handlers.move}
      activateOnClick={activateOnClick}
      current={current}
      renderRow={(film) => <span>{film.title}</span>}
    />
  );
}

let stopTracking: () => void;

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  stopTracking = trackFocusOrigin();
  for (const handler of Object.values(handlers)) {
    handler.mockClear();
  }
});

afterEach(() => {
  stopTracking();
});

function selectedName() {
  return screen.queryByRole("option", { selected: true })?.getAttribute("aria-label") ?? null;
}

describe("ListBox", () => {
  it("is a list of options, each named, with the current one marked", () => {
    renderUi(<List current={12} />);
    const list = screen.getByRole("listbox", { name: "Playlist" });
    expect(list).toHaveAttribute("tabindex", "0");
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.getAttribute("aria-label"))).toEqual([
      "1, Blue",
      "2, White",
      "3, Red",
    ]);
    expect(options[1]).toHaveAttribute("aria-current", "true");
    expect(options[0]).not.toHaveAttribute("aria-current");
  });

  it("selects on a click and acts on a double-click", async () => {
    renderUi(<List />);
    await userEvent.click(screen.getByText("White"));
    expect(selectedName()).toBe("2, White");
    expect(handlers.activate).not.toHaveBeenCalled();
    await userEvent.dblClick(screen.getByText("Red"));
    expect(handlers.activate).toHaveBeenCalledTimes(1);
    expect(handlers.activate).toHaveBeenCalledWith(FILMS[2]);
  });

  it("acts on a single click when it is a table of contents", async () => {
    renderUi(<List activateOnClick />);
    await userEvent.click(screen.getByText("White"));
    expect(handlers.activate).toHaveBeenCalledWith(FILMS[1]);
    await userEvent.dblClick(screen.getByText("Red"));
    // Two clicks are two visits, not three.
    expect(handlers.activate).toHaveBeenCalledTimes(3);
  });

  it("names the selected row as its active descendant, keeping focus on the list", async () => {
    renderUi(<List />);
    const list = screen.getByRole("listbox");
    await userEvent.click(screen.getByText("White"));
    const selected = screen.getByRole("option", { selected: true });
    expect(list).toHaveAttribute("aria-activedescendant", selected.id);
    expect(list).toHaveFocus();
  });

  it("moves the selection with the arrows, Home and End", async () => {
    renderUi(<List />);
    await userEvent.tab();
    // Arriving by keyboard, it starts at the first row.
    expect(selectedName()).toBe("1, Blue");
    await userEvent.keyboard("{ArrowDown}");
    expect(selectedName()).toBe("2, White");
    await userEvent.keyboard("{End}");
    expect(selectedName()).toBe("3, Red");
    // It stops at the ends.
    await userEvent.keyboard("{ArrowDown}");
    expect(selectedName()).toBe("3, Red");
    await userEvent.keyboard("{Home}{ArrowUp}");
    expect(selectedName()).toBe("1, Blue");
  });

  it("starts at the current row when reached from the keyboard", async () => {
    renderUi(<List current={13} />);
    await userEvent.tab();
    expect(selectedName()).toBe("3, Red");
  });

  it("acts on Return, and removes on Delete, moving the selection to what takes its place", async () => {
    renderUi(<List />);
    await userEvent.click(screen.getByText("White"));
    await userEvent.keyboard("{Enter}");
    expect(handlers.activate).toHaveBeenCalledWith(FILMS[1]);
    await userEvent.keyboard("{Delete}");
    expect(handlers.remove).toHaveBeenCalledWith(FILMS[1]);
    expect(selectedName()).toBe("3, Red");
    await userEvent.keyboard("{Backspace}");
    expect(handlers.remove).toHaveBeenLastCalledWith(FILMS[2]);
    // The last row gone: the one before it.
    expect(selectedName()).toBe("2, White");
  });

  it("carries the selected row with Option and an arrow", async () => {
    renderUi(<List />);
    await userEvent.click(screen.getByText("White"));
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(handlers.move).toHaveBeenCalledWith(FILMS[1], 2);
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(handlers.move).toHaveBeenLastCalledWith(FILMS[1], 0);
    // The first row cannot go further up.
    await userEvent.click(screen.getByText("Blue"));
    handlers.move.mockClear();
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(handlers.move).not.toHaveBeenCalled();
  });

  it("says which keys it takes, so the rest still reach the player", () => {
    renderUi(<List />);
    expect(screen.getByRole("listbox")).toHaveAttribute(
      "data-own-keys",
      "Up Down Home End PageUp PageDown Enter Delete Backspace",
    );
  });

  it("leaves a key with Command to whoever wants it", async () => {
    renderUi(<List />);
    await userEvent.click(screen.getByText("White"));
    const list = screen.getByRole("listbox");
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      list.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(selectedName()).toBe("2, White");
  });

  it("draws only the rows in view of a very long list", () => {
    const many = Array.from({ length: 2000 }, (_, index) => ({
      id: index,
      title: `Film ${index}`,
    }));
    renderUi(<List films={many} />);
    // No layout here, so no rows are in view; what matters is that 2000 are not drawn.
    expect(screen.queryAllByRole("option").length).toBeLessThan(100);
    // The space for all of them is still there to scroll through.
    const inner = screen.getByRole("listbox").firstElementChild as HTMLElement;
    expect(inner.style.height).toBe("56000px");
  });

  it("does nothing with keys when it is empty", () => {
    renderUi(<List films={[]} />);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(handlers.activate).not.toHaveBeenCalled();
  });
});

describe("the focus ring and the selection", () => {
  it("hands the ring to the selected row, drawn inside it, and to no other", async () => {
    renderUi(<List />);
    const list = screen.getByRole("listbox");
    // The list itself draws none: see styles.css, "ring-on-part".
    expect(list).toHaveClass("ring-on-part");
    expect(document.querySelector("[data-ring]")).toBeNull();
    await userEvent.click(screen.getByRole("option", { name: "2, White" }));
    const ringed = Array.from(document.querySelectorAll("[data-ring]"));
    expect(ringed).toHaveLength(1);
    expect(ringed[0]).toHaveAccessibleName("2, White");
    expect(ringed[0]).toHaveAttribute("data-ring", "inside");
  });

  it("draws what a selected row writes in tertiary ink in secondary ink", async () => {
    renderUi(<List />);
    await userEvent.click(screen.getByRole("option", { name: "1, Blue" }));
    expect(screen.getByRole("option", { name: "1, Blue" })).toHaveClass(
      "bg-accent-soft",
      "[--ink-3:var(--ink-2)]",
    );
    expect(screen.getByRole("option", { name: "2, White" })).not.toHaveClass("bg-accent-soft");
  });

  it("leaves no row selected after a click that acts, so a fill never outlasts what it marked", async () => {
    renderUi(<List activateOnClick current={11} />);
    await userEvent.click(screen.getByRole("option", { name: "3, Red" }));
    expect(handlers.activate).toHaveBeenCalledWith(FILMS[2]);
    expect(screen.queryByRole("option", { selected: true })).not.toBeInTheDocument();
    // The keyboard still has a selection to move: arriving, it starts from the current row.
    act(() => screen.getByRole("listbox").blur());
    await userEvent.tab();
    expect(screen.getByRole("option", { selected: true })).toHaveAccessibleName("1, Blue");
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { selected: true })).toHaveAccessibleName("2, White");
    // And a click clears that one too.
    await userEvent.click(screen.getByRole("option", { name: "1, Blue" }));
    expect(screen.queryByRole("option", { selected: true })).not.toBeInTheDocument();
  });
});
