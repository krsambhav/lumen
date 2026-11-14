import { ArrowDownToLine, RefreshCw, RotateCw } from "lucide-react";
import type { Action } from "@/actions/registry";
import { confirm } from "@/features/player/actions";
import { hasMedia, usePlayer } from "@/features/player/store";
import { changeSettings } from "@/features/settings/change";
import { useSettings } from "@/features/settings/store";
import { checkForUpdates, installUpdate, restartToUpdate, underWay, useUpdates } from "./store";

/** What "Update Lumen" would do now, in the words its control uses. */
export function updateLabel(): string {
  const { status } = useUpdates.getState();
  if (status.state === "ready") {
    return "Restart to update";
  }
  if (status.state === "available") {
    return `Update to ${status.version}`;
  }
  return "Update Lumen";
}

/** Why there is nothing to update to, or to restart for, right now. */
export function updateUnavailable(): string | undefined {
  const { status } = useUpdates.getState();
  if (status.state === "available" || status.state === "ready") {
    return undefined;
  }
  if (underWay(status)) {
    return "The update is already on its way";
  }
  return status.state === "current" ? "Lumen is up to date" : "No newer version has been found";
}

/** Lumen's own updates (DESIGN.md §7, "Updates"). */
export const updateActions: readonly Action[] = [
  {
    id: "app.update",
    name: "Update Lumen",
    label: updateLabel,
    keywords: ["upgrade", "install", "new version", "restart", "relaunch"],
    category: "app",
    icon: ArrowDownToLine,
    shortcuts: [],
    unavailable: updateUnavailable,
    run: () => {
      if (useUpdates.getState().status.state === "ready") {
        restartToUpdate();
      } else {
        installUpdate();
      }
    },
  },
  {
    id: "app.checkForUpdates",
    name: "Check for updates",
    keywords: ["upgrade", "new version", "latest", "release"],
    category: "app",
    icon: RefreshCw,
    shortcuts: [],
    run: checkForUpdates,
  },
  {
    id: "app.automaticUpdates",
    name: "Check for updates automatically",
    keywords: ["background", "by itself", "on launch", "network"],
    category: "app",
    icon: RotateCw,
    shortcuts: [],
    checked: () => useSettings.getState().settings.general.checkForUpdates,
    run: (context) => {
      const checking = !useSettings.getState().settings.general.checkForUpdates;
      changeSettings((current) => ({
        ...current,
        general: { ...current.general, checkForUpdates: checking },
      }));
      // The menu's tick shows it; over a film from a key or the palette, nothing else would.
      if (hasMedia(usePlayer.getState())) {
        confirm(context, {
          label: checking ? "Checks for updates by itself" : "Checks for updates only when asked",
        });
      }
    },
  },
];
