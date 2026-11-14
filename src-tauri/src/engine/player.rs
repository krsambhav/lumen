//! The player: one libmpv instance, its event loop, and a snapshot of its
//! state that the interface can read at any time.
//!
//! The player knows nothing about windows or IPC. Whoever creates it passes a
//! listener and receives every change to the snapshot as a `PlayerChange`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use parking_lot::{Mutex, ReentrantMutex, RwLock};

use super::failure;
use super::mpv::{EndReason, Event, Format, Mpv, MpvError, Value};
use super::types::{
    audio_devices_from, chapters_from, dynamic_range_from, tracks_from, FileState, PlaybackStatus,
    PlayerChange, PlayerSnapshot, SubtitleChoice, Track, TrackKind, VideoInfo,
};
use crate::error::{AppError, AppResult};
use crate::media::sources::display_name;

mod adjustments;

/// Where the picture and sound go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Output {
    /// The app: video through the render API into the window, real audio.
    Embedded,
    /// No picture and no sound device. For tests.
    #[cfg_attr(not(test), allow(dead_code))]
    Headless,
}

/// What mpv renders for, matching how the video layer is tagged.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum OutputRange {
    /// BT.709, SDR. HDR sources are tone-mapped down by mpv.
    Sdr,
    /// BT.2020 with the PQ transfer, tone-mapped to `peak_nits`: the brightest
    /// level the display can show right now.
    Hdr { peak_nits: f64 },
}

pub type ChangeListener = Arc<dyn Fn(PlayerChange) + Send + Sync>;

/// Somewhere else playing what is open: a TV being cast to. While there is
/// one, mpv holds still on the open file, and what would start, stop, seek
/// or change the sound is asked of it instead; its own state is what the
/// player reports (see `Player::set_remote`).
pub trait Remote: Send + Sync {
    fn set_paused(&self, paused: bool);
    fn seek_to(&self, seconds: f64);
    fn set_volume(&self, percent: f64);
    fn set_muted(&self, muted: bool);
}

/// The changes a remote reports in mpv's place.
fn is_transport(change: &PlayerChange) -> bool {
    matches!(
        change,
        PlayerChange::Status { .. }
            | PlayerChange::Position { .. }
            | PlayerChange::Volume { .. }
            | PlayerChange::Muted { .. }
            | PlayerChange::Speed { .. }
    )
}

/// The interface is told the position at most this often; it interpolates in
/// between. Seeks and pauses are reported at once.
const POSITION_INTERVAL: Duration = Duration::from_millis(100);

pub const MAX_VOLUME: f64 = 200.0;
pub const MIN_SPEED: f64 = 0.25;
pub const MAX_SPEED: f64 = 4.0;

/// Properties the event loop watches. The discriminant is the observer id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u64)]
enum Watched {
    Pause = 1,
    TimePos,
    Duration,
    Volume,
    Mute,
    Speed,
    IdleActive,
    EofReached,
    PausedForCache,
    MediaTitle,
    TrackList,
    ChapterList,
    VideoParams,
    HwdecCurrent,
    AudioDeviceList,
}

const WATCHED: &[(Watched, &str, Format)] = &[
    (Watched::Pause, "pause", Format::Flag),
    (Watched::TimePos, "time-pos", Format::Double),
    (Watched::Duration, "duration", Format::Double),
    (Watched::Volume, "volume", Format::Double),
    (Watched::Mute, "mute", Format::Flag),
    (Watched::Speed, "speed", Format::Double),
    (Watched::IdleActive, "idle-active", Format::Flag),
    (Watched::EofReached, "eof-reached", Format::Flag),
    (Watched::PausedForCache, "paused-for-cache", Format::Flag),
    (Watched::MediaTitle, "media-title", Format::String),
    (Watched::TrackList, "track-list", Format::Node),
    (Watched::ChapterList, "chapter-list", Format::Node),
    (Watched::VideoParams, "video-params", Format::Node),
    (Watched::HwdecCurrent, "hwdec-current", Format::String),
    (Watched::AudioDeviceList, "audio-device-list", Format::Node),
];

impl Watched {
    fn from_id(id: u64) -> Option<Self> {
        WATCHED
            .iter()
            .map(|(watched, _, _)| *watched)
            .find(|watched| *watched as u64 == id)
    }
}

struct Shared {
    snapshot: RwLock<PlayerSnapshot>,
    listener: ChangeListener,
    quit: AtomicBool,
    /// Set by `open` and cleared when the file has loaded or failed. It makes
    /// the status "loading" from the moment of the request, before mpv has
    /// reported anything.
    opening: AtomicBool,
    /// Where the file being opened is to start, when that is not its
    /// beginning. Taken when the file has loaded, and reported as `Resumed`.
    resume_at: Mutex<Option<f64>>,
    /// What is open was given its name by whoever opened it (a playlist
    /// file's own title for it), so the name mpv finds does not replace it.
    named: AtomicBool,
    /// Held while a position mpv reported is passed on, and while `opening`
    /// is raised, so that the two cannot be interleaved: a position of the
    /// file that was open is told before the new one is named, or not at
    /// all. Reentrant, because a listener may open something in answer to
    /// what it is told.
    positions: ReentrantMutex<()>,
    /// What the user has chosen for the file that is open: see `FileState`.
    chosen: Mutex<FileState>,
    /// The labelled filters Lumen has put in mpv's chains, by chain and
    /// label, each with what it was set to.
    filters: Mutex<HashMap<String, String>>,
    /// The equaliser's chain is in mpv's audio filters.
    equalised: AtomicBool,
    /// A file with no picture is to be given a drawing of its sound.
    visualiser: AtomicBool,
    /// Subtitle files were just added, and the track that made is not
    /// known yet: the next list of tracks says which it is.
    added_subtitles: AtomicBool,
    /// The subtitle tracks that were showing when subtitles were last
    /// switched off, the first and the second, to switch on again.
    set_aside: Mutex<(Option<i32>, Option<i32>)>,
    /// What plays the open file instead of mpv, if anything does.
    remote: RwLock<Option<Arc<dyn Remote>>>,
    /// The event loop is to read mpv's state again and report all of it.
    resync: AtomicBool,
}

impl Shared {
    fn new(listener: ChangeListener) -> Self {
        Self {
            snapshot: RwLock::new(PlayerSnapshot::default()),
            listener,
            quit: AtomicBool::new(false),
            opening: AtomicBool::new(false),
            resume_at: Mutex::new(None),
            named: AtomicBool::new(false),
            positions: ReentrantMutex::new(()),
            chosen: Mutex::new(FileState::default()),
            filters: Mutex::new(HashMap::new()),
            equalised: AtomicBool::new(false),
            visualiser: AtomicBool::new(true),
            added_subtitles: AtomicBool::new(false),
            set_aside: Mutex::new((None, None)),
            remote: RwLock::new(None),
            resync: AtomicBool::new(false),
        }
    }

