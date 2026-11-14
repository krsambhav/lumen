import { ChevronsRight } from "lucide-react";
import { useEffect, useState } from "react";
import { runAction } from "@/actions/registry";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { skippableAt } from "./chapters";
import { currentPosition, hasMedia, usePlayer } from "./store";

/** How often the film's place is looked at while it plays, to know when a recap starts and ends. */
const LOOK_EVERY_MS = 250;

/**
 * "Skip recap" or "Skip intro", at the bottom right of the picture while a
 * chapter of that name plays (the way streaming services offer it). It is
 * an offer: nothing is skipped unless it is chosen. It stays while the rest
 * of the chrome dims, because the moment to take it is now, and sits above
 * the control bar's line so the two never meet.
 */
export function SkipButton() {
  const chapters = usePlayer((state) => state.chapters);
  const duration = usePlayer((state) => state.duration);
  const playing = usePlayer((state) => state.status === "playing");
  const open = usePlayer(hasMedia);
  // Re-read on the player's own updates, and on a clock while it plays.
  usePlayer((state) => state.position);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!playing) {
      return;
    }
    const timer = setInterval(() => tick((n) => n + 1), LOOK_EVERY_MS);
    return () => clearInterval(timer);
  }, [playing]);

  const part = open ? skippableAt(chapters, currentPosition(usePlayer.getState()), duration) : null;
  if (part === null) {
    return null;
  }
  const label = part.kind === "recap" ? "Skip recap" : "Skip intro";
  return (
    <div
      className={cn(
        "pointer-events-none absolute right-gutter z-chrome flex justify-end",
        "bottom-[calc(var(--controlbar-h)+1rem)]",
      )}
    >
      <Button
        key={part.kind}
        variant="secondary"
        aria-keyshortcuts="Shift+S"
        className="pointer-events-auto h-9 animate-fade-in gap-2 border-line-strong bg-surface-2 px-4 shadow-pop"
        onClick={() => runAction("playback.skipSegment", "control")}
      >
        {label}
        <ChevronsRight aria-hidden="true" className="size-4 flex-none" />
      </Button>
    </div>
  );
}
