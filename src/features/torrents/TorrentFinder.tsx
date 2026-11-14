import { Command } from "cmdk";
import {
  ArrowDownToLine,
  ArrowLeft,
  ChevronsRight,
  CircleAlert,
  Eraser,
  History,
  Magnet,
  Search,
  SkipForward,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PlayGlyph } from "@/components/ui/glyphs";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { Shortcut } from "@/components/ui/shortcut";
import { usePalette } from "@/features/palette/store";
import { hasMedia, usePlayer } from "@/features/player/store";
import type { TorrentFile, TorrentResult } from "@/ipc";
import { cn } from "@/lib/cn";
import { describeState, formatBytes, formatSeeds, formatSpeed } from "./format";
import { nextEpisodeSearch, nextSeasonSearch } from "./nextEpisode";
import { type Fetching, type Intent, playableFiles, useTorrents } from "./store";

/** How many recent searches the command palette shows before anything is typed. */
const RECENT_IN_PALETTE = 3;
/** The command palette offers a torrent search from this many characters: below it, typing is for actions. */
const PALETTE_MIN_CHARS = 3;

const ROW = cn(
  "flex h-9 cursor-default select-none items-center gap-3 rounded-sm px-3",
  "data-[selected=true]:bg-surface-3 data-[disabled=true]:opacity-45",
);
const GROUP =
  "[&>[cmdk-group-heading]]:label [&>[cmdk-group-heading]]:px-3 [&>[cmdk-group-heading]]:pb-1 [&>[cmdk-group-heading]]:pt-3 [&>[cmdk-group-heading]]:text-ink-3";

/**
 * The row in hand, for a cmdk list whose rows arrive later than what was
 * typed: each time `signature` changes (new results, a new view) the first
 * row is taken, so Return chooses the best answer and not whatever row was
 * in hand before the others came above it.
 */
export function useFirstRow(signature: string) {
  const root = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature is what changes the rows
  useLayoutEffect(() => {
    const first = root.current?.querySelector("[cmdk-item]:not([data-disabled=true])");
    setValue(first?.getAttribute("data-value") ?? "");
    const list = root.current?.querySelector("[cmdk-list]");
    if (list) {
      list.scrollTop = 0;
    }
  }, [signature]);
  return { ref: root, value, onValueChange: setValue };
}

/** One result: a mark for whether it plays at once, its name, its size and how widely it is shared. */
function ResultItem({
  result,
  onSelect,
  onNext,
}: {
  result: TorrentResult;
  onSelect: () => void;
  /** Puts it next in the playlist; only while something is playing. */
  onNext: (() => void) | null;
}) {
  const ready = result.ready === true;
  return (
    <Command.Item value={`torrent:${result.hash}`} onSelect={onSelect} className={cn(ROW, "group")}>
      <span
        aria-hidden="true"
        className="flex size-4 flex-none items-center justify-center text-ink-2"
      >
        {ready ? <PlayGlyph className="size-3.5" /> : <ArrowDownToLine className="size-4" />}
      </span>
      {/* A release is named title first, so its end is what may go. */}
      <MiddleTruncate text={result.name} tail={0} className="min-w-0 flex-1" />
      <span className="sr-only">{ready ? ", ready to play" : ", fetched first"}</span>
      <span className="tabular w-16 flex-none whitespace-nowrap text-right text-caption text-ink-3">
        {result.size}
      </span>
      {/* On the row in hand, while a film plays, the seeds give way to Play next (⌘↩). */}
      <span className="relative flex h-6 w-[5.25rem] flex-none items-center justify-end">
        <span
          className={cn(
            "tabular whitespace-nowrap text-caption text-ink-3",
            onNext && "group-data-[selected=true]:invisible",
          )}
        >
          {formatSeeds(result.seeders)}
        </span>
        {onNext ? (
          <button
            type="button"
            tabIndex={-1}
            aria-keyshortcuts="Meta+Enter"
            onPointerDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              onNext();
            }}
            className={cn(
              "invisible absolute inset-y-0 right-0 flex items-center gap-1.5 whitespace-nowrap rounded-xs",
              "border border-line-strong bg-surface-2 px-2 text-caption font-medium text-ink-1",
              "hover:bg-surface-4 active:scale-[0.97] group-data-[selected=true]:visible",
              "transition-[background-color,transform] duration-fast ease-out",
            )}
          >
            Play next
          </button>
        ) : null}
      </span>
    </Command.Item>
  );
}

