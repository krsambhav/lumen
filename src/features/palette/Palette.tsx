import { Command } from "cmdk";
import { Link, Search } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useMemo, useState } from "react";
import { allActions, runAction } from "@/actions/registry";
import { Shortcut } from "@/components/ui/shortcut";
import { useRecents } from "@/features/library/recents";
import { goTo, goToChapter, setSpeed } from "@/features/player/actions";
import { useChromeHold } from "@/features/player/chrome";
import { currentPosition, hasMedia, usePlayer } from "@/features/player/store";
import { openSources } from "@/features/playlist/actions";
import { readAddress } from "@/features/playlist/address";
import { useSaved } from "@/features/playlist/saved";
import { useQueue } from "@/features/playlist/store";
import { useInterface } from "@/features/shell/interface";
import { useTorrents } from "@/features/torrents/store";
import { TorrentFinder, TorrentsInPalette, useFirstRow } from "@/features/torrents/TorrentFinder";
import { commands } from "@/ipc";
import { cn } from "@/lib/cn";
import { send } from "@/lib/notify";
import { type PaletteRow, type PaletteRunners, paletteGroups } from "./results";
import { type PaletteMode, usePalette } from "./store";

const FROM_PALETTE = { source: "palette" } as const;

const RUNNERS: PaletteRunners = {
  action: (id) => runAction(id, "palette"),
  goTo: (seconds) => goTo(FROM_PALETTE, seconds),
  speed: (rate) => setSpeed(FROM_PALETTE, rate),
  playItem: (id) => send("play that", commands.playlistPlay(id)),
  chapter: (index) => goToChapter(FROM_PALETTE, index),
  openSaved: (id) => send("open that playlist", commands.playlistsOpen(id)),
  openRecent: (source) => openSources([source]),
  openAddress: (address) => openSources([address]),
  addAddress: (address) => send("add that to the playlist", commands.playlistAdd([address], null)),
};

/** What the palette is called, for each thing it is open for. */
const TITLES: Readonly<Record<PaletteMode, string>> = {
  all: "Command palette",
  time: "Go to time",
  address: "Open address",
  torrents: "Search torrents",
};

const PLACEHOLDERS: Readonly<Record<PaletteMode, string>> = {
  all: "Search actions, the playlist and what was played",
  time: "A time, like 1:23:45, 90m, 25% or +30",
  address: "Paste a link to a video, a page or a stream",
  torrents: "Search for a film, a show or an album",
};

/** What the list says when nothing answers. */
function emptyText(mode: PaletteMode, typed: string): string {
  switch (mode) {
    case "time":
      return typed === ""
        ? "Type where to go: 1:23:45, 90m, 1h20, 25% of the way through, or +30 for a step from here."
        : `“${typed}” is not a time. Try 1:23:45, 90m, 25% or +30.`;
    case "address":
      return typed === ""
        ? "A YouTube or Vimeo page, a link to a video or audio file, or a live stream."
        : `“${typed}” is not an address. Try https://… or a site’s name, like vimeo.com/…`;
    default:
      return `Nothing matches “${typed}”.`;
  }
}

/**
 * The command palette (DESIGN.md §7): every action, and what is at hand to
 * play or go to, found by typing.
 *
 * cmdk supplies the list's keyboard behaviour; the finding and ordering are
 * done here (see results.ts), so a long playlist costs nothing until
 * something is typed.
 */
