//! The player's adjustments: which tracks play, how the picture is shaped
//! and tuned, the equaliser, where the sound goes, how subtitles look.
//!
//! Two kinds, kept apart. What belongs to the file that is open (its tracks,
//! its delays, how it is turned and cut) is chosen with the methods here, is
//! remembered as a `FileState`, and is set again before the file next loads.
//! What belongs to the room and the listener (picture levels, equaliser,
//! output, subtitle style) comes from the settings and is applied whole.

use std::path::Path;
use std::sync::atomic::Ordering;

use serde_json::Value as Json;

use super::{Player, Shared};
use crate::engine::adjust::{
    crop_rect, Channels, Equaliser, Frame, Picture, Shape, SubtitleStyle, BANDS, DENOISE_LABEL,
    EQUALISER_LABEL, FLIP_LABEL, MIRROR_LABEL, PASSTHROUGH,
};
use crate::engine::mpv::{Format, Mpv};
use crate::engine::types::{
    FileState, PlayerChange, SubtitleChoice, TrackKind, MAX_SUBTITLE_DELAY, MAX_SUBTITLE_SPEED,
    MIN_SUBTITLE_SPEED,
};
use crate::error::{AppError, AppResult};
use crate::media::formats::{self, MediaKind};

/// The furthest sound or subtitles can be moved against the picture, in seconds.
pub const MAX_DELAY: f64 = 30.0;
/// mpv's own distance between subtitles and the bottom of the picture, in
/// the 720ths of the picture's height that it measures subtitles in.
const SUBTITLE_MARGIN: f64 = 34.0;

fn delay(seconds: f64) -> AppResult<f64> {
    delay_within(seconds, MAX_DELAY)
}

fn delay_within(seconds: f64, reach: f64) -> AppResult<f64> {
    if !seconds.is_finite() {
        return Err(AppError::Invalid("the delay is not a number".to_owned()));
    }
    // Milliseconds are as fine as a delay is ever set.
    Ok((seconds.clamp(-reach, reach) * 1000.0).round() / 1000.0)
}

/// Logs a setting mpv would not take. One refused adjustment must not stop
/// a file from opening, or the rest from being applied.
fn tolerate(what: &str, result: Result<(), crate::engine::mpv::MpvError>) {
    if let Err(error) = result {
        tracing::warn!(%error, "could not set {what}");
    }
}

/// Hardware decoding whose frames stay on the GPU, straight to the screen.
pub(super) const HWDEC_DIRECT: &str = "auto-safe";
/// Hardware decoding whose frames are copied back, for software filters.
const HWDEC_COPY: &str = "auto-copy-safe";

/// The drawing of the sound shown for a file that has no picture: its
/// waveform as one continuous trace about the middle of the frame, like an
/// oscilloscope's, in the interface's own ink (DESIGN.md §7, "Visualiser").
/// `track` is the audio track it draws.
///
/// `showwaves` draws on a transparent frame, and the picture's layer shows
/// what is behind the window through alpha; the frame is made opaque, black
/// like the bars around any picture, before it reaches the screen.
fn visualiser_graph(track: i32) -> String {
    format!(
        "[aid{track}] asplit [ao] [seen] ; \
         [seen] showwaves=s=1280x720:mode=p2p:draw=full:rate=60:scale=sqrt:colors=0xEFEFE6@0.9, \
         format=yuv420p [vo]"
    )
}

/// Sets, or takes off, the cut that shows the picture in `shape`'s crop.
/// The rectangle depends on the frames mpv is decoding, so this is called
/// again whenever they change.
pub(super) fn apply_crop(mpv: &Mpv, shape: &Shape) {
    let wanted = shape
        .crop
        .and_then(|ratio| {
            let params = mpv.get("video-params", Format::Node).ok()?;
            let params = params.as_node()?;
            let number = |key: &str| params.get(key).and_then(Json::as_f64);
            let size = |key: &str| {
                number(key)
                    .filter(|value| *value >= 1.0)
                    .map(|value| value as u32)
            };
            let own_turn = number("rotate").unwrap_or(0.0) as i64 / 90;
            crop_rect(
                ratio,
                Frame {
                    width: size("w")?,
                    height: size("h")?,
                    pixel_aspect: number("par").unwrap_or(1.0),
                    sideways: (own_turn + i64::from(shape.turns)) % 2 != 0,
                },
            )
        })
        .map(|(width, height, x, y)| format!("{width}x{height}+{x}+{y}"))
        .unwrap_or_default();
    let current = mpv
        .get_string("video-crop")
        .ok()
        .flatten()
        .unwrap_or_default();
    // Setting it lays the picture out again; only when it would change.
    if current != wanted {
        tolerate("the crop", mpv.set_string("video-crop", &wanted));
    }
}

impl Shared {
    /// What the user has chosen for the file that is open.
    pub(super) fn file_state(&self) -> FileState {
        self.chosen.lock().clone()
    }
}

impl Player {
    /// What has been chosen for the file that is open, to be remembered
    /// with it.
    pub fn file_state(&self) -> FileState {
        self.shared.file_state()
    }

