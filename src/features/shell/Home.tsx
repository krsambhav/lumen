import { CircleAlert, Magnet } from "lucide-react";
import { useId, useState } from "react";
import { runAction, shortcutFor } from "@/actions/registry";
import { Button } from "@/components/ui/button";
import { Shortcut } from "@/components/ui/shortcut";
import { RecentlyPlayed } from "@/features/library/RecentlyPlayed";
import { useRecents } from "@/features/library/recents";
import { usePalette } from "@/features/palette/store";
import { SavedPlaylists } from "@/features/playlist/SavedPlaylists";
import { useSaved } from "@/features/playlist/saved";
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
 */
export function Home({ dropping, failure = null }: HomeProps) {
  const openShortcut = shortcutFor("file.open");
  const addressShortcut = shortcutFor("file.openAddress");
  const reveal = failure?.reveal ?? null;
  const played = useRecents((state) => state.entries.length > 0);
  const kept = useSaved((state) => state.entries.length > 0);
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
        Centred by its own auto margins rather than by the column: in a
        window too short for it, it then starts at the top, under the title
        bar, instead of being pushed up beneath it.
      */}
      <div
        className={cn("flex flex-none animate-fade-in flex-col items-start", !history && "my-auto")}
      >
        <Ruler />
        <h2 className="mt-8 text-display text-ink-1">
          {dropping ? "Release to play" : "Drop a file to play"}
        </h2>
        {/* While a file is held over the window only the headline speaks; the rest keeps its place. */}
        <div className={cn("flex flex-col items-start", dropping && "invisible")}>
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
          <div className="mt-6 flex items-center gap-3">
            <Button variant="primary" onClick={() => runAction("file.open", "control")}>
              Open file…
            </Button>
            {openShortcut ? (
              <Shortcut chord={openShortcut} variant="keycap" className="text-caption text-ink-2" />
            ) : null}
            <Button
              variant="secondary"
              className="ml-3"
              onClick={() => runAction("file.openAddress", "control")}
            >
              Open address…
            </Button>
            {addressShortcut ? (
              <Shortcut
                chord={addressShortcut}
                variant="keycap"
                className="text-caption text-ink-2"
              />
            ) : null}
            {reveal ? (
              <Button
                variant="ghost"
                onClick={() => send("show that in the Finder", commands.filesShowInFinder(reveal))}
              >
                Show in Finder
              </Button>
            ) : null}
          </div>
          <TorrentSearchField />
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

/**
 * A third way to find something to play, beside the two ways to open one:
 * a search of torrents. Return opens the palette on the results, where the
 * keyboard carries on.
 */
function TorrentSearchField() {
  const [query, setQuery] = useState("");
  const shortcut = shortcutFor("file.searchTorrents");
  const id = useId();
  return (
    <search className="mt-6 block w-[min(26rem,100%)]">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const typed = query.trim();
          usePalette.getState().show("torrents", typed);
          setQuery("");
        }}
      >
        <label htmlFor={id} className="sr-only">
          Search torrents
        </label>
        <div
          className={cn(
            "flex h-8 items-center gap-2 rounded-sm border border-line-strong bg-surface-1 pl-2.5 pr-2",
            "focus-within:border-accent",
          )}
        >
          <Magnet aria-hidden="true" className="size-4 flex-none text-ink-3" />
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
            placeholder="Search torrents for a film or a show"
            className="h-full min-w-0 flex-1 bg-transparent text-body text-ink-1 outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {shortcut ? (
            <Shortcut
              chord={shortcut}
              variant="keycap"
              className="flex-none text-caption text-ink-3"
            />
          ) : null}
        </div>
      </form>
    </search>
  );
}
