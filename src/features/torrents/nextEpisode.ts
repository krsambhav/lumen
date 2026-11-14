import { create } from "zustand";
import { commands, type TorrentResult } from "@/ipc";
import {
  type Episode,
  episodeOf,
  firstOfNextSeason,
  isEpisode,
  nextInSeason,
  searchFor,
} from "./episode";
import { useTorrents } from "./store";

/**
 * Where the quiet look for the next episode stands, for what is playing:
 * - `waiting`: not yet near the end.
 * - `looking`: searching now.
 * - `found`: one is ready to play; the card offers it.
 * - `none`: nothing ready was found; nothing is offered.
 * - `done`: the offer was taken or turned down; it is not made again.
 */
export type NextStatus = "waiting" | "looking" | "found" | "none" | "done";

interface NextEpisodeState {
  /** What is playing, for which all this is. */
  source: string | null;
  /** The episode playing, if its name says which. */
  playing: Episode | null;
  status: NextStatus;
  /** The episode found and the release of it to play. */
  found: { episode: Episode; result: TorrentResult } | null;
  /** Follows what is playing; anything about the one before is forgotten. */
  follow: (source: string | null, title: string | null) => void;
  /** Searches quietly for the next episode, then the next season's first. */
  look: () => void;
  /** Fetches the episode found and puts it next in the playlist. */
  take: () => void;
  /** Turns the offer down for this episode. */
  dismiss: () => void;
}

/** The best release of exactly that episode among the results: they come best shared first. */
function bestOf(results: readonly TorrentResult[], episode: Episode): TorrentResult | null {
  return (
    results.find((result) => result.ready !== false && isEpisode(result.name, episode)) ?? null
  );
}

async function search(episode: Episode): Promise<TorrentResult | null> {
  const settled = await commands.torrentsSearch(searchFor(episode));
  return settled.status === "ok" ? bestOf(settled.data, episode) : null;
}

export const useNextEpisode = create<NextEpisodeState>((set, get) => ({
  source: null,
  playing: null,
  status: "waiting",
  found: null,

  follow: (source, title) => {
    const current = get();
    if (current.source === source) {
      // The same film under a better name: what it is may only now be known.
      if (current.playing === null) {
        set({ playing: episodeOf(title) });
      }
      return;
    }
    set({ source, playing: episodeOf(title), status: "waiting", found: null });
  },

  look: () => {
    const { playing, status, source } = get();
    if (playing === null || status !== "waiting") {
      return;
    }
    set({ status: "looking" });
    void (async () => {
      const next = nextInSeason(playing);
      let episode = next;
      let result = await search(next);
      if (result === null) {
        // The last of a season: the next one may have begun.
        episode = firstOfNextSeason(playing);
        result = await search(episode);
      }
      // Something else may have started playing meanwhile.
      if (get().source !== source) {
        return;
      }
      set(
        result === null
          ? { status: "none", found: null }
          : { status: "found", found: { episode, result } },
      );
    })();
  },

  take: () => {
    const { found } = get();
    if (found === null) {
      return;
    }
    // Fetched in the background; a toast says when it is next.
    useTorrents.getState().choose(found.result, "next");
    set({ status: "done" });
  },

  dismiss: () => set({ status: "done" }),
}));

/** The search for the episode after the one playing, if a name says which one that is. */
export function nextEpisodeSearch(title: string | null | undefined): string | null {
  const playing = episodeOf(title);
  return playing === null ? null : searchFor(nextInSeason(playing));
}

/** The search for the first episode of the next season, for when this was a season's last. */
export function nextSeasonSearch(title: string | null | undefined): string | null {
  const playing = episodeOf(title);
  return playing === null ? null : searchFor(firstOfNextSeason(playing));
}