    /// Sets everything that belongs to one file, before that file is
    /// loaded, so that it starts with it: no first second in the wrong
    /// language, no picture that turns the right way up after it appears.
    pub(super) fn prepare(&self, source: &str, state: &FileState) {
        let mpv = &self.mpv;
        let track = |id: Option<i32>| id.map_or_else(|| "auto".to_owned(), |id| id.to_string());
        tolerate(
            "the audio track",
            mpv.set_string("aid", &track(state.audio)),
        );
        let subtitle = match state.subtitle {
            None => "auto".to_owned(),
            Some(SubtitleChoice::Off) => "no".to_owned(),
            Some(SubtitleChoice::Track(id)) => id.to_string(),
        };
        tolerate("the subtitle track", mpv.set_string("sid", &subtitle));
        let second = state
            .second_subtitle
            .map_or_else(|| "no".to_owned(), |id| id.to_string());
        tolerate(
            "the second subtitle track",
            mpv.set_string("secondary-sid", &second),
        );
        tolerate(
            "the subtitle delay",
            mpv.set_double("sub-delay", state.subtitle_delay),
        );
        let speed = state.subtitle_speed.unwrap_or(1.0);
        tolerate("the subtitle speed", mpv.set_double("sub-speed", speed));
        tolerate(
            "the audio delay",
            mpv.set_double("audio-delay", state.audio_delay),
        );
        // Subtitle files added by hand last time are added again, if they
        // are still where they were.
        tolerate(
            "the subtitle files",
            mpv.command(&["change-list", "sub-files", "clr", ""]),
        );
        for file in state
            .subtitle_files
            .iter()
            .filter(|file| Path::new(file).is_file())
        {
            tolerate(
                "a subtitle file",
                mpv.command(&["change-list", "sub-files", "append", file]),
            );
        }
        self.apply_shape(&state.shape);

        // A file with no picture is given one made from its sound. Which
        // files those are is told from their names, so that the drawing is
        // there from the first moment and the sound does not have to start
        // twice; the name mpv finds inside the file comes too late for that.
        let visualise = self.shared.visualiser.load(Ordering::Acquire)
            && formats::kind_of(Path::new(source)) == Some(MediaKind::Audio);
        let graph = if visualise {
            visualiser_graph(state.audio.unwrap_or(1))
        } else {
            String::new()
        };
        tolerate("the visualiser", mpv.set_string("lavfi-complex", &graph));

        self.shared.publish(PlayerChange::AudioDelay {
            seconds: state.audio_delay,
        });
        self.shared.publish(PlayerChange::SubtitleDelay {
            seconds: state.subtitle_delay,
        });
        self.shared
            .publish(PlayerChange::SubtitleSpeed { rate: speed });
        self.shared
            .publish(PlayerChange::Shape { shape: state.shape });
        self.shared.publish(PlayerChange::Visualised {
            visualised: visualise,
        });
    }

    fn needs_media(&self) -> AppResult<()> {
        if self.snapshot().source.is_none() {
            return Err(AppError::Invalid("nothing is open".to_owned()));
        }
        Ok(())
    }

    /// Plays another audio track, or shows another subtitle track; for
    /// subtitles, `None` shows none.
    pub fn select_track(&self, kind: TrackKind, id: Option<i32>) -> AppResult<()> {
        self.needs_media()?;
        let known = |id: i32| {
            self.snapshot()
                .tracks
                .iter()
                .any(|track| track.kind == kind && track.id == id)
        };
        if let Some(id) = id.filter(|id| !known(*id)) {
            return Err(AppError::NotFound(format!("there is no track {id}")));
        }
        match (kind, id) {
            (TrackKind::Audio, Some(id)) => {
                if self.snapshot().visualised {
                    // The drawing is made from one named track: it follows.
                    self.mpv
                        .set_string("lavfi-complex", &visualiser_graph(id))?;
                } else {
                    self.mpv.set_string("aid", &id.to_string())?;
                }
                self.shared.chosen.lock().audio = Some(id);
            }
            (TrackKind::Subtitle, Some(id)) => {
                self.mpv.set_string("sid", &id.to_string())?;
                // A speed found by syncing fits the track it was found for.
                let showing = self.snapshot().tracks.iter().any(|track| {
                    track.kind == kind && track.id == id && track.selected && !track.secondary
                });
                if !showing {
                    self.reset_subtitle_speed();
                }
                let mut chosen = self.shared.chosen.lock();
                chosen.subtitle = Some(SubtitleChoice::Track(id));
                // One track cannot be both: the second gives way.
                if chosen.second_subtitle == Some(id) {
                    chosen.second_subtitle = None;
                }
            }
            (TrackKind::Subtitle, None) => {
                self.mpv.set_string("sid", "no")?;
                self.shared.chosen.lock().subtitle = Some(SubtitleChoice::Off);
            }
            (TrackKind::Audio, None) | (TrackKind::Video, _) => {
                return Err(AppError::Invalid(
                    "that kind of track cannot be chosen".to_owned(),
                ));
            }
        }
        Ok(())
    }

    /// Shows a second subtitle track above the first, or stops showing one.
    pub fn select_second_subtitle(&self, id: Option<i32>) -> AppResult<()> {
        self.needs_media()?;
        let tracks = self.snapshot().tracks;
        if let Some(id) = id {
            let track = tracks
                .iter()
                .find(|track| track.kind == TrackKind::Subtitle && track.id == id)
                .ok_or_else(|| AppError::NotFound(format!("there is no track {id}")))?;
            if track.selected && !track.secondary {
                return Err(AppError::Invalid(
                    "that track is already showing as the first".to_owned(),
                ));
            }
        }
        let value = id.map_or_else(|| "no".to_owned(), |id| id.to_string());
        self.mpv.set_string("secondary-sid", &value)?;
        self.shared.chosen.lock().second_subtitle = id;
        Ok(())
    }

