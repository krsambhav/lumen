//! Syncing an external subtitle file to the film's speech.
//!
//! A few samples of the film are listened to by Whisper, running on this
//! Mac, and what was heard is lined up with the cues (see `align`). The
//! timing found is set as the subtitles' speed and delay; the file itself
//! is never rewritten. The speech model is downloaded the first time.

pub mod align;
mod cues;
mod listen;
mod model;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;
use serde::Serialize;
use specta::Type;
use specta_typescript::Number;

use crate::engine::failure::is_address;
use crate::engine::player::Player;
use crate::engine::types::{Track, TrackKind};
use crate::error::{AppError, AppResult};
use align::{Found, Method, Window, Word};

/// How a sync is going, for the file and track it was started for.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SyncStatus {
    /// Nothing is being synced. `installed`: the speech model is already
    /// here, so a sync starts listening at once.
    Idle { installed: bool },
    /// The speech model is being downloaded.
    #[serde(rename_all = "camelCase")]
    Installing {
        source: String,
        track: i32,
        /// 0–1.
        #[specta(type = Number)]
        progress: f64,
        /// The model's size, in bytes.
        #[specta(type = Number)]
        size: f64,
    },
    /// Samples of the film are being listened to.
    #[serde(rename_all = "camelCase")]
    Listening {
        source: String,
        track: i32,
        done: u32,
        total: u32,
    },
    /// A timing was found and is in effect.
    #[serde(rename_all = "camelCase")]
    Synced {
        source: String,
        track: i32,
        #[specta(type = Number)]
        speed: f64,
        #[specta(type = Number)]
        delay: f64,
        /// How it was found: from words, or only from when people speak
        /// (the subtitles are in another language than the sound).
        by_words: bool,
        /// Samples that agreed, of those in which anything was heard.
        agreeing: u32,
        heard: u32,
        /// The timing before, which Undo puts back.
        #[specta(type = Number)]
        speed_before: f64,
        #[specta(type = Number)]
        delay_before: f64,
    },
    /// No timing could be found, or something went wrong.
    #[serde(rename_all = "camelCase")]
    Failed {
        source: String,
        track: i32,
        message: String,
    },
}

/// Says each new status.
pub type StatusListener = Arc<dyn Fn(SyncStatus) + Send + Sync>;

pub struct Syncer {
    player: Arc<Player>,
    /// Where the speech model is kept.
    data_dir: PathBuf,
    listener: StatusListener,
    status: Mutex<SyncStatus>,
    /// The sync that is running, if one is.
    running: Mutex<Option<Arc<AtomicBool>>>,
}

impl Syncer {
    pub fn new(player: Arc<Player>, data_dir: PathBuf, listener: StatusListener) -> Arc<Self> {
        let installed = model::is_installed(&data_dir);
        Arc::new(Self {
            player,
            data_dir,
            listener,
            status: Mutex::new(SyncStatus::Idle { installed }),
            running: Mutex::new(None),
        })
    }

    pub fn status(&self) -> SyncStatus {
        self.status.lock().clone()
    }

    fn say(&self, status: SyncStatus) {
        *self.status.lock() = status.clone();
        (self.listener)(status);
    }

