import { useEffect, useId, useRef, useState } from "react";
import { runAction } from "@/actions/registry";
import { Button } from "@/components/ui/button";
import { ContextMenuArea, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { openSources } from "@/features/playlist/actions";
import { nameOf } from "@/features/shell/failure";
import { commands, type Recent } from "@/ipc";
import { cn } from "@/lib/cn";
import { notifyFailure, send, undoable } from "@/lib/notify";
import { shortDuration } from "@/lib/timecode";
import { useRecents } from "./recents";
import { readTitle } from "./title";

/** A tile is never narrower than this (DESIGN.md §7, "Home, with history"). */
const TILE_MIN_PX = 168;
const GAP_PX = 16;
const ROWS = 2;
/** A wider window gets larger tiles, not more of them. */
const MOST_COLUMNS = 6;
/** Shown before the grid has been measured, and where it cannot be (tests). */
const UNMEASURED_COLUMNS = 5;

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

function Tile({ entry }: { entry: Recent }) {
  const through = progress(entry);
  const { name, episode } = readTitle(entry.title);
  const local = !entry.source.includes("://");
  return (
    <ContextMenuArea
      menu={
        entry.available ? (
          <>
            <MenuItem onSelect={() => openSources([entry.source])}>
              {through === null ? "Play" : "Resume"}
            </MenuItem>
            {through === null ? null : (
              <MenuItem onSelect={() => openSources([entry.source], false)}>
                Play from the beginning
              </MenuItem>
            )}
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
            <MenuItem onSelect={() => forgetRecent(entry)}>Remove from recently played</MenuItem>
          </>
        ) : (
          // The file has gone: there is nothing to play or to show, only this.
          <MenuItem onSelect={() => forgetRecent(entry)}>Remove from recently played</MenuItem>
        )
      }
    >
      <button
        type="button"
        onClick={() => openSources([entry.source])}
        onKeyDown={(event) => {
          if (event.key === "Delete" || event.key === "Backspace") {
            event.preventDefault();
            // The keyboard goes to its neighbour, or with no tile left to the way to open something.
            const tile = event.currentTarget;
            const next =
              tile.nextElementSibling ??
              tile.previousElementSibling ??
              tile.closest("main")?.querySelector("button");
            forgetRecent(entry);
            if (next instanceof HTMLElement) {
              next.focus();
            }
          }
        }}
        // The ring goes on the thumbnail: around the whole tile it would run through the caption.
        className="ring-on-part group/tile flex min-w-0 flex-col gap-2 rounded-md text-left"
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
          <span className="tabular min-h-4 truncate text-caption text-ink-2">
            {episode ? `${episode} · ${about(entry)}` : about(entry)}
          </span>
        </span>
      </button>
    </ContextMenuArea>
  );
}

/**
 * What was played recently, newest first, as tiles filling the window's
 * width, two rows at most (DESIGN.md §7, "Home, with history").
 */
export function RecentlyPlayed({ className }: { className?: string }) {
  const entries = useRecents((state) => state.entries);
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
        <Button
          variant="ghost"
          size="sm"
          className="-mx-3 -my-1.5 flex-none whitespace-nowrap px-3 text-ink-2"
          aria-label="Clear recently played"
          onClick={() => runAction("history.clear", "control")}
        >
          Clear
        </Button>
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
