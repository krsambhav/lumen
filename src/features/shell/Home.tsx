import { CircleAlert, HatGlasses, Search } from "lucide-react";
import { useId, useState } from "react";
import { runAction, shortcutFor } from "@/actions/registry";
import { Button } from "@/components/ui/button";
import { Shortcut } from "@/components/ui/shortcut";
import { RecentlyPlayed } from "@/features/library/RecentlyPlayed";
import { useRecents } from "@/features/library/recents";
import { usePalette } from "@/features/palette/store";
import { ActionButton } from "@/features/player/ActionButton";
import { openSources } from "@/features/playlist/actions";
import { readAddress } from "@/features/playlist/address";
import { SavedPlaylists } from "@/features/playlist/SavedPlaylists";
import { useSaved } from "@/features/playlist/saved";
import { useSettings } from "@/features/settings/store";
import { commands, type FailureReason } from "@/ipc";
import { cn } from "@/lib/cn";
import { send } from "@/lib/notify";
import { describeFailure } from "./failure";
import { Ruler } from "./Mark";

interface HomeProps {
  /** Files are being dragged over the window. */
  dropping: boolean;
  /** The last thing that would not open, until something else is tried. */
  failure?: { source: string; reason: FailureReason; reveal: string | null } | null;
}

/**
 * What the window shows when nothing is open: the instrument at rest
 * (DESIGN.md §7, "Empty state"). A scale across the window, and under its
 * start what to do next. The whole window takes a dropped file.
 *
 * Once something has been played, what was played follows under the lead
 * ("Home, with history"), and the lead moves up to make room for it.
 *
 * Everything starts at the gutter, under the traffic lights: one left edge.
 * The lead is one column (`lead`, 34rem) whose right edge the scale and the
 * find field share.
 */
export function Home({ dropping, failure = null }: HomeProps) {
  const openShortcut = shortcutFor("file.open");
  const reveal = failure?.reveal ?? null;
  const played = useRecents((state) => state.entries.length > 0);
  const kept = useSaved((state) => state.entries.length > 0);
  const incognito = useSettings((state) => state.settings.general.incognito);
  // Something to come back to: what was played, or a playlist that was saved.
  const history = played || kept;
  return (
    <main
      className={cn(
        "flex min-h-0 flex-1 flex-col px-gutter",
        history
          ? "scrollbar-thin overflow-y-auto pb-8 pt-6"
          : // A little above the middle: the bottom padding is a tenth of the height more than the title bar's.
            "pb-[calc(10vh+var(--titlebar-h))]",
      )}
    >
      {/*
        One column, one width: the scale, the headline and the controls share
        both edges, so the lead reads as a single instrument. Centred by its
        own auto margins rather than by the column: in a window too short for
        it, it then starts at the top, under the title bar.
      */}
      <div
        className={cn(
          "flex w-full max-w-lead flex-none animate-fade-in flex-col items-start",
          !history && "my-auto",
        )}
      >
        <Ruler />
        <h2 className="mt-6 text-display text-ink-1">
          {dropping ? "Release to play" : "Drop a file to play"}
        </h2>
        {/* While a file is held over the window only the headline speaks; the rest keeps its place. */}
        <div className={cn("flex w-full flex-col items-start", dropping && "invisible")}>
          {failure ? (
            <p
              role="alert"
              className="mt-2 flex max-w-[68ch] items-start gap-2 text-body text-ink-1"
            >
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 flex-none text-danger" />
              <span className="min-w-0 break-words">
                {describeFailure(failure.source, failure.reason)}
              </span>
            </p>
          ) : history ? null : (
            // Someone who has played a film knows what Lumen plays.
            <p className="mt-2 max-w-[68ch] text-body text-ink-2">
              Lumen plays MKV, MP4, MOV, WebM, AVI, FLAC, MP3 and most other video and audio files,
              and video from the web.
            </p>
          )}
          {/*
            The ways to start, on one line and at one height: the file, then
            (after a failure) its folder, then the field that finds a film or
            takes a link. The field wraps under them before it gets too short
            to read.
          */}
          <div className="mt-6 flex w-full flex-wrap items-center gap-3">
            <Button
              variant="primary"
              className="h-9"
              aria-keyshortcuts={openShortcut ? ariaChord(openShortcut) : undefined}
              onClick={() => runAction("file.open", "control")}
            >
              Open file…
              {/* Drawn, not read: the button is named by its action, and `aria-keyshortcuts` gives its keys. */}
              {openShortcut ? (
                <span aria-hidden="true" className="inline-flex">
                  <Shortcut chord={openShortcut} className="text-caption opacity-60" />
                </span>
              ) : null}
            </Button>
            {reveal ? (
              <Button
                variant="ghost"
                className="h-9"
                onClick={() => send("show that in the Finder", commands.filesShowInFinder(reveal))}
              >
                Show in Finder
              </Button>
            ) : null}
            <FindField />
            {/* At the field's height, so the row keeps one line of controls. */}
            <ActionButton action="history.incognito" pressed={incognito} className="size-9">
              <HatGlasses aria-hidden="true" />
            </ActionButton>
          </div>
          {incognito ? (
            <p
              data-incognito=""
              className="mt-3 flex max-w-[68ch] items-center gap-2 text-caption text-ink-2"
            >
              <HatGlasses aria-hidden="true" className="size-3.5 flex-none text-ink-3" />
              <span className="min-w-0">
                Incognito: nothing you play or search for now is remembered.
              </span>
            </p>
          ) : null}
        </div>
      </div>
      {played ? (
        <RecentlyPlayed className={cn("mt-12 flex-none", dropping && "invisible")} />
      ) : null}
      {kept ? (
        <SavedPlaylists
          className={cn("flex-none", played ? "mt-8" : "mt-12", dropping && "invisible")}
        />
      ) : null}
    </main>
  );
}

/** "Cmd+o" as `aria-keyshortcuts` writes it: "Meta+O". */
function ariaChord(chord: string): string {
  return chord
    .split("+")
    .map((part) => (part === "Cmd" ? "Meta" : part.length === 1 ? part.toUpperCase() : part))
    .join("+");
}

/**
 * The other way to start: find a film or a show among torrents, or play a
 * link. Return on an address plays it, as pasting one anywhere does;
 * anything else opens the palette on the torrent search, where the keyboard
 * carries on.
 */
function FindField() {
  const [query, setQuery] = useState("");
  const shortcut = shortcutFor("file.searchTorrents");
  const id = useId();
  return (
    <search className="block min-w-0 flex-1 basis-64">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const typed = query.trim();
          const address = readAddress(typed);
          if (address !== null) {
            openSources([address]);
          } else {
            usePalette.getState().show("torrents", typed);
          }
          setQuery("");
        }}
      >
        <label htmlFor={id} className="sr-only">
          Search torrents, or play a link
        </label>
        <div
          className={cn(
            "flex h-9 items-center gap-2 rounded-sm border border-line-strong bg-surface-1 pl-3 pr-2.5",
            "transition-colors duration-fast ease-out hover:border-ink-3 focus-within:border-accent hover:focus-within:border-accent",
          )}
        >
          <Search aria-hidden="true" className="size-4 flex-none text-ink-3" />
          <input
            id={id}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.currentTarget.blur();
              }
            }}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Find a film or a show, or paste a link"
            className="h-full min-w-0 flex-1 truncate bg-transparent text-body text-ink-1 outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {shortcut ? (
            <Shortcut chord={shortcut} className="flex-none text-caption text-ink-3" />
          ) : null}
        </div>
      </form>
    </search>
  );
}
