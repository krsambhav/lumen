//! What the player tells the interface: a snapshot of its state, and the
//! changes to it. These cross the IPC boundary, so they are plain data.

use crate::engine::adjust::Shape;
use crate::engine::failure::FailureReason;
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use specta::Type;
use specta_typescript::Number;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackStatus {
    /// Nothing is open.
    Idle,
    /// A file or stream is being opened.
    Loading,
    Playing,
    Paused,
    /// Playing, but waiting for data.
    Buffering,
    /// The last file played to its end and is still open on its last frame.
    Ended,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TrackKind {
    Video,
    Audio,
    Subtitle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    /// mpv's id, unique within its kind.
    pub id: i32,
    pub kind: TrackKind,
    pub title: Option<String>,
    /// Language tag from the file, e.g. "eng".
    pub language: Option<String>,
    /// Short codec name, e.g. "hevc", "ac3", "subrip".
    pub codec: Option<String>,
    pub selected: bool,
    pub default: bool,
    pub forced: bool,
    /// Loaded from a separate file rather than the container.
    pub external: bool,
    /// That file, for a track that is external.
    pub file: Option<String>,
    /// Subtitles only: selected as the second track, shown above the first.
    pub secondary: bool,
    /// Audio only.
    pub channels: Option<i32>,
}

/// Which subtitle track was chosen for a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SubtitleChoice {
    /// None: the user turned them off.
    Off,
    /// The track with this id.
    Track(i32),
}

/// What was chosen for one file. It is kept with the file's place in the
/// history, and set again before the file is next loaded.
///
/// Only choices are kept. A track the player picked by itself is not one:
/// kept, it would stand in the way of a better pick later, when a
/// preference has changed or another subtitle file has turned up.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileState {
    /// The audio track, by mpv's id; `None` leaves the choice to the player.
    pub audio: Option<i32>,
    /// The subtitle track; `None` leaves the choice to the player.
    pub subtitle: Option<SubtitleChoice>,
    pub second_subtitle: Option<i32>,
    /// Subtitle files added by hand.
    pub subtitle_files: Vec<String>,
    /// Seconds.
    #[specta(type = Number)]
    pub audio_delay: f64,
    #[specta(type = Number)]
    pub subtitle_delay: f64,
    /// How much faster than they are timed the subtitles run, when it is
    /// not 1: a file timed for another frame rate, found by syncing.
    #[serde(default)]
    #[specta(type = Option<Number>)]
    pub subtitle_speed: Option<f64>,
    pub shape: Shape,
}

impl FileState {
    /// Nothing was chosen: there is nothing to keep.
    pub fn is_untouched(&self) -> bool {
        *self == Self::default()
    }

    /// Makes a state read from storage safe to apply.
    pub fn sanitised(mut self) -> Self {
        let delay = |seconds: f64, reach: f64| {
            if seconds.is_finite() {
                seconds.clamp(-reach, reach)
            } else {
                0.0
            }
        };
        self.audio_delay = delay(self.audio_delay, 30.0);
        self.subtitle_delay = delay(self.subtitle_delay, MAX_SUBTITLE_DELAY);
        self.subtitle_speed = self.subtitle_speed.filter(|speed| {
            speed.is_finite()
                && (MIN_SUBTITLE_SPEED..=MAX_SUBTITLE_SPEED).contains(speed)
                && *speed != 1.0
        });
        self.shape = self.shape.sanitised();
        self.audio = self.audio.filter(|id| *id > 0);
        self.second_subtitle = self.second_subtitle.filter(|id| *id > 0);
        self.subtitle_files.truncate(16);
        self
    }
}

/// The furthest subtitles can be moved against the picture, in seconds.
/// Further than sound can (`MAX_DELAY`): a subtitle file made for another
/// release of a film can be a minute or more out.
pub const MAX_SUBTITLE_DELAY: f64 = 600.0;

/// The range of subtitle speeds: every ratio of two common frame rates
/// lies well inside it.
pub const MIN_SUBTITLE_SPEED: f64 = 0.9;
pub const MAX_SUBTITLE_SPEED: f64 = 1.1;