    /// Starts syncing the subtitle track that is showing. Returns at once;
    /// how it goes is said through the listener.
    pub fn start(self: &Arc<Self>) -> AppResult<()> {
        let snapshot = self.player.snapshot();
        let source = snapshot
            .source
            .clone()
            .ok_or_else(|| AppError::Invalid("nothing is open".to_owned()))?;
        let track = shown_subtitle(&snapshot.tracks)
            .ok_or_else(|| AppError::Invalid("no subtitles are showing".to_owned()))?;
        let file = track
            .file
            .clone()
            .filter(|_| track.external)
            .ok_or_else(|| {
                AppError::Unsupported(
                    "Only subtitles added from a file can be synced. Those inside the film are \
                     timed with it."
                        .to_owned(),
                )
            })?;
        if is_address(&source) && !source.starts_with("http") {
            return Err(AppError::Unsupported(
                "Subtitles can be synced only for files and direct links.".to_owned(),
            ));
        }
        let audio = snapshot
            .tracks
            .iter()
            .find(|track| track.kind == TrackKind::Audio && track.selected)
            .map_or(0, |track| (track.id - 1).max(0) as usize);
        let duration = snapshot.duration.unwrap_or(0.0);
        let before = (snapshot.subtitle_speed, snapshot.subtitle_delay);

        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut running = self.running.lock();
            if running.is_some() {
                return Err(AppError::Exists("a sync is already running".to_owned()));
            }
            *running = Some(Arc::clone(&cancelled));
        }
        let job = Job {
            source,
            track: track.id,
            file: PathBuf::from(file),
            audio,
            duration,
            before,
        };
        let this = Arc::clone(self);
        std::thread::Builder::new()
            .name("subtitle-sync".to_owned())
            .spawn(move || {
                let outcome = this.run(&job, &cancelled);
                listen::unload();
                *this.running.lock() = None;
                let installed = model::is_installed(&this.data_dir);
                let status = match outcome {
                    _ if cancelled.load(Ordering::Acquire) => SyncStatus::Idle { installed },
                    Ok(status) => status,
                    Err(error) => SyncStatus::Failed {
                        source: job.source.clone(),
                        track: job.track,
                        message: error.to_string(),
                    },
                };
                this.say(status);
            })
            .map_err(|error| AppError::Internal(format!("no thread for the sync: {error}")))?;
        Ok(())
    }

    /// Stops the sync that is running. What was in effect stays.
    pub fn cancel(&self) {
        if let Some(cancelled) = self.running.lock().as_ref() {
            cancelled.store(true, Ordering::Release);
        }
    }

    /// Puts back the timing from before the last sync.
    pub fn undo(&self) -> AppResult<()> {
        let SyncStatus::Synced {
            source,
            track,
            speed_before,
            delay_before,
            ..
        } = self.status()
        else {
            return Err(AppError::Invalid("there is no sync to undo".to_owned()));
        };
        self.still_showing(&source, track)?;
        self.player
            .set_subtitle_timing(speed_before, delay_before)?;
        self.say(SyncStatus::Idle {
            installed: model::is_installed(&self.data_dir),
        });
        Ok(())
    }

    fn still_showing(&self, source: &str, track: i32) -> AppResult<()> {
        let snapshot = self.player.snapshot();
        let same = snapshot.source.as_deref() == Some(source)
            && shown_subtitle(&snapshot.tracks).is_some_and(|shown| shown.id == track);
        if same {
            Ok(())
        } else {
            Err(AppError::Invalid(
                "the subtitles changed while they were being synced".to_owned(),
            ))
        }
    }

    fn run(&self, job: &Job, cancelled: &Arc<AtomicBool>) -> AppResult<SyncStatus> {
        let started = Instant::now();
        let model = if model::is_installed(&self.data_dir) {
            model::path_in(&self.data_dir)
        } else {
            let mut said = -1.0;
            model::install(&self.data_dir, cancelled, |progress| {
                // A hundred steps are as fine as anyone can see.
                if progress - said >= 0.01 || progress >= 1.0 {
                    said = progress;
                    self.say(SyncStatus::Installing {
                        source: job.source.clone(),
                        track: job.track,
                        progress,
                        size: model::SIZE as f64,
                    });
                }
            })?
        };

        let cues = cues::read(&job.file)?;
        let duration = if job.duration > 0.0 {
            job.duration
        } else {
            // A stream that does not say how long it is: as long as its
            // subtitles, roughly.
            cues.last().map_or(0.0, |cue| cue.end + 30.0)
        };
        let windows = align::plan_windows(&cues, duration);
        if windows.is_empty() {
            return Err(AppError::Invalid(
                "the film is too short to sync".to_owned(),
            ));
        }
        let total = windows.len() as u32;
        let listening = |done: u32| SyncStatus::Listening {
            source: job.source.clone(),
            track: job.track,
            done,
            total,
        };
        self.say(listening(0));

        let mut heard: Vec<Vec<Word>> = Vec::with_capacity(windows.len());
        for (index, window) in windows.iter().enumerate() {
            if cancelled.load(Ordering::Acquire) {
                return Err(model::cancelled_error());
            }
            let sound = listen::sound_of(&job.source, job.audio, window)?;
            let words = listen::words_in(&model, &sound, window.start, cancelled)?;
            tracing::debug!(
                at = window.start,
                words = words.len(),
                said = %words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" "),
                "sample heard"
            );
            heard.push(words);
            self.say(listening(index as u32 + 1));
        }
        if cancelled.load(Ordering::Acquire) {
            return Err(model::cancelled_error());
        }

        let found = find_timing(&windows, &heard, &cues).ok_or_else(|| {
            let nothing = heard.iter().all(Vec::is_empty);
            AppError::Invalid(if nothing {
                "No speech was heard in the samples, so there was nothing to sync to.".to_owned()
            } else {
                "These subtitles could not be matched to the speech. They may belong to a \
                 different cut of the film."
                    .to_owned()
            })
        })?;
        tracing::info!(
            ?found,
            seconds = started.elapsed().as_secs_f64(),
            "subtitles synced"
        );

        self.still_showing(&job.source, job.track)?;
        self.player
            .set_subtitle_timing(found.timing.speed, found.timing.delay)?;
        Ok(SyncStatus::Synced {
            source: job.source.clone(),
            track: job.track,
            speed: found.timing.speed,
            delay: self.player.snapshot().subtitle_delay,
            by_words: found.method == Method::Words,
            agreeing: found.agreeing as u32,
            heard: found.heard as u32,
            speed_before: job.before.0,
            delay_before: job.before.1,
        })
    }
}

