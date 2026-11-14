import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  FolderOpen,
  FolderSearch,
  Link,
  ListPlus,
  ListVideo,
  ListX,
  Magnet,
  Repeat,
  Save,
  Shuffle,
  SkipBack,
  SkipForward,
  X,
} from "lucide-react";
import type { Action, ActionContext } from "@/actions/registry";
import { usePalette } from "@/features/palette/store";
import { confirm, NOTHING_OPEN, needsMedia } from "@/features/player/actions";
import { hasMedia, usePlayer } from "@/features/player/store";
import { useInterface } from "@/features/shell/interface";
import { commands, type InspectorTab, type QueueItem, type Repeat as RepeatMode } from "@/ipc";
import { notifyFailure, send, undoable } from "@/lib/notify";
import { hasSeveral, useQueue } from "./store";
import { usePlaylistUi } from "./ui";

/** Repeat steps round these, in this order. */
const REPEAT_ORDER: readonly RepeatMode[] = ["off", "all", "one"];

export const REPEAT_NAMES: Readonly<Record<RepeatMode, string>> = {
  off: "Repeat off",
  all: "Repeat all",
  one: "Repeat one",
};

/** The modes as a menu headed "Repeat" lists them. */
export const REPEAT_CHOICES: readonly { value: RepeatMode; name: string }[] = [
  { value: "off", name: "Off" },
  { value: "all", name: "All" },
  { value: "one", name: "One" },
];

export function nextRepeat(repeat: RepeatMode): RepeatMode {
  return REPEAT_ORDER[(REPEAT_ORDER.indexOf(repeat) + 1) % REPEAT_ORDER.length] ?? "off";
}

/** Sets the repeat mode, and says so. */
export function setRepeat(context: ActionContext, repeat: RepeatMode): void {
  send("change repeat", commands.playlistSetRepeat(repeat));
  confirm(context, { label: REPEAT_NAMES[repeat] });
}

/** Opens files, folders, playlist files or addresses, replacing the playlist. */
export function openSources(sources: readonly string[], resume = true): void {
  if (sources.length > 0) {
    send("open that", commands.playlistOpen([...sources], resume));
  }
}

/**
 * Removes an item from the playlist, with a toast that can put it back
 * (DESIGN.md §8: Undo rather than a confirmation).
 */
export function removeItem(item: QueueItem): void {
  const index = useQueue.getState().items.findIndex((other) => other.id === item.id);
  void commands.playlistRemove(item.id).then((result) => {
    if (result.status === "error") {
      notifyFailure("remove that from the playlist", result.error);
      return;
    }
    undoable("Removed from the playlist", {
      id: "playlist-removed",
      name: item.title,
      undo: () => send("put that back", commands.playlistAdd([item.source], Math.max(0, index))),
    });
  });
}

/** Empties the playlist of everything but what is playing, with a toast that can undo it. */
export function clearPlaylist(): void {
  const before = useQueue.getState();
  const others = before.items.filter((item) => item.id !== before.current);
  if (others.length === 0) {
    return;
  }
  void commands.playlistClear().then((result) => {
    if (result.status === "error") {
      notifyFailure("clear the playlist", result.error);
      return;
    }
    const removed = others.length === 1 ? "1 item" : `${others.length} items`;
    undoable(`Removed ${removed} from the playlist`, {
      id: "playlist-cleared",
      undo: () => {
        // What was before the playing item goes back before it, in order; the rest after.
        const at = before.items.findIndex((item) => item.id === before.current);
        const earlier = before.items.slice(0, Math.max(0, at)).map((item) => item.source);
        const later = before.items.slice(at + 1).map((item) => item.source);
        void (async () => {
          if (earlier.length > 0) {
            await commands.playlistAdd(earlier, 0);
          }
          if (later.length > 0) {
            send("put those back", commands.playlistAdd(later, null));
          }
        })();
      },
    });
  });
}

/** Whether the panel beside the picture is open on `tab`. */
export function showing(tab: InspectorTab): boolean {
  const { panelOpen, inspectorTab } = useInterface.getState();
  return panelOpen && inspectorTab === tab;
}

/** The open file's path, if what is open is a file on this Mac. */
function openFile(): string | null {
  const { source } = usePlayer.getState();
  return source !== null && !source.includes("://") ? source : null;
}