    /// Adds subtitle files to what is open and shows the first of them.
    /// Returns how many were added.
    pub fn add_subtitles(&self, files: &[String]) -> AppResult<usize> {
        self.needs_media()?;
        let mut added = 0;
        for file in files {
            let how = if added == 0 { "select" } else { "auto" };
            match self.mpv.command(&["sub-add", file, how]) {
                Ok(()) => {
                    added += 1;
                    let mut chosen = self.shared.chosen.lock();
                    if !chosen.subtitle_files.contains(file) {
                        chosen.subtitle_files.push(file.clone());
                    }
                }
                Err(error) => tracing::warn!(%error, %file, "not added as subtitles"),
            }
        }
        if added == 0 {
            return Err(AppError::Invalid(if files.len() == 1 {
                "that is not a subtitle file Lumen can read".to_owned()
            } else {
                "none of those is a subtitle file Lumen can read".to_owned()
            }));
        }
        // Which track that made it is known once mpv lists it; the choice
        // is remembered then, by `note_selection`.
        self.shared.chosen.lock().subtitle = None;
        self.shared.added_subtitles.store(true, Ordering::Release);
        Ok(added)
    }

    /// Plays the sound this much later than the picture; negative, earlier.
    pub fn set_audio_delay(&self, seconds: f64) -> AppResult<()> {
        let seconds = delay(seconds)?;
        self.mpv.set_double("audio-delay", seconds)?;
        self.shared.chosen.lock().audio_delay = seconds;
        self.shared.publish(PlayerChange::AudioDelay { seconds });
        Ok(())
    }

    /// Shows subtitles this much later than they are timed; negative, earlier.
    pub fn set_subtitle_delay(&self, seconds: f64) -> AppResult<()> {
        let seconds = delay_within(seconds, MAX_SUBTITLE_DELAY)?;
        self.mpv.set_double("sub-delay", seconds)?;
        // The second track keeps time with the first.
        self.mpv.set_double("secondary-sub-delay", seconds)?;
        self.shared.chosen.lock().subtitle_delay = seconds;
        self.shared.publish(PlayerChange::SubtitleDelay { seconds });
        Ok(())
    }

    /// Runs the subtitles at `speed` times the rate they are timed for, and
    /// shows them `delay` seconds later: what syncing them found.
    pub fn set_subtitle_timing(&self, speed: f64, delay: f64) -> AppResult<()> {
        self.needs_media()?;
        if !(speed.is_finite() && (MIN_SUBTITLE_SPEED..=MAX_SUBTITLE_SPEED).contains(&speed)) {
            return Err(AppError::Invalid("that speed is out of range".to_owned()));
        }
        self.mpv.set_double("sub-speed", speed)?;
        self.shared.chosen.lock().subtitle_speed = (speed != 1.0).then_some(speed);
        self.shared
            .publish(PlayerChange::SubtitleSpeed { rate: speed });
        self.set_subtitle_delay(delay)
    }

    fn reset_subtitle_speed(&self) {
        if self.snapshot().subtitle_speed == 1.0 {
            return;
        }
        tolerate("the subtitle speed", self.mpv.set_double("sub-speed", 1.0));
        self.shared.chosen.lock().subtitle_speed = None;
        self.shared
            .publish(PlayerChange::SubtitleSpeed { rate: 1.0 });
    }

    /// Switches subtitles off, or on again as they were: the same track, and
    /// the same second track if there was one. With none to go back to, the
    /// player picks as it does when a file opens. Returns whether they are
    /// on afterwards.
    pub fn toggle_subtitles(&self) -> AppResult<bool> {
        self.needs_media()?;
        let tracks = self.snapshot().tracks;
        let showing = |second: bool| {
            tracks
                .iter()
                .find(|track| {
                    track.kind == TrackKind::Subtitle && track.selected && track.secondary == second
                })
                .map(|track| track.id)
        };
        let (first, second) = (showing(false), showing(true));
        if first.is_some() || second.is_some() {
            *self.shared.set_aside.lock() = (first, second);
            self.mpv.set_string("sid", "no")?;
            self.mpv.set_string("secondary-sid", "no")?;
            let mut chosen = self.shared.chosen.lock();
            chosen.subtitle = Some(SubtitleChoice::Off);
            chosen.second_subtitle = None;
            return Ok(false);
        }
        if !tracks.iter().any(|track| track.kind == TrackKind::Subtitle) {
            return Err(AppError::Invalid("there are no subtitles".to_owned()));
        }
        let (first, second) = *self.shared.set_aside.lock();
        let still_there = |id: &i32| {
            tracks
                .iter()
                .any(|track| track.kind == TrackKind::Subtitle && track.id == *id)
        };
        let first = first.filter(still_there);
        let second = second.filter(still_there).filter(|id| Some(*id) != first);
        let value = first.map_or_else(|| "auto".to_owned(), |id| id.to_string());
        self.mpv.set_string("sid", &value)?;
        // "Pick for me" may pick none, for a film in the listener's own
        // language; then the first there is, since they were asked for.
        if first.is_none() && self.mpv.get_string("sid")?.as_deref() == Some("no") {
            if let Some(track) = tracks
                .iter()
                .find(|track| track.kind == TrackKind::Subtitle)
            {
                self.mpv.set_string("sid", &track.id.to_string())?;
            }
        }
        if let Some(second) = second {
            self.mpv.set_string("secondary-sid", &second.to_string())?;
        }
        let mut chosen = self.shared.chosen.lock();
        chosen.subtitle = first.map(SubtitleChoice::Track);
        chosen.second_subtitle = second;
        Ok(true)
    }

    /// Turns, cuts and stretches the picture of the file that is open.
    pub fn set_shape(&self, shape: Shape) -> AppResult<()> {
        let shape = shape.sanitised();
        self.apply_shape(&shape);
        self.shared.chosen.lock().shape = shape;
        self.shared.publish(PlayerChange::Shape { shape });
        Ok(())
    }

    fn apply_shape(&self, shape: &Shape) {
        let mpv = &self.mpv;
        tolerate(
            "the aspect",
            mpv.set_string("video-aspect-override", &shape.aspect_override()),
        );
        tolerate("the zoom", mpv.set_double("video-zoom", shape.zoom_steps()));
        tolerate("the rotation", mpv.set_int("video-rotate", shape.degrees()));
        tolerate(
            "deinterlacing",
            mpv.set_string("deinterlace", shape.deinterlace.as_mpv()),
        );
        self.set_filter("vf", MIRROR_LABEL, shape.mirrored.then_some("hflip"));
        self.set_filter("vf", FLIP_LABEL, shape.flipped.then_some("vflip"));
        apply_crop(mpv, shape);
    }