struct Job {
    source: String,
    track: i32,
    file: PathBuf,
    /// The audio stream listened to, by its place among the file's audio
    /// streams.
    audio: usize,
    duration: f64,
    /// Speed and delay before the sync.
    before: (f64, f64),
}

/// The words first; failing those, when people speak.
fn find_timing(windows: &[Window], heard: &[Vec<Word>], cues: &[align::Cue]) -> Option<Found> {
    if let Some(found) = align::fit_anchors(&align::word_anchors(heard, cues), windows.len()) {
        return Some(found);
    }
    let samples: Vec<(Window, Vec<bool>)> = windows
        .iter()
        .zip(heard)
        .map(|(window, words)| (*window, align::speech_in(window, words)))
        .collect();
    align::fit_speech(&samples, cues)
}

fn shown_subtitle(tracks: &[Track]) -> Option<&Track> {
    tracks
        .iter()
        .find(|track| track.kind == TrackKind::Subtitle && track.selected && !track.secondary)
}

/// Against a real film and the real model. Needs `LUMEN_SYNC_FILM` (a
/// video with speech), `LUMEN_SYNC_SUBS` (its subtitles, mistimed),
/// `LUMEN_SYNC_MODEL` (the model file) and `LUMEN_SYNC_EXPECT`
/// ("speed,delay"): `cargo test sync_a_real_film -- --ignored --nocapture`.
#[cfg(test)]
#[test]
#[ignore = "needs a film, its subtitles and the speech model"]
fn sync_a_real_film() {
    let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} is not set"));
    let film = var("LUMEN_SYNC_FILM");
    let model = PathBuf::from(var("LUMEN_SYNC_MODEL"));
    let cues = cues::read(std::path::Path::new(&var("LUMEN_SYNC_SUBS"))).unwrap();
    let expect: Vec<f64> = var("LUMEN_SYNC_EXPECT")
        .split(',')
        .map(|part| part.parse().unwrap())
        .collect();
    let duration = crate::media::probe::duration(std::path::Path::new(&film)).unwrap();
    let windows = align::plan_windows(&cues, duration);
    let started = Instant::now();
    let cancelled = Arc::new(AtomicBool::new(false));
    let heard: Vec<Vec<Word>> = windows
        .iter()
        .map(|window| {
            let sound = listen::sound_of(&film, 0, window).unwrap();
            let words = listen::words_in(&model, &sound, window.start, &cancelled).unwrap();
            eprintln!(
                "{:7.1}s: {}",
                window.start,
                words
                    .iter()
                    .map(|w| w.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            words
        })
        .collect();
    let found = find_timing(&windows, &heard, &cues).expect("a timing");
    eprintln!("found {found:?} in {:.1}s", started.elapsed().as_secs_f64());
    assert!((found.timing.speed - expect[0]).abs() < 1e-4, "{found:?}");
    assert!((found.timing.delay - expect[1]).abs() < 0.35, "{found:?}");
}
