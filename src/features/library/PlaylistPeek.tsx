import { ListVideo } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import type { Recent } from "@/ipc";
import { cn } from "@/lib/cn";
import { shortDuration } from "@/lib/timecode";
import { playRecent } from "./recents";
import { readEpisodeTitle, readTitle } from "./title";

interface PlaylistPeekProps {
  /** What was played last in the playlist; the tile stands for it. */
  entry: Recent;
  /** What is left of it, as the tile's own line says. */
  left: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The list's width, `w-80`. */
const LIST_WIDTH = 320;

/** Moves the keyboard between the rows with the arrows, Home and End. */
function stepRows(event: KeyboardEvent<HTMLElement>) {
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-row]"));
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const to =
    event.key === "ArrowDown"
      ? Math.min(rows.length - 1, at + 1)
      : event.key === "ArrowUp"
        ? Math.max(0, at - 1)
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? rows.length - 1
            : null;
  if (to !== null) {
    event.preventDefault();
    rows[to]?.focus();
  }
}

/**
 * The playlist a recent tile stands for, without playing anything
 * (DESIGN.md §7, "Home, with history"): a chip on the thumbnail opens its
 * list, the item played last marked with the needle, and choosing any
 * item brings the whole playlist back and plays from there.
 */
export function PlaylistPeek({ entry, left, open, onOpenChange }: PlaylistPeekProps) {
  const items = entry.playlist?.items ?? [];
  const last = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  if (items.length < 2) {
    return null;
  }
  // Beside the tile where the window has room for the list (20rem and its
  // 8 px gap and margin), else under or over it: Radix flips a side that
  // does not fit to its opposite, never to another axis.
  const room = trigger.current
    ? window.innerWidth - trigger.current.getBoundingClientRect().right
    : Number.POSITIVE_INFINITY;
  const side = room >= LIST_WIDTH + 16 ? "right" : "bottom";
  const title = entry.playlist?.name ?? readTitle(entry.title).name;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip label="Show playlist">
        <PopoverTrigger asChild>
          <button
            ref={trigger}
            type="button"
            aria-label={`Show playlist, ${items.length} items`}
            className={cn(
              // On the thumbnail, a small stage control: it reads over any frame.
              "stage absolute right-2 top-2 flex h-6 items-center gap-1 rounded-sm bg-stage-veil px-1.5",
              "text-caption tabular text-stage-ink transition-colors duration-fast ease-out hover:bg-stage-press",
              "outline-none focus-visible:ring-2 focus-visible:ring-accent",
            )}
          >
            <ListVideo aria-hidden="true" className="size-3.5 flex-none" />
            {items.length}
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        label={`Playlist: ${title}`}
        // Beside the tile, from its top: it covers no other tile's picture.
        side={side}
        align={side === "right" ? "start" : "end"}
        className="w-80 p-1"
        // The keyboard starts where the playlist was left.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          last.current?.focus();
        }}
      >
        <div className="flex items-baseline justify-between gap-3 px-2 pb-1 pt-1.5">
          <h4 className="min-w-0 truncate text-body font-medium text-ink-1">{title}</h4>
          <span className="tabular flex-none text-caption text-ink-2">{items.length} items</span>
        </div>
        <ol className="flex flex-col gap-px" onKeyDown={stepRows}>
          {items.map((item, index) => {
            const isLast = item.source === entry.source;
            // The show is named above: a row is its episode and that episode's own name.
            const read = readEpisodeTitle(item.title);
            return (
              <li key={item.source}>
                <button
                  ref={isLast ? last : undefined}
                  type="button"
                  data-row=""
                  aria-current={isLast ? "true" : undefined}
                  onClick={() => {
                    onOpenChange(false);
                    playRecent(entry.source, true, item.source);
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-sm px-2 text-left outline-none",
                    "transition-colors duration-fast ease-out hover:bg-surface-3 focus-visible:bg-surface-3",
                    "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
                    isLast ? "min-h-11 py-1.5" : "h-9",
                  )}
                >
                  {/* Its place, or for the one played last the needle: where the playlist was left. */}
                  <span className="tabular flex w-5 flex-none justify-end text-caption text-ink-3">
                    {isLast ? (
                      <span aria-hidden="true" className="needle mr-1.5 h-3.5 w-0.5 rounded-xs" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  {read ? (
                    <span className="tabular w-10 flex-none whitespace-nowrap text-caption text-ink-2">
                      {read.episode}
                    </span>
                  ) : null}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span
                      className={cn(
                        "truncate text-body",
                        isLast ? "font-medium text-ink-1" : "text-ink-1",
                      )}
                    >
                      {read ? read.name || `Episode ${read.episode.split("E")[1]}` : item.title}
                    </span>
                    {isLast ? (
                      <span className="tabular truncate text-caption text-ink-2">
                        Last played · {left}
                      </span>
                    ) : null}
                  </span>
                  {item.duration !== null && !isLast ? (
                    <span className="tabular flex-none text-caption text-ink-2">
                      {shortDuration(item.duration)}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>
      </PopoverContent>
    </Popover>
  );
}
