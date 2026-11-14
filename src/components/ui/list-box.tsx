import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  useCallback,
  useId,
  useImperativeHandle,
  useRef,
} from "react";
import { cn } from "@/lib/cn";
import { focusedFromKeyboard } from "@/lib/focus-origin";

/** Lists longer than this draw only the rows in view. */
export const VIRTUAL_FROM = 200;

/**
 * The keys a list takes while it has keyboard focus; every other key still
 * reaches the player (DESIGN.md §8).
 */
const OWN_KEYS = "Up Down Home End PageUp PageDown Enter Delete Backspace";

/** What a row's element needs in order to be an option of the list. */
export interface OptionProps {
  id: string;
  role: "option";
  "aria-selected": boolean;
  "aria-label"?: string;
  "aria-current"?: "true";
  /** The selected row carries the list's focus ring: see styles.css. */
  "data-ring"?: "inside";
  "data-index": number;
  className: string;
  style: CSSProperties;
  onClick: (event: MouseEvent) => void;
  onDoubleClick: (event: MouseEvent) => void;
}

export interface RowState {
  index: number;
  selected: boolean;
}

/** What a list lets its owner do to it from outside. */
export interface ListBoxHandle {
  /** The scrolling element. */
  element: HTMLDivElement | null;
  /** The place in the list, between rows, nearest to a height on the screen. */
  indexAt: (clientY: number) => number;
}

interface ListBoxProps<T> {
  /** The accessible name. */
  label: string;
  items: readonly T[];
  getId: (item: T) => number;
  /**
   * What assistive technology calls a row, for a row whose content does not
   * say it. A row that shows its name should be named by what it shows
   * (with words for the eye-only parts hidden inside it), so the two can
   * never differ: leave this out for those.
   */
  getLabel?: (item: T, index: number) => string;
  /** Row height in pixels: 28 or 44 (DESIGN.md §4). */
  rowHeight: number;
  /** The selected row's id. */
  selected: number | null;
  onSelect: (id: number | null) => void;
  /** Return, or a double-click. */
  onActivate: (item: T) => void;
  /** Delete. Leave out for a list nothing can be removed from. */
  onRemove?: (item: T) => void;
  /** ⌥↑ and ⌥↓: move the row to this place in the list. */
  onMove?: (item: T, index: number) => void;
  /**
   * A single click activates, and leaves no row selected: for a list that is
   * a table of contents. The selection is then only where the keyboard is.
   */
  activateOnClick?: boolean;
  /** The id of the row that is "the current one" (playing), if any. */
  current?: number | null;
  renderRow: (item: T, state: RowState) => ReactNode;
  /**
   * Renders the row's own element, for a list whose rows need more than a
   * plain one (a drag handle, a menu). It must spread `props` on its root.
   */
  renderOption?: (item: T, state: RowState, props: OptionProps, content: ReactNode) => ReactElement;
  /** Drawn over the rows, in the same scrolling space: an insertion line. */
  overlay?: ReactNode;
  handle?: Ref<ListBoxHandle>;
  className?: string;
}

/**
 * A list in a panel (DESIGN.md §7, "List row"): one row is selected, the
 * arrows move the selection, Return acts on it.
 *
 * Focus stays on the list itself and the selected row is named as its
 * active descendant, so a long list can draw only the rows in view without
 * the keyboard ever losing its place. With keyboard focus the ring is drawn
 * on that row, not around the whole list.
 */
