import { Bell, BookOpen, HatGlasses, History, Search, Undo2 } from "lucide-react";
import type { Action } from "@/actions/registry";
import { useRecents } from "@/features/library/recents";
import { usePalette } from "@/features/palette/store";
import { confirm, needsMedia } from "@/features/player/actions";
import { hasMedia, usePlayer } from "@/features/player/store";
import { showing } from "@/features/playlist/actions";
import { changeSettings } from "@/features/settings/change";
import { useSettings } from "@/features/settings/store";
import { commands } from "@/ipc";
import { notifyFailure, send, undoable, undoNewest } from "@/lib/notify";
import { canUndo } from "@/lib/undo";
import { useInterface } from "./interface";

/** The list Sonner draws its toasts in. */
function toastList(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-sonner-toaster]");
}

/** Forgets everything that was played and is not pinned, with a toast that can undo it. */
function clearRecents(): void {
  const all = useRecents.getState().entries;
  const before = all.filter((entry) => !entry.pinned);
  // Gone from the screen at once. The backend says when the history has
  // changed, and it is read again then.
  useRecents.setState({ entries: all.filter((entry) => entry.pinned) });
  void commands.historyClear().then((result) => {
    if (result.status === "error") {
      notifyFailure("clear what was played", result.error);
      void useRecents.getState().load();
      return;
    }
    undoable("Cleared recently played", {
      id: "recents-cleared",
      undo: () => {
        for (const { available: _a, poster: _p, resumesAt: _r, ...entry } of before) {
          send("put those back", commands.historyRestore(entry));
        }
      },
    });
  });
}

/** Nothing played now is remembered, nor any search. */
export function incognito(): boolean {
  return useSettings.getState().settings.general.incognito;
}

/** Actions of the window as a whole: the palette, the panel, notifications, history. */
export const shellActions: readonly Action[] = [
  {
    id: "view.palette",
    name: "Command palette…",
    keywords: ["search", "find", "commands", "actions"],
    category: "view",
    icon: Search,
    shortcuts: ["Cmd+k"],
    run: () => {
      const palette = usePalette.getState();
      // The same keys close it again.
      if (palette.open && palette.mode === "all") {
        palette.hide();
      } else {
        palette.show("all");
      }
    },
  },
  {
    id: "view.chapters",
    name: "Show chapters",
    label: () => (showing("chapters") ? "Hide chapters" : "Show chapters"),
    keywords: ["scenes", "contents", "panel", "sidebar"],
    category: "view",
    icon: BookOpen,
    shortcuts: ["Shift+Cmd+c"],
    unavailable: needsMedia,
    run: (context) =>
      useInterface.getState().togglePanel("chapters", context.source === "keyboard"),
  },
  {
    id: "edit.undo",
    name: "Undo",
    keywords: ["put back", "restore", "revert"],
    category: "edit",
    icon: Undo2,
    // In a text field these keys are the field's own undo (DESIGN.md §8).
    shortcuts: ["Cmd+z"],
    unavailable: () => (canUndo() ? undefined : "There is nothing to undo"),
    run: () => {
      undoNewest();
    },
  },
  {
    id: "view.notifications",
    name: "Go to notifications",
    keywords: ["messages", "toasts", "alerts"],
    category: "view",
    icon: Bell,
    shortcuts: ["Alt+t"],
    unavailable: () =>
      (toastList()?.querySelector("[data-sonner-toast]") ?? null) === null
        ? "There are no notifications"
        : undefined,
    // The list takes focus; Tab then reaches each notification's controls.
    run: () => toastList()?.focus(),
  },
  {
    id: "history.clear",
    name: "Clear recently played",
    keywords: ["history", "recent", "forget"],
    category: "file",
    icon: History,
    shortcuts: ["Shift+Cmd+Backspace"],
    unavailable: () => {
      const entries = useRecents.getState().entries;
      if (entries.length === 0) {
        return "Nothing has been played";
      }
      return entries.every((entry) => entry.pinned) ? "Everything left is pinned" : undefined;
    },
    run: clearRecents,
  },
  {
    id: "history.incognito",
    name: "Incognito",
    keywords: ["private", "privacy", "history", "don't remember", "secret"],
    category: "file",
    icon: HatGlasses,
    shortcuts: ["Shift+Cmd+n"],
    // A switch, ticked in the menu bar while it is on, as "Check for updates automatically" is.
    checked: incognito,
    run: (context) => {
      const on = !incognito();
      changeSettings((current) => ({ ...current, general: { ...current.general, incognito: on } }));
      // The home screen says so where it is looked at; over a film nothing else would.
      if (hasMedia(usePlayer.getState())) {
        confirm(context, {
          label: on ? "Incognito: nothing played is remembered" : "Incognito off",
        });
      }
    },
  },
];