    /// Puts a labelled filter in one of mpv's chains, replaces it, or takes
    /// it out; and leaves the chain alone if that changes nothing, because
    /// any change to a chain makes mpv build it again, which can be seen
    /// and heard.
    fn set_filter(&self, chain: &str, label: &str, filter: Option<&str>) {
        let mut installed = self.shared.filters.lock();
        let key = format!("{chain}/{label}");
        if installed.get(&key).map(String::as_str) == filter {
            return;
        }
        // A software filter cannot take frames that stay on the GPU: with
        // one in the video chain, decoding copies its frames back first.
        // It is switched before the filter goes in, so that no frame of
        // the GPU's reaches it, and back once the last one is out.
        let others = installed
            .keys()
            .any(|other| other != &key && other.starts_with("vf/"));
        let software = chain == "vf" && (filter.is_some() || others);
        if chain == "vf" {
            self.decode_for_filters(software);
        }
        let done = match filter {
            Some(filter) => self
                .mpv
                .command(&[chain, "add", &format!("@{label}:{filter}")]),
            None => self.mpv.command(&[chain, "remove", &format!("@{label}")]),
        };
        match (done, filter) {
            (Ok(()), Some(filter)) => {
                installed.insert(key, filter.to_owned());
            }
            (Ok(()), None) => {
                installed.remove(&key);
            }
            (Err(error), _) => tracing::warn!(%error, "could not change the {label} filter"),
        }
    }

    /// Decodes in hardware either way; with `software` filters in the video
    /// chain the frames are copied back to memory for them, without, they
    /// go straight to the screen.
    fn decode_for_filters(&self, software: bool) {
        let wanted = if software { HWDEC_COPY } else { HWDEC_DIRECT };
        let current = self.mpv.get_string("hwdec").ok().flatten();
        if current.as_deref() != Some(wanted) {
            tolerate("hardware decoding", self.mpv.set_string("hwdec", wanted));
        }
    }

    /// Applies the picture tuner.
    pub fn apply_picture(&self, picture: &Picture) {
        for (name, level) in picture.levels() {
            tolerate(name, self.mpv.set_int(name, level));
        }
        tolerate(
            "sharpness",
            self.mpv.set_double("sharpen", picture.sharpen()),
        );
        self.set_filter("vf", DENOISE_LABEL, picture.denoise().as_deref());
    }

    /// Applies the equaliser. `bypassed` says sound is being handed on
    /// undecoded, which nothing can be done to: the chain is taken out.
    pub fn apply_equaliser(&self, equaliser: &Equaliser, bypassed: bool) {
        let installed = self.shared.equalised.load(Ordering::Acquire);
        if bypassed {
            if installed {
                tolerate(
                    "the equaliser",
                    self.mpv
                        .command(&["af", "remove", &format!("@{EQUALISER_LABEL}")]),
                );
                self.shared.equalised.store(false, Ordering::Release);
            }
            return;
        }
        if !installed {
            // Not there yet, and not wanted: sound that has never been
            // equalised goes through no filter at all.
            if equaliser.enabled {
                let added = self.mpv.command(&["af", "add", &equaliser.chain()]);
                self.shared
                    .equalised
                    .store(added.is_ok(), Ordering::Release);
                tolerate("the equaliser", added);
            }
            return;
        }
        // Once it is there it stays, and is turned: changing a band this
        // way is not heard as anything but the change, where taking the
        // chain out and putting it back is a gap in the sound.
        let turn = |command: &str, value: String, target: String| {
            tolerate(
                "an equaliser band",
                self.mpv
                    .command(&["af-command", EQUALISER_LABEL, command, &value, &target]),
            );
        };
        turn(
            "volume",
            format!("{:.1}dB", equaliser.headroom()),
            "volume@pre".to_owned(),
        );
        for (band, gain) in equaliser
            .in_effect()
            .into_iter()
            .enumerate()
            .take(BANDS.len())
        {
            turn("gain", format!("{gain:.1}"), format!("equalizer@b{band}"));
        }
    }

    /// Says where sound goes and in what form. `device` is one of the ids
    /// in the snapshot's `audio_devices`; `None` follows the Mac's own choice.
    pub fn apply_output(&self, device: Option<&str>, channels: Channels, passthrough: bool) {
        tolerate(
            "the output device",
            self.mpv
                .set_string("audio-device", device.unwrap_or("auto")),
        );
        tolerate(
            "the channels",
            self.mpv.set_string("audio-channels", channels.as_mpv()),
        );
        tolerate(
            "passthrough",
            self.mpv
                .set_string("audio-spdif", if passthrough { PASSTHROUGH } else { "" }),
        );
    }

    /// Applies how subtitles look.
    pub fn apply_subtitle_style(&self, style: &SubtitleStyle) {
        for (name, value) in style.properties() {
            tolerate(name, self.mpv.set_string(name, &value));
        }
    }

    /// Says whether a file with no picture is to be given a drawing of its
    /// sound. It takes effect with the next file opened.
    pub fn set_visualiser(&self, on: bool) {
        self.shared.visualiser.store(on, Ordering::Release);
    }

