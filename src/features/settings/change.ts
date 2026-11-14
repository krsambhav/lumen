import type {
  AudioSettings,
  Equaliser,
  Picture,
  Settings,
  SubtitleSettings,
  SubtitleStyle,
  VideoSettings,
} from "@/ipc";
import { notifyFailure } from "@/lib/notify";
import { useSettings } from "./store";

/**
 * Changes the settings, and says so if they could not be saved: the store
 * has by then put back what was last accepted, and a control that springs
 * back without a word would be a puzzle.
 */
export function changeSettings(change: (current: Settings) => Settings): void {
  void useSettings
    .getState()
    .update(change)
    .then(() => {
      const failure = useSettings.getState().saveError;
      if (failure !== null) {
        notifyFailure("save that setting", { kind: failure.kind, message: failure.message });
      }
    });
}

export function changeVideo(change: (video: VideoSettings) => VideoSettings): void {
  changeSettings((current) => ({ ...current, video: change(current.video) }));
}

export function changeAudio(change: (audio: AudioSettings) => AudioSettings): void {
  changeSettings((current) => ({ ...current, audio: change(current.audio) }));
}

export function changeSubtitles(change: (subtitles: SubtitleSettings) => SubtitleSettings): void {
  changeSettings((current) => ({ ...current, subtitles: change(current.subtitles) }));
}

export function setPicture(picture: Picture): void {
  changeVideo((video) => ({ ...video, picture }));
}

export function setEqualiser(equaliser: Equaliser): void {
  changeAudio((audio) => ({ ...audio, equaliser }));
}

export function setSubtitleStyle(style: SubtitleStyle): void {
  changeSubtitles((subtitles) => ({ ...subtitles, style }));
}
