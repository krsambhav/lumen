import "@fontsource-variable/plus-jakarta-sans/wght.css";
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { isTauri, readBoot } from "./app/boot";
import { applyAppearance } from "./design/theme";
import { commands } from "./ipc";
import { trackFocusOrigin } from "./lib/focus-origin";

// Theme and accent are set before React renders, so the first frame is right.
applyAppearance(readBoot().settings.appearance);
// Recording starts before anything can take focus (DESIGN.md §8).
trackFocusOrigin();

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html is missing #root");
}

const root = createRoot(container);

/**
 * Development aids, reached through the URL fragment. They exist only in
 * builds made with VITE_LUMEN_DEVTOOLS; the condition is a build-time
 * constant, so release bundles drop these imports entirely.
 *
 *   #gallery       the component gallery
 *   #mock          the app, on a simulated backend (for browsers and tests)
 *   #mock-film     the same, with a film already open and paused
 *   #mock-queue    the same, with a playlist of five open, the second playing
 *   #mock-history  the same, with nothing open and things played before
 *                  (#mock-history-24 for that many, to fill the window)
 *   #mock-update   the same, with a newer version of Lumen found
 */
async function start() {
  const fragment = window.location.hash;
  if (import.meta.env.VITE_LUMEN_DEVTOOLS && fragment === "#gallery") {
    const { Gallery } = await import("./dev/Gallery");
    root.render(
      <StrictMode>
        <Gallery />
      </StrictMode>,
    );
    if (isTauri()) {
      void commands.appReady();
    }
    return;
  }
  if (import.meta.env.VITE_LUMEN_DEVTOOLS && fragment.includes("mock") && !isTauri()) {
    const { FILM_TRACKS, installMockBackend } = await import("./dev/mockBackend");
    const mock = installMockBackend();
    if (fragment.includes("film")) {
      mock.open({
        source: "/Users/me/Films/The Long Take (2019).mkv",
        duration: 7305,
        position: 2537,
        paused: true,
        chapters: [
          { title: "The Station", time: 0 },
          { title: "Night Train", time: 1260 },
          { title: null, time: 2400 },
          { title: "The Long Take", time: 4020 },
          { title: "Morning", time: 6300 },
        ],
        tracks: [...FILM_TRACKS],
      });
    }
    if (fragment.includes("queue")) {
      mock.lengths["/Users/me/Series/The Crossing S01E05 Low Water.mkv"] = null;
      mock.openQueue(
        [
          "/Users/me/Series/The Crossing S01E01 Departures.mkv",
          "/Users/me/Series/The Crossing S01E02 The Ferryman.mkv",
          "/Users/me/Series/The Crossing S01E03 A Very Long Episode Title That Goes On And On.mkv",
          "/Users/me/Series/The Crossing S01E04 Night Passage.mkv",
          "/Users/me/Series/The Crossing S01E05 Low Water.mkv",
        ],
        { paused: true, at: 600 },
      );
    }
    if (fragment.includes("update")) {
      mock.findUpdate("1.5.0");
    }
    const many = /history-(\d+)/.exec(fragment);
    if (many) {
      mock.seedHistory(
        Array.from({ length: Number(many[1]) }, (_, index) => ({
          source: `/Users/me/Films/Film number ${index + 1}.mkv`,
        })),
      );
    } else if (fragment.includes("history")) {
      mock.seedHistory([
        { source: "/Users/me/Films/The Long Take (2019).mkv", position: 2537 },
        { source: "/Users/me/Films/Solaris (1972).mkv", position: 5200, duration: 9960 },
        { source: "/Users/me/Music/Night Drive.m4a", duration: 247 },
        { source: "/Users/me/Films/A Film That Was Moved.mkv", available: false },
        { source: "/Users/me/Films/Stalker (1979).mkv", finished: true, duration: 9660 },
        { source: "https://example.com/talks/a-lecture", title: "A lecture", duration: null },
      ]);
    }
  }
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
