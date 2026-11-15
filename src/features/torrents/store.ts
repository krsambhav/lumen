import { toast } from "sonner";
import { create } from "zustand";
import { usePalette } from "@/features/palette/store";
import { useSettings } from "@/features/settings/store";
import {
  type AppError,
  commands,
  type TorrentFile,
  type TorrentProgress,
  type TorrentResult,
} from "@/ipc";
import { notifyFailure, TWO_LINES_MS } from "@/lib/notify";

/** How often a torrent being fetched is asked after, in milliseconds. */
export const POLL_MS = 2000;
/** How many searches are remembered. */
export const HISTORY_KEPT = 8;
const HISTORY_KEY = "lumen.torrent-searches";

/** The searches remembered on this Mac, newest first. Storage may be refused; then there are none. */
function loadHistory(): string[] {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(kept)
      ? kept.filter((entry): entry is string => typeof entry === "string").slice(0, HISTORY_KEPT)
      : [];
  } catch {
    return [];
  }
}

function saveHistory(history: readonly string[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

export type SearchState =
  | { status: "idle" }
  | { status: "searching"; query: string }
  | { status: "done"; query: string; results: TorrentResult[] }
  | { status: "failed"; query: string; error: AppError };

/** The one torrent being fetched to play, if any. */
export interface Fetching {
  id: string | null;
  /** The result's name, until the server says what the torrent is called. */
  name: string;
  progress: TorrentProgress | null;
  /** Asking the server to take it failed. */
  error: AppError | null;
  /** What to do once it has come: play it now, or put it next in the playlist. */
  intent: Intent;
}

export type Intent = "play" | "next";

interface TorrentsState {
  search: SearchState;
  fetching: Fetching | null;
  /** What was searched for lately, newest first, without repeats. */
  history: string[];
  /** Sends a search for `query` (asked for with Return) and remembers it, unless incognito. */
  find: (query: string) => void;
  /** Forgets every search. */
  clearHistory: () => void;
  /**
   * Fetches a result, then plays it as soon as it can, or puts it next in
   * the playlist. What is playing goes on playing until then.
   */
  choose: (result: TorrentResult, intent?: Intent) => void;
  /** Plays a file of the torrent fetched (or puts it next), with those after it. */
  take: (file: TorrentFile) => void;
  /** Opens a file Lumen does not play in the browser, to download it. */
  download: (file: TorrentFile) => void;
  /** Stops following the torrent being fetched. The server keeps it. */
  forget: () => void;
}

/** Bumped by every search, so an answer to an older one is dropped. */
let searches = 0;
/** Bumped by every choice, so the polling of an earlier one stops. */
let fetches = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function stopPolling() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** The files Lumen can play, in the order a person would number them. */
export function playableFiles(progress: TorrentProgress | null): TorrentFile[] {
  if (progress?.phase !== "ready") {
    return [];
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return progress.files
    .filter((file) => file.playable)
    .sort((a, b) => collator.compare(a.name, b.name));
}

/** The palette is open on the torrent being fetched: the user is waiting for it. */
function watched(): boolean {
  const palette = usePalette.getState();
  return palette.open && palette.mode === "torrents";
}

export const useTorrents = create<TorrentsState>((set, get) => {
  function playNow(id: string, file: TorrentFile) {
    stopPolling();
    void commands.torrentsPlay(id, file.index).then((settled) => {
      if (settled.status === "error") {
        notifyFailure("play that", settled.error);
        return;
      }
      set({ fetching: null });
      usePalette.getState().hide();
    });
  }

  function queueNext(id: string, file: TorrentFile) {
    stopPolling();
    void commands.torrentsPlayNext(id, file.index).then((settled) => {
      if (settled.status === "error") {
        notifyFailure("put that next in the playlist", settled.error);
        return;
      }
      set({ fetching: null });
      if (watched()) {
        usePalette.getState().hide();
      }
      toast(settled.data > 1 ? `Plays next, with ${settled.data - 1} after it` : "Plays next", {
        id: `torrent-next:${id}`,
        description: file.name.replace(/\.[^.]+$/, ""),
        classNames: { description: "truncate text-ink-2" },
        duration: TWO_LINES_MS,
        // It is next in the playlist, so playing it now is going on to the next.
        action: {
          label: "Play now",
          onClick: () => {
            void commands.playlistNext().then((moved) => {
              if (moved.status === "error") {
                notifyFailure("play that", moved.error);
              }
            });
          },
        },
      });
    });
  }

  /** Plays a file now, or puts it next, as the fetch was asked for. */
  function takeNow(id: string, file: TorrentFile) {
    if (get().fetching?.intent === "next") {
      queueNext(id, file);
    } else {
      playNow(id, file);
    }
  }

  function downloadNow(id: string, file: TorrentFile) {
    void commands.torrentsDownload(id, file.index).then((settled) => {
      if (settled.status === "error") {
        notifyFailure("open that in the browser", settled.error);
        return;
      }
      toast("Downloading in your browser", {
        id: `torrent-download:${id}:${file.index}`,
        description: file.name,
        classNames: { description: "truncate text-ink-2" },
        duration: TWO_LINES_MS,
      });
    });
  }

  /**
   * The torrent has arrived. One file Lumen plays, plays; one it does not is
   * downloaded in the browser, and what is playing goes on; several are
   * listed in the palette to choose from. If the user has moved on, a toast
   * says it is ready.
   */
  function arrived(id: string, progress: TorrentProgress & { phase: "ready" }) {
    const files = playableFiles(progress);
    const only = files.length === 1 ? files[0] : undefined;
    const lone = progress.files.length === 1 ? progress.files[0] : undefined;
    // Asked to go next, one file is put there without asking again.
    if (only && get().fetching?.intent === "next") {
      queueNext(id, only);
      return;
    }
    if (watched()) {
      if (only) {
        playNow(id, only);
      } else if (files.length === 0 && lone) {
        downloadNow(id, lone);
        set({ fetching: null });
        usePalette.getState().hide();
      }
      return;
    }
    if (progress.files.length === 0) {
      return;
    }
    const action = only
      ? { label: "Play", onClick: () => playNow(id, only) }
      : files.length === 0 && lone
        ? { label: "Download", onClick: () => downloadNow(id, lone) }
        : { label: "Choose", onClick: () => usePalette.getState().show("torrents") };
    toast("Ready", {
      id: `torrent:${id}`,
      description: progress.name,
      classNames: { description: "truncate text-ink-2" },
      duration: TWO_LINES_MS,
      action,
    });
  }

  function poll(id: string, turn: number) {
    void commands.torrentsStatus(id).then((settled) => {
      if (turn !== fetches) {
        return;
      }
      const fetching = get().fetching;
      if (fetching === null) {
        return;
      }
      if (settled.status === "error") {
        // A network hiccup is not the end of a fetch: ask again.
        timer = setTimeout(() => poll(id, turn), POLL_MS * 2);
        return;
      }
      const progress = settled.data;
      set({ fetching: { ...fetching, progress } });
      if (progress.phase === "working") {
        timer = setTimeout(() => poll(id, turn), POLL_MS);
      } else if (progress.phase === "ready") {
        arrived(id, progress);
      }
    });
  }

  return {
    search: { status: "idle" },
    fetching: null,
    history: loadHistory(),

    clearHistory: () => {
      set({ history: [] });
      saveHistory([]);
    },

    find: (query) => {
      const typed = query.trim();
      if (typed === "") {
        searches++;
        set({ search: { status: "idle" } });
        return;
      }
      // Incognito, a search is made but not remembered.
      if (!useSettings.getState().settings.general.incognito) {
        const history = [
          typed,
          ...get().history.filter((entry) => entry.toLowerCase() !== typed.toLowerCase()),
        ].slice(0, HISTORY_KEPT);
        set({ history });
        saveHistory(history);
      }
      // The same search asked for again (⌘K, then ⌘F on it) is the one under
      // way or done: it must not count as newer, or its answer is dropped.
      const current = get().search;
      if (current.status !== "idle" && current.query === typed && current.status !== "failed") {
        return;
      }
      const turn = ++searches;
      set({ search: { status: "searching", query: typed } });
      void commands.torrentsSearch(typed).then((settled) => {
        if (turn !== searches) {
          return;
        }
        set({
          search:
            settled.status === "ok"
              ? { status: "done", query: typed, results: settled.data }
              : { status: "failed", query: typed, error: settled.error },
        });
      });
    },

    choose: (result, intent = "play") => {
      stopPolling();
      const turn = ++fetches;
      const base = { name: result.name, progress: null, intent };
      set({ fetching: { ...base, id: null, error: null } });
      void commands.torrentsPrepare(result.magnet).then((settled) => {
        if (turn !== fetches) {
          return;
        }
        if (settled.status === "error") {
          set({ fetching: { ...base, id: null, error: settled.error } });
          return;
        }
        set({ fetching: { ...base, id: settled.data, error: null } });
        poll(settled.data, turn);
      });
    },

    take: (file) => {
      const id = get().fetching?.id;
      if (id) {
        takeNow(id, file);
      }
    },

    download: (file) => {
      const id = get().fetching?.id;
      if (id) {
        downloadNow(id, file);
      }
    },

    forget: () => {
      fetches++;
      stopPolling();
      set({ fetching: null });
    },
  };
});
