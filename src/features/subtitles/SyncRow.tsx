import { Button } from "@/components/ui/button";
import { usePlayer } from "@/features/player/store";
import { shownSubtitle } from "@/features/player/tracks";
import { cn } from "@/lib/cn";
import {
  cancelSync,
  type SyncView,
  sizeText,
  startSync,
  syncedDetail,
  syncedSpoken,
  syncedText,
  syncUnavailable,
  syncView,
  undoSync,
  useSubtitleSync,
} from "./sync";

/** The sync as it concerns the subtitles showing now. */
export function useSyncView(): SyncView {
  const status = useSubtitleSync((state) => state.status);
  const source = usePlayer((state) => state.source);
  const track = usePlayer((state) => shownSubtitle(state.tracks)?.id);
  const unavailable = usePlayer((state) => syncUnavailable(state.source, state.tracks));
  return syncView(status, source, track, unavailable);
}

/** What the row says under its name. */
function hintOf(view: SyncView): { text: string; detail?: string } {
  switch (view.state) {
    case "unavailable":
      return { text: view.reason };
    case "ready":
      return view.installed
        ? { text: "Listens to a few moments of the film and lines the subtitles up." }
        : {
            text: "Listens to a few moments of the film and lines the subtitles up.",
            detail: "The first time, it downloads a 60 MB speech model that runs on this Mac.",
          };
    case "installing":
      return {
        text: `Downloading the speech model… ${Math.round(view.progress * 100)}%`,
        detail: `${sizeText(view.size)}, once. Nothing leaves this Mac.`,
      };
    case "listening":
      return { text: `Listening… ${view.done} of ${view.total}` };
    case "synced":
      return { text: syncedText(view), detail: syncedDetail(view) };
    case "failed":
      return { text: view.message };
  }
}

/** How far a download or a listen has come, 0–1; undefined when nothing is under way. */
function progressOf(view: SyncView): number | undefined {
  if (view.state === "installing") {
    return view.progress;
  }
  if (view.state === "listening") {
    return view.total === 0 ? 0 : view.done / view.total;
  }
  return undefined;
}

/**
 * Sync to speech (DESIGN.md §7): one row of the Subtitles tab's Track
 * group. Its button does the one thing that makes sense now: Sync,
 * Cancel while it works, Undo once it has. Under the name, what it is
 * doing or what it did; a hairline beneath fills as it goes.
 */
export function SyncRow() {
  const view = useSyncView();
  const hint = hintOf(view);
  const progress = progressOf(view);
  const busy = progress !== undefined;
  const button =
    view.state === "synced"
      ? { label: "Undo", run: undoSync }
      : busy
        ? { label: "Cancel", run: cancelSync }
        : { label: view.state === "failed" ? "Try again" : "Sync", run: startSync };
  return (
    <div className="flex min-w-0 flex-col pb-1.5">
      <div className="flex h-8 min-w-0 items-center gap-3">
        <span id="subtitle-sync-name" className="min-w-0 flex-1 truncate text-body text-ink-2">
          Sync to speech
        </span>
        <Button
          variant="secondary"
          size="sm"
          className="min-w-[5.75rem] flex-none"
          aria-describedby="subtitle-sync-name"
          disabled={view.state === "unavailable"}
          onClick={button.run}
        >
          {button.label}
        </Button>
      </div>
      <span
        className={cn(
          "text-caption",
          view.state === "synced" ? "text-ink-1" : "text-ink-3",
          busy && "tabular-nums",
        )}
        role="status"
        aria-live="polite"
        aria-label={view.state === "synced" ? syncedSpoken(view) : undefined}
      >
        {hint.text}
      </span>
      {hint.detail ? <span className="text-caption text-ink-3">{hint.detail}</span> : null}
      {busy ? (
        <div
          className="mt-2 h-0.5 overflow-hidden rounded-full bg-line-strong"
          role="progressbar"
          aria-labelledby="subtitle-sync-name"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((progress ?? 0) * 100)}
        >
          <div
            className="h-full origin-left rounded-full bg-ink-1 transition-transform duration-base ease-out motion-reduce:transition-none"
            style={{ transform: `scaleX(${progress ?? 0})` }}
          />
        </div>
      ) : null}
    </div>
  );
}
