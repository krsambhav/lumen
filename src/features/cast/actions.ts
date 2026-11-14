import { Cast, CircleStop } from "lucide-react";
import type { Action } from "@/actions/registry";
import { needsMedia } from "@/features/player/actions";
import { commands } from "@/ipc";
import { send } from "@/lib/notify";
import { useCast } from "./store";

function needsSession(): string | undefined {
  return useCast.getState().session === null ? "Nothing is being cast" : undefined;
}

/** Stops casting; the Mac takes over, paused where the TV was. */
export function stopCasting(): void {
  send("stop casting", commands.castStop());
}

/** The actions of casting. */
export const castActions: readonly Action[] = [
  {
    id: "cast.devices",
    name: "Cast to a device…",
    keywords: ["chromecast", "airplay", "tv", "google", "apple tv", "stream", "send"],
    category: "playback",
    icon: Cast,
    shortcuts: ["Alt+Cmd+c"],
    unavailable: needsMedia,
    run: () => {
      void commands.castSearch();
      // The menu beside the cast button lists the devices. On a narrow stage
      // the button is in More, which opens instead, with Cast first in it.
      const button = document.querySelector<HTMLElement>('button[aria-label="Cast"]');
      if (button !== null && button.offsetParent === null) {
        const more = document.querySelector<HTMLElement>('button[aria-label="More"]');
        more?.focus();
        more?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        return;
      }
      useCast.getState().setMenuOpen(true);
    },
  },
  {
    id: "cast.stop",
    name: "Stop casting",
    keywords: ["disconnect", "chromecast", "airplay", "tv"],
    category: "playback",
    icon: CircleStop,
    shortcuts: [],
    unavailable: needsSession,
    run: stopCasting,
  },
];
