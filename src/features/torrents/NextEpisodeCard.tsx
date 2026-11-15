import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { currentPosition, usePlayer } from "@/features/player/store";
import { useQueue } from "@/features/playlist/store";
import { cn } from "@/lib/cn";
import { lookAt, searchFor } from "./episode";
import { formatSeeds } from "./format";
import { useNextEpisode } from "./nextEpisode";

/** How often the film's place is checked against the moment to look. */
const CHECK_EVERY_MS = 1000;

/**
 * Near the end of an episode, looks quietly for the next one, and if one is
 * ready to play, offers it at the bottom right of the picture: "Play next"
 * puts it after this one (fetched in the background), "Not now" lets it be.
 * Nothing is ever added without being asked. The look happens 30 s before
 * the end credits when a chapter says where they start, else a minute
 * before the end, and not at all when something already follows in the
 * playlist. The offer is shown only while the film is past that moment:
 * seeking back hides it, and it comes back as the end nears again.
 */
export function NextEpisodeCard() {
  const source = usePlayer((state) => state.source);
  const title = usePlayer((state) => state.title);
  const playing = usePlayer((state) => state.status === "playing");
  const follow = useNextEpisode((state) => state.follow);
  const status = useNextEpisode((state) => state.status);
  const found = useNextEpisode((state) => state.found);
  const take = useNextEpisode((state) => state.take);
  const dismiss = useNextEpisode((state) => state.dismiss);

  useEffect(() => follow(source, title), [source, title, follow]);

  // Whether the film is past the moment to look, so the offer belongs on screen.
  const [near, setNear] = useState(false);

  useEffect(() => {
    const check = () => {
      const player = usePlayer.getState();
      const at = lookAt(player.chapters, player.duration);
      const past = at !== null && currentPosition(player) >= at;
      setNear(past);
      const next = useNextEpisode.getState();
      if (!past || !playing || next.status !== "waiting" || next.playing === null) {
        return;
      }
      // Something already follows: the playlist knows what is next.
      if (useQueue.getState().hasNext) {
        return;
      }
      next.look();
    };
    check();
    const timer = setInterval(check, CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [playing]);

  if (status !== "found" || found === null || !near) {
    return null;
  }
  const { episode, result } = found;
  return (
    <section
      aria-label="Next episode"
      aria-live="polite"
      className={cn(
        "absolute right-gutter z-chrome w-[min(22rem,calc(100%-2*var(--gutter)))]",
        "bottom-[calc(var(--controlbar-h)+1rem)]",
        "animate-pop-in rounded-lg border border-line-strong bg-surface-2 p-4 shadow-pop",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="label whitespace-nowrap text-ink-3">Next episode found</p>
        <IconButton label="Not now" onClick={dismiss} className="-my-2 -mr-2 flex-none">
          <X />
        </IconButton>
      </div>
      <p className="mt-1 truncate text-heading text-ink-1">{searchFor(episode)}</p>
      <div className="mt-0.5 flex min-w-0 items-center gap-2 text-caption text-ink-3">
        <MiddleTruncate text={result.name} tail={0} className="min-w-0 flex-1" />
        <span className="tabular flex-none whitespace-nowrap">
          {result.size} · {formatSeeds(result.seeders)}
        </span>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Button variant="primary" onClick={take}>
          Play next
        </Button>
        <Button variant="ghost" onClick={dismiss}>
          Not now
        </Button>
      </div>
    </section>
  );
}
