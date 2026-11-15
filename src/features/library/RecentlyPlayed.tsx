import { Pin, PinOff, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { runAction } from "@/actions/registry";
import { Button } from "@/components/ui/button";
import { ContextMenuArea, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { Tooltip } from "@/components/ui/tooltip";
import { nameOf } from "@/features/shell/failure";
import { commands, type Recent } from "@/ipc";
import { cn } from "@/lib/cn";
import { notifyFailure, send, undoable } from "@/lib/notify";
import { shortDuration } from "@/lib/timecode";
import { PlaylistPeek } from "./PlaylistPeek";
import { pinRecent, playRecent, useRecents } from "./recents";
import { readTitle } from "./title";

/** A tile is never narrower than this (DESIGN.md §7, "Home, with history"). */
const TILE_MIN_PX = 168;
const GAP_PX = 16;
const ROWS = 2;
/** A wider window gets larger tiles, not more of them. */
const MOST_COLUMNS = 6;
/** Shown before the grid has been measured, and where it cannot be (tests). */
const UNMEASURED_COLUMNS = 5;

/** Where it stood in the playlist it was played in: "3 of 8", or `null` if it was played alone. */
export function placeInPlaylist(entry: Recent): string | null {
  const items = entry.playlist?.items ?? [];
  const at = items.findIndex((item) => item.source === entry.source);
  return items.length > 1 && at >= 0 ? `${at + 1} of ${items.length}` : null;
}

/** Forgets that something was played, with a toast that can undo it. */
export function forgetRecent(entry: Recent): void {
  // Gone from the screen at once. The backend says when the history has
  // changed, and it is read again then.
  useRecents.setState((state) => ({
    entries: state.entries.filter((other) => other.source !== entry.source),
  }));
  void commands.historyForget(entry.source).then((result) => {
    if (result.status === "error") {
      notifyFailure("remove that from recently played", result.error);
      void useRecents.getState().load();
      return;
    }
    undoable("Removed from recently played", {
      id: "recent-removed",
      name: entry.title,
      undo: () => {
        const { available: _available, poster: _poster, resumesAt: _resumesAt, ...plain } = entry;
        send("put that back", commands.historyRestore(plain));
      },
    });
  });
}

/**
 * How far through it was left, from 0 to 1, or `null` if opening it will
 * start from the beginning. The backend says which: it is the one that opens it.
 */
function progress(entry: Recent): number | null {
  if (entry.resumesAt === null || entry.duration === null || entry.duration <= 0) {
    return null;
  }
  return Math.min(1, entry.position / entry.duration);
}

/** The line under the title: what is left, or how long it is, or that it has gone. */
function about(entry: Recent): string {
  if (!entry.available) {
    return "Not found";
  }
  if (entry.duration === null) {
    return "Length unknown";
  }
  return progress(entry) === null
    ? shortDuration(entry.duration)
    : `${shortDuration(entry.duration - entry.position)} left`;
}

/**
 * A small stage control on a tile's thumbnail, beside the playlist chip's
 * kind: `stage-veil` behind `stage-ink`, 24 px square.
 */
function ThumbButton({
  label,
  onClick,
  pressed,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        className={cn(
          "group/pin stage grid size-6 flex-none place-items-center rounded-sm bg-stage-veil text-stage-ink",
          "transition-[background-color,opacity] duration-fast ease-out hover:bg-stage-press",
          "outline-none focus-visible:ring-2 focus-visible:ring-accent",
          "[&_svg]:pointer-events-none [&_svg]:size-3.5",
          className,
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function Tile({ entry }: { entry: Recent }) {
  const pinned = entry.pinned === true;
  const through = progress(entry);
  const { name, episode } = readTitle(entry.title);
  const place = placeInPlaylist(entry);
  const local = !entry.source.includes("://");
  const [listOpen, setListOpen] = useState(false);
  return (
    // The cell holds the tile and, for a playlist, the chip that lists it:
    // a control of its own, since a button cannot hold another.
    <div data-tile="" data-pinned={pinned || undefined} className="group/cell relative min-w-0">
      <ContextMenuArea
        menu={
          entry.available ? (
            <>
              <MenuItem onSelect={() => playRecent(entry.source)}>
                {through === null ? "Play" : "Resume"}
              </MenuItem>
              {through === null ? null : (
                <MenuItem onSelect={() => playRecent(entry.source, false)}>
                  Play from the beginning
                </MenuItem>
              )}
              {place ? <MenuItem onSelect={() => setListOpen(true)}>Show playlist</MenuItem> : null}
              {local ? (
                <MenuItem
                  onSelect={() =>
                    send("show that in the Finder", commands.filesShowInFinder(entry.source))
                  }
                >
                  Show in Finder
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem onSelect={() => pinRecent(entry.source, !pinned)}>
                {pinned ? "Unpin" : "Pin to recently played"}
              </MenuItem>
              <MenuItem onSelect={() => forgetRecent(entry)}>Remove from recently played</MenuItem>
            </>
          ) : (
            // The file has gone: there is nothing to play or to show, only these.
            <>
              {pinned ? (
                <MenuItem onSelect={() => pinRecent(entry.source, false)}>Unpin</MenuItem>
              ) : null}
              <MenuItem onSelect={() => forgetRecent(entry)}>Remove from recently played</MenuItem>
            </>
          )
        }
      >
        <button
          type="button"
          onClick={() => playRecent(entry.source)}
          onKeyDown={(event) => {
            if (event.key === "Delete" || event.key === "Backspace") {
              event.preventDefault();
              // The keyboard goes to its neighbour, or with no tile left to the way to open something.
              const cell = event.currentTarget.closest("[data-tile]");
              const next =
                cell?.nextElementSibling?.querySelector("button") ??
                cell?.previousElementSibling?.querySelector("button") ??
                cell?.closest("main")?.querySelector("button");
              forgetRecent(entry);
              if (next instanceof HTMLElement) {
                next.focus();
              }
            }
          }}
          // The ring goes on the thumbnail: around the whole tile it would run through the caption.
          className="ring-on-part group/tile flex w-full min-w-0 flex-col gap-2 rounded-md text-left"
        >
          {/* The thumbnail is a small stage: dark in either theme, with the stage's lines. */}
          <span
            data-ring=""
            className={cn(
              "stage relative block aspect-video w-full overflow-hidden rounded-md bg-surface-2",
              !entry.available && "opacity-45",
            )}
          >
            {entry.poster ? (
              <img
                src={entry.poster}
                alt=""
                draggable={false}
                className="absolute inset-0 size-full object-cover"
              />
            ) : (
              // No picture (sound only, or a stream), or its frame is not there yet:
              // a title card, set like the stage's own words, rather than an empty box.
              <span
                aria-hidden="true"
                data-title-card=""
                className="absolute inset-0 flex flex-col justify-end gap-0.5 p-3"
              >
                {episode ? (
                  <span className="label tabular truncate text-stage-ink-2">{episode}</span>
                ) : null}
                <span className="line-clamp-2 break-words text-heading text-stage-ink">{name}</span>
              </span>
            )}
            {/* A hairline edge, so a dark frame still has a shape on a dark window. */}
            <span className="absolute inset-0 rounded-md shadow-[inset_0_0_0_1px_var(--line)] transition-shadow duration-fast ease-out group-hover/tile:shadow-[inset_0_0_0_1px_var(--line-strong)]" />
            {through === null ? null : (
              // Where it was left, drawn like the timeline: ivory played, the needle at its end.
              <span
                data-progress=""
                // Inset by the corner's radius: along the straight part of the edge, so the needle is whole at both ends.
                className="absolute inset-x-2.5 bottom-0 h-0.5 bg-stage-track shadow-[0_0_0_1px_var(--stage-edge)]"
              >
                <span
                  className="absolute inset-y-0 left-0 bg-stage-ink"
                  style={{ width: `${through * 100}%` }}
                />
                <span
                  className="needle absolute bottom-0 h-1.5 w-0.5 -translate-x-1/2 rounded-xs"
                  style={{ left: `${through * 100}%` }}
                />
              </span>
            )}
          </span>
          <span className="flex min-w-0 flex-col">
            <MiddleTruncate
              text={name}
              full={nameOf(entry.source)}
              className={cn("font-medium", entry.available ? "text-ink-1" : "text-ink-2")}
            />
            {/* Keeps its line even when there is nothing to say, so titles in a row share a baseline. */}
            {/* Played in a playlist: opening it brings the playlist back, so it says where in it. */}
            <span className="tabular min-h-4 truncate text-caption text-ink-2">
              {[episode, place, about(entry)].filter(Boolean).join(" · ")}
            </span>
          </span>
        </button>
      </ContextMenuArea>
      {/*
        Pin and remove, at the thumbnail's top left (the playlist chip has its
        right): shown while the pointer is on the tile or the keyboard is in
        it. A pinned tile keeps its pin in sight, so it reads as pinned.
      */}
      <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1">
        <ThumbButton
          label={pinned ? "Unpin" : "Pin to recently played"}
          pressed={pinned}
          onClick={() => pinRecent(entry.source, !pinned)}
          className={cn(
            "pointer-events-auto",
            !pinned &&
              "opacity-0 focus-visible:opacity-100 group-hover/cell:opacity-100 group-focus-within/cell:opacity-100",
          )}
        >
          {pinned ? (
            <>
              {/* Filled while pinned; under the pointer it shows what a press would do. */}
              <Pin aria-hidden="true" className="fill-current group-hover/pin:hidden" />
              <PinOff aria-hidden="true" className="hidden group-hover/pin:block" />
            </>
          ) : (
            <Pin aria-hidden="true" />
          )}
        </ThumbButton>
        <ThumbButton
          label="Remove from recently played"
          onClick={() => forgetRecent(entry)}
          className="pointer-events-auto opacity-0 focus-visible:opacity-100 group-hover/cell:opacity-100 group-focus-within/cell:opacity-100"
        >
          <X aria-hidden="true" />
        </ThumbButton>
      </div>
      {entry.available ? (
        <PlaylistPeek
          entry={entry}
          left={about(entry)}
          open={listOpen}
          onOpenChange={setListOpen}
        />
      ) : null}
    </div>
  );
}

/**
 * What was played recently, newest first, as tiles filling the window's
 * width, two rows at most (DESIGN.md §7, "Home, with history").
 */
export function RecentlyPlayed({ className }: { className?: string }) {
  const entries = useRecents((state) => state.entries);
  // Clear leaves what is pinned; with nothing else there, it would do nothing.
  const clearBlocked =
    entries.length > 0 && entries.every((entry) => entry.pinned)
      ? "Everything left is pinned"
      : undefined;
  const heading = useId();
  const grid = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(UNMEASURED_COLUMNS);

  useEffect(() => {
    const element = grid.current;
    if (!element) {
      return;
    }
    const measure = () => {
      const width = element.clientWidth;
      if (width > 0) {
        const fit = Math.floor((width + GAP_PX) / (TILE_MIN_PX + GAP_PX));
        setColumns(Math.min(MOST_COLUMNS, Math.max(1, fit)));
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (entries.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby={heading} className={cn("flex flex-col gap-3", className)}>
      {/*
        The heading keeps its own height: Clear's box overhangs it, and its
        word ends at the grid's edge. A hairline runs between the two, so
        Clear belongs to its line however wide the window is.
      */}
      <div className="flex items-center gap-3">
        <h3 id={heading} className="label flex-none whitespace-nowrap text-ink-3">
          Recently played
        </h3>
        <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-line" />
        <Tooltip label="Clear recently played" detail={clearBlocked} disabled={!clearBlocked}>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "-mx-3 -my-1.5 flex-none whitespace-nowrap px-3 text-ink-2",
              clearBlocked && "cursor-default opacity-45 hover:bg-transparent hover:text-ink-2",
            )}
            aria-label="Clear recently played"
            aria-disabled={clearBlocked ? true : undefined}
            onClick={() => {
              if (!clearBlocked) {
                runAction("history.clear", "control");
              }
            }}
          >
            Clear
          </Button>
        </Tooltip>
      </div>
      <div
        ref={grid}
        className="grid gap-x-4 gap-y-6"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {entries.slice(0, columns * ROWS).map((entry) => (
          <Tile key={entry.source} entry={entry} />
        ))}
      </div>
    </section>
  );
}
