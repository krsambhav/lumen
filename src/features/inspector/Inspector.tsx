import {
  AudioLines,
  Captions,
  Film,
  ListVideo,
  type LucideIcon,
  PanelRightClose,
  TableOfContents,
} from "lucide-react";
import { Tabs } from "radix-ui";
import { useEffect, useRef } from "react";
import { getAction } from "@/actions/registry";
import { IconButton } from "@/components/ui/icon-button";
import { SurfaceProvider } from "@/components/ui/surface";
import { Tooltip } from "@/components/ui/tooltip";
import { AudioPanel } from "@/features/audio/AudioPanel";
import { PlaylistPanel } from "@/features/playlist/PlaylistPanel";
import { usePlaylistUi } from "@/features/playlist/ui";
import { useSettings } from "@/features/settings/store";
import { useInterface } from "@/features/shell/interface";
import { SubtitlesPanel } from "@/features/subtitles/SubtitlesPanel";
import { isNeutral } from "@/features/video/picture";
import { VideoPanel } from "@/features/video/VideoPanel";
import type { InspectorTab } from "@/ipc";
import { cn } from "@/lib/cn";
import { ChaptersPanel } from "./ChaptersPanel";

/** The panel's tabs, in order, each with the action whose keys open it. */
export const TABS: readonly {
  id: InspectorTab;
  name: string;
  action: string;
  icon: LucideIcon;
}[] = [
  { id: "playlist", name: "Playlist", action: "view.playlist", icon: ListVideo },
  { id: "chapters", name: "Chapters", action: "view.chapters", icon: TableOfContents },
  { id: "video", name: "Video", action: "view.video", icon: Film },
  { id: "audio", name: "Audio", action: "view.audio", icon: AudioLines },
  { id: "subtitles", name: "Subtitles", action: "view.subtitles", icon: Captions },
];

const TAB = cn(
  // An icon of one size, in a square as tall as the control that closes the
  // panel at the other end of the row (DESIGN.md §7).
  "relative flex size-8 flex-none select-none items-center justify-center rounded-sm text-ink-2",
  "transition-colors duration-fast ease-out [&_svg]:pointer-events-none [&_svg]:size-[18px]",
  "hover:bg-surface-3 hover:text-ink-1 aria-selected:text-ink-1",
  // The lamp: an accent line on the header's bottom edge, under the active
  // tab. The header is 44 px and the tab 32, centred: 6 px below the tab.
  "after:absolute after:inset-x-1.5 after:-bottom-1.5 after:h-0.5 after:rounded-full after:content-['']",
  // Keyed to `aria-selected`: the tooltip around each tab writes its own `data-state` over the tab's.
  "aria-selected:after:bg-accent",
);

/** The tabs whose lasting adjustments are in effect: they say so whether or not they are showing. */
function useInEffect(): ReadonlySet<InspectorTab> {
  const tuned = useSettings((state) => !isNeutral(state.settings.video.picture));
  const equalised = useSettings((state) => state.settings.audio.equaliser.enabled);
  const lit = new Set<InspectorTab>();
  if (tuned) {
    lit.add("video");
  }
  if (equalised) {
    lit.add("audio");
  }
  return lit;
}

/** The first thing in `within` that Tab would reach. */
function firstStop(within: Element | null | undefined): HTMLElement | null {
  const stops = within?.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  return Array.from(stops ?? []).find((stop) => stop.getClientRects().length > 0) ?? null;
}

/** How long the panel is given to leave before it is taken away regardless, in milliseconds. */
const LEAVE_BY_MS = 400;

interface InspectorProps {
  /** It has been closed and is on its way out. */
  leaving?: boolean;
  /** Called once it has gone. */
  onLeft?: () => void;
}

/**
 * The panel beside the picture (DESIGN.md §7). It is drawn in the stage's
 * dark tokens whatever the window's theme, since it stands beside a film,
 * and it takes no room from the picture: the window grows by its width
 * while it is open (see `usePanelRoom`).
 */