/** What the list says while there is nothing to choose: searching, nothing found, or why it failed. */
function Note({
  children,
  tone = "plain",
}: {
  children: React.ReactNode;
  tone?: "plain" | "danger";
}) {
  return (
    <div className="flex items-start gap-2 px-3 py-5 text-body text-ink-2">
      {tone === "danger" ? (
        <CircleAlert aria-hidden="true" className="mt-0.5 size-4 flex-none text-danger" />
      ) : null}
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

/** A needle that travels a hairline, for work of unknown length (DESIGN.md §5). */
function Sweep({ className }: { className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  return (
    <span ref={ref} aria-hidden="true" className={cn("relative block h-3.5", className)}>
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line-strong" />
      <span
        className="absolute left-0 top-0 h-full w-0.5 animate-sweep rounded-xs bg-accent"
        style={{ "--sweep": `${Math.max(0, width - 2)}px` } as React.CSSProperties}
      />
    </span>
  );
}

/** How far a fetch has come, as the scale and needle every level in Lumen is shown by. */
function Meter({ value, label }: { value: number; label: string }) {
  const share = Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share)}
      aria-valuetext={`${Math.round(share)}%`}
      className="relative h-3.5"
    >
      <span className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-xs bg-line-strong" />
      <span
        className="absolute left-0 top-1/2 h-0.5 -translate-y-1/2 rounded-xs bg-ink-1 transition-[width] duration-base ease-out"
        style={{ width: `${share}%` }}
      />
      <span
        className="absolute top-0 h-full w-0.5 rounded-xs bg-accent transition-[left] duration-base ease-out"
        style={{ left: `calc(${share}% - ${(share / 100) * 2}px)` }}
      />
    </div>
  );
}