export function Palette() {
  const open = usePalette((state) => state.open);
  const mode = usePalette((state) => state.mode);
  const hide = usePalette((state) => state.hide);
  const onStage = usePlayer(hasMedia);
  useChromeHold("palette", open);
  // The picture is a native layer under the page: it is blurred natively.
  useEffect(() => {
    if (!open || !onStage) {
      return;
    }
    // A blur that cannot be drawn is not worth a word: the veil still dims.
    const veil = (on: boolean) => commands.windowSetBackdropBlur(on).catch(() => undefined);
    void veil(true);
    return () => void veil(false);
  }, [open, onStage]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          hide();
        }
      }}
    >
      <Dialog.Portal>
        {/*
          Catches a click outside, and veils what is behind: dimmed and
          blurred, so what is typed stands out. A film goes on playing.
        */}
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-palette bg-stage-veil",
            "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
            // The page behind is blurred here; the picture, which is not in the page, natively.
            "[-webkit-backdrop-filter:blur(14px)] [backdrop-filter:blur(14px)]",
          )}
        />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            // Focus goes back only to a control that had the keyboard; see the store.
            event.preventDefault();
            usePalette.getState().returnTo?.focus();
          }}
          className={cn(
            onStage && "stage",
            "fixed inset-x-0 top-[18%] z-palette mx-auto flex flex-col overflow-hidden",
            "w-[min(var(--palette-w),calc(100vw-2*var(--gutter)))]",
            "rounded-lg border border-line bg-surface-2 text-ink-1 shadow-palette outline-none",
            "data-[state=open]:animate-pop-in data-[state=closed]:animate-fade-out",
          )}
        >
          <Dialog.Title className="sr-only">{TITLES[mode]}</Dialog.Title>
          {/* Remounted for each mode, so what was typed for one is not left for the other. */}
          {mode === "torrents" ? <TorrentFinder key={mode} /> : <Finder key={mode} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Finder() {
  const mode = usePalette((state) => state.mode);
  const hide = usePalette((state) => state.hide);
  const [query, setQuery] = useState(() => usePalette.getState().seed);
  const saved = useSaved((state) => state.entries);

  const recentActions = useInterface((state) => state.recentActions);
  const queue = useQueue();
  const chapters = usePlayer((state) => state.chapters);
  const duration = usePlayer((state) => state.duration);
  const media = usePlayer(hasMedia);
  const history = useRecents((state) => state.entries);

  const groups = useMemo(
    () =>
      paletteGroups(
        query,
        mode,
        {
          actions: allActions(),
          recentActions,
          queue,
          chapters,
          duration,
          // Where the film is as this is typed: what a step ("+30") is taken from.
          position: currentPosition(usePlayer.getState()),
          hasMedia: media,
          history,
          saved,
        },
        RUNNERS,
      ),
    [query, mode, recentActions, queue, chapters, duration, media, history, saved],
  );

  function choose(row: PaletteRow) {
    if (row.unavailable !== undefined) {
      return;
    }
    if (row.action) {
      useInterface.getState().noteAction(row.action);
    }
    // Closed first: some actions open something of their own, the palette among them.
    hide();
    row.run();
  }

  const typed = query.trim();
  // Torrents arrive after the rest: the first row is taken again when they do.
  const torrents = useTorrents((state) => state.search.status);
  const rows = useFirstRow(`${typed}|${torrents}`);
  return (
    <Command
      {...rows}
      label={TITLES[mode]}
      shouldFilter={false}
      loop
      className="flex min-h-0 flex-col"
    >
      <div className="flex h-12 flex-none items-center gap-3 border-b border-line px-4">
        {mode === "address" ? (
          <Link aria-hidden="true" className="size-4 flex-none text-ink-3" />
        ) : (
          <Search aria-hidden="true" className="size-4 flex-none text-ink-3" />
        )}
        <Command.Input
          // The palette changing what it is for replaces this field: the keyboard comes with it.
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder={PLACEHOLDERS[mode]}
          // The palette's own edge says where typing goes; a ring inside it would be a second one.
          className="h-full min-w-0 flex-1 bg-transparent text-heading font-medium text-ink-1 outline-none"
        />
      </div>
      <Command.List
        // Eight rows before it scrolls; fewer in a short window, never off its bottom edge.
        className="scrollbar-thin max-h-[min(20rem,calc(82vh-5rem))] overflow-y-auto overscroll-contain p-1"
      >
        <Command.Empty className="px-3 py-5 text-body text-ink-2">
          {emptyText(mode, typed)}
        </Command.Empty>
        {groups.map((group) => (
          <Command.Group
            key={group.heading}
            heading={group.heading}
            className="[&>[cmdk-group-heading]]:label [&>[cmdk-group-heading]]:px-3 [&>[cmdk-group-heading]]:pb-1 [&>[cmdk-group-heading]]:pt-3 [&>[cmdk-group-heading]]:text-ink-3"
          >
            {group.rows.map((row) => (
              <Command.Item
                key={row.key}
                value={row.key}
                disabled={row.unavailable !== undefined}
                onSelect={() => choose(row)}
                className={cn(
                  "flex h-9 cursor-default select-none items-center gap-3 rounded-sm px-3",
                  "data-[selected=true]:bg-surface-3 data-[disabled=true]:opacity-45",
                )}
              >
                <span
                  aria-hidden="true"
                  className="flex size-4 flex-none items-center justify-center text-ink-2"
                >
                  {row.icon ? <row.icon className="size-4" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                {row.unavailable !== undefined ? (
                  <span className="max-w-[50%] flex-none truncate text-caption text-ink-3">
                    {row.unavailable}
                  </span>
                ) : row.shortcut ? (
                  <Shortcut chord={row.shortcut} className="flex-none text-caption text-ink-3" />
                ) : row.detail ? (
                  <span className="tabular flex-none text-caption text-ink-3">{row.detail}</span>
                ) : null}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
        {/* What was typed may be something to watch: torrents follow everything else found. */}
        {mode === "all" && readAddress(typed) === null ? <TorrentsInPalette query={query} /> : null}
      </Command.List>
    </Command>
  );
}
