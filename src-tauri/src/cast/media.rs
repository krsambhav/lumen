//! What a cast device is sent, and how it is made.
//!
//! A film goes to a device in one of three ways, cheapest first:
//!
//! - **Direct**: the device can play the file as it is, so it is served as
//!   it is, with byte ranges, and the device seeks in it by itself.
//! - **Remux**: the device can decode the picture but not read the
//!   container (MKV, AVI) or the sound (DTS, FLAC): FFmpeg copies the picture
//!   into MP4 and converts only the sound. This costs almost nothing.
//! - **Transcode**: the picture itself has to be encoded again, on the
//!   Mac's media engine (VideoToolbox), because the device cannot decode it
//!   or because subtitles have to be drawn into it.
//!
//! Subtitles that are text go to a Chromecast as WebVTT beside the film, so
//! they can be switched on the TV without starting again. Everything else
//! (pictures of text, as on Blu-ray, and any subtitles at all over AirPlay,
//! whose receivers take none from a sender) is drawn into the picture.

use std::path::{Path, PathBuf};

use serde_json::Value as Json;

use crate::engine::types::{Track, TrackKind};
use crate::error::{AppError, AppResult};
use crate::media::tools::{self, Tool};

/// What a kind of device can play without help.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    /// Google Cast. `hevc` for the models that decode it (Ultra, Google TV).
    Chromecast { hevc: bool },
    /// An Apple TV or a TV with AirPlay, through AVFoundation.
    AirPlay,
}

impl Profile {
    fn plays_video(self, video: &VideoStream) -> bool {
        let eight_bit = matches!(
            video.pix_fmt.as_deref(),
            Some("yuv420p" | "yuvj420p") | None
        );
        match (self, video.codec.as_str()) {
            // High profile at most, and a level the first Chromecasts manage.
            (Self::Chromecast { .. }, "h264") => {
                eight_bit
                    && video.level.is_none_or(|level| level <= 42)
                    && !matches!(video.profile.as_deref(), Some(p) if p.contains("4:4:4") || p.contains("4:2:2") || p.contains("10"))
            }
            (Self::Chromecast { hevc }, "hevc") => hevc,
            (Self::AirPlay, "h264") => eight_bit,
            (Self::AirPlay, "hevc") => true,
            _ => false,
        }
    }

    fn plays_audio(self, codec: &str) -> bool {
        match self {
            Self::Chromecast { .. } => matches!(codec, "aac" | "mp3" | "opus" | "vorbis" | "flac"),
            Self::AirPlay => matches!(codec, "aac" | "mp3" | "ac3" | "eac3" | "alac"),
        }
    }

