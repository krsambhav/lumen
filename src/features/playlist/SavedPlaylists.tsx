import { ListMusic } from "lucide-react";
import { type KeyboardEvent, useId } from "react";
import { ContextMenuArea, MenuItem, MenuSeparator } from "@/components/ui/menu";
import type { SavedPlaylist } from "@/ipc";
import { cn } from "@/lib/cn";
import { shortDuration } from "@/lib/timecode";
import { countOf, deleteSaved, openSaved, useSaved } from "./saved";

/** As many as the home screen lists; the rest are in File ▸ Open Playlist and the palette. */
const SHOWN = 12;

function about(playlist: SavedPlaylist): string {
  const items = countOf(playlist.count);
  return playlist.duration === null || playlist.duration <= 0
    ? items
    : `${items} · ${shortDuration(playlist.duration)}`;
}

/** After one is deleted the keyboard goes to its neighbour, so Delete can be pressed again. */
function deleteAndMoveOn(event: KeyboardEvent<HTMLButtonElement>, playlist: SavedPlaylist) {
  event.preventDefault();
  const row = event.currentTarget;
  const neighbour = row.nextElementSibling ?? row.previousElementSibling;
  deleteSaved(playlist);
  if (neighbour instanceof HTMLElement) {
    neighbour.focus();
  }
}

function Row({ playlist }: { playlist: SavedPlaylist }) {
  return (
    <ContextMenuArea
      menu={
        <>
          <MenuItem onSelect={() => openSaved(playlist)}>Open</MenuItem>
          <MenuSeparator />
          <MenuItem danger onSelect={() => deleteSaved(playlist)}>
            Delete playlist
          </MenuItem>
        </>
      }
    >
      <button
        type="button"
        onClick={() => openSaved(playlist)}
        onKeyDown={(event) => {
          if (event.key === "Delete" || event.key === "Backspace") {
            deleteAndMoveOn(event, playlist);
          }
        }}
        // The fill reaches 8 px past the words on each side; the words keep the page's left edge.
        className="-mx-2 flex h-11 min-w-0 items-center gap-3 rounded-sm px-2 text-left transition-colors duration-fast ease-out hover:bg-surface-3 active:bg-surface-4"
      >
        <ListMusic aria-hidden="true" className="size-4 flex-none text-ink-2" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-ink-1">{playlist.name}</span>
          <span className="tabular truncate text-caption text-ink-2">{about(playlist)}</span>
        </span>
      </button>
    </ContextMenuArea>
  );
}

/**
 * The saved playlists, on the home screen (DESIGN.md §7, "Home, with
 * history"): names with how much is in each, no thumbnails. A click opens
 * one; its menu, or Delete, deletes it, with Undo.
 */
export function SavedPlaylists({ className }: { className?: string }) {
  const entries = useSaved((state) => state.entries);
  const heading = useId();
  if (entries.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby={heading} className={cn("flex flex-col gap-2", className)}>
      <h3 id={heading} className="label text-ink-3">
        Playlists
      </h3>
      {/* As many columns as fit at 14rem or more each; the rows are 44 px with 4 between. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-x-6 gap-y-1">
        {entries.slice(0, SHOWN).map((playlist) => (
          <Row key={playlist.id} playlist={playlist} />
        ))}
      </div>
    </section>
  );
}