export function ListBox<T>({
  label,
  items,
  getId,
  getLabel,
  rowHeight,
  selected,
  onSelect,
  onActivate,
  onRemove,
  onMove,
  activateOnClick = false,
  current = null,
  renderRow,
  renderOption,
  overlay,
  handle,
  className,
}: ListBoxProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const optionId = (id: number) => `${baseId}-${id}`;

  const virtual = items.length > VIRTUAL_FROM;
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    enabled: virtual,
  });

  useImperativeHandle(
    handle,
    () => ({
      get element() {
        return scrollRef.current;
      },
      indexAt: (clientY: number) => {
        const scroll = scrollRef.current;
        if (!scroll) {
          return items.length;
        }
        const offset = clientY - scroll.getBoundingClientRect().top + scroll.scrollTop;
        return Math.min(items.length, Math.max(0, Math.round(offset / rowHeight)));
      },
    }),
    [items.length, rowHeight],
  );

  const selectedIndex = items.findIndex((item) => getId(item) === selected);

  const reveal = useCallback(
    (index: number) => {
      const scroll = scrollRef.current;
      if (!scroll) {
        return;
      }
      const top = index * rowHeight;
      if (top < scroll.scrollTop) {
        scroll.scrollTop = top;
      } else if (top + rowHeight > scroll.scrollTop + scroll.clientHeight) {
        scroll.scrollTop = top + rowHeight - scroll.clientHeight;
      }
    },
    [rowHeight],
  );

  function selectAt(index: number) {
    const item = items[Math.min(items.length - 1, Math.max(0, index))];
    if (item !== undefined) {
      onSelect(getId(item));
      reveal(items.indexOf(item));
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || items.length === 0) {
      return;
    }
    const chosen = selectedIndex >= 0 ? items[selectedIndex] : undefined;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / rowHeight) - 1);

    if (event.altKey) {
      // ⌥↑ ⌥↓ carry the selected row with them.
      const by = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      const target = selectedIndex + by;
      if (by !== 0 && onMove && chosen !== undefined && target >= 0 && target < items.length) {
        event.preventDefault();
        onMove(chosen, target);
        reveal(target);
      }
      return;
    }

    const moves: Record<string, number> = {
      ArrowDown: selectedIndex < 0 ? 0 : selectedIndex + 1,
      ArrowUp: selectedIndex < 0 ? items.length - 1 : selectedIndex - 1,
      Home: 0,
      End: items.length - 1,
      PageDown: Math.max(0, selectedIndex) + page,
      PageUp: Math.max(0, selectedIndex) - page,
    };
    const move = moves[event.key];
    if (move !== undefined) {
      event.preventDefault();
      selectAt(move);
      return;
    }
    if (chosen === undefined) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onActivate(chosen);
    } else if ((event.key === "Delete" || event.key === "Backspace") && onRemove) {
      event.preventDefault();
      // The selection moves to what takes the removed row's place.
      const next = items[selectedIndex + 1] ?? items[selectedIndex - 1];
      onSelect(next === undefined ? null : getId(next));
      onRemove(chosen);
    }
  }

  function option(item: T, index: number) {
    const id = getId(item);
    const state: RowState = { index, selected: id === selected };
    const props: OptionProps = {
      id: optionId(id),
      role: "option",
      "aria-selected": state.selected,
      ...(getLabel ? { "aria-label": getLabel(item, index) } : {}),
      ...(id === current ? { "aria-current": "true" as const } : {}),
      ...(state.selected ? { "data-ring": "inside" as const } : {}),
      "data-index": index,
      className: cn(
        "absolute inset-x-0 top-0 flex items-center rounded-sm",
        // On the selected fill tertiary ink would fall short of 4.5:1 in the
        // dark theme, so whatever a row draws in it is drawn in secondary ink
        // there (DESIGN.md §7, "List row").
        state.selected ? "bg-accent-soft [--ink-3:var(--ink-2)]" : "hover:bg-surface-3",
      ),
      style: { height: rowHeight, transform: `translateY(${index * rowHeight}px)` },
      onClick: () => {
        if (activateOnClick) {
          // The click has done its work; a fill left behind would say
          // "this one" long after playback had moved on.
          onSelect(null);
          onActivate(item);
        } else {
          onSelect(id);
        }
      },
      onDoubleClick: () => {
        if (!activateOnClick) {
          onActivate(item);
        }
      },
    };
    const content = renderRow(item, state);
    return renderOption ? (
      <Fragment key={id}>{renderOption(item, state, props, content)}</Fragment>
    ) : (
      <div key={id} {...props}>
        {content}
      </div>
    );
  }

  const rows = virtual
    ? virtualizer.getVirtualItems().map((row) => {
        const item = items[row.index];
        return item === undefined ? null : option(item, row.index);
      })
    : items.map(option);

  return (
    <div
      ref={scrollRef}
      role="listbox"
      tabIndex={0}
      aria-label={label}
      aria-activedescendant={
        selectedIndex >= 0 && selected !== null ? optionId(selected) : undefined
      }
      data-own-keys={OWN_KEYS}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        // Arriving by keyboard with nothing selected: start at the current
        // row, or the first, so the arrows have somewhere to move from.
        if (selectedIndex < 0 && focusedFromKeyboard(event.target) && items.length > 0) {
          const start = items.findIndex((item) => getId(item) === current);
          selectAt(Math.max(0, start));
        }
      }}
      className={cn(
        "ring-on-part scrollbar-thin relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-2",
        className,
      )}
    >
      <div className="relative" style={{ height: items.length * rowHeight }}>
        {rows}
        {overlay}
      </div>
    </div>
  );
}