/** The actions of the playlist, and of opening and closing things. */
export const playlistActions: readonly Action[] = [
  {
    id: "file.open",
    name: "Open file…",
    keywords: ["browse", "load", "play a file"],
    category: "file",
    icon: FolderOpen,
    shortcuts: ["Cmd+o"],
    run: () => send("show the open panel", commands.playlistOpenDialog(false)),
  },
  {
    id: "file.openFolder",
    name: "Open folder…",
    keywords: ["directory", "browse", "series", "season"],
    category: "file",
    icon: FolderOpen,
    shortcuts: ["Shift+Cmd+o"],
    run: () => send("show the open panel", commands.playlistOpenDialog(true)),
  },
  {
    id: "file.openAddress",
    name: "Open address…",
    keywords: ["url", "link", "web", "online", "stream", "youtube", "vimeo", "internet"],
    category: "file",
    icon: Link,
    shortcuts: ["Cmd+u"],
    run: () => usePalette.getState().show("address"),
  },
  {
    id: "file.searchTorrents",
    name: "Search torrents…",
    keywords: [
      "find",
      "torrent",
      "magnet",
      "film",
      "movie",
      "show",
      "episode",
      "download",
      "torbox",
    ],
    category: "file",
    icon: Magnet,
    shortcuts: ["Cmd+f"],
    // What is playing goes on playing while the search is open.
    run: () => usePalette.getState().show("torrents"),
  },
  {
    id: "file.add",
    name: "Add to playlist…",
    keywords: ["queue", "enqueue", "append"],
    category: "file",
    icon: ListPlus,
    shortcuts: ["Alt+Cmd+o"],
    run: () => send("show the open panel", commands.playlistAddDialog()),
  },
  {
    id: "file.close",
    name: "Close",
    // What ⌘W closes is whatever is in front, and its name says which.
    label: () => (hasMedia(usePlayer.getState()) ? "Close file" : "Close window"),
    keywords: ["stop", "eject", "quit playing"],
    category: "file",
    icon: X,
    shortcuts: ["Cmd+w"],
    run: () => {
      if (hasMedia(usePlayer.getState())) {
        send("close that", commands.playlistClose());
      } else {
        void getCurrentWindow().close();
      }
    },
  },
  {
    id: "file.reveal",
    name: "Show in Finder",
    keywords: ["reveal", "locate", "where is it", "folder"],
    category: "file",
    icon: FolderSearch,
    shortcuts: ["Shift+Cmd+r"],
    unavailable: () =>
      needsMedia() ?? (openFile() === null ? "This is not a file on this Mac" : undefined),
    run: () => {
      const file = openFile();
      if (file !== null) {
        send("show that in the Finder", commands.filesShowInFinder(file));
      }
    },
  },
  {
    id: "playlist.next",
    name: "Next item",
    keywords: ["skip", "forward", "episode"],
    category: "playback",
    icon: SkipForward,
    shortcuts: ["Cmd+Right", "n"],
    unavailable: () => {
      const queue = useQueue.getState();
      if (!hasMedia(usePlayer.getState())) {
        return NOTHING_OPEN;
      }
      if (!hasSeveral(queue)) {
        return "The playlist has only this item";
      }
      return queue.hasNext ? undefined : "This is the last item";
    },
    run: () => send("go to the next item", commands.playlistNext()),
  },
  {
    id: "playlist.previous",
    name: "Previous item",
    keywords: ["back", "episode"],
    category: "playback",
    icon: SkipBack,
    shortcuts: ["Cmd+Left", "p"],
    unavailable: () => {
      const queue = useQueue.getState();
      if (!hasMedia(usePlayer.getState())) {
        return NOTHING_OPEN;
      }
      if (!hasSeveral(queue)) {
        return "The playlist has only this item";
      }
      return queue.hasPrevious ? undefined : "This is the first item";
    },
    run: () => send("go to the previous item", commands.playlistPrevious()),
  },
  {
    id: "playlist.repeat",
    // Named for what it is: it has three states, and its control says which
    // it is in beside the name (DESIGN.md §10).
    name: "Repeat",
    keywords: ["loop", "again", "repeat one", "repeat all"],
    category: "playback",
    icon: Repeat,
    shortcuts: ["r"],
    checked: () => useQueue.getState().repeat !== "off",
    run: (context) => setRepeat(context, nextRepeat(useQueue.getState().repeat)),
  },
  {
    id: "playlist.shuffle",
    name: "Shuffle",
    keywords: ["random", "mix"],
    category: "playback",
    icon: Shuffle,
    shortcuts: ["s"],
    checked: () => useQueue.getState().shuffle,
    run: (context) => {
      const shuffle = !useQueue.getState().shuffle;
      send("change shuffle", commands.playlistSetShuffle(shuffle));
      confirm(context, { label: shuffle ? "Shuffle on" : "Shuffle off" });
    },
  },
  {
    id: "playlist.save",
    name: "Save playlist as…",
    keywords: ["keep", "store", "name"],
    category: "file",
    icon: Save,
    shortcuts: ["Cmd+s"],
    unavailable: needsMedia,
    run: () => {
      useInterface.getState().showPanel("playlist");
      usePlaylistUi.getState().setSaving(true);
    },
  },
  {
    id: "playlist.clear",
    name: "Clear playlist",
    keywords: ["empty", "remove all", "queue"],
    category: "file",
    icon: ListX,
    shortcuts: ["Alt+Cmd+Backspace"],
    unavailable: () =>
      needsMedia() ??
      (hasSeveral(useQueue.getState()) ? undefined : "There is nothing else in the playlist"),
    run: clearPlaylist,
  },
  {
    id: "view.playlist",
    name: "Show playlist",
    label: () => (showing("playlist") ? "Hide playlist" : "Show playlist"),
    keywords: ["queue", "list", "panel", "sidebar", "up next"],
    category: "view",
    icon: ListVideo,
    shortcuts: ["Shift+Cmd+p"],
    unavailable: needsMedia,
    // From the keyboard the keyboard goes with it, to the list (DESIGN.md §7).
    run: (context) =>
      useInterface.getState().togglePanel("playlist", context.source === "keyboard"),
  },
];
