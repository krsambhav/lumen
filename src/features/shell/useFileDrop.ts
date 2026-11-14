import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useState } from "react";
import { isTauri } from "@/app/boot";
import { openSources } from "@/features/playlist/actions";
import { usePlaylistUi } from "@/features/playlist/ui";
import { commands } from "@/ipc";
import { send } from "@/lib/notify";

/** Where files being dragged over the window would go. */
export type DropTarget = "window" | "playlist";

/**
 * Something that takes dropped files for itself instead of the window: the
 * playlist panel. It says where a point is in its list.
 */
interface DropZone {
  element: HTMLElement;
  /** The place in the list a drop at this height would add to. */
  indexAt: (clientY: number) => number;
}

let playlistZone: DropZone | null = null;

/** Registers the playlist's list as a place to drop files. Returns a function that takes it back. */
export function registerPlaylistDropZone(zone: DropZone): () => void {
  playlistZone = zone;
  return () => {
    if (playlistZone === zone) {
      playlistZone = null;
    }
  };
}

/** The drop zone under a point given in physical pixels, as Tauri reports it. */
function zoneAt(position: { x: number; y: number }): { zone: DropZone; y: number } | null {
  if (!playlistZone) {
    return null;
  }
  const x = position.x / window.devicePixelRatio;
  const y = position.y / window.devicePixelRatio;
  const rect = playlistZone.element.getBoundingClientRect();
  const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  return inside ? { zone: playlistZone, y } : null;
}

/**
 * Makes the whole window a drop target for files. Dropped on the playlist
 * they are added where they are dropped; anywhere else they replace the
 * playlist and play (DESIGN.md §7). Returns where the files being dragged
 * would go, or `null` when nothing is being dragged over the window.
 */
export function useFileDrop(): DropTarget | null {
  const [over, setOver] = useState<DropTarget | null>(null);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    const ui = usePlaylistUi.getState();
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      switch (payload.type) {
        case "enter":
        case "over": {
          const hit = zoneAt(payload.position);
          ui.setDropIndex(hit ? hit.zone.indexAt(hit.y) : null);
          setOver(hit ? "playlist" : "window");
          break;
        }
        case "leave":
          ui.setDropIndex(null);
          setOver(null);
          break;
        case "drop": {
          const hit = zoneAt(payload.position);
          ui.setDropIndex(null);
          setOver(null);
          if (payload.paths.length === 0) {
            break;
          }
          if (hit) {
            send(
              "add what you dropped",
              commands.playlistAdd(payload.paths, hit.zone.indexAt(hit.y)),
            );
          } else {
            openSources(payload.paths);
          }
          break;
        }
      }
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  return over;
}