    /// Keeps subtitles clear of a strip along the bottom of the picture,
    /// given as a share of its height: the control bar, while it is up.
    pub fn set_subtitle_lift(&self, share: f64) -> AppResult<()> {
        let share = if share.is_finite() {
            share.clamp(0.0, 0.5)
        } else {
            0.0
        };
        let margin = (SUBTITLE_MARGIN + share * 720.0).round() as i64;
        Ok(self.mpv.set_int("sub-margin-y", margin)?)
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::Harness;
    use super::*;
    use crate::engine::adjust::{Deinterlace, Ratio};
    use crate::engine::test_support::{audio_clip, second_clip, subtitle_file, test_clip};
    use crate::engine::types::{PlaybackStatus, Track};

    fn path(file: &Path) -> String {
        file.to_string_lossy().into_owned()
    }

    fn subtitles(harness: &Harness) -> Vec<Track> {
        harness
            .player
            .snapshot()
            .tracks
            .into_iter()
            .filter(|track| track.kind == TrackKind::Subtitle)
            .collect()
    }

    /// The player with the test clip playing and `names` added as subtitles.
    fn with_subtitles(names: &[&str]) -> Harness {
        let harness = Harness::new();
        harness.open_clip();
        harness.expect_status(PlaybackStatus::Playing);
        let files: Vec<String> = names
            .iter()
            .map(|name| path(&subtitle_file(name)))
            .collect();
        assert_eq!(harness.player.add_subtitles(&files).unwrap(), names.len());
        harness.wait_until("the subtitle tracks", |snapshot| {
            snapshot
                .tracks
                .iter()
                .filter(|track| track.kind == TrackKind::Subtitle)
                .count()
                == names.len()
                && snapshot
                    .tracks
                    .iter()
                    .any(|track| track.kind == TrackKind::Subtitle && track.selected)
        });
        harness
    }

    #[test]
    fn subtitles_added_by_hand_are_shown_and_remembered_as_the_choice() {
        let harness = with_subtitles(&["english"]);
        let tracks = subtitles(&harness);
        assert!(tracks[0].external && tracks[0].selected && !tracks[0].secondary);
        assert_eq!(
            tracks[0].file.as_deref(),
            Some(path(&subtitle_file("english")).as_str())
        );
        harness.wait_until("the choice to be noted", |_| {
            harness.player.file_state().subtitle == Some(SubtitleChoice::Track(tracks[0].id))
        });
        assert_eq!(
            harness.player.file_state().subtitle_files,
            [path(&subtitle_file("english"))]
        );
    }

    #[test]
    fn something_that_is_not_subtitles_is_refused_in_words() {
        let harness = Harness::new();
        // Nothing is open for them to belong to.
        assert!(matches!(
            harness
                .player
                .add_subtitles(&[path(&subtitle_file("english"))]),
            Err(AppError::Invalid(_))
        ));
        harness.open_clip();
        harness.expect_status(PlaybackStatus::Playing);
        let refused = harness
            .player
            .add_subtitles(&["/no/such/file.srt".to_owned()]);
        assert!(
            matches!(refused, Err(AppError::Invalid(ref said)) if said.contains("not a subtitle file"))
        );
        assert!(harness.player.file_state().subtitle_files.is_empty());
    }

    #[test]
    fn a_second_track_shows_with_the_first_and_one_track_is_never_both() {
        let harness = with_subtitles(&["english", "french"]);
        let tracks = subtitles(&harness);
        let first = tracks.iter().find(|track| track.selected).unwrap().id;
        let other = tracks.iter().find(|track| !track.selected).unwrap().id;

        // The one already showing cannot also be the second.
        assert!(matches!(
            harness.player.select_second_subtitle(Some(first)),
            Err(AppError::Invalid(_))
        ));
        harness.player.select_second_subtitle(Some(other)).unwrap();
        harness.wait_until("the second track", |snapshot| {
            snapshot
                .tracks
                .iter()
                .any(|track| track.id == other && track.secondary && track.selected)
        });
        assert_eq!(harness.player.file_state().second_subtitle, Some(other));

        // Made the first, it stops being the second.
        harness
            .player
            .select_track(TrackKind::Subtitle, Some(other))
            .unwrap();
        assert_eq!(harness.player.file_state().second_subtitle, None);
        assert_eq!(
            harness.player.file_state().subtitle,
            Some(SubtitleChoice::Track(other))
        );

        harness.player.select_second_subtitle(None).unwrap();
        harness.wait_until("no second track", |snapshot| {
            !snapshot.tracks.iter().any(|track| track.secondary)
        });
    }

    #[test]
    fn turning_subtitles_off_is_a_choice() {
        let harness = with_subtitles(&["english"]);
        harness
            .player
            .select_track(TrackKind::Subtitle, None)
            .unwrap();
        harness.wait_until("no subtitles", |snapshot| {
            !snapshot
                .tracks
                .iter()
                .any(|track| track.kind == TrackKind::Subtitle && track.selected)
        });
        assert_eq!(
            harness.player.file_state().subtitle,
            Some(SubtitleChoice::Off)
        );
        // A track that is not there cannot be chosen, nor "no audio".
        assert!(matches!(
            harness.player.select_track(TrackKind::Subtitle, Some(99)),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            harness.player.select_track(TrackKind::Audio, None),
            Err(AppError::Invalid(_))
        ));
    }

    /// How many subtitle tracks are showing.
    fn showing(snapshot: &crate::engine::types::PlayerSnapshot) -> usize {
        snapshot
            .tracks
            .iter()
            .filter(|track| track.kind == TrackKind::Subtitle && track.selected)
            .count()
    }

    #[test]
    fn subtitles_switched_off_come_back_as_they_were() {
        let harness = with_subtitles(&["english", "french"]);
        let tracks = subtitles(&harness);
        let first = tracks.iter().find(|track| track.selected).unwrap().id;
        let other = tracks.iter().find(|track| !track.selected).unwrap().id;
        harness.player.select_second_subtitle(Some(other)).unwrap();
        harness.wait_until("both tracks", |snapshot| showing(snapshot) == 2);

        // Off: neither shows, and that is what is remembered for the file.
        assert!(!harness.player.toggle_subtitles().unwrap());
        harness.wait_until("no subtitles", |snapshot| showing(snapshot) == 0);
        assert_eq!(
            harness.player.file_state().subtitle,
            Some(SubtitleChoice::Off)
        );

        // On again: the same first track, and the same second.
        assert!(harness.player.toggle_subtitles().unwrap());
        let back = harness.wait_until("both tracks again", |snapshot| showing(snapshot) == 2);
        let shown = |second: bool| {
            back.tracks
                .iter()
                .find(|track| {
                    track.kind == TrackKind::Subtitle && track.selected && track.secondary == second
                })
                .map(|track| track.id)
        };
        assert_eq!(shown(false), Some(first));
        assert_eq!(shown(true), Some(other));
        assert_eq!(
            harness.player.file_state().subtitle,
            Some(SubtitleChoice::Track(first))
        );
    }

    #[test]
    fn subtitles_cannot_be_switched_on_where_there_are_none() {
        let harness = Harness::new();
        assert!(matches!(
            harness.player.toggle_subtitles(),
            Err(AppError::Invalid(_))
        ));
        harness.open_clip();
        harness.expect_status(PlaybackStatus::Playing);
        let refused = harness.player.toggle_subtitles();
        assert!(
            matches!(refused, Err(AppError::Invalid(ref said)) if said.contains("no subtitles"))
        );
    }

    #[test]
    fn software_filters_get_frames_copied_back_from_the_gpu_and_only_while_they_are_in() {
        let harness = Harness::new();
        harness.open_clip();
        harness.expect_status(PlaybackStatus::Playing);
        let mpv = harness.player.mpv();
        let hwdec = || mpv.get_string("hwdec").unwrap().unwrap_or_default();
        assert_eq!(hwdec(), HWDEC_DIRECT);
        let mirrored = Shape {
            mirrored: true,
            ..Shape::default()
        };
        harness.player.set_shape(mirrored).unwrap();
        assert_eq!(hwdec(), HWDEC_COPY);
        // A second filter, then the first out: still one in, still copied.
        harness.player.apply_picture(&Picture {
            noise_reduction: 50,
            ..Picture::default()
        });
        harness.player.set_shape(Shape::default()).unwrap();
        assert_eq!(hwdec(), HWDEC_COPY);
        // The last one out: straight to the screen again.
        harness.player.apply_picture(&Picture::default());
        assert_eq!(hwdec(), HWDEC_DIRECT);
    }

    #[test]
    fn a_quarter_turn_is_reported_as_a_picture_on_its_side() {
        let harness = Harness::new();
        harness.open_clip();
        harness.expect_status(PlaybackStatus::Playing);
        harness.wait_until("the picture's size", |snapshot| {
            snapshot
                .video
                .as_ref()
                .map(|video| (video.width, video.height))
                == Some((320, 180))
        });
        harness
            .player
            .set_shape(Shape {
                turns: 1,
                ..Shape::default()
            })
            .unwrap();
        // The window is shaped from this, so it must stand upright now.
        harness.wait_until("the turned size", |snapshot| {
            snapshot
                .video
                .as_ref()
                .map(|video| (video.width, video.height))
                == Some((180, 320))
        });
    }

    #[test]
    fn a_synced_timing_belongs_to_the_file_and_reaches_further_than_a_delay() {
        let harness = Harness::new();
        harness.open_clip();
        harness.expect_status(PlaybackStatus::Playing);
        let speed = 25.0 / (24_000.0 / 1001.0);
        harness.player.set_subtitle_timing(speed, -95.25).unwrap();
        let snapshot = harness.player.snapshot();
        assert_eq!(snapshot.subtitle_speed, speed);
        // Beyond the 30 s that sound can be moved.
        assert_eq!(snapshot.subtitle_delay, -95.25);
        let mpv = harness.player.mpv();
        // mpv keeps it as a 32-bit float.
        let near = |value: Option<f64>| (value.unwrap() - speed).abs() < 1e-6;
        assert!(near(mpv.get_double("sub-speed").unwrap()));
        assert!(harness.player.set_subtitle_timing(2.0, 0.0).is_err());
        let kept = harness.player.file_state();
        assert_eq!(kept.subtitle_speed, Some(speed));

        harness
            .player
            .open(second_clip().to_str().unwrap())
            .unwrap();
        assert_eq!(harness.player.snapshot().subtitle_speed, 1.0);
        assert_eq!(mpv.get_double("sub-speed").unwrap(), Some(1.0));

        harness
            .player
            .open_at(test_clip().to_str().unwrap(), None, None, Some(&kept))
            .unwrap();
        assert_eq!(harness.player.snapshot().subtitle_speed, speed);
        assert!(near(mpv.get_double("sub-speed").unwrap()));
        assert_eq!(mpv.get_double("sub-delay").unwrap(), Some(-95.25));
    }

    #[test]
    fn delays_and_the_picture_s_shape_belong_to_the_file() {
        let harness = Harness::new();
        harness.open_clip();
        harness.expect_status(PlaybackStatus::Playing);
        harness.player.set_audio_delay(0.25).unwrap();
        harness.player.set_subtitle_delay(-0.5004).unwrap();
        let turned = Shape {
            turns: 1,
            mirrored: true,
            ..Shape::default()
        };
        harness.player.set_shape(turned).unwrap();
        let snapshot = harness.player.snapshot();
        assert_eq!(snapshot.audio_delay, 0.25);
        assert_eq!(snapshot.subtitle_delay, -0.5);
        assert_eq!(snapshot.shape, turned);
        let kept = harness.player.file_state();

        // The next file starts as itself.
        harness
            .player
            .open(second_clip().to_str().unwrap())
            .unwrap();
        let snapshot = harness.player.snapshot();
        assert_eq!(snapshot.audio_delay, 0.0);
        assert_eq!(snapshot.subtitle_delay, 0.0);
        assert_eq!(snapshot.shape, Shape::default());
        let mpv = harness.player.mpv();
        assert_eq!(mpv.get_double("audio-delay").unwrap(), Some(0.0));
        assert_eq!(mpv.get_double("video-rotate").unwrap(), Some(0.0));
        assert!(!mpv
            .get_string("vf")
            .unwrap()
            .unwrap_or_default()
            .contains(MIRROR_LABEL));

        // And the first, opened again with what was chosen for it, has it
        // all back before it has loaded.
        harness
            .player
            .open_at(test_clip().to_str().unwrap(), None, None, Some(&kept))
            .unwrap();
        let snapshot = harness.player.snapshot();
        assert_eq!(snapshot.audio_delay, 0.25);
        assert_eq!(snapshot.subtitle_delay, -0.5);
        assert_eq!(snapshot.shape, turned);
        assert_eq!(mpv.get_double("sub-delay").unwrap(), Some(-0.5));
        assert_eq!(mpv.get_double("video-rotate").unwrap(), Some(90.0));
        assert!(mpv
            .get_string("vf")
            .unwrap()
            .unwrap_or_default()
            .contains(MIRROR_LABEL));
        assert_eq!(harness.player.file_state(), kept);
    }

    #[test]
    fn what_was_chosen_for_a_file_is_chosen_again_when_it_opens() {
        let english = path(&subtitle_file("english"));
        let harness = Harness::new();
        let state = FileState {
            subtitle: Some(SubtitleChoice::Track(1)),
            subtitle_files: vec![english.clone(), "/gone/since/then.srt".to_owned()],
            ..FileState::default()
        };
        harness
            .player
            .open_at(test_clip().to_str().unwrap(), None, None, Some(&state))
            .unwrap();
        let loaded = harness.wait_until("the remembered subtitles", |snapshot| {
            snapshot
                .tracks
                .iter()
                .any(|track| track.kind == TrackKind::Subtitle && track.selected)
        });
        let shown: Vec<&Track> = loaded
            .tracks
            .iter()
            .filter(|track| track.kind == TrackKind::Subtitle)
            .collect();
        // The file that has gone is passed over; the one still there is back.
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].file.as_deref(), Some(english.as_str()));