/// Somewhere sound can be sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    /// What the engine knows it by.
    pub id: String,
    /// What macOS calls it.
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    pub title: Option<String>,
    /// Start, in seconds.
    #[specta(type = Number)]
    pub time: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DynamicRange {
    Sdr,
    /// HDR10 and other PQ content.
    Pq,
    Hlg,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    /// Display size in pixels, after aspect correction and rotation.
    pub width: i32,
    pub height: i32,
    #[specta(type = Option<Number>)]
    pub fps: Option<f64>,
    pub codec: Option<String>,
    pub dynamic_range: DynamicRange,
    /// The hardware decoder in use, or `None` for software decoding.
    pub hardware_decoder: Option<String>,
}

/// Everything the interface needs to draw the player, at one moment.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshot {
    pub status: PlaybackStatus,
    /// The path or URL that is open.
    pub source: Option<String>,
    pub title: Option<String>,
    /// Seconds from the start.
    #[specta(type = Number)]
    pub position: f64,
    /// Seconds; `None` for live streams and while loading.
    #[specta(type = Option<Number>)]
    pub duration: Option<f64>,
    /// 0–200, where 100 is the file's own level.
    #[specta(type = Number)]
    pub volume: f64,
    pub muted: bool,
    #[specta(type = Number)]
    pub speed: f64,
    /// `None` when the media has no picture.
    pub video: Option<VideoInfo>,
    pub tracks: Vec<Track>,
    pub chapters: Vec<Chapter>,
    /// How much later than the picture the sound is played, in seconds;
    /// negative is earlier. Belongs to the file that is open.
    #[specta(type = Number)]
    pub audio_delay: f64,
    /// How much later than they are timed the subtitles are shown, in seconds.
    #[specta(type = Number)]
    pub subtitle_delay: f64,
    /// How much faster than they are timed the subtitles run: 1 but for a
    /// file timed for another frame rate.
    #[specta(type = Number)]
    pub subtitle_speed: f64,
    /// How the picture is turned, cut and stretched for this file.
    pub shape: Shape,
    /// Where sound can be sent, as macOS lists them.
    pub audio_devices: Vec<AudioDevice>,
    /// The picture is a drawing of the sound, made because the file has none.
    pub visualised: bool,
}

impl Default for PlayerSnapshot {
    fn default() -> Self {
        Self {
            status: PlaybackStatus::Idle,
            source: None,
            title: None,
            position: 0.0,
            duration: None,
            volume: 100.0,
            muted: false,
            speed: 1.0,
            video: None,
            tracks: Vec::new(),
            chapters: Vec::new(),
            audio_delay: 0.0,
            subtitle_delay: 0.0,
            subtitle_speed: 1.0,
            shape: Shape::default(),
            audio_devices: Vec::new(),
            visualised: false,
        }
    }
}

/// One change to the snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PlayerChange {
    Status {
        status: PlaybackStatus,
    },
    /// Something new is being opened, or the player went idle (`source: None`).
    Media {
        source: Option<String>,
        title: Option<String>,
    },
    Position {
        #[specta(type = Number)]
        seconds: f64,
    },
    Duration {
        #[specta(type = Option<Number>)]
        seconds: Option<f64>,
    },
    Volume {
        #[specta(type = Number)]
        percent: f64,
    },
    Muted {
        muted: bool,
    },
    Speed {
        #[specta(type = Number)]
        rate: f64,
    },
    Video {
        video: Option<VideoInfo>,
    },
    Tracks {
        tracks: Vec<Track>,
    },
    Chapters {
        chapters: Vec<Chapter>,
    },
    AudioDelay {
        #[specta(type = Number)]
        seconds: f64,
    },
    SubtitleDelay {
        #[specta(type = Number)]
        seconds: f64,
    },
    SubtitleSpeed {
        #[specta(type = Number)]
        rate: f64,
    },
    Shape {
        shape: Shape,
    },
    AudioDevices {
        devices: Vec<AudioDevice>,
    },
    Visualised {
        visualised: bool,
    },
    /// The file that has just loaded started where it was left last time
    /// rather than at its beginning.
    Resumed {
        #[specta(type = Number)]
        seconds: f64,
    },
    /// `source` could not be opened or stopped playing because of an error.
    Failed {
        source: String,
        reason: FailureReason,
        /// What the Finder can show about it: the file if it is still there,
        /// else the nearest folder that is. Absent for an address.
        reveal: Option<String>,
    },
}