    /// Containers the device reads by itself, by FFmpeg's name for them.
    fn reads_container(self, format: &str) -> bool {
        format
            .split(',')
            .any(|name| matches!(name, "mp4" | "mov" | "m4a"))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct VideoStream {
    pub codec: String,
    pub profile: Option<String>,
    pub pix_fmt: Option<String>,
    pub level: Option<i64>,
    pub height: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AudioStream {
    pub codec: String,
    pub channels: Option<i64>,
    pub default: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SubtitleStream {
    pub codec: String,
}

/// What FFmpeg finds in a file: its container and streams, each kind in the
/// order the file has them, which is also the order of mpv's ids for them.
#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    pub format: String,
    pub duration: Option<f64>,
    pub video: Option<VideoStream>,
    pub audio: Vec<AudioStream>,
    pub subtitles: Vec<SubtitleStream>,
}

impl Probe {
    /// Asks ffprobe about `source`, a path or an address.
    pub fn of(source: &str) -> AppResult<Self> {
        let mut command = tools::command(Tool::Ffprobe)
            .ok_or_else(|| AppError::Internal("ffprobe is missing".to_owned()))?;
        let output = command
            .args([
                "-v",
                "error",
                "-of",
                "json",
                "-show_format",
                "-show_streams",
            ])
            .arg(source)
            .output()
            .map_err(|error| AppError::Internal(format!("ffprobe would not run: {error}")))?;
        if !output.status.success() {
            return Err(AppError::Invalid(
                "this can't be cast: Lumen can't read it as a film".to_owned(),
            ));
        }
        let json: Json = serde_json::from_slice(&output.stdout)
            .map_err(|error| AppError::Internal(format!("ffprobe said nonsense: {error}")))?;
        Ok(Self::from_json(&json))
    }

    pub fn from_json(json: &Json) -> Self {
        let text =
            |value: &Json, key: &str| value.get(key).and_then(Json::as_str).map(str::to_owned);
        let mut probe = Self {
            format: json
                .pointer("/format/format_name")
                .and_then(Json::as_str)
                .unwrap_or_default()
                .to_owned(),
            duration: json
                .pointer("/format/duration")
                .and_then(Json::as_str)
                .and_then(|text| text.parse().ok())
                .filter(|seconds: &f64| seconds.is_finite() && *seconds > 0.0),
            video: None,
            audio: Vec::new(),
            subtitles: Vec::new(),
        };
        for stream in json
            .get("streams")
            .and_then(Json::as_array)
            .into_iter()
            .flatten()
        {
            let codec = text(stream, "codec_name").unwrap_or_default();
            let picture = stream
                .pointer("/disposition/attached_pic")
                .and_then(Json::as_i64)
                == Some(1);
            match stream.get("codec_type").and_then(Json::as_str) {
                Some("video") if !picture && probe.video.is_none() => {
                    probe.video = Some(VideoStream {
                        codec,
                        profile: text(stream, "profile"),
                        pix_fmt: text(stream, "pix_fmt"),
                        level: stream.get("level").and_then(Json::as_i64),
                        height: stream.get("height").and_then(Json::as_i64),
                    });
                }
                Some("audio") => probe.audio.push(AudioStream {
                    codec,
                    channels: stream.get("channels").and_then(Json::as_i64),
                    default: stream
                        .pointer("/disposition/default")
                        .and_then(Json::as_i64)
                        == Some(1),
                }),
                Some("subtitle") => probe.subtitles.push(SubtitleStream { codec }),
                _ => {}
            }
        }
        probe
    }
}

/// Subtitle formats that are text, which can be turned into WebVTT.
pub fn is_text_subtitle(codec: &str) -> bool {
    matches!(
        codec,
        "subrip"
            | "srt"
            | "ass"
            | "ssa"
            | "webvtt"
            | "mov_text"
            | "text"
            | "sami"
            | "microdvd"
            | "subviewer"
            | "subviewer1"
            | "realtext"
            | "jacosub"
            | "mpl2"
            | "pjs"
            | "vplayer"
            | "stl"
    )
}

/// Where a subtitle track's cues are.
#[derive(Debug, Clone, PartialEq)]
pub enum SubtitleSource {
    /// The n-th subtitle stream of the film itself.
    Embedded(usize),
    /// A file of its own.
    External(PathBuf),
}

/// One subtitle track as the device will be offered it.
#[derive(Debug, Clone, PartialEq)]
pub struct SubtitleTrack {
    /// mpv's id for it.
    pub id: i32,
    pub source: SubtitleSource,
    pub text: bool,
    pub name: String,
    pub language: Option<String>,
}

/// What the user has chosen in the player, as far as casting cares.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Choice {
    /// The n-th audio stream of the film, if not the file's own default.
    pub audio: Option<usize>,
    /// The subtitle track showing, if any.
    pub subtitle: Option<i32>,
    /// Seconds subtitles are shown late (negative: early).
    pub subtitle_delay: f64,
}

/// Every subtitle track mpv knows of that can be cast, from its track list.
pub fn subtitle_tracks(tracks: &[Track], probe: &Probe) -> Vec<SubtitleTrack> {
    let mut embedded = 0usize;
    let mut out = Vec::new();
    for track in tracks
        .iter()
        .filter(|track| track.kind == TrackKind::Subtitle)
    {
        let codec = track.codec.clone().unwrap_or_default();
        let source = if track.external {
            match track.file.as_deref() {
                // Only files on this Mac: an address would be fetched by FFmpeg each time.
                Some(file) if !file.contains("://") => {
                    SubtitleSource::External(PathBuf::from(file))
                }
                _ => continue,
            }
        } else {
            let index = embedded;
            embedded += 1;
            if index >= probe.subtitles.len() {
                continue;
            }
            SubtitleSource::Embedded(index)
        };
        let name = track
            .title
            .clone()
            .or_else(|| track.language.clone())
            .unwrap_or_else(|| format!("Track {}", track.id));
        out.push(SubtitleTrack {
            id: track.id,
            source,
            text: is_text_subtitle(&codec),
            name,
            language: track.language.clone(),
        });
    }
    out
}

/// The audio and subtitle choices in the player's track list.
pub fn choice_from(tracks: &[Track], subtitle_delay: f64) -> Choice {
    let audio = tracks
        .iter()
        .filter(|track| track.kind == TrackKind::Audio && !track.external)
        .position(|track| track.selected);
    let subtitle = tracks
        .iter()
        .find(|track| track.kind == TrackKind::Subtitle && track.selected && !track.secondary)
        .map(|track| track.id);
    Choice {
        audio,
        subtitle,
        subtitle_delay,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Delivery {
    Direct,
    Remux,
    Transcode,
}

#[derive(Debug, Clone, PartialEq)]
pub enum VideoPlan {
    None,
    Copy,
    /// Encoded again on the media engine, at most this many lines tall.
    Encode {
        hevc: bool,
        max_height: i64,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum AudioPlan {
    None,
    Copy,
    /// To AAC with at most this many channels.
    Aac {
        channels: i64,
    },
}

/// How one film is to be made for one device.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub delivery: Delivery,
    pub video: VideoPlan,
    pub audio: AudioPlan,
    /// The n-th audio stream, if it is not the first.
    pub audio_stream: usize,
    /// Subtitles drawn into the picture.
    pub burn: Option<SubtitleTrack>,
    /// Subtitle tracks sent beside the film, for a device that takes them.
    pub side: Vec<SubtitleTrack>,
    /// The one of `side` showing.
    pub side_active: Option<i32>,
    /// The film's picture is HEVC.
    pub hevc_source: bool,
}

/// Decides how a film reaches a device.
pub fn plan(probe: &Probe, profile: Profile, choice: &Choice, subtitles: &[SubtitleTrack]) -> Plan {
    let chosen = choice
        .subtitle
        .and_then(|id| subtitles.iter().find(|track| track.id == id))
        .cloned();
    let (burn, side, side_active) = match profile {
        Profile::Chromecast { .. } => {
            let side: Vec<SubtitleTrack> = subtitles.iter().filter(|t| t.text).cloned().collect();
            match chosen {
                Some(track) if track.text => (None, side, Some(track.id)),
                Some(track) => (Some(track), side, None),
                None => (None, side, None),
            }
        }
        Profile::AirPlay => (chosen, Vec::new(), None),
    };

    let default_audio = probe
        .audio
        .iter()
        .position(|audio| audio.default)
        .unwrap_or(0);
    let audio_stream = choice
        .audio
        .unwrap_or(default_audio)
        .min(probe.audio.len().saturating_sub(1));
    let audio = probe
        .audio
        .get(audio_stream)
        .map_or(AudioPlan::None, |audio| {
            if profile.plays_audio(&audio.codec) {
                AudioPlan::Copy
            } else {
                let most = if matches!(profile, Profile::AirPlay) {
                    6
                } else {
                    2
                };
                AudioPlan::Aac {
                    channels: audio.channels.unwrap_or(2).clamp(1, most),
                }
            }
        });
    let video = match &probe.video {
        None => VideoPlan::None,
        Some(video) if burn.is_none() && profile.plays_video(video) => VideoPlan::Copy,
        Some(video) => {
            let hevc = match profile {
                Profile::AirPlay => video.codec == "hevc" || video.height.unwrap_or(0) > 1080,
                Profile::Chromecast { hevc } => hevc && video.height.unwrap_or(0) > 1080,
            };
            VideoPlan::Encode {
                hevc,
                max_height: if hevc { 2160 } else { 1080 },
            }
        }
    };
    let direct = profile.reads_container(&probe.format)
        && video != VideoPlan::None
        && matches!(video, VideoPlan::Copy)
        && matches!(audio, AudioPlan::Copy | AudioPlan::None)
        && audio_stream == default_audio
        && burn.is_none();
    let delivery = if direct {
        Delivery::Direct
    } else if matches!(video, VideoPlan::Encode { .. }) {
        Delivery::Transcode
    } else {
        Delivery::Remux
    };
    Plan {
        delivery,
        video,
        audio,
        audio_stream,
        burn,
        side,
        side_active,
        hevc_source: probe
            .video
            .as_ref()
            .is_some_and(|video| video.codec == "hevc"),
    }
}

/// How FFmpeg writes what it makes.
#[derive(Debug, Clone, PartialEq)]
pub enum Output {
    /// Fragmented MP4 on its standard output, for a device that reads a
    /// stream as it comes (Chromecast).
    Fragmented,
    /// HTTP Live Streaming into a folder, for AVFoundation.
    Hls { dir: PathBuf },
}

/// Escapes a path for FFmpeg's filter syntax, quoted.
fn filter_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    let mut out = String::with_capacity(text.len() + 2);
    out.push('\'');
    for ch in text.chars() {
        match ch {
            '\'' => out.push_str("'\\''"),
            ':' | '\\' | ',' | ';' | '[' | ']' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out.push('\'');
    out
}

/// FFmpeg's arguments for making `plan` of `source`, from `start` seconds in.
/// `delay` is how late drawn-in subtitles are shown.
pub fn ffmpeg_args(
    source: &str,
    plan: &Plan,
    start: f64,
    delay: f64,
    output: &Output,
) -> Vec<String> {
    let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error"]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    if source.contains("://") {
        args.extend(["-reconnect", "1", "-reconnect_streamed", "1"].map(str::to_owned));
    }
    let start = start.max(0.0);
    if start > 0.0 {
        args.extend(["-ss".to_owned(), format!("{start:.3}")]);
    }
    args.extend(["-i".to_owned(), source.to_owned()]);

    let mut video_filters: Vec<String> = Vec::new();
    let mut complex: Option<String> = None;
    if let VideoPlan::Encode { max_height, .. } = plan.video {
        // Never taller than the device wants, and an even width.
        let scale = format!("scale=-2:'min(ih,{max_height})'");
        match &plan.burn {
            Some(track) if track.text => {
                // The subtitles filter reads cue times from the file, but the
                // frames it is given start at zero: they are put back where
                // they are in the film for it, and taken back after.
                let file = match &track.source {
                    SubtitleSource::External(path) => filter_path(path),
                    SubtitleSource::Embedded(_) => filter_path(Path::new(source)),
                };
                let index = match track.source {
                    SubtitleSource::Embedded(n) => format!(":si={n}"),
                    SubtitleSource::External(_) => String::new(),
                };
                let shift = start - delay;
                video_filters.push(format!("setpts=PTS+({shift:.3})/TB"));
                video_filters.push(format!("subtitles=filename={file}{index}"));
                video_filters.push("setpts=PTS-STARTPTS".to_owned());
                video_filters.push(scale);
            }
            Some(track) => {
                if let SubtitleSource::Embedded(n) = track.source {
                    complex = Some(format!(
                        "[0:v:0][0:s:{n}]overlay=eof_action=pass,{scale},format=yuv420p[v]"
                    ));
                } else {
                    video_filters.push(scale);
                }
            }
            None => video_filters.push(scale),
        }
        if complex.is_none() {
            video_filters.push("format=yuv420p".to_owned());
        }
    }

    match &complex {
        Some(graph) => args.extend([
            "-filter_complex".to_owned(),
            graph.clone(),
            "-map".to_owned(),
            "[v]".to_owned(),
        ]),
        None if plan.video != VideoPlan::None => {
            args.extend(["-map".to_owned(), "0:v:0".to_owned()])
        }
        None => {}
    }
    if plan.audio != AudioPlan::None {
        args.extend(["-map".to_owned(), format!("0:a:{}?", plan.audio_stream)]);
    }
    args.push("-sn".to_owned());
    args.push("-dn".to_owned());

    match &plan.video {
        VideoPlan::None => args.push("-vn".to_owned()),
        VideoPlan::Copy => args.extend(["-c:v", "copy"].map(str::to_owned)),
        VideoPlan::Encode { hevc, max_height } => {
            let bitrate = match max_height {
                h if *h > 1080 => "16M",
                _ => "8M",
            };
            args.extend([
                "-c:v".to_owned(),
                if *hevc {
                    "hevc_videotoolbox"
                } else {
                    "h264_videotoolbox"
                }
                .to_owned(),
                "-b:v".to_owned(),
                bitrate.to_owned(),
                "-allow_sw".to_owned(),
                "1".to_owned(),
                // A keyframe every two seconds, so segments can be cut there.
                "-force_key_frames".to_owned(),
                "expr:gte(t,n_forced*2)".to_owned(),
            ]);
            if !video_filters.is_empty() {
                args.extend(["-vf".to_owned(), video_filters.join(",")]);
            }
        }
    }
    // Apple's players want HEVC tagged as hvc1, and so does a Chromecast.
    let hevc_out = match plan.video {
        VideoPlan::Copy => plan.hevc_source,
        VideoPlan::Encode { hevc, .. } => hevc,
        VideoPlan::None => false,
    };
    if hevc_out {
        args.extend(["-tag:v".to_owned(), "hvc1".to_owned()]);
    }
    match &plan.audio {
        AudioPlan::None => args.push("-an".to_owned()),
        AudioPlan::Copy => args.extend(["-c:a", "copy"].map(str::to_owned)),
        AudioPlan::Aac { channels } => args.extend([
            "-c:a".to_owned(),
            "aac".to_owned(),
            "-ac".to_owned(),
            channels.to_string(),
            "-b:a".to_owned(),
            if *channels > 2 { "384k" } else { "192k" }.to_owned(),
        ]),
    }
    args.extend(
        [
            "-avoid_negative_ts",
            "make_zero",
            "-max_muxing_queue_size",
            "4096",
        ]
        .map(str::to_owned),
    );
    match output {
        Output::Fragmented => args.extend(
            [
                "-f",
                "mp4",
                "-movflags",
                "frag_keyframe+empty_moov+default_base_moof",
                "-frag_duration",
                "2000000",
                "pipe:1",
            ]
            .map(str::to_owned),
        ),
        Output::Hls { dir } => {
            args.extend(
                [
                    "-f",
                    "hls",
                    "-hls_time",
                    "4",
                    "-hls_list_size",
                    "0",
                    "-hls_playlist_type",
                    "event",
                    "-hls_segment_type",
                    "fmp4",
                    "-hls_flags",
                    "independent_segments+temp_file",
                ]
                .map(str::to_owned),
            );
            args.push("-hls_fmp4_init_filename".to_owned());
            args.push("init.mp4".to_owned());
            args.push("-hls_segment_filename".to_owned());
            args.push(dir.join("s%05d.m4s").to_string_lossy().into_owned());
            args.push(dir.join("index.m3u8").to_string_lossy().into_owned());
        }
    }
    args
}

/// FFmpeg's arguments for turning one subtitle track into WebVTT on its
/// standard output, timed as in the film.
pub fn webvtt_args(film: &str, source: &SubtitleSource) -> Vec<String> {
    let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error"]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    match source {
        SubtitleSource::Embedded(n) => {
            args.extend([
                "-i".to_owned(),
                film.to_owned(),
                "-map".to_owned(),
                format!("0:s:{n}"),
            ]);
        }
        SubtitleSource::External(path) => {
            args.extend([
                "-i".to_owned(),
                path.to_string_lossy().into_owned(),
                "-map".to_owned(),
                "0:s:0".to_owned(),
            ]);
        }
    }
    args.extend(["-vn", "-an", "-c:s", "webvtt", "-f", "webvtt", "pipe:1"].map(str::to_owned));
    args
}

/// Moves every cue of a WebVTT file by `shift` seconds, dropping those that
/// would end before the start.
pub fn shift_webvtt(text: &str, shift: f64) -> String {
    if shift.abs() < 0.0005 {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    // Cues are blocks separated by blank lines; the header is the first.
    let normalised = text.replace("\r\n", "\n");
    let mut first = true;
    for block in normalised.split("\n\n") {
        if first {
            first = false;
            out.push_str(block);
            out.push_str("\n\n");
            continue;
        }
        let mut lines = block.lines();
        let mut kept = Vec::new();
        let mut timing_found = false;
        let mut dropped = false;
        for line in lines.by_ref() {
            if !timing_found && line.contains("-->") {
                timing_found = true;
                match shift_timing(line, shift) {
                    Some(line) => kept.push(line),
                    None => {
                        dropped = true;
                        break;
                    }
                }
            } else {
                kept.push(line.to_owned());
            }
        }
        if dropped || kept.iter().all(|line| line.trim().is_empty()) {
            continue;
        }
        out.push_str(&kept.join("\n"));
        out.push_str("\n\n");
    }
    out
}

fn shift_timing(line: &str, shift: f64) -> Option<String> {
    let (start, rest) = line.split_once("-->")?;
    let rest = rest.trim_start();
    let (end, settings) = rest.split_once(' ').map_or((rest, ""), |(e, s)| (e, s));
    let start = parse_time(start.trim())? + shift;
    let end = parse_time(end.trim())? + shift;
    if end <= 0.0 {
        return None;
    }
    let mut line = format!("{} --> {}", format_time(start.max(0.0)), format_time(end));
    if !settings.is_empty() {
        line.push(' ');
        line.push_str(settings);
    }
    Some(line)
}

fn parse_time(text: &str) -> Option<f64> {
    let mut parts: Vec<&str> = text.split(':').collect();
    let seconds: f64 = parts.pop()?.replace(',', ".").parse().ok()?;
    let minutes: f64 = parts.pop().map_or(Some(0.0), |m| m.parse().ok())?;
    let hours: f64 = parts.pop().map_or(Some(0.0), |h| h.parse().ok())?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

fn format_time(seconds: f64) -> String {
    let millis = (seconds * 1000.0).round() as u64;
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        millis / 3_600_000,
        (millis / 60_000) % 60,
        (millis / 1000) % 60,
        millis % 1000
    )
}

/// The MIME type of a file served as it is.
pub fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("mov") => "video/quicktime",
        Some("m4a") => "audio/mp4",
        Some("mp3") => "audio/mpeg",
        Some("webm") => "video/webm",
        _ => "video/mp4",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn probe(format: &str, video: &str, audio: &[&str]) -> Probe {
        Probe {
            format: format.to_owned(),
            duration: Some(100.0),
            video: Some(VideoStream {
                codec: video.to_owned(),
                profile: Some("High".to_owned()),
                pix_fmt: Some("yuv420p".to_owned()),
                level: Some(41),
                height: Some(1080),
            }),
            audio: audio
                .iter()
                .map(|codec| AudioStream {
                    codec: (*codec).to_owned(),
                    channels: Some(6),
                    default: false,
                })
                .collect(),
            subtitles: vec![
                SubtitleStream {
                    codec: "subrip".to_owned(),
                },
                SubtitleStream {
                    codec: "hdmv_pgs_subtitle".to_owned(),
                },
            ],
        }
    }

    const CAST: Profile = Profile::Chromecast { hevc: false };

    #[test]
    fn reads_what_ffprobe_says() {
        let probed = Probe::from_json(&json!({
            "format": {"format_name": "matroska,webm", "duration": "62.5"},
            "streams": [
                {"codec_type": "video", "codec_name": "mjpeg", "disposition": {"attached_pic": 1}},
                {"codec_type": "video", "codec_name": "hevc", "pix_fmt": "yuv420p10le", "level": 150, "height": 2160},
                {"codec_type": "audio", "codec_name": "dts", "channels": 6, "disposition": {"default": 0}},
                {"codec_type": "audio", "codec_name": "aac", "channels": 2, "disposition": {"default": 1}},
                {"codec_type": "subtitle", "codec_name": "ass"}
            ]
        }));
        assert_eq!(probed.format, "matroska,webm");
        assert_eq!(probed.duration, Some(62.5));
        assert_eq!(
            probed.video.as_ref().map(|v| v.codec.as_str()),
            Some("hevc")
        );
        assert_eq!(probed.audio.len(), 2);
        assert!(probed.audio[1].default);
        assert_eq!(probed.subtitles.len(), 1);
    }

    #[test]
    fn an_mp4_a_chromecast_plays_goes_as_it_is() {
        let plan = plan(
            &probe("mov,mp4,m4a,3gp,3g2,mj2", "h264", &["aac"]),
            CAST,
            &Choice::default(),
            &[],
        );
        assert_eq!(plan.delivery, Delivery::Direct);
    }

    #[test]
    fn an_mkv_is_copied_into_mp4_with_its_sound_converted() {
        let plan = plan(
            &probe("matroska,webm", "h264", &["dts"]),
            CAST,
            &Choice::default(),
            &[],
        );
        assert_eq!(plan.delivery, Delivery::Remux);
        assert_eq!(plan.video, VideoPlan::Copy);
        assert_eq!(plan.audio, AudioPlan::Aac { channels: 2 });
    }

    #[test]
    fn hevc_is_encoded_again_for_a_chromecast_without_it() {
        let plan = plan(
            &probe("matroska,webm", "hevc", &["aac"]),
            CAST,
            &Choice::default(),
            &[],
        );
        assert_eq!(plan.delivery, Delivery::Transcode);
        let plan = super::plan(
            &probe("matroska,webm", "hevc", &["aac"]),
            Profile::Chromecast { hevc: true },
            &Choice::default(),
            &[],
        );
        assert_eq!(plan.delivery, Delivery::Remux);
    }

    #[test]
    fn another_audio_track_means_the_file_cannot_go_as_it_is() {
        let choice = Choice {
            audio: Some(1),
            ..Choice::default()
        };
        let plan = plan(
            &probe("mov,mp4", "h264", &["aac", "aac"]),
            CAST,
            &choice,
            &[],
        );
        assert_eq!(plan.delivery, Delivery::Remux);
        assert_eq!(plan.audio_stream, 1);
    }

    fn tracks() -> Vec<SubtitleTrack> {
        vec![
            SubtitleTrack {
                id: 1,
                source: SubtitleSource::Embedded(0),
                text: true,
                name: "English".to_owned(),
                language: Some("eng".to_owned()),
            },
            SubtitleTrack {
                id: 2,
                source: SubtitleSource::Embedded(1),
                text: false,
                name: "Commentary".to_owned(),
                language: None,
            },
        ]
    }

    #[test]
    fn text_subtitles_go_beside_the_film_to_a_chromecast() {
        let choice = Choice {
            subtitle: Some(1),
            ..Choice::default()
        };
        let plan = plan(
            &probe("mov,mp4", "h264", &["aac"]),
            CAST,
            &choice,
            &tracks(),
        );
        assert_eq!(plan.delivery, Delivery::Direct);
        assert_eq!(plan.side_active, Some(1));
        assert_eq!(
            plan.side.len(),
            1,
            "pictures of text cannot go beside the film"
        );
    }

    #[test]
    fn pictures_of_text_are_drawn_in() {
        let choice = Choice {
            subtitle: Some(2),
            ..Choice::default()
        };
        let plan = plan(
            &probe("mov,mp4", "h264", &["aac"]),
            CAST,
            &choice,
            &tracks(),
        );
        assert_eq!(plan.delivery, Delivery::Transcode);
        let args = ffmpeg_args("/f.mkv", &plan, 10.0, 0.0, &Output::Fragmented).join(" ");
        assert!(args.contains("[0:v:0][0:s:1]overlay"), "{args}");
    }

    #[test]
    fn airplay_has_every_subtitle_drawn_in() {
        let choice = Choice {
            subtitle: Some(1),
            ..Choice::default()
        };
        let plan = plan(
            &probe("mov,mp4", "h264", &["aac"]),
            Profile::AirPlay,
            &choice,
            &tracks(),
        );
        assert_eq!(plan.delivery, Delivery::Transcode);
        assert!(plan.side.is_empty());
        let args = ffmpeg_args(
            "/films/it's: here.mkv",
            &plan,
            30.0,
            2.0,
            &Output::Hls {
                dir: "/tmp/x".into(),
            },
        )
        .join(" ");
        assert!(
            args.contains(
                "setpts=PTS+(28.000)/TB,subtitles=filename='/films/it'\\''s\\: here.mkv':si=0"
            ),
            "{args}"
        );
        assert!(args.contains("-f hls"));
    }

    #[test]
    fn starts_where_asked_and_maps_the_chosen_sound() {
        let choice = Choice {
            audio: Some(1),
            ..Choice::default()
        };
        let plan = plan(
            &probe("matroska", "h264", &["aac", "ac3"]),
            CAST,
            &choice,
            &[],
        );
        let args = ffmpeg_args("/f.mkv", &plan, 61.5, 0.0, &Output::Fragmented);
        let text = args.join(" ");
        assert!(text.contains("-ss 61.500 -i /f.mkv"), "{text}");
        assert!(text.contains("-map 0:a:1?"), "{text}");
        assert!(text.contains("frag_keyframe+empty_moov"), "{text}");
    }

    #[test]
    fn moves_cues_and_drops_the_ones_before_the_start() {
        let vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nGone\n\n1\n00:01:00.500 --> 00:01:02.000 line:90%\nKept\nTwo lines\n";
        let shifted = shift_webvtt(vtt, -30.0);
        assert!(!shifted.contains("Gone"));
        assert!(
            shifted.contains("00:00:30.500 --> 00:00:32.000 line:90%\nKept\nTwo lines"),
            "{shifted}"
        );
        assert!(shifted.starts_with("WEBVTT\n\n1\n"));
    }

    #[test]
    fn subtitle_tracks_follow_mpv_ids() {
        let track = |id, external, codec: &str, file: Option<&str>| Track {
            id,
            kind: TrackKind::Subtitle,
            title: None,
            language: Some("eng".to_owned()),
            codec: Some(codec.to_owned()),
            selected: false,
            default: false,
            forced: false,
            external,
            file: file.map(str::to_owned),
            secondary: false,
            channels: None,
        };
        let list = vec![
            track(1, false, "subrip", None),
            track(2, false, "hdmv_pgs_subtitle", None),
            track(3, true, "subrip", Some("/films/a.srt")),
        ];
        let found = subtitle_tracks(&list, &probe("matroska", "h264", &["aac"]));
        assert_eq!(found.len(), 3);
        assert_eq!(found[1].source, SubtitleSource::Embedded(1));
        assert!(!found[1].text);
        assert_eq!(
            found[2].source,
            SubtitleSource::External("/films/a.srt".into())
        );
    }
}
