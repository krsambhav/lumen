import { Bell, BookOpen, History, Search, Undo2 } from "lucide-react";
import type { Action } from "@/actions/registry";
import { useRecents } from "@/features/library/recents";
import { usePalette } from "@/features/palette/store";
import { needsMedia } from "@/features/player/actions";
import { showing } from "@/features/playlist/actions";
import { commands } from "@/ipc";
import { notifyFailure, send, undoable, undoNewest } from "@/lib/notify";
import { canUndo } from "@/lib/undo";
import { useInterface } from "./interface";

/** The list Sonner draws its toasts in. */
function toastList(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-sonner-toaster]");
}

/** Forgets everything that was played, with a toast that can undo it. */
function clearRecents(): void {
  const before = useRecents.getState().entries;
  // Gone from the screen at once. The backend says when the history has
  // changed, and it is read again then.
  useRecents.setState({ entries: [] });
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
    unavailable: () =>
      useRecents.getState().entries.length === 0 ? "Nothing has been played" : undefined,
    run: clearRecents,
  },
];