export function Inspector({ leaving = false, onLeft }: InspectorProps) {
  const tab = useInterface((state) => state.inspectorTab);
  const setTab = useInterface((state) => state.setTab);
  const hide = useInterface((state) => state.hidePanel);
  const wantsKeyboard = useInterface((state) => state.panelWantsKeyboard);
  const panel = useRef<HTMLElement>(null);
  // The keys that opened this tab close the panel again.
  const closing = TABS.find((each) => each.id === tab)?.action;

  const inEffect = useInEffect();

  // Opened from the keyboard: the keyboard comes with it, to the list of the
  // tab that is showing, or to the first of its controls where it has no
  // list. (Escape gives it back to the picture.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: again when the tab changes under the same request
  useEffect(() => {
    if (!wantsKeyboard) {
      return;
    }
    useInterface.getState().keyboardTaken();
    const showing = panel.current?.querySelector('[role="tabpanel"][data-state="active"]');
    (showing?.querySelector<HTMLElement>('[role="listbox"]') ?? firstStop(showing))?.focus({
      // It is still sliding in from beyond the window's edge: scrolling it
      // into view would shift the whole page sideways under the picture.
      preventScroll: true,
    });
  }, [wantsKeyboard, tab]);

  // If nothing animates (reduced to nothing, or not drawn at all), it still goes.
  useEffect(() => {
    if (!leaving) {
      return;
    }
    // What was selected is forgotten with the panel: a row nobody can see
    // should not go on answering Return and Delete.
    usePlaylistUi.getState().select(null);
    // On its way out it is out of reach: whatever in it had the keyboard gives it up.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && panel.current?.contains(focused)) {
      focused.blur();
    }
    const timer = setTimeout(() => onLeft?.(), LEAVE_BY_MS);
    return () => clearTimeout(timer);
  }, [leaving, onLeft]);

  return (
    <SurfaceProvider value="panel">
      <aside
        ref={panel}
        aria-label="Panel"
        aria-hidden={leaving || undefined}
        onAnimationEnd={(event) => {
          if (leaving && event.target === event.currentTarget) {
            onLeft?.();
          }
        }}
        className={cn(
          "stage absolute inset-y-0 right-0 flex w-inspector flex-col border-l border-line bg-surface-1 text-ink-1",
          // On its way out nothing in it takes a click.
          leaving ? "pointer-events-none animate-slide-out" : "animate-slide-in",
        )}
      >
        <Tabs.Root
          value={tab}
          onValueChange={(next) => setTab(next as InspectorTab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          {/* As tall as the title bar, and it drags the window as the title bar does. */}
          <header
            data-tauri-drag-region
            className="relative flex h-titlebar flex-none items-center gap-1 pl-2 pr-2 before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-line before:content-['']"
          >
            <Tabs.List aria-label="Panel tabs" className="flex flex-none items-center gap-1">
              {TABS.map((each) => (
                <Tooltip
                  key={each.id}
                  label={each.name}
                  shortcut={getAction(each.action)?.shortcuts[0]}
                  side="bottom"
                >
                  <Tabs.Trigger
                    value={each.id}
                    aria-label={inEffect.has(each.id) ? `${each.name}, in effect` : each.name}
                    className={TAB}
                  >
                    <each.icon aria-hidden="true" />
                    {inEffect.has(each.id) ? (
                      // Its lasting adjustments are in effect: said here, where
                      // it can be seen whichever tab is showing.
                      <span
                        aria-hidden="true"
                        data-in-effect=""
                        className="absolute right-1 top-1 size-1 rounded-full bg-accent"
                      />
                    ) : null}
                  </Tabs.Trigger>
                </Tooltip>
              ))}
            </Tabs.List>
            <div data-tauri-drag-region className="h-full min-w-0 flex-1" />
            <IconButton
              label="Hide panel"
              shortcut={closing ? getAction(closing)?.shortcuts[0] : undefined}
              tooltipSide="bottom"
              onClick={hide}
            >
              <PanelRightClose />
            </IconButton>
          </header>
          <Tabs.Content
            value="playlist"
            // The tab is the panel's content, not a stop of its own.
            tabIndex={-1}
            // The tab that is not showing is marked `hidden`, which a display class would undo.
            className="flex min-h-0 flex-1 flex-col outline-none data-[state=inactive]:hidden"
          >
            <PlaylistPanel />
          </Tabs.Content>
          <Tabs.Content
            value="chapters"
            tabIndex={-1}
            className="flex min-h-0 flex-1 flex-col outline-none data-[state=inactive]:hidden"
          >
            <ChaptersPanel />
          </Tabs.Content>
          <Tabs.Content
            value="video"
            tabIndex={-1}
            className="flex min-h-0 flex-1 flex-col outline-none data-[state=inactive]:hidden"
          >
            <VideoPanel />
          </Tabs.Content>
          <Tabs.Content
            value="audio"
            tabIndex={-1}
            className="flex min-h-0 flex-1 flex-col outline-none data-[state=inactive]:hidden"
          >
            <AudioPanel />
          </Tabs.Content>
          <Tabs.Content
            value="subtitles"
            tabIndex={-1}
            className="flex min-h-0 flex-1 flex-col outline-none data-[state=inactive]:hidden"
          >
            <SubtitlesPanel />
          </Tabs.Content>
        </Tabs.Root>
      </aside>
    </SurfaceProvider>
  );
}