impl PlayerChange {
    /// True for a change that is something that happened rather than a new
    /// value of the state: it is said once, and cannot be read back from a
    /// snapshot afterwards.
    pub fn is_event(&self) -> bool {
        matches!(self, Self::Failed { .. } | Self::Resumed { .. })
    }
}

fn text(node: &Json, key: &str) -> Option<String> {
    node.get(key)
        .and_then(Json::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn flag(node: &Json, key: &str) -> bool {
    node.get(key).and_then(Json::as_bool).unwrap_or(false)
}

fn int(node: &Json, key: &str) -> Option<i32> {
    node.get(key)
        .and_then(Json::as_i64)
        .and_then(|value| i32::try_from(value).ok())
}

/// Reads mpv's `track-list`. Entries of a kind Lumen does not know, or
/// without an id, are skipped rather than guessed at.
pub fn tracks_from(list: &Json) -> Vec<Track> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let kind = match entry.get("type")?.as_str()? {
                "video" => TrackKind::Video,
                "audio" => TrackKind::Audio,
                "sub" => TrackKind::Subtitle,
                _ => return None,
            };
            // Cover art is a "video" track that is a single image; it is
            // not something to list as a video track.
            if kind == TrackKind::Video && (flag(entry, "albumart") || flag(entry, "image")) {
                return None;
            }
            Some(Track {
                id: int(entry, "id")?,
                kind,
                title: text(entry, "title"),
                language: text(entry, "lang"),
                codec: text(entry, "codec"),
                selected: flag(entry, "selected"),
                default: flag(entry, "default"),
                forced: flag(entry, "forced"),
                external: flag(entry, "external"),
                file: text(entry, "external-filename"),
                // mpv numbers the selected tracks of a kind: 0 is the first.
                secondary: kind == TrackKind::Subtitle && int(entry, "main-selection") == Some(1),
                channels: int(entry, "demux-channel-count"),
            })
        })
        .collect()
}

/// Reads mpv's `audio-device-list`, keeping what a person would choose
/// from. mpv lists each device once for every way it can reach it, and puts
/// its own "pick one for me" first; Core Audio's are the ones kept.
pub fn audio_devices_from(list: &Json) -> Vec<AudioDevice> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = text(entry, "name")?;
            id.starts_with("coreaudio/").then(|| AudioDevice {
                name: text(entry, "description").unwrap_or_else(|| id.clone()),
                id,
            })
        })
        .collect()
}

/// Reads mpv's `chapter-list`.
pub fn chapters_from(list: &Json) -> Vec<Chapter> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let time = entry.get("time")?.as_f64()?;
            time.is_finite().then(|| Chapter {
                title: text(entry, "title"),
                time: time.max(0.0),
            })
        })
        .collect()
}

