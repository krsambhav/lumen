import { AudioWaveform, Captions, FilePlus2, Timer } from "lucide-react";
import type { Action, ActionContext } from "@/actions/registry";
import { confirm, needsMedia } from "@/features/player/actions";
import { delayText, MAX_SUBTITLE_DELAY, setSubtitleDelay } from "@/features/player/adjust";
import { usePlayer } from "@/features/player/store";
import { shownSubtitle, trackName, tracksOf } from "@/features/player/tracks";
import { showing } from "@/features/playlist/actions";
import { useInterface } from "@/features/shell/interface";
import { commands, type Track } from "@/ipc";
import { notifyFailure, send } from "@/lib/notify";
import { startSync, syncUnavailable, useSubtitleSync } from "./sync";

/** What one press of a delay key moves subtitles by, in seconds. */
export const SUBTITLE_DELAY_STEP = 0.05;

function subtitleTracks(): Track[] {
  return tracksOf(usePlayer.getState().tracks, "subtitle");
}

function needsSubtitles(): string | undefined {
  return needsMedia() ?? (subtitleTracks().length === 0 ? "This file has no subtitles" : undefined);
}

/** Shows `track`, or no subtitles, and says which. */
export function chooseSubtitles(context: ActionContext, track: Track | null) {
  send("change the subtitles", commands.playerSelectTrack("subtitle", track?.id ?? null));
  confirm(context, { label: "Subtitles", value: track ? trackName(track) : "Off" });
}

function moveSubtitles(context: ActionContext, seconds: number) {
  setSubtitleDelay(seconds);
  const shown = usePlayer.getState().subtitleDelay;
  confirm(context, {
    label: "Subtitle delay",
    value: delayText(shown),
    scale: { at: Math.min(1, Math.max(0, (shown + 5) / 10)), mark: 0.5 },
  });
}

/** The actions of the subtitles. */
export const subtitleActions: readonly Action[] = [
  {
    id: "subtitles.toggle",
    name: "Show or hide subtitles",
    label: () => (shownSubtitle(usePlayer.getState().tracks) ? "Hide subtitles" : "Show subtitles"),
    keywords: ["captions", "cc", "subs", "on", "off"],
    category: "subtitles",
    icon: Captions,
    shortcuts: ["c"],
    unavailable: needsSubtitles,
    run: (context) => {
      const tracks = usePlayer.getState().tracks;
      const showingNow = shownSubtitle(tracks);
      void commands.playerToggleSubtitles().then((result) => {
        if (result.status === "error") {
          notifyFailure("change the subtitles", result.error);
          return;
        }
        if (!result.data) {
          confirm(context, { label: "Subtitles", value: "Off" });
          return;
        }
        // Which track came back is known once the player says so.
        const shown = shownSubtitle(usePlayer.getState().tracks) ?? showingNow;
        confirm(context, { label: "Subtitles", value: shown ? trackName(shown) : "On" });
      });
    },
  },
  {
    id: "subtitles.next",
    name: "Next subtitle track",
    keywords: ["captions", "language", "switch", "subs"],
    category: "subtitles",
    icon: Captions,
    shortcuts: ["Shift+c"],
    unavailable: needsSubtitles,
    run: (context) => {
      // Through each track in turn, and then none.
      const tracks = subtitleTracks();
      const at = tracks.findIndex((track) => track.selected && !track.secondary);
      chooseSubtitles(context, tracks[at + 1] ?? (at < 0 ? (tracks[0] ?? null) : null));
    },
  },
  {
    id: "subtitles.later",
    name: "Subtitles later",
    keywords: ["delay", "sync", "timing", "late", "captions"],
    category: "subtitles",
    icon: Timer,
    shortcuts: ["h"],
    repeats: true,
    unavailable: () =>
      needsSubtitles() ??
      (usePlayer.getState().subtitleDelay >= MAX_SUBTITLE_DELAY
        ? "This is as late as they go"
        : undefined),
    run: (context) =>
      moveSubtitles(context, usePlayer.getState().subtitleDelay + SUBTITLE_DELAY_STEP),
  },
  {
    id: "subtitles.earlier",
    name: "Subtitles earlier",
    keywords: ["delay", "sync", "timing", "early", "captions"],
    category: "subtitles",
    icon: Timer,
    shortcuts: ["g"],
    repeats: true,
    unavailable: () =>
      needsSubtitles() ??
      (usePlayer.getState().subtitleDelay <= -MAX_SUBTITLE_DELAY
        ? "This is as early as they go"
        : undefined),
    run: (context) =>
      moveSubtitles(context, usePlayer.getState().subtitleDelay - SUBTITLE_DELAY_STEP),
  },
  {
    id: "subtitles.resetDelay",
    name: "Subtitles in time",
    keywords: ["delay", "sync", "reset", "timing", "captions"],
    category: "subtitles",
    icon: Timer,
    shortcuts: [],
    unavailable: () =>
      needsSubtitles() ??
      (usePlayer.getState().subtitleDelay === 0 ? "The subtitles are not delayed" : undefined),
    run: (context) => moveSubtitles(context, 0),
  },
  {
    id: "subtitles.sync",
    name: "Sync subtitles to speech",
    keywords: [
      "sync",
      "auto",
      "timing",
      "align",
      "match",
      "offset",
      "drift",
      "whisper",
      "captions",
    ],
    category: "subtitles",
    icon: AudioWaveform,
    shortcuts: [],
    unavailable: () => {
      const { status } = useSubtitleSync.getState();
      if (status.state === "installing" || status.state === "listening") {
        return "The subtitles are being synced";
      }
      return syncUnavailable();
    },
    run: (context) => {
      startSync();
      // How it goes is told in the Subtitles tab, which opens to show it.
      if (!showing("subtitles")) {
        useInterface.getState().togglePanel("subtitles", context.source === "keyboard");
      }
    },
  },
  {
    id: "subtitles.add",
    name: "Add subtitle file…",
    keywords: ["srt", "ass", "vtt", "load", "open", "captions", "external"],
    category: "subtitles",
    icon: FilePlus2,
    shortcuts: ["Alt+Cmd+s"],
    unavailable: needsMedia,
    run: () => send("add subtitles", commands.playerAddSubtitlesDialog()),
  },
  {
    id: "view.subtitles",
    name: "Show subtitle adjustments",
    label: () => (showing("subtitles") ? "Hide subtitle adjustments" : "Show subtitle adjustments"),
    keywords: ["captions", "tracks", "delay", "font", "size", "style", "panel"],
    category: "view",
    icon: Captions,
    shortcuts: ["Shift+Cmd+s"],
    unavailable: needsMedia,
    run: (context) =>
      useInterface.getState().togglePanel("subtitles", context.source === "keyboard"),
  },
];