    /// Applies a change to the snapshot and tells the listener, unless the
    /// snapshot already says the same.
    fn publish(&self, change: PlayerChange) {
        // While a remote plays, mpv's idea of where and how it plays is not news.
        if is_transport(&change) && self.remote.read().is_some() {
            return;
        }
        self.publish_always(change);
    }

    fn publish_always(&self, change: PlayerChange) {
        let changed = {
            let mut snapshot = self.snapshot.write();
            apply(&mut snapshot, &change)
        };
        if changed {
            (self.listener)(change);
        }
    }

    /// Passes on where mpv says playback is, unless something is being
    /// opened: until that has loaded, any position mpv has to give is of
    /// the file it replaces. One that was held back to be told later is the
    /// same, which is why this is asked here and not where it was received.
    fn publish_position(&self, seconds: f64) {
        let _in_order = self.positions.lock();
        if self.opening.load(Ordering::Acquire) {
            return;
        }
        self.publish(PlayerChange::Position { seconds });
    }

    /// Says that something is being opened. No position of what was open
    /// before is passed on from here until the new file has loaded.
    fn start_opening(&self) {
        let _in_order = self.positions.lock();
        self.opening.store(true, Ordering::Release);
    }
}

/// Folds a change into a snapshot. Returns false if nothing changed.
fn apply(snapshot: &mut PlayerSnapshot, change: &PlayerChange) -> bool {
    fn set<T: PartialEq + Clone>(slot: &mut T, value: &T) -> bool {
        if slot == value {
            return false;
        }
        *slot = value.clone();
        true
    }
    match change {
        PlayerChange::Status { status } => set(&mut snapshot.status, status),
        PlayerChange::Media { source, title } => {
            let a = set(&mut snapshot.source, source);
            let b = set(&mut snapshot.title, title);
            a || b
        }
        PlayerChange::Position { seconds } => set(&mut snapshot.position, seconds),
        PlayerChange::Duration { seconds } => set(&mut snapshot.duration, seconds),
        PlayerChange::Volume { percent } => set(&mut snapshot.volume, percent),
        PlayerChange::Muted { muted } => set(&mut snapshot.muted, muted),
        PlayerChange::Speed { rate } => set(&mut snapshot.speed, rate),
        PlayerChange::Video { video } => set(&mut snapshot.video, video),
        PlayerChange::Tracks { tracks } => set(&mut snapshot.tracks, tracks),
        PlayerChange::Chapters { chapters } => set(&mut snapshot.chapters, chapters),
        PlayerChange::AudioDelay { seconds } => set(&mut snapshot.audio_delay, seconds),
        PlayerChange::SubtitleDelay { seconds } => set(&mut snapshot.subtitle_delay, seconds),
        PlayerChange::SubtitleSpeed { rate } => set(&mut snapshot.subtitle_speed, rate),
        PlayerChange::Shape { shape } => set(&mut snapshot.shape, shape),
        PlayerChange::AudioDevices { devices } => set(&mut snapshot.audio_devices, devices),
        PlayerChange::Visualised { visualised } => set(&mut snapshot.visualised, visualised),
        // Events, not state: always delivered.
        PlayerChange::Failed { .. } | PlayerChange::Resumed { .. } => true,
    }
}

pub struct Player {
    mpv: Arc<Mpv>,
    shared: Arc<Shared>,
    events: Mutex<Option<JoinHandle<()>>>,
}

impl Player {
    pub fn new(output: Output, listener: ChangeListener) -> AppResult<Self> {
        let ytdl = ytdl_options();
        let mut all: Vec<(&str, &str)> = options(output);
        if let Some(ytdl) = ytdl.as_deref() {
            all.push(("script-opts", ytdl));
        }
        let mpv = Arc::new(Mpv::new(&all)?);
        for (watched, name, format) in WATCHED {
            mpv.observe(*watched as u64, name, *format)?;
        }
        mpv.request_log_messages("warn")?;

        let shared = Arc::new(Shared::new(listener));
        let events = std::thread::Builder::new()
            .name("lumen-player".to_owned())
            .spawn({
                let mpv = mpv.clone();
                let shared = shared.clone();
                move || EventLoop::new(mpv, shared).run()
            })
            .map_err(|error| {
                AppError::Internal(format!("could not start player thread: {error}"))
            })?;

        Ok(Self {
            mpv,
            shared,
            events: Mutex::new(Some(events)),
        })
    }

    /// The underlying mpv handle, for the video surface's render context.
    pub fn mpv(&self) -> Arc<Mpv> {
        self.mpv.clone()
    }

    pub fn snapshot(&self) -> PlayerSnapshot {
        self.shared.snapshot.read().clone()
    }

    /// Opens a file path or URL and starts playing it from its beginning.
    #[cfg(test)]
    pub fn open(&self, source: &str) -> AppResult<()> {
        self.open_at(source, None, None, None)
    }

    /// Opens a file path or URL and starts playing it.
    ///
    /// `title` is what to call it, if the caller knows better than its file
    /// name. `start` is where to begin, in seconds, if not at the beginning;
    /// that is then reported as `Resumed` once the file has loaded. `state`
    /// is what was chosen for this file the last time it was open.
    pub fn open_at(
        &self,
        source: &str,
        title: Option<&str>,
        start: Option<f64>,
        state: Option<&FileState>,
    ) -> AppResult<()> {
        if source.trim().is_empty() {
            return Err(AppError::Invalid("nothing to open".to_owned()));
        }
        let start = start.filter(|seconds| seconds.is_finite() && *seconds > 0.0);
        let title = title.map(str::trim).filter(|title| !title.is_empty());
        let before = self.snapshot();
        let chosen_before = self.shared.file_state();
        let state = state.cloned().unwrap_or_default().sanitised();
        let named_before = self.shared.named.swap(title.is_some(), Ordering::AcqRel);
        *self.shared.resume_at.lock() = start;
        self.shared.start_opening();
        self.shared.publish(PlayerChange::Media {
            source: Some(source.to_owned()),
            title: Some(title.map_or_else(|| display_name(source), str::to_owned)),
        });
        // Where the new file will start, so the timeline does not go on
        // showing where the old one was while this one loads.
        self.shared.publish(PlayerChange::Position {
            seconds: start.unwrap_or(0.0),
        });
        self.shared.publish(PlayerChange::Status {
            status: PlaybackStatus::Loading,
        });
        self.shared.added_subtitles.store(false, Ordering::Release);
        *self.shared.set_aside.lock() = (None, None);
        *self.shared.chosen.lock() = state.clone();
        self.prepare(source, &state);
        let loaded = match start {
            // The third argument is where in mpv's own playlist the file
            // goes, which Lumen does not use; the options follow it.
            Some(seconds) => self.mpv.command(&[
                "loadfile",
                source,
                "replace",
                "-1",
                &format!("start={seconds:.3}"),
            ]),
            None => self.mpv.command(&["loadfile", source, "replace"]),
        };
        let remote = self.shared.remote.read().is_some();
        let started = loaded.and_then(|()| self.mpv.set_flag("pause", remote));
        if started.is_err() {
            // mpv would not even take the request: whatever was open still is.
            self.shared.opening.store(false, Ordering::Release);
            self.shared.named.store(named_before, Ordering::Release);
            *self.shared.resume_at.lock() = None;
            // Its adjustments are its own again, too.
            if let Some(source) = before.source.as_deref() {
                self.prepare(source, &chosen_before);
            }
            *self.shared.chosen.lock() = chosen_before;
            self.shared.publish(PlayerChange::Media {
                source: before.source,
                title: before.title,
            });
            self.shared.publish(PlayerChange::Position {
                seconds: before.position,
            });
            self.shared.publish(PlayerChange::Status {
                status: before.status,
            });
        }
        Ok(started?)
    }