        // Chosen "off" last time: off this time, though the file is added.
        let off = FileState {
            subtitle: Some(SubtitleChoice::Off),
            subtitle_files: vec![english],
            ..FileState::default()
        };
        harness
            .player
            .open_at(second_clip().to_str().unwrap(), None, None, Some(&off))
            .unwrap();
        let loaded = harness.wait_until("the second file", |snapshot| {
            snapshot.status == PlaybackStatus::Playing
                && snapshot
                    .tracks
                    .iter()
                    .any(|track| track.kind == TrackKind::Subtitle)
        });
        assert!(!loaded
            .tracks
            .iter()
            .any(|track| track.kind == TrackKind::Subtitle && track.selected));
    }

    #[test]
    fn the_picture_is_turned_stretched_and_cut_as_asked() {
        let harness = Harness::new();
        harness.open_clip();
        harness.expect_status(PlaybackStatus::Playing);
        let mpv = harness.player.mpv();
        harness
            .player
            .set_shape(Shape {
                aspect: Some(Ratio {
                    width: 4,
                    height: 3,
                }),
                zoom: 2.0,
                turns: 2,
                flipped: true,
                deinterlace: Deinterlace::On,
                ..Shape::default()
            })
            .unwrap();
        assert_eq!(mpv.get_double("video-zoom").unwrap(), Some(1.0));
        assert_eq!(mpv.get_double("video-rotate").unwrap(), Some(180.0));
        assert_eq!(
            mpv.get_string("deinterlace").unwrap().as_deref(),
            Some("yes")
        );
        assert!(mpv
            .get_string("vf")
            .unwrap()
            .unwrap_or_default()
            .contains(FLIP_LABEL));

        // The clip is 320×180. Cut to 4:3 about its centre: 240 across.
        harness
            .player
            .set_shape(Shape {
                crop: Some(Ratio {
                    width: 4,
                    height: 3,
                }),
                ..Shape::default()
            })
            .unwrap();
        // (The rectangle is worked out from the frames being decoded, which
        // mpv has to hand again a moment after its filters have changed.)
        harness.wait_until("the crop", |_| {
            mpv.get_string("video-crop").unwrap().as_deref() == Some("240x180+40+0")
        });
        assert!(!mpv
            .get_string("vf")
            .unwrap()
            .unwrap_or_default()
            .contains(FLIP_LABEL));
        // And back to all of it.
        harness.player.set_shape(Shape::default()).unwrap();
        assert_eq!(
            mpv.get_string("video-crop").unwrap().unwrap_or_default(),
            ""
        );
    }

    #[test]
    fn the_picture_tuner_sets_levels_and_takes_noise_out_only_when_asked() {
        let harness = Harness::new();
        let mpv = harness.player.mpv();
        let tuned = Picture {
            brightness: 12,
            hue: -30,
            sharpness: 50,
            noise_reduction: 40,
            ..Picture::default()
        };
        harness.player.apply_picture(&tuned);
        assert_eq!(mpv.get_double("brightness").unwrap(), Some(12.0));
        assert_eq!(mpv.get_double("hue").unwrap(), Some(-30.0));
        assert_eq!(mpv.get_double("sharpen").unwrap(), Some(0.75));
        let chain = mpv.get_string("vf").unwrap().unwrap_or_default();
        assert!(chain.contains(DENOISE_LABEL), "vf is {chain}");

        harness.player.apply_picture(&Picture::default());
        assert_eq!(mpv.get_double("brightness").unwrap(), Some(0.0));
        assert!(!mpv
            .get_string("vf")
            .unwrap()
            .unwrap_or_default()
            .contains(DENOISE_LABEL));
    }

    #[test]
    fn the_equaliser_goes_in_when_first_switched_on_and_is_turned_from_then_on() {
        let harness = Harness::new();
        harness.open_clip();
        harness.expect_status(PlaybackStatus::Playing);
        let mpv = harness.player.mpv();
        let chain = || mpv.get_string("af").unwrap().unwrap_or_default();
        let mut equaliser = Equaliser::default();
        equaliser.gains[1] = 6.0;

        // Off, and never been on: sound goes through no filter at all.
        harness.player.apply_equaliser(&equaliser, false);
        assert!(!chain().contains(EQUALISER_LABEL));

        equaliser.enabled = true;
        harness.player.apply_equaliser(&equaliser, false);
        assert!(chain().contains(EQUALISER_LABEL), "af is {}", chain());

        // Turned, and switched off: the chain stays where it is.
        equaliser.gains[1] = -3.0;
        harness.player.apply_equaliser(&equaliser, false);
        equaliser.enabled = false;
        harness.player.apply_equaliser(&equaliser, false);
        assert_eq!(chain().matches(EQUALISER_LABEL).count(), 1);
        // The film has played on through all of it.
        harness.wait_until("playback to go on", |snapshot| snapshot.position > 0.2);

        // Sound handed on undecoded cannot be equalised: it comes out.
        harness.player.apply_equaliser(&equaliser, true);
        assert!(!chain().contains(EQUALISER_LABEL));
    }

    #[test]
    fn a_file_with_no_picture_is_given_a_drawing_of_its_sound() {
        let harness = Harness::new();
        harness.player.open(audio_clip().to_str().unwrap()).unwrap();
        let drawn = harness.wait_until("the drawing", |snapshot| {
            snapshot.video.is_some() && snapshot.status == PlaybackStatus::Playing
        });
        assert!(drawn.visualised);
        // It is still the sound that plays.
        harness.wait_until("the sound to play", |snapshot| snapshot.position > 0.2);

        // A film after it has its own picture.
        harness.open_clip();
        let film = harness.wait_until("the film", |snapshot| {
            !snapshot.visualised
                && snapshot.status == PlaybackStatus::Playing
                && snapshot
                    .video
                    .as_ref()
                    .is_some_and(|video| video.width == 320)
        });
        assert!(!film.visualised);

        // Switched off, a file with no picture has none.
        harness.player.set_visualiser(false);
        harness.player.open(audio_clip().to_str().unwrap()).unwrap();
        let plain = harness.wait_until("the sound alone", |snapshot| {
            snapshot.status == PlaybackStatus::Playing && snapshot.position > 0.1
        });
        assert!(!plain.visualised);
        assert_eq!(plain.video, None);
    }

    #[test]
    fn subtitles_are_lifted_clear_of_a_strip_at_the_bottom() {
        let harness = Harness::new();
        let mpv = harness.player.mpv();
        harness.player.set_subtitle_lift(0.1).unwrap();
        // A tenth of the picture's 720 parts, above mpv's own margin.
        assert_eq!(mpv.get_double("sub-margin-y").unwrap(), Some(106.0));
        harness.player.set_subtitle_lift(0.0).unwrap();
        assert_eq!(mpv.get_double("sub-margin-y").unwrap(), Some(34.0));
        harness.player.set_subtitle_lift(f64::NAN).unwrap();
        assert_eq!(mpv.get_double("sub-margin-y").unwrap(), Some(34.0));
    }

    #[test]
    fn the_style_of_subtitles_and_where_sound_goes_are_set_as_given() {
        let harness = Harness::new();
        let mpv = harness.player.mpv();
        harness.player.apply_subtitle_style(&SubtitleStyle {
            scale: 1.5,
            colour: "#FFEE00".to_owned(),
            background: 0.5,
            ..SubtitleStyle::default()
        });
        assert_eq!(mpv.get_double("sub-scale").unwrap(), Some(1.5));
        assert_eq!(
            mpv.get_string("sub-color").unwrap().as_deref(),
            Some("#FFFFEE00")
        );
        assert_eq!(
            mpv.get_string("sub-border-style").unwrap().as_deref(),
            Some("background-box")
        );

        harness.player.apply_output(None, Channels::Stereo, true);
        assert_eq!(
            mpv.get_string("audio-channels").unwrap().as_deref(),
            Some("stereo")
        );
        assert_eq!(
            mpv.get_string("audio-spdif").unwrap().as_deref(),
            Some(PASSTHROUGH)
        );
        harness.player.apply_output(None, Channels::Auto, false);
        assert_eq!(mpv.get_string("audio-spdif").unwrap().as_deref(), Some(""));
    }

    #[test]
    fn a_delay_is_whole_milliseconds_within_half_a_minute() {
        assert_eq!(delay(0.12345).unwrap(), 0.123);
        assert_eq!(delay(-99.0).unwrap(), -MAX_DELAY);
        assert_eq!(delay(99.0).unwrap(), MAX_DELAY);
        assert!(delay(f64::NAN).is_err());
    }

    #[test]
    fn the_visualiser_draws_the_track_it_is_told_and_still_plays_it() {
        let graph = visualiser_graph(2);
        assert!(graph.starts_with("[aid2] asplit [ao] [seen]"));
        assert!(graph.contains("showwaves="));
        // Opaque: a transparent frame would show what is behind the window.
        assert!(graph.trim_end().ends_with("format=yuv420p [vo]"));
        assert!(graph.ends_with("[vo]"));
    }
}
