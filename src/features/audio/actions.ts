import { AudioLines, Languages, SlidersVertical, Timer } from "lucide-react";
import type { Action, ActionContext } from "@/actions/registry";
import { confirm, needsMedia } from "@/features/player/actions";
import { delayText, MAX_DELAY, setAudioDelay } from "@/features/player/adjust";
import { usePlayer } from "@/features/player/store";
import { playingAudio, trackName, tracksOf } from "@/features/player/tracks";
import { showing } from "@/features/playlist/actions";
import { setEqualiser } from "@/features/settings/change";
import { useSettings } from "@/features/settings/store";
import { useInterface } from "@/features/shell/interface";
import { commands, type Track } from "@/ipc";
import { send } from "@/lib/notify";

/** What one press of a delay key moves the sound by, in seconds. */
export const AUDIO_DELAY_STEP = 0.025;

function audioTracks(): Track[] {
  return tracksOf(usePlayer.getState().tracks, "audio");
}

function needsSound(): string | undefined {
  return needsMedia() ?? (audioTracks().length === 0 ? "This file has no sound" : undefined);
}

/** Plays `track`, and says which it is. */
export function chooseAudio(context: ActionContext, track: Track) {
  send("change the audio track", commands.playerSelectTrack("audio", track.id));
  confirm(context, { label: "Audio", value: trackName(track) });
}

function moveSound(context: ActionContext, seconds: number) {
  setAudioDelay(seconds);
  const shown = usePlayer.getState().audioDelay;
  confirm(context, {
    label: "Audio delay",
    value: delayText(shown),
    scale: { at: (shown + 1) / 2, mark: 0.5 },
  });
}

/** The actions of the sound, beyond its volume. */
export const audioActions: readonly Action[] = [
  {
    id: "audio.nextTrack",
    name: "Next audio track",
    keywords: ["language", "dub", "commentary", "soundtrack", "switch"],
    category: "audio",
    icon: Languages,
    shortcuts: ["a"],
    unavailable: () =>
      needsSound() ?? (audioTracks().length < 2 ? "There is only one audio track" : undefined),
    run: (context) => {
      const tracks = audioTracks();
      const at = tracks.findIndex((track) => track.id === playingAudio(tracks)?.id);
      const next = tracks[(at + 1) % tracks.length];
      if (next) {
        chooseAudio(context, next);
      }
    },
  },
  {
    id: "audio.later",
    name: "Sound later",
    keywords: ["delay", "sync", "lip sync", "lag", "audio"],
    category: "audio",
    icon: Timer,
    shortcuts: ["Ctrl+="],
    repeats: true,
    unavailable: () =>
      needsSound() ??
      (usePlayer.getState().audioDelay >= MAX_DELAY ? "This is as late as it goes" : undefined),
    run: (context) => moveSound(context, usePlayer.getState().audioDelay + AUDIO_DELAY_STEP),
  },
  {
    id: "audio.earlier",
    name: "Sound earlier",
    keywords: ["delay", "sync", "lip sync", "advance", "audio"],
    category: "audio",
    icon: Timer,
    shortcuts: ["Ctrl+-"],
    repeats: true,
    unavailable: () =>
      needsSound() ??
      (usePlayer.getState().audioDelay <= -MAX_DELAY ? "This is as early as it goes" : undefined),
    run: (context) => moveSound(context, usePlayer.getState().audioDelay - AUDIO_DELAY_STEP),
  },
  {
    id: "audio.resetDelay",
    name: "Sound in time",
    keywords: ["delay", "sync", "reset", "audio"],
    category: "audio",
    icon: Timer,
    shortcuts: [],
    unavailable: () =>
      needsSound() ??
      (usePlayer.getState().audioDelay === 0 ? "The sound is not delayed" : undefined),
    run: (context) => moveSound(context, 0),
  },
  {
    id: "audio.equaliser",
    name: "Equaliser",
    keywords: ["eq", "bass", "treble", "tone", "bands"],
    category: "audio",
    icon: SlidersVertical,
    shortcuts: ["e"],
    checked: () => useSettings.getState().settings.audio.equaliser.enabled,
    run: (context) => {
      const equaliser = useSettings.getState().settings.audio.equaliser;
      setEqualiser({ ...equaliser, enabled: !equaliser.enabled });
      confirm(context, { label: "Equaliser", value: equaliser.enabled ? "Off" : "On" });
    },
  },
  {
    id: "view.audio",
    name: "Show audio adjustments",
    label: () => (showing("audio") ? "Hide audio adjustments" : "Show audio adjustments"),
    keywords: ["equaliser", "eq", "tracks", "output", "device", "delay", "panel", "sound"],
    category: "view",
    icon: AudioLines,
    shortcuts: ["Shift+Cmd+a"],
    unavailable: needsMedia,
    run: (context) => useInterface.getState().togglePanel("audio", context.source === "keyboard"),
  },
];