    /// True when nothing is open and nothing is being opened.
    pub fn is_idle(&self) -> bool {
        self.snapshot().source.is_none()
    }

    /// Plays the open file round and round, without a gap, or stops doing so.
    pub fn set_looping(&self, looping: bool) -> AppResult<()> {
        Ok(self
            .mpv
            .set_string("loop-file", if looping { "inf" } else { "no" })?)
    }

    /// Closes whatever is open and returns to idle.
    pub fn stop(&self) -> AppResult<()> {
        Ok(self.mpv.command(&["stop"])?)
    }

    pub fn set_paused(&self, paused: bool) -> AppResult<()> {
        if let Some(remote) = self.remote() {
            if !paused && self.snapshot().status == PlaybackStatus::Ended {
                remote.seek_to(0.0);
            }
            remote.set_paused(paused);
            return Ok(());
        }
        // Playing again from the end restarts the file.
        if !paused && self.snapshot().status == PlaybackStatus::Ended {
            return self.restart();
        }
        Ok(self.mpv.set_flag("pause", paused)?)
    }

    /// Plays the open file again from its beginning.
    pub fn restart(&self) -> AppResult<()> {
        if let Some(remote) = self.remote() {
            remote.seek_to(0.0);
            remote.set_paused(false);
            return Ok(self.mpv.command(&["seek", "0", "absolute"])?);
        }
        self.mpv.command(&["seek", "0", "absolute"])?;
        Ok(self.mpv.set_flag("pause", false)?)
    }

    /// Shows the next frame, or the one before, and stays paused on it.
    pub fn step_frame(&self, forward: bool) -> AppResult<()> {
        // A TV cannot be stepped a frame at a time.
        if self.remote().is_some() {
            return Ok(());
        }
        Ok(self.mpv.command(&[if forward {
            "frame-step"
        } else {
            "frame-back-step"
        }])?)
    }

    pub fn toggle_paused(&self) -> AppResult<()> {
        let status = self.snapshot().status;
        self.set_paused(!matches!(
            status,
            PlaybackStatus::Paused | PlaybackStatus::Ended
        ))
    }

    /// Seeks to an absolute time. `exact` lands on the frame at that time;
    /// otherwise on the nearest keyframe, which is much faster and is what
    /// dragging the timeline wants.
    pub fn seek_to(&self, seconds: f64, exact: bool) -> AppResult<()> {
        if !seconds.is_finite() {
            return Err(AppError::Invalid(
                "seek position is not a number".to_owned(),
            ));
        }
        if let Some(remote) = self.remote() {
            remote.seek_to(seconds.max(0.0));
            // The still on the Mac follows, so the stage shows where the TV is.
            let target = format!("{:.6}", seconds.max(0.0));
            return Ok(self.mpv.command(&["seek", &target, "absolute+keyframes"])?);
        }
        let target = format!("{:.6}", seconds.max(0.0));
        let mode = if exact {
            "absolute+exact"
        } else {
            "absolute+keyframes"
        };
        Ok(self.mpv.command(&["seek", &target, mode])?)
    }

    /// Seeks relative to the current position, exactly.
    pub fn seek_by(&self, seconds: f64) -> AppResult<()> {
        if !seconds.is_finite() {
            return Err(AppError::Invalid(
                "seek distance is not a number".to_owned(),
            ));
        }
        if self.remote().is_some() {
            let snapshot = self.snapshot();
            let mut target = (snapshot.position + seconds).max(0.0);
            if let Some(duration) = snapshot.duration {
                target = target.min(duration);
            }
            return self.seek_to(target, false);
        }
        let distance = format!("{seconds:.6}");
        Ok(self.mpv.command(&["seek", &distance, "relative+exact"])?)
    }

    /// Sets the volume in percent, clamped to 0–200.
    pub fn set_volume(&self, percent: f64) -> AppResult<()> {
        if !percent.is_finite() {
            return Err(AppError::Invalid("volume is not a number".to_owned()));
        }
        if let Some(remote) = self.remote() {
            remote.set_volume(percent.clamp(0.0, 100.0));
            return Ok(());
        }
        Ok(self
            .mpv
            .set_double("volume", percent.clamp(0.0, MAX_VOLUME))?)
    }

    pub fn set_muted(&self, muted: bool) -> AppResult<()> {
        if let Some(remote) = self.remote() {
            remote.set_muted(muted);
            return Ok(());
        }
        Ok(self.mpv.set_flag("mute", muted)?)
    }

    /// Sets the playback speed, clamped to 0.25–4. Pitch is preserved.
    pub fn set_speed(&self, rate: f64) -> AppResult<()> {
        if !rate.is_finite() {
            return Err(AppError::Invalid("speed is not a number".to_owned()));
        }
        // A cast film plays at its own speed.
        if self.remote().is_some() {
            return Ok(());
        }
        Ok(self
            .mpv
            .set_double("speed", rate.clamp(MIN_SPEED, MAX_SPEED))?)
    }

    fn remote(&self) -> Option<Arc<dyn Remote>> {
        self.shared.remote.read().clone()
    }

    /// Hands playback to `remote`, or takes it back with `None`.
    ///
    /// Handing it over pauses mpv where it is; from then on only what the
    /// remote reports through `publish_remote` says where playback is and
    /// how loud. Taking it back reports mpv's own state again, still paused.
    pub fn set_remote(&self, remote: Option<Arc<dyn Remote>>) {
        let handing_over = remote.is_some();
        if handing_over {
            let _ = self.mpv.set_flag("pause", true);
        }
        *self.shared.remote.write() = remote;
        if !handing_over {
            self.shared.resync.store(true, Ordering::Release);
            self.mpv.wakeup();
        }
    }

    pub fn is_remote(&self) -> bool {
        self.shared.remote.read().is_some()
    }

    /// Reports a change of the remote's: where it is, whether it plays, how loud.
    pub fn publish_remote(&self, change: PlayerChange) {
        if self.is_remote() {
            self.shared.publish_always(change);
        }
    }

    /// Where mpv itself is in the open file, once it has loaded.
    pub fn local_position(&self) -> Option<f64> {
        if self.shared.opening.load(Ordering::Acquire) {
            return None;
        }
        self.mpv.get_double("time-pos").ok().flatten()
    }

    /// Keeps the picture out of a strip at the right of the window, given as
    /// a share of the window's width: the picture is fitted into the rest.
    pub fn set_right_margin(&self, share: f64) -> AppResult<()> {
        let share = if share.is_finite() {
            share.clamp(0.0, 0.9)
        } else {
            0.0
        };
        Ok(self.mpv.set_double("video-margin-ratio-right", share)?)
    }