/** The torrent being fetched: how it is getting on, then its files. */
function FetchView({ fetching, onBack }: { fetching: Fetching; onBack: (() => void) | null }) {
  const take = useTorrents((state) => state.take);
  const download = useTorrents((state) => state.download);
  const { progress, error } = fetching;
  const name =
    progress && progress.phase !== "failed" ? progress.name || fetching.name : fetching.name;
  const failure = error?.message ?? (progress?.phase === "failed" ? progress.message : null);

  let label: string;
  let body: React.ReactNode;
  if (failure !== null) {
    label = "Could not fetch";
    body = (
      <p className="mt-3 flex items-start gap-2 text-body text-ink-1">
        <CircleAlert aria-hidden="true" className="mt-0.5 size-4 flex-none text-danger" />
        <span className="min-w-0 break-words">
          {failure.charAt(0).toUpperCase() + failure.slice(1).replace(/[.\s]*$/, ".")}
        </span>
      </p>
    );
  } else if (progress?.phase === "working") {
    label = describeState(progress.state, progress.progress);
    const known = progress.progress > 0;
    body = (
      <>
        <div className="mt-4">
          {known ? <Meter value={progress.progress} label={label} /> : <Sweep />}
        </div>
        <div className="mt-2 flex items-center justify-between gap-4 text-caption text-ink-2">
          <span className="tabular whitespace-nowrap">
            {known ? `${Math.round(progress.progress)}%` : label}
          </span>
          <span className="tabular min-w-0 truncate text-right">
            {[
              progress.speed > 0 ? formatSpeed(progress.speed) : null,
              formatSeeds(progress.seeders),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      </>
    );
  } else if (progress?.phase === "ready") {
    const playable = playableFiles(progress);
    label = playable.length === 1 ? "Starting" : progress.files.length === 0 ? "Empty" : "Ready";
    body =
      playable.length === 1 ? (
        <div className="mt-4">
          <Sweep />
        </div>
      ) : progress.files.length === 0 ? (
        <p className="mt-3 text-body text-ink-2">This torrent has no files to play or download.</p>
      ) : null;
  } else {
    label = "Asking the server";
    body = (
      <div className="mt-4">
        <Sweep />
      </div>
    );
  }

  const files = progress?.phase === "ready" ? progress.files : [];
  const playable = playableFiles(progress);
  const others = files.filter((file) => !file.playable);
  const listed = playable.length !== 1 && files.length > 0;

  return (
    <>
      <div className="px-3 pb-3 pt-3" aria-live="polite">
        <p className="label text-ink-3">
          {label}
          {fetching.intent === "next" && failure === null ? " · then plays next" : ""}
        </p>
        <MiddleTruncate
          text={name}
          tail={0}
          className="mt-1 block text-body font-semibold text-ink-1"
        />
        {body}
      </div>
      {listed && playable.length > 0 ? (
        <Command.Group
          heading={fetching.intent === "next" ? "Choose what plays next" : "Play"}
          className={GROUP}
        >
          {playable.map((file) => (
            <FileItem key={file.index} file={file} onSelect={() => take(file)} />
          ))}
        </Command.Group>
      ) : null}
      {listed && others.length > 0 ? (
        <Command.Group
          heading={playable.length > 0 ? "Download in the browser" : "Download"}
          className={GROUP}
        >
          {others.map((file) => (
            <FileItem key={file.index} file={file} onSelect={() => download(file)} />
          ))}
        </Command.Group>
      ) : null}
      {onBack ? (
        <Command.Group className={cn(GROUP, "border-t border-line pt-1")}>
          <Command.Item value="torrent:back" onSelect={onBack} className={ROW}>
            <ArrowLeft aria-hidden="true" className="size-4 flex-none text-ink-2" />
            <span className="min-w-0 flex-1 truncate">Back to results</span>
          </Command.Item>
        </Command.Group>
      ) : null}
    </>
  );
}

function FileItem({ file, onSelect }: { file: TorrentFile; onSelect: () => void }) {
  return (
    <Command.Item value={`file:${file.index}`} onSelect={onSelect} className={ROW}>
      <span
        aria-hidden="true"
        className="flex size-4 flex-none items-center justify-center text-ink-2"
      >
        {file.playable ? (
          <PlayGlyph className="size-3.5" />
        ) : (
          <ArrowDownToLine className="size-4" />
        )}
      </span>
      <MiddleTruncate text={file.name} className="min-w-0 flex-1" />
      <span className="tabular w-16 flex-none whitespace-nowrap text-right text-caption text-ink-3">
        {formatBytes(file.size)}
      </span>
    </Command.Item>
  );
}

/** The results of a search, split by whether they play at once. */
function ResultGroups({
  results,
  limit,
  onChoose,
}: {
  results: readonly TorrentResult[];
  limit?: number;
  onChoose: (result: TorrentResult, intent: Intent) => void;
}) {
  const shown = limit === undefined ? results : results.slice(0, limit);
  const playing = usePlayer(hasMedia);
  // ⌘↩ on a result puts it next. Heard before cmdk, which would otherwise play it.
  useEffect(() => {
    if (!playing) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !event.metaKey) {
        return;
      }
      const value = document
        .querySelector('[cmdk-item][data-selected="true"]')
        ?.getAttribute("data-value");
      const result = shown.find((candidate) => `torrent:${candidate.hash}` === value);
      if (result) {
        event.preventDefault();
        event.stopPropagation();
        onChoose(result, "next");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [playing, shown, onChoose]);
  // Only results that play at once are found (the server is asked which TorBox has).
  const groups: [string, readonly TorrentResult[]][] = [["Ready to play", shown]];
  return (
    <>
      {groups
        .filter(([, rows]) => rows.length > 0)
        .map(([heading, rows]) => (
          <Command.Group key={heading} heading={heading} className={GROUP}>
            {rows.map((result) => (
              <ResultItem
                key={result.hash}
                result={result}
                onSelect={() => onChoose(result, "play")}
                onNext={playing ? () => onChoose(result, "next") : null}
              />
            ))}
          </Command.Group>
        ))}
    </>
  );
}

const MODE_PLACEHOLDER = "Search for a film, a show or an album";

/**
 * The palette opened to search torrents (⌘F, or "All results" from ⌘K).
 * What is playing goes on playing: only choosing a file to play replaces it.
 */
export function TorrentFinder() {
  const seed = usePalette((state) => state.seed);
  const fetching = useTorrents((state) => state.fetching);
  const search = useTorrents((state) => state.search);
  const choose = useTorrents((state) => state.choose);
  const forget = useTorrents((state) => state.forget);
  const [query, setQuery] = useState(() =>
    seed !== "" ? seed : fetching === null && search.status !== "idle" ? search.query : "",
  );
  // Opened on a fetch (from its toast, or again while it runs), the fetch is shown.
  const [view, setView] = useState<"results" | "fetch">(
    fetching !== null && seed === "" ? "fetch" : "results",
  );
  const find = useTorrents((state) => state.find);
  // Opened with something to search for (Return on Home, or ⌘K's row), it is searched for.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for what it was opened with
  useEffect(() => {
    if (seed.trim() !== "") {
      find(seed);
    }
  }, []);

  const typed = query.trim();
  const showFetch = view === "fetch" && fetching !== null;
  const searched = search.status !== "idle" && search.query === typed;
  const remembered = useTorrents((state) => state.history.length);
  const rows = useFirstRow(
    `${view}|${typed}|${search.status}|${fetching?.progress?.phase ?? ""}|${fetching?.id ?? ""}|${remembered}`,
  );

  return (
    <Command
      {...rows}
      label="Search torrents"
      shouldFilter={false}
      loop
      className="flex min-h-0 flex-col"
    >
      <div className="flex h-12 flex-none items-center gap-3 border-b border-line px-4">
        <Magnet aria-hidden="true" className="size-4 flex-none text-ink-3" />
        <Command.Input
          // The palette changing what it is for replaces this field: the keyboard comes with it.
          autoFocus
          value={query}
          onValueChange={(next) => {
            setQuery(next);
            setView("results");
          }}
          placeholder={MODE_PLACEHOLDER}
          className="h-full min-w-0 flex-1 bg-transparent text-heading font-medium text-ink-1 outline-none"
        />
      </div>
      <Command.List className="scrollbar-thin max-h-[min(22rem,calc(82vh-5rem))] overflow-y-auto overscroll-contain p-1">
        {showFetch ? (
          <FetchView
            fetching={fetching}
            onBack={
              search.status === "done"
                ? () => {
                    forget();
                    setQuery(search.query);
                    setView("results");
                  }
                : null
            }
          />
        ) : typed === "" ? (
          <>
            <NextEpisodeRow
              onSearch={(next) => {
                setQuery(next);
                find(next);
              }}
            />
            <RecentSearches
              limit={undefined}
              onSearch={(entry) => {
                setQuery(entry);
                find(entry);
              }}
              empty={
                <Note>
                  Type the name of a film, a show or an album, and press Return. Only what plays at
                  once is listed; anything Lumen does not play opens in the browser to download.
                </Note>
              }
            />
          </>
        ) : !searched ? (
          <Command.Group className={GROUP}>
            <Command.Item value="torrent:search" onSelect={() => find(typed)} className={ROW}>
              <Search aria-hidden="true" className="size-4 flex-none text-ink-2" />
              <span className="min-w-0 flex-1 truncate">Search for “{typed}”</span>
              <Shortcut
                chord="Return"
                variant="keycap"
                className="flex-none text-caption text-ink-3"
              />
            </Command.Item>
          </Command.Group>
        ) : search.status === "searching" ? (
          <div className="flex items-center gap-3 px-3 py-5 text-body text-ink-2">
            <Sweep className="w-5 flex-none" />
            <span>Searching for “{typed}”</span>
          </div>
        ) : search.status === "failed" ? (
          <Note tone="danger">
            {search.error.message.charAt(0).toUpperCase() +
              search.error.message.slice(1).replace(/[.\s]*$/, ".")}
          </Note>
        ) : search.results.length === 0 ? (
          <Note>
            Nothing is ready to play for “{typed}”. Try fewer words, or the original title.
          </Note>
        ) : (
          <ResultGroups
            results={search.results}
            onChoose={(result, intent) => {
              choose(result, intent);
              setView("fetch");
            }}
          />
        )}
      </Command.List>
    </Command>
  );
}

/**
 * While an episode plays: rows that search for the one after it, and for
 * the next season's first, in case this was the season's last.
 */
function NextEpisodeRow({ onSearch }: { onSearch: (query: string) => void }) {
  const title = usePlayer((state) => state.title);
  const next = nextEpisodeSearch(title);
  const season = nextSeasonSearch(title);
  if (next === null || season === null) {
    return null;
  }
  return (
    <Command.Group heading="Next episode" className={GROUP}>
      <Command.Item value="torrent:next-episode" onSelect={() => onSearch(next)} className={ROW}>
        <SkipForward aria-hidden="true" className="size-4 flex-none text-ink-2" />
        <span className="min-w-0 flex-1 truncate">Find {next}</span>
        <Shortcut chord="Shift+Cmd+f" className="flex-none text-caption text-ink-3" />
      </Command.Item>
      <Command.Item value="torrent:next-season" onSelect={() => onSearch(season)} className={ROW}>
        <ChevronsRight aria-hidden="true" className="size-4 flex-none text-ink-2" />
        <span className="min-w-0 flex-1 truncate">Find {season}</span>
        <span className="flex-none whitespace-nowrap text-caption text-ink-3">Next season</span>
      </Command.Item>
    </Command.Group>
  );
}

/**
 * Recent torrent searches, newest first, and a row that forgets them all.
 * `empty` is shown when there are none.
 */
function RecentSearches({
  limit,
  onSearch,
  empty = null,
}: {
  limit: number | undefined;
  onSearch: (query: string) => void;
  empty?: React.ReactNode;
}) {
  const history = useTorrents((state) => state.history);
  const clear = useTorrents((state) => state.clearHistory);
  if (history.length === 0) {
    return <>{empty}</>;
  }
  const shown = limit === undefined ? history : history.slice(0, limit);
  return (
    <Command.Group heading="Recent searches" className={GROUP}>
      {shown.map((entry) => (
        <Command.Item
          key={entry}
          value={`torrent:recent:${entry}`}
          onSelect={() => onSearch(entry)}
          className={ROW}
        >
          <History aria-hidden="true" className="size-4 flex-none text-ink-2" />
          <span className="min-w-0 flex-1 truncate">{entry}</span>
        </Command.Item>
      ))}
      <Command.Item value="torrent:clear-history" onSelect={clear} className={ROW}>
        <Eraser aria-hidden="true" className="size-4 flex-none text-ink-2" />
        <span className="min-w-0 flex-1 truncate">Clear search history</span>
      </Command.Item>
    </Command.Group>
  );
}

/**
 * The command palette's way into a torrent search: with nothing typed, the
 * recent searches; with something typed, a row that searches for it (in the
 * torrent view, so the results have the room they need). Nothing is
 * searched until that is chosen.
 */
export function TorrentsInPalette({ query }: { query: string }) {
  const typed = query.trim();
  const search = (text: string) => usePalette.getState().show("torrents", text);
  if (typed === "") {
    return (
      <>
        <NextEpisodeRow onSearch={search} />
        <RecentSearches limit={RECENT_IN_PALETTE} onSearch={search} />
      </>
    );
  }
  if (typed.length < PALETTE_MIN_CHARS) {
    return null;
  }
  return (
    <Command.Group heading="Torrents" className={GROUP}>
      <Command.Item value="torrent:all" onSelect={() => search(typed)} className={ROW}>
        <Magnet aria-hidden="true" className="size-4 flex-none text-ink-2" />
        <span className="min-w-0 flex-1 truncate">Search torrents for “{typed}”</span>
      </Command.Item>
    </Command.Group>
  );
}