/// The dynamic range from mpv's `video-params` transfer name.
pub fn dynamic_range_from(video_params: &Json) -> DynamicRange {
    match video_params.get("gamma").and_then(Json::as_str) {
        Some("pq") => DynamicRange::Pq,
        Some("hlg") => DynamicRange::Hlg,
        _ => DynamicRange::Sdr,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_tracks_and_skips_cover_art_and_unknown_kinds() {
        let tracks = tracks_from(&json!([
            { "id": 1, "type": "video", "codec": "hevc", "selected": true, "default": true },
            { "id": 2, "type": "video", "codec": "mjpeg", "albumart": true },
            { "id": 1, "type": "audio", "codec": "eac3", "lang": "eng", "title": "Surround",
              "demux-channel-count": 6, "selected": true },
            { "id": 2, "type": "audio", "codec": "aac", "lang": "", "title": "" },
            { "id": 1, "type": "sub", "codec": "subrip", "external": true, "forced": true },
            { "id": 9, "type": "attachment" },
            { "type": "audio" }
        ]));
        assert_eq!(tracks.len(), 4);
        assert_eq!(tracks[0].kind, TrackKind::Video);
        assert_eq!(tracks[0].codec.as_deref(), Some("hevc"));
        assert_eq!(tracks[1].channels, Some(6));
        assert_eq!(tracks[1].language.as_deref(), Some("eng"));
        // Empty strings from the file are "not given", not names.
        assert_eq!(tracks[2].language, None);
        assert_eq!(tracks[2].title, None);
        assert!(tracks[3].external && tracks[3].forced);
        assert_eq!(tracks[3].kind, TrackKind::Subtitle);
    }

    #[test]
    fn knows_the_second_subtitle_track_and_the_file_an_external_one_came_from() {
        let tracks = tracks_from(&json!([
            { "id": 1, "type": "sub", "selected": true, "main-selection": 1 },
            { "id": 2, "type": "sub", "selected": true, "main-selection": 0,
              "external": true, "external-filename": "/films/a.en.srt" },
            { "id": 1, "type": "audio", "selected": true, "main-selection": 1 }
        ]));
        assert!(tracks[0].secondary && tracks[0].selected);
        assert!(!tracks[1].secondary);
        assert_eq!(tracks[1].file.as_deref(), Some("/films/a.en.srt"));
        // "Second" means something only for subtitles.
        assert!(!tracks[2].secondary);
    }

    #[test]
    fn lists_each_output_device_once_by_the_name_macos_gives_it() {
        let devices = audio_devices_from(&json!([
            { "name": "auto", "description": "Autoselect device" },
            { "name": "coreaudio/BuiltInSpeakerDevice", "description": "MacBook Pro Speakers" },
            { "name": "avfoundation/BuiltInSpeakerDevice", "description": "MacBook Pro Speakers" },
            { "name": "coreaudio/AppleUSBAudioEngine:1", "description": "" }
        ]));
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].id, "coreaudio/BuiltInSpeakerDevice");
        assert_eq!(devices[0].name, "MacBook Pro Speakers");
        // No name from macOS: its id is better than nothing.
        assert_eq!(devices[1].name, "coreaudio/AppleUSBAudioEngine:1");
        assert!(audio_devices_from(&Json::Null).is_empty());
    }

    #[test]
    fn a_missing_or_malformed_track_list_is_empty() {
        assert!(tracks_from(&Json::Null).is_empty());
        assert!(tracks_from(&json!({ "not": "a list" })).is_empty());
    }

    #[test]
    fn reads_chapters_and_drops_ones_without_a_time() {
        let chapters = chapters_from(&json!([
            { "title": "Opening", "time": 0.0 },
            { "time": 61.5 },
            { "title": "Broken" },
            { "title": "Negative", "time": -3.0 }
        ]));
        assert_eq!(chapters.len(), 3);
        assert_eq!(chapters[0].title.as_deref(), Some("Opening"));
        assert_eq!(chapters[1].title, None);
        assert_eq!(chapters[1].time, 61.5);
        assert_eq!(chapters[2].time, 0.0);
    }

    #[test]
    fn recognises_hdr_transfers() {
        assert_eq!(
            dynamic_range_from(&json!({ "gamma": "pq" })),
            DynamicRange::Pq
        );
        assert_eq!(
            dynamic_range_from(&json!({ "gamma": "hlg" })),
            DynamicRange::Hlg
        );
        assert_eq!(
            dynamic_range_from(&json!({ "gamma": "bt.1886" })),
            DynamicRange::Sdr
        );
        assert_eq!(dynamic_range_from(&Json::Null), DynamicRange::Sdr);
    }

    #[test]
    fn a_change_serialises_with_its_type_tag() {
        let json = serde_json::to_value(PlayerChange::Position { seconds: 12.5 }).unwrap();
        assert_eq!(json, json!({ "type": "position", "seconds": 12.5 }));
    }
}