    /// Tells mpv what the video layer expects. Must be kept in step with the
    /// layer's own colour space.
    pub fn set_output_range(&self, range: OutputRange) -> AppResult<()> {
        match range {
            OutputRange::Sdr => {
                self.mpv.set_string("target-prim", "bt.709")?;
                self.mpv.set_string("target-trc", "bt.1886")?;
                self.mpv.set_string("target-peak", "auto")?;
            }
            OutputRange::Hdr { peak_nits } => {
                self.mpv.set_string("target-prim", "bt.2020")?;
                self.mpv.set_string("target-trc", "pq")?;
                let peak = peak_nits.clamp(100.0, 10_000.0).round();
                self.mpv.set_string("target-peak", &format!("{peak}"))?;
            }
        }
        Ok(())
    }

    /// Stops the event loop. Call before the video surface is detached and the
    /// player dropped.
    pub fn shutdown(&self) {
        self.shared.quit.store(true, Ordering::Release);
        self.mpv.wakeup();
        if let Some(thread) = self.events.lock().take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl From<MpvError> for AppError {
    fn from(error: MpvError) -> Self {
        // The interface shows this to the user. Which call failed is for the
        // log; what mpv said about it is the part a person can use.
        tracing::warn!(%error, "the playback engine refused");
        match error {
            MpvError::Api { message, .. } => Self::Engine(message),
            other => Self::Engine(other.to_string()),
        }
    }
}

/// Where yt-dlp is, for mpv's built-in hook that turns the address of a web
/// page (YouTube, Vimeo and the rest) into streams it can play.
///
/// An app opened from the Finder gets a bare `PATH`, so the hook would not
/// find a copy installed with Homebrew, pipx or uv on its own. `LUMEN_YTDL`
/// names one outright. Without yt-dlp, addresses of media files and streams
/// still play; pages of video sites do not.
fn find_ytdl() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    if let Some(named) = std::env::var_os("LUMEN_YTDL") {
        return Some(PathBuf::from(named));
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut places: Vec<PathBuf> = Vec::new();
    if let Some(home) = &home {
        places.push(home.join(".local/bin"));
    }
    places.extend(["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"].map(PathBuf::from));
    if let Some(path) = std::env::var_os("PATH") {
        places.extend(std::env::split_paths(&path));
    }
    places
        .into_iter()
        .map(|place| place.join("yt-dlp"))
        .find(|candidate| candidate.is_file())
}

/// The hook's options: which yt-dlp to run. `None` if there is none.
fn ytdl_options() -> Option<String> {
    let found = find_ytdl()?;
    let path = found.to_str()?;
    // `script-opts` is a comma-separated list; a path with a comma cannot be named in it.
    if path.contains(',') {
        tracing::warn!(path, "yt-dlp is at a path mpv cannot be given");
        return None;
    }
    tracing::info!(path, "web pages of video sites open with yt-dlp");
    Some(format!("ytdl_hook-ytdl_path={path}"))
}

fn options(output: Output) -> Vec<(&'static str, &'static str)> {
    let mut options = vec![
        // Lumen is the only source of configuration and input.
        ("config", "no"),
        ("terminal", "no"),
        ("load-scripts", "no"),
        ("osc", "no"),
        // The one built-in script Lumen keeps: addresses of video sites' pages, through yt-dlp.
        ("ytdl", "yes"),
        ("osd-level", "0"),
        ("osd-bar", "no"),
        ("input-default-bindings", "no"),
        ("input-builtin-bindings", "no"),
        ("input-vo-keyboard", "no"),
        ("input-cursor", "no"),
        ("load-stats-overlay", "no"),
        ("load-console", "no"),
        ("load-auto-profiles", "no"),
        ("load-select", "no"),
        ("load-commands", "no"),
        ("load-positioning", "no"),
        ("load-context-menu", "no"),
        // Stay alive with nothing open, and hold the last frame at the end.
        ("idle", "yes"),
        ("keep-open", "yes"),
        ("force-window", "no"),
        // Sound.
        ("volume", "100"),
        ("volume-max", "200"),
        ("audio-pitch-correction", "yes"),
        // Subtitles: a film that has them starts with them showing, even
        // when no track is marked as the default and when they are in the
        // language that is spoken. Turning them off is remembered per file.
        ("subs-fallback", "yes"),
        ("subs-with-matching-audio", "yes"),
        ("subs-match-os-language", "yes"),
        // Decoding: VideoToolbox where the Mac supports the codec.
        ("hwdec", adjustments::HWDEC_DIRECT),
    ];
    match output {
        Output::Embedded => options.extend([
            ("vo", "libmpv"),
            // The layer is tagged BT.709 with a 2.2 gamma; anything else is
            // converted to that by mpv, and from there to the display by macOS.
            ("target-prim", "bt.709"),
            ("target-trc", "bt.1886"),
        ]),
        Output::Headless => options.extend([("vo", "null"), ("ao", "null")]),
    }
    options
}

/// Runs on the player thread: turns mpv's events into `PlayerChange`s.
struct EventLoop {
    mpv: Arc<Mpv>,
    shared: Arc<Shared>,
    idle: bool,
    /// A file is open and playable (between "file loaded" and its end).
    loaded: bool,
    paused: bool,
    ended: bool,
    buffering: bool,
    /// The newest position mpv reported that the interface has not been told.
    pending_position: Option<f64>,
    last_position: Instant,
}

impl EventLoop {
    fn new(mpv: Arc<Mpv>, shared: Arc<Shared>) -> Self {
        Self {
            mpv,
            shared,
            idle: true,
            loaded: false,
            paused: false,
            ended: false,
            buffering: false,
            pending_position: None,
            last_position: Instant::now(),
        }
    }

    fn run(mut self) {
        while !self.shared.quit.load(Ordering::Acquire) {
            // The timeout bounds how late a throttled position can be.
            let event = self.mpv.wait_event(POSITION_INTERVAL.as_secs_f64());
            match event {
                Event::Shutdown => break,
                Event::None => self.flush_position(false),
                event => self.handle(event),
            }
            if self.shared.resync.swap(false, Ordering::AcqRel) {
                self.resync();
                self.pending_position = self.mpv.get_double("time-pos").ok().flatten();
                self.flush_position(true);
            }
        }
    }

    fn handle(&mut self, event: Event) {
        match event {
            Event::StartFile => {
                self.loaded = false;
                self.ended = false;
                // Whatever position was waiting to be reported was the
                // previous file's.
                self.pending_position = None;
                self.publish_status();
            }
            Event::FileLoaded => {
                self.loaded = true;
                self.shared.opening.store(false, Ordering::Release);
                self.publish_status();
                if let Some(seconds) = self.shared.resume_at.lock().take() {
                    self.shared.publish(PlayerChange::Resumed { seconds });
                }
            }
            Event::PlaybackRestart => self.flush_position(true),
            Event::EndFile { reason, error } => {
                self.loaded = false;
                if reason == EndReason::Error {
                    self.shared.opening.store(false, Ordering::Release);
                    let source = self
                        .shared
                        .snapshot
                        .read()
                        .source
                        .clone()
                        .unwrap_or_default();
                    let said = error.unwrap_or_else(|| "unknown error".to_owned());
                    tracing::warn!(%source, engine = %said, "could not play");
                    *self.shared.resume_at.lock() = None;
                    self.shared.publish(PlayerChange::Failed {
                        reason: failure::classify(&source, &said),
                        reveal: failure::reveal_target(&source)
                            .map(|path| path.to_string_lossy().into_owned()),
                        source,
                    });
                    // Whoever heard that may already have opened something
                    // else. If not, nothing is open any more.
                    self.clear_media();
                }
                self.publish_status();
            }
            Event::PropertyChange { id, value, .. } => {
                if let Some(watched) = Watched::from_id(id) {
                    self.property(watched, value);
                }
            }
            Event::Log {
                level,
                prefix,
                text,
            } => {
                if level <= 20 {
                    tracing::error!(target: "mpv", "[{prefix}] {text}");
                } else {
                    tracing::warn!(target: "mpv", "[{prefix}] {text}");
                }
            }
            Event::QueueOverflow => {
                tracing::warn!("mpv dropped events; re-reading state");
                self.resync();
            }
            _ => {}
        }
    }

    fn property(&mut self, watched: Watched, value: Value) {
        match watched {
            Watched::Pause => {
                self.paused = value.as_bool().unwrap_or(false);
                self.flush_position(true);
                self.publish_status();
            }
            Watched::IdleActive => {
                let was_idle = self.idle;
                self.idle = value.as_bool().unwrap_or(true);
                // Only a change to idle clears the media. mpv also reports
                // the value it already had at start-up, and by then `open`
                // may have named the file that is about to load.
                if self.idle && !was_idle {
                    self.loaded = false;
                    self.ended = false;
                    self.clear_media();
                }
                self.publish_status();
            }
            Watched::EofReached => {
                self.ended = value.as_bool().unwrap_or(false);
                self.flush_position(true);
                self.publish_status();
            }
            Watched::PausedForCache => {
                self.buffering = value.as_bool().unwrap_or(false);
                self.publish_status();
            }
            Watched::TimePos => {
                // While something is being opened, positions are still those
                // of what it replaces.
                if self.shared.opening.load(Ordering::Acquire) {
                    return;
                }
                if let Some(seconds) = value.as_f64().filter(|seconds| seconds.is_finite()) {
                    self.pending_position = Some(seconds.max(0.0));
                    self.flush_position(false);
                }
            }
            Watched::Duration => {
                let seconds = value.as_f64().filter(|d| d.is_finite() && *d > 0.0);
                self.shared.publish(PlayerChange::Duration { seconds });
            }
            Watched::Volume => {
                if let Some(percent) = value.as_f64() {
                    self.shared.publish(PlayerChange::Volume { percent });
                }
            }
            Watched::Mute => {
                if let Some(muted) = value.as_bool() {
                    self.shared.publish(PlayerChange::Muted { muted });
                }
            }
            Watched::Speed => {
                if let Some(rate) = value.as_f64() {
                    self.shared.publish(PlayerChange::Speed { rate });
                }
            }
            Watched::MediaTitle => {
                // The file name set by `open` stands for local files, whose
                // embedded titles are often junk; streams take mpv's title.
                let source = self.shared.snapshot.read().source.clone();
                if self.shared.named.load(Ordering::Acquire) {
                    return;
                }
                if let (Some(title), Some(source)) = (value.as_str(), source) {
                    // "0" for `…/dl/<torrent>/0` is the address's tail, not a title.
                    if source.contains("://")
                        && crate::media::sources::given_name(&source, title).is_some()
                    {
                        self.shared.publish(PlayerChange::Media {
                            source: Some(source),
                            title: Some(title.to_owned()),
                        });
                    }
                }
            }
            Watched::TrackList => {
                let tracks = value.as_node().map(tracks_from).unwrap_or_default();
                self.note_added_subtitles(&tracks);
                self.shared.publish(PlayerChange::Tracks { tracks });
            }
            Watched::AudioDeviceList => {
                let devices = value.as_node().map(audio_devices_from).unwrap_or_default();
                self.shared.publish(PlayerChange::AudioDevices { devices });
            }
            Watched::ChapterList => {
                let chapters = value.as_node().map(chapters_from).unwrap_or_default();
                self.shared.publish(PlayerChange::Chapters { chapters });
            }
            Watched::VideoParams => {
                // A crop is a rectangle of these frames: worked out again
                // whenever they change.
                adjustments::apply_crop(&self.mpv, &self.shared.file_state().shape);
                self.publish_video();
            }
            Watched::HwdecCurrent => self.publish_video(),
        }
    }

    /// After subtitle files are added by hand, the track mpv then shows is
    /// the one the user chose: it is remembered as their choice.
    fn note_added_subtitles(&self, tracks: &[Track]) {
        if !self.shared.added_subtitles.load(Ordering::Acquire) {
            return;
        }
        let shown = tracks.iter().find(|track| {
            track.kind == TrackKind::Subtitle
                && track.external
                && track.selected
                && !track.secondary
        });
        if let Some(track) = shown {
            self.shared.chosen.lock().subtitle = Some(SubtitleChoice::Track(track.id));
            self.shared.added_subtitles.store(false, Ordering::Release);
        }
    }

    /// Forgets what was open, unless something else is already on its way:
    /// mpv reports going idle after a file fails or is stopped even when the
    /// next one has been asked for by then, and that one must keep its name.
    fn clear_media(&mut self) {
        if self.shared.opening.load(Ordering::Acquire) {
            return;
        }
        self.pending_position = None;
        self.shared.publish(PlayerChange::Media {
            source: None,
            title: None,
        });
        self.shared.publish(PlayerChange::Position { seconds: 0.0 });
    }

    fn status(&self) -> PlaybackStatus {
        if self.shared.opening.load(Ordering::Acquire) {
            PlaybackStatus::Loading
        } else if self.idle {
            PlaybackStatus::Idle
        } else if !self.loaded {
            // Between leaving idle and the file being readable.
            PlaybackStatus::Loading
        } else if self.ended {
            PlaybackStatus::Ended
        } else if self.buffering {
            PlaybackStatus::Buffering
        } else if self.paused {
            PlaybackStatus::Paused
        } else {
            PlaybackStatus::Playing
        }
    }

    fn publish_status(&self) {
        self.shared.publish(PlayerChange::Status {
            status: self.status(),
        });
    }

    /// Reports the pending position if enough time has passed, or at once
    /// when `now` is set (after a seek, a pause, the end).
    fn flush_position(&mut self, now: bool) {
        if !now && self.last_position.elapsed() < POSITION_INTERVAL {
            return;
        }
        if let Some(seconds) = self.pending_position.take() {
            self.last_position = Instant::now();
            self.shared.publish_position(seconds);
        }
    }

    fn publish_video(&self) {
        let params = self
            .mpv
            .get("video-params", Format::Node)
            .ok()
            .and_then(|value| value.as_node().cloned());
        let video = params.and_then(|params| {
            let size = |key: &str| {
                params
                    .get(key)
                    .and_then(serde_json::Value::as_i64)
                    .and_then(|value| i32::try_from(value).ok())
                    .filter(|value| *value > 0)
            };
            // `dw` and `dh` are the picture before it is turned; `rotate`
            // is the file's own turn and the one chosen for it, together.
            let sideways = params
                .get("rotate")
                .and_then(serde_json::Value::as_i64)
                .is_some_and(|degrees| degrees.rem_euclid(180) == 90);
            let (width, height) = (size("dw")?, size("dh")?);
            let (width, height) = if sideways {
                (height, width)
            } else {
                (width, height)
            };
            Some(VideoInfo {
                width,
                height,
                fps: self
                    .mpv
                    .get_double("container-fps")
                    .ok()
                    .flatten()
                    .filter(|fps| fps.is_finite() && *fps > 0.0),
                codec: self.mpv.get_string("video-format").ok().flatten(),
                dynamic_range: dynamic_range_from(&params),
                hardware_decoder: self
                    .mpv
                    .get_string("hwdec-current")
                    .ok()
                    .flatten()
                    .filter(|name| !name.is_empty() && name != "no"),
            })
        });
        self.shared.publish(PlayerChange::Video { video });
    }

    /// Re-reads every watched property after events were lost.
    fn resync(&mut self) {
        for (watched, name, format) in WATCHED {
            if let Ok(value) = self.mpv.get(name, *format) {
                self.property(*watched, value);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::{channel, Receiver};

    use super::*;
    use crate::engine::failure::FailureReason;
    use crate::engine::test_support::test_clip;

    pub(super) struct Harness {
        pub(super) player: Player,
        changes: Receiver<PlayerChange>,
    }

    impl Harness {
        pub(super) fn new() -> Self {
            let (sender, changes) = channel();
            let sender = Mutex::new(sender);
            let player = Player::new(
                Output::Headless,
                Arc::new(move |change| {
                    let _ = sender.lock().send(change);
                }),
            )
            .expect("create player");
            Self { player, changes }
        }

        /// Waits for a change that `wanted` accepts; fails after five seconds.
        fn expect<T>(&self, what: &str, mut wanted: impl FnMut(&PlayerChange) -> Option<T>) -> T {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                match self.changes.recv_timeout(left) {
                    Ok(change) => {
                        if let Some(found) = wanted(&change) {
                            return found;
                        }
                    }
                    Err(_) => panic!("timed out waiting for {what}"),
                }
            }
        }

        /// Polls the snapshot until `ready` accepts it; fails after five seconds.
        pub(super) fn wait_until(
            &self,
            what: &str,
            ready: impl Fn(&PlayerSnapshot) -> bool,
        ) -> PlayerSnapshot {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let snapshot = self.player.snapshot();
                if ready(&snapshot) {
                    return snapshot;
                }
                assert!(Instant::now() < deadline, "timed out waiting for {what}");
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        pub(super) fn expect_status(&self, status: PlaybackStatus) {
            self.expect(&format!("status {status:?}"), |change| {
                (*change == PlayerChange::Status { status }).then_some(())
            });
        }

        pub(super) fn open_clip(&self) {
            self.player.open(test_clip().to_str().unwrap()).unwrap();
        }
    }

    #[test]
    fn starts_idle_with_default_levels() {
        let harness = Harness::new();
        let snapshot = harness.player.snapshot();
        assert_eq!(snapshot.status, PlaybackStatus::Idle);
        assert_eq!(snapshot.source, None);
        assert_eq!(snapshot.volume, 100.0);
        assert_eq!(snapshot.speed, 1.0);
    }

    #[test]
    fn opening_a_file_reports_its_name_then_plays() {
        let harness = Harness::new();
        harness.open_clip();
        let title = harness.expect("media", |change| match change {
            PlayerChange::Media {
                title,
                source: Some(_),
            } => title.clone(),
            _ => None,
        });
        assert_eq!(title, "clip-v1");
        harness.expect_status(PlaybackStatus::Loading);
        harness.expect_status(PlaybackStatus::Playing);

        let snapshot = harness.player.snapshot();
        assert_eq!(snapshot.title.as_deref(), Some("clip-v1"));
        assert!(snapshot.source.is_some());
    }

    #[test]
    fn reports_duration_tracks_and_chapters() {
        let harness = Harness::new();
        harness.open_clip();
        // These arrive in no fixed order relative to each other.
        let snapshot = harness.wait_until("media details", |snapshot| {
            snapshot.duration.is_some()
                && snapshot.chapters.len() == 2
                && snapshot.tracks.len() >= 2
                && snapshot.status == PlaybackStatus::Playing
        });
        let duration = snapshot.duration.unwrap();
        assert!((duration - 2.0).abs() < 0.2, "duration {duration}");
        let kinds: Vec<_> = snapshot.tracks.iter().map(|track| track.kind).collect();
        assert!(
            kinds.contains(&crate::engine::types::TrackKind::Video),
            "{kinds:?}"
        );
        assert!(
            kinds.contains(&crate::engine::types::TrackKind::Audio),
            "{kinds:?}"
        );
        let titles: Vec<_> = snapshot
            .chapters
            .iter()
            .map(|chapter| chapter.title.clone().unwrap_or_default())
            .collect();
        assert_eq!(titles, ["Opening", "Second half"]);
        assert_eq!(snapshot.chapters[1].time, 1.0);
    }

    #[test]
    fn position_advances_and_is_throttled() {
        let harness = Harness::new();
        harness.open_clip();
        harness.expect_status(PlaybackStatus::Playing);
        let started = Instant::now();
        let mut positions = Vec::new();
        while started.elapsed() < Duration::from_millis(900) {
            if let Ok(PlayerChange::Position { seconds }) =
                harness.changes.recv_timeout(Duration::from_millis(200))
            {
                positions.push(seconds);
            }
        }
        assert!(positions.len() >= 4, "too few updates: {positions:?}");
        // 30 frames a second arrive from mpv; about ten a second leave.
        assert!(positions.len() <= 14, "not throttled: {positions:?}");
        assert!(
            positions.windows(2).all(|pair| pair[1] >= pair[0]),
            "{positions:?}"
        );
    }

    #[test]
    fn pausing_reports_the_exact_position_at_once() {
        let harness = Harness::new();
        harness.open_clip();
        harness.expect_status(PlaybackStatus::Playing);
        std::thread::sleep(Duration::from_millis(300));
        harness.player.set_paused(true).unwrap();
        harness.expect_status(PlaybackStatus::Paused);
        let reported = harness.player.snapshot().position;
        let actual = harness
            .player
            .mpv()
            .get_double("time-pos")
            .unwrap()
            .unwrap();
        assert!((reported - actual).abs() < 0.05, "{reported} vs {actual}");
        assert!(reported > 0.1);
    }

    #[test]
    fn seeks_exactly_while_paused() {
        let harness = Harness::new();
        harness.open_clip();
        harness.expect_status(PlaybackStatus::Playing);
        harness.player.set_paused(true).unwrap();
        harness.expect_status(PlaybackStatus::Paused);

        harness.player.seek_to(1.25, true).unwrap();
        let landed = harness.expect("seek position", |change| match change {
            PlayerChange::Position { seconds } if (*seconds - 1.25).abs() < 0.05 => Some(*seconds),
            _ => None,
        });
        assert!((landed - 1.25).abs() < 0.05);

        harness.player.seek_by(-1.0).unwrap();
        harness.expect("relative seek", |change| match change {
            PlayerChange::Position { seconds } if (*seconds - 0.25).abs() < 0.06 => Some(()),
            _ => None,
        });
    }

    #[test]
    fn rejects_values_that_are_not_numbers() {
        let harness = Harness::new();
        assert!(matches!(
            harness.player.seek_to(f64::NAN, true),
            Err(AppError::Invalid(_))
        ));
        assert!(matches!(
            harness.player.seek_by(f64::INFINITY),
            Err(AppError::Invalid(_))
        ));
        assert!(matches!(
            harness.player.set_volume(f64::NAN),
            Err(AppError::Invalid(_))
        ));
        assert!(matches!(
            harness.player.set_speed(f64::NAN),
            Err(AppError::Invalid(_))
        ));
        assert!(matches!(
            harness.player.open("  "),
            Err(AppError::Invalid(_))
        ));
    }

    #[test]
    fn clamps_volume_and_speed_and_reports_them() {
        let harness = Harness::new();
        harness.player.set_volume(250.0).unwrap();
        harness.expect("volume", |change| {
            (*change == PlayerChange::Volume { percent: 200.0 }).then_some(())
        });
        harness.player.set_volume(-5.0).unwrap();
        harness.expect("volume", |change| {
            (*change == PlayerChange::Volume { percent: 0.0 }).then_some(())
        });
        harness.player.set_speed(9.0).unwrap();
        harness.expect("speed", |change| {
            (*change == PlayerChange::Speed { rate: 4.0 }).then_some(())
        });
        harness.player.set_speed(0.1).unwrap();
        harness.expect("speed", |change| {
            (*change == PlayerChange::Speed { rate: 0.25 }).then_some(())
        });
        harness.player.set_muted(true).unwrap();
        harness.expect("mute", |change| {
            (*change == PlayerChange::Muted { muted: true }).then_some(())
        });
    }

    #[test]
    fn holds_the_last_frame_at_the_end_and_replays_from_the_start() {
        let harness = Harness::new();
        harness.open_clip();
        harness.expect_status(PlaybackStatus::Playing);
        harness.player.seek_to(1.7, true).unwrap();
        harness.expect_status(PlaybackStatus::Ended);
        assert!(
            harness.player.snapshot().source.is_some(),
            "the file stays open"
        );

        harness.player.toggle_paused().unwrap();
        harness.expect_status(PlaybackStatus::Playing);
        let position = harness.expect("restart position", |change| match change {
            PlayerChange::Position { seconds } => Some(*seconds),
            _ => None,
        });
        assert!(position < 1.0, "restarted at {position}");
    }

    #[test]
    fn a_file_that_cannot_be_opened_fails_and_returns_to_idle() {
        let harness = Harness::new();
        harness.player.open("/no/such/film.mkv").unwrap();
        let (source, reason, reveal) = harness.expect("failure", |change| match change {
            PlayerChange::Failed {
                source,
                reason,
                reveal,
            } => Some((source.clone(), reason.clone(), reveal.clone())),
            _ => None,
        });
        assert_eq!(source, "/no/such/film.mkv");
        assert_eq!(reason, FailureReason::Missing);
        // Nothing of that path exists, so there is nothing to show in the Finder.
        assert_eq!(reveal, None);
        harness.expect("idle media", |change| {
            (*change
                == PlayerChange::Media {
                    source: None,
                    title: None,
                })
            .then_some(())
        });
        harness.wait_until("idle", |snapshot| snapshot.status == PlaybackStatus::Idle);
        assert!(harness.player.is_idle());
    }

    #[test]
    fn starts_where_it_is_told_to_and_says_so() {
        let harness = Harness::new();
        harness
            .player
            .open_at(test_clip().to_str().unwrap(), None, Some(1.2), None)
            .unwrap();
        // The timeline is told at once where the file will start.
        harness.expect("the starting place", |change| {
            (*change == PlayerChange::Position { seconds: 1.2 }).then_some(())
        });
        let resumed = harness.expect("resumed", |change| match change {
            PlayerChange::Resumed { seconds } => Some(*seconds),
            _ => None,
        });
        assert_eq!(resumed, 1.2);
        harness.player.set_paused(true).unwrap();
        let snapshot = harness.wait_until("paused", |snapshot| {
            snapshot.status == PlaybackStatus::Paused
        });
        assert!(snapshot.position >= 1.15, "at {}", snapshot.position);
    }

    #[test]
    fn a_file_opened_from_its_beginning_is_not_said_to_resume() {
        let harness = Harness::new();
        harness.open_clip();
        let mut resumed = false;
        harness.expect("playing", |change| {
            resumed |= matches!(change, PlayerChange::Resumed { .. });
            (*change
                == PlayerChange::Status {
                    status: PlaybackStatus::Playing,
                })
            .then_some(())
        });
        assert!(!resumed);
    }

    #[test]
    fn keeps_a_name_it_was_given() {
        let harness = Harness::new();
        harness
            .player
            .open_at(test_clip().to_str().unwrap(), Some(" Solaris "), None, None)
            .unwrap();
        harness.expect_status(PlaybackStatus::Playing);
        assert_eq!(harness.player.snapshot().title.as_deref(), Some("Solaris"));
    }

    #[test]
    fn steps_one_frame_at_a_time_and_stays_paused() {
        let harness = Harness::new();
        harness.open_clip();
        harness.expect_status(PlaybackStatus::Playing);
        harness.player.set_paused(true).unwrap();
        harness.expect_status(PlaybackStatus::Paused);
        harness.player.seek_to(1.0, true).unwrap();
        harness.wait_until("the seek", |snapshot| {
            (snapshot.position - 1.0).abs() < 0.02
        });

        // The clip runs at 30 frames a second.
        let frame = 1.0 / 30.0;
        harness.player.step_frame(true).unwrap();
        let forward = harness.wait_until("a frame forward", |snapshot| snapshot.position > 1.01);
        assert!(
            (forward.position - (1.0 + frame)).abs() < 0.01,
            "{}",
            forward.position
        );
        assert_eq!(forward.status, PlaybackStatus::Paused);

        // A step back is a seek, and mpv takes one at a time: each is waited
        // for, as each press of the key is in use.
        harness.player.step_frame(false).unwrap();
        harness.wait_until("a frame back", |snapshot| snapshot.position < 1.02);
        harness.player.step_frame(false).unwrap();
        let back = harness.wait_until("two frames back", |snapshot| snapshot.position < 0.99);
        assert!(
            (back.position - (1.0 - frame)).abs() < 0.01,
            "{}",
            back.position
        );
        assert_eq!(back.status, PlaybackStatus::Paused);
    }

    #[test]
    fn plays_round_and_round_when_asked() {
        let harness = Harness::new();
        harness.player.set_looping(true).unwrap();
        harness.open_clip();
        harness.expect_status(PlaybackStatus::Playing);
        harness.player.seek_to(1.8, true).unwrap();
        harness.wait_until("the seek", |snapshot| snapshot.position >= 1.75);
        // It comes round to the start instead of ending.
        let wrapped = harness.wait_until("the start again", |snapshot| snapshot.position < 1.0);
        assert_eq!(wrapped.status, PlaybackStatus::Playing);
    }

    /// The shared state on its own, with everything it tells its listener.
    fn shared_alone() -> (Arc<Shared>, Arc<Mutex<Vec<PlayerChange>>>) {
        let heard = Arc::new(Mutex::new(Vec::new()));
        let shared = Arc::new(Shared::new(Arc::new({
            let heard = heard.clone();
            move |change| heard.lock().push(change)
        })));
        (shared, heard)
    }

    #[test]
    fn a_position_held_back_is_dropped_once_something_else_is_being_opened() {
        let (shared, heard) = shared_alone();
        shared.publish_position(2400.0);
        // Another file is asked for, and named, and put at its beginning.
        // Whatever mpv still has to say about where playback is, it says of
        // the file that is going: the throttled position that was waiting
        // its turn, or one that arrives with the old file's last events.
        shared.start_opening();
        shared.publish(PlayerChange::Position { seconds: 0.0 });
        shared.publish_position(2400.2);
        assert_eq!(
            *heard.lock(),
            [
                PlayerChange::Position { seconds: 2400.0 },
                PlayerChange::Position { seconds: 0.0 },
            ]
        );
        assert_eq!(shared.snapshot.read().position, 0.0);

        // Once it has loaded, positions are the new file's.
        shared.opening.store(false, Ordering::Release);
        shared.publish_position(0.4);
        assert_eq!(
            heard.lock().last(),
            Some(&PlayerChange::Position { seconds: 0.4 })
        );
    }

    #[test]
    fn a_listener_may_open_something_in_answer_to_a_position() {
        // What the conductor may do when it hears where playback is: ask for
        // another file, on the thread that told it, while the position is
        // still being passed on.
        let slot: Arc<Mutex<Option<Arc<Shared>>>> = Arc::default();
        let shared = Arc::new(Shared::new(Arc::new({
            let slot = slot.clone();
            move |change| {
                if matches!(change, PlayerChange::Position { .. }) {
                    let shared = slot.lock().clone();
                    if let Some(shared) = shared {
                        shared.start_opening();
                    }
                }
            }
        })));
        *slot.lock() = Some(shared.clone());
        shared.publish_position(5.0);
        assert!(shared.opening.load(Ordering::Acquire));
        *slot.lock() = None;
    }

    #[test]
    fn a_new_file_is_never_given_the_old_ones_position() {
        let harness = Harness::new();
        harness.open_clip();
        harness.expect_status(PlaybackStatus::Playing);
        harness.wait_until("some playback", |snapshot| snapshot.position > 0.6);

        let second = crate::engine::test_support::second_clip();
        harness.player.open(second.to_str().unwrap()).unwrap();
        let mut named = false;
        let mut late = Vec::new();
        harness.expect("the second file playing", |change| {
            match change {
                PlayerChange::Media { source, .. } => {
                    named = source.as_deref() == second.to_str();
                }
                PlayerChange::Position { seconds } if named && *seconds > 0.3 => {
                    late.push(*seconds);
                }
                _ => {}
            }
            (named
                && *change
                    == PlayerChange::Status {
                        status: PlaybackStatus::Playing,
                    })
            .then_some(())
        });
        assert!(late.is_empty(), "positions of the first file: {late:?}");
    }

    #[test]
    fn opening_something_else_when_a_file_fails_keeps_the_new_ones_name() {
        // What the conductor does: on a failure, open the next thing at once,
        // from inside the report of the failure.
        let slot: Arc<Mutex<Option<Arc<Player>>>> = Arc::new(Mutex::new(None));
        let (sender, changes) = channel();
        let sender = Mutex::new(sender);
        let listener: ChangeListener = {
            let slot = slot.clone();
            Arc::new(move |change| {
                if matches!(change, PlayerChange::Failed { .. }) {
                    let player = slot.lock().clone();
                    if let Some(player) = player {
                        player.open(test_clip().to_str().unwrap()).unwrap();
                    }
                }
                let _ = sender.lock().send(change);
            })
        };
        let player = Arc::new(Player::new(Output::Headless, listener).unwrap());
        *slot.lock() = Some(player.clone());

        player.open("/no/such/film.mkv").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut after_failure = Vec::new();
        let mut failed = false;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let change = changes.recv_timeout(left).expect("the clip playing");
            failed |= matches!(change, PlayerChange::Failed { .. });
            let playing = failed
                && change
                    == PlayerChange::Status {
                        status: PlaybackStatus::Playing,
                    };
            if failed {
                after_failure.push(change);
            }
            if playing {
                break;
            }
        }
        // Going idle after the failure must not have wiped the clip's name.
        assert!(
            !after_failure.contains(&PlayerChange::Media {
                source: None,
                title: None
            }),
            "{after_failure:?}"
        );
        // Let any late report of idleness arrive, then look again.
        std::thread::sleep(Duration::from_millis(300));
        let snapshot = player.snapshot();
        assert_eq!(snapshot.title.as_deref(), Some("clip-v1"));
        assert_eq!(snapshot.status, PlaybackStatus::Playing);
        // Undo the cycle between the player and its listener.
        slot.lock().take();
    }

    #[test]
    fn stopping_returns_to_idle_and_clears_the_media() {
        let harness = Harness::new();
        harness.open_clip();
        harness.expect_status(PlaybackStatus::Playing);
        harness.player.stop().unwrap();
        harness.expect_status(PlaybackStatus::Idle);
        let snapshot = harness.player.snapshot();
        assert_eq!(snapshot.source, None);
        assert_eq!(snapshot.position, 0.0);
        assert!(snapshot.tracks.is_empty());
    }

    #[test]
    fn identical_changes_are_not_reported_twice() {
        let mut snapshot = PlayerSnapshot::default();
        assert!(apply(
            &mut snapshot,
            &PlayerChange::Volume { percent: 50.0 }
        ));
        assert!(!apply(
            &mut snapshot,
            &PlayerChange::Volume { percent: 50.0 }
        ));
        // A failure is an event and is always delivered.
        let failed = PlayerChange::Failed {
            source: "a".into(),
            reason: FailureReason::Missing,
            reveal: None,
        };
        assert!(apply(&mut snapshot, &failed));
        assert!(apply(&mut snapshot, &failed));
    }
}
