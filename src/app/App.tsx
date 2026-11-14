import { useEffect, useState } from "react";
import { appActions } from "@/actions/all";
import { registerActions } from "@/actions/registry";
import { useGlobalShortcuts } from "@/actions/useGlobalShortcuts";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyAppearance, watchSystemTheme } from "@/design/theme";
import { connectCast } from "@/features/cast/store";
import { Inspector } from "@/features/inspector/Inspector";
import { connectPosters, connectRecents, useRecents } from "@/features/library/recents";
import { Palette } from "@/features/palette/Palette";
import { usePalette } from "@/features/palette/store";
import { useChrome } from "@/features/player/chrome";
import { connectPlaybackNotices } from "@/features/player/notices";
import { showOsd } from "@/features/player/osd";
import { Stage } from "@/features/player/Stage";
import { connectScrollGestures } from "@/features/player/scroll";
import { connectPlayer, hasMedia, usePlayer } from "@/features/player/store";
import { connectWindow } from "@/features/player/window";
import { connectPlaylistNotices } from "@/features/playlist/notices";
import { connectSaved, useSaved } from "@/features/playlist/saved";
import { connectQueue } from "@/features/playlist/store";
import { subscribeToSettings, useSettings } from "@/features/settings/store";
import { DropFrame } from "@/features/shell/DropFrame";
import { Home } from "@/features/shell/Home";
import { INSPECTOR_WIDTH, rememberInterface, useInterface } from "@/features/shell/interface";
import { connectMenuBar } from "@/features/shell/menuBar";
import { TitleBar } from "@/features/shell/TitleBar";
import { useFileDrop } from "@/features/shell/useFileDrop";
import { usePasteToOpen } from "@/features/shell/usePasteToOpen";
import { connectSubtitleSync } from "@/features/subtitles/sync";
import { commands } from "@/ipc";
import { cn } from "@/lib/cn";
import { dismissFrontToast } from "@/lib/notify";
import { isTauri } from "./boot";

// Registered before the first render, so tooltips can show shortcuts at once.
registerActions(appActions);

/** Keeps the document's theme and accent in step with the settings and with macOS. */
function useAppearance() {
  const appearance = useSettings((state) => state.settings.appearance);
  useEffect(() => {
    applyAppearance(appearance);
    return watchSystemTheme(() => applyAppearance(appearance));
  }, [appearance]);
}

/** Resolves when the interface font has loaded, or after a short wait if it will not. */
function fontsReady(): Promise<unknown> {
  const loaded = document.fonts.load('1em "Plus Jakarta Sans Variable"').catch(() => undefined);
  const giveUp = new Promise((resolve) => window.setTimeout(resolve, 400));
  return Promise.race([loaded, giveUp]);
}

/**
 * Asks the window for room beside the picture while the panel is open, and
 * gives it back when the panel closes or there is no picture to be beside
 * (DESIGN.md §7, "Panel beside the picture").
 */
function usePanelRoom(shown: boolean) {
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    // If the window cannot follow, the panel is still there; nothing to say.
    void commands.windowSetPanelWidth(shown ? INSPECTOR_WIDTH : 0);
  }, [shown]);
}

/**
 * Says why a key did nothing, where a film is open to say it over. On the
 * home screen nearly every key waits for something to be open, and the
 * screen itself says what to do about that.
 */
function sayWhyNot(reason: string) {
  if (hasMedia(usePlayer.getState())) {
    showOsd({ label: reason });
  }
}

const SHORTCUTS = { refused: sayWhyNot, dismiss: dismissFrontToast };

export function App() {
  useAppearance();
  useGlobalShortcuts(SHORTCUTS);
  const dropping = useFileDrop();
  usePasteToOpen();
  const open = usePlayer(hasMedia);
  const paletteOpen = usePalette((state) => state.open);
  const menuOpen = useChrome((state) => state.holds.has("menu"));
  const failure = usePlayer((state) => state.failure);
  const panelWanted = useInterface((state) => state.panelOpen) && open;
  // The panel stays in the window while it leaves (DESIGN.md §5); the window
  // gives its room back once it has gone.
  const [panelLeaving, setPanelLeaving] = useState(false);
  const [panelWas, setPanelWas] = useState(panelWanted);
  if (panelWanted !== panelWas) {
    setPanelWas(panelWanted);
    // Closed while the film is still open: it is seen out. With the film
    // gone there is no stage for it to leave.
    setPanelLeaving(!panelWanted && open);
  }
  if (panelLeaving && !open) {
    setPanelLeaving(false);
  }
  const panel = panelWanted || panelLeaving;
  usePanelRoom(panel);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    const subscriptions = [
      subscribeToSettings(),
      connectPlayer(),
      connectQueue(),
      connectSaved(),
      connectWindow(),
      connectPlaybackNotices(),
      connectPlaylistNotices(),
      connectPosters(),
      connectRecents(),
      connectMenuBar(),
      connectScrollGestures(),
      connectSubtitleSync(),
      connectCast(),
    ];
    const forget = rememberInterface();
    let stopped = false;
    // The window is created hidden and revealed once the first render has
    // committed and the interface font is in, so the first frame the user
    // sees is the finished one. This cannot wait for requestAnimationFrame: a
    // hidden page never gets one, so the window would never appear.
    //
    // It also waits until the backend is delivering events here, because
    // "ready" is when the backend says whatever went wrong before anyone
    // could hear it, such as a file opened from the Finder that would not
    // play; and until what was played before has been read, so the home
    // screen does not rearrange itself a moment after it appears.
    void Promise.all([
      fontsReady(),
      useRecents.getState().load(),
      useSaved.getState().load(),
      ...subscriptions.map((each) => each.ready),
    ]).then(() => {
      if (!stopped) {
        void commands.appReady();
      }
    });
    return () => {
      stopped = true;
      forget();
      for (const each of subscriptions) {
        each.stop();
      }
    };
  }, []);

  // Back on the home screen: where what was playing was left belongs on it.
  // (That it was played at all, the backend has already said.)
  useEffect(() => {
    if (!open && isTauri() && useRecents.getState().loaded) {
      void useRecents.getState().load();
    }
  }, [open]);

  return (
    <TooltipProvider>
      {open ? (
        <div className="relative h-full">
          {/* The picture's part of the window: all of it, or all but the panel. */}
          <div className={cn("absolute inset-y-0 left-0", panel ? "right-inspector" : "right-0")}>
            <Stage />
          </div>
          {panel ? (
            <Inspector leaving={panelLeaving} onLeft={() => setPanelLeaving(false)} />
          ) : null}
        </div>
      ) : (
        <div className="flex h-full flex-col bg-bg text-ink-1">
          <TitleBar title="Lumen" />
          <Home dropping={dropping !== null} failure={failure} />
        </div>
      )}
      <Palette />
      <DropFrame target={dropping} overVideo={open} panel={panel} />
      {/* Nothing lies across the palette or an open menu (DESIGN.md §7, "Toast"). */}
      <Toaster onStage={open} besidePanel={panel} quiet={paletteOpen || (open && menuOpen)} />
    </TooltipProvider>
  );
}
