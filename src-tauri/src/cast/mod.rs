//! Casting: playing what is open on a TV.
//!
//! One module per protocol (`chromecast`, and AirPlay in the platform
//! layer, since macOS does the talking there), each behind `CastTarget`.
//! The `Caster` here owns the one session there can be at a time. While it
//! lasts, the player is in remote mode: mpv holds still and every control
//! (the bar, the keys, the menus, the queue moving on) is asked of the TV,
//! whose state the player reports in mpv's place. The interface needs no
//! second set of controls, and a playlist goes on to its next item on the
//! TV just as it does on the Mac.

mod apple_tv;
pub mod chromecast;
pub mod discovery;
pub mod media;
pub mod server;

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::engine::failure::is_address;
use crate::engine::player::{Player, Remote};
use crate::engine::types::{PlaybackStatus, PlayerChange};
use crate::error::{AppError, AppResult};
use crate::media::tools::{self, Tool};
use discovery::Discovery;
use media::{Choice, Delivery, Output, Plan, Probe, Profile};
use server::{MediaServer, Published, Subtitles};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CastProtocol {
    Chromecast,
    AirPlay,
}

/// A device that can be cast to.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CastDevice {
    pub id: String,
    pub name: String,
    /// What it is, as it says: "Chromecast", "Google TV Streamer".
    pub model: String,
    pub protocol: CastProtocol,
    /// It has a picture: a TV rather than a speaker.
    pub video: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CastPhase {
    /// The AirPlay picker of macOS is open and nothing is chosen yet.
    Choosing,
    Pairing,
    /// Reaching the device and starting its player.
    Connecting,
    /// The film is on the TV.
    Casting,
}

/// The session there is, if any.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CastSession {
    pub device: String,
    pub protocol: CastProtocol,
    pub phase: CastPhase,
    /// How the open film reaches it, once that is decided.
    pub delivery: Option<Delivery>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CastSnapshot {
    /// Devices are being looked for.
    pub searching: bool,
    pub devices: Vec<CastDevice>,
    pub session: Option<CastSession>,
}

/// Where a remote's player is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteState {
    Playing,
    Paused,
    Buffering,
}

/// What a device says.
#[derive(Debug, Clone, PartialEq)]
pub enum TargetEvent {
    Pairing(bool),
    /// It is ready for, or now showing, the film. AirPlay names the device.
    Active(Option<String>),
    /// `at` is in the device's time: seconds into what it was given.
    State {
        state: RemoteState,
        at: Option<f64>,
    },
    /// 0–1.
    Volume {
        level: f64,
        muted: bool,
    },
    Finished,
    Failed(String),
    /// The session is over; with a reason if it was not asked to end.
    Closed(Option<String>),
}

pub type EventSink = Arc<dyn Fn(TargetEvent) + Send + Sync>;

/// A subtitle track a device can show and switch by itself.
#[derive(Debug, Clone, PartialEq)]
pub struct SideSubtitle {
    pub id: i32,
    pub url: String,
    pub name: String,
    pub language: Option<String>,
}

/// A film as a device is given it.
#[derive(Debug, Clone, PartialEq)]
pub struct Loadable {
    pub url: String,
    pub content_type: String,
    pub title: String,
    pub duration: Option<f64>,
    /// Where to start, in the device's time.
    pub start: f64,
    pub autoplay: bool,
    pub subtitles: Vec<SideSubtitle>,
    pub active_subtitle: Option<i32>,
}

/// One protocol's way of playing on a device.
pub trait CastTarget: Send + Sync {
    fn load(&self, media: Loadable);
    fn pair(&self, _pin: &str) {}
    /// This sender accepts a fresh HLS stream at each seek position.
    fn seeks_with_new_stream(&self) -> bool {
        false
    }
    fn play(&self);
    fn pause(&self);
    /// In the device's time.
    fn seek(&self, seconds: f64);
    /// 0–1.
    fn set_volume(&self, level: f64);
    fn set_muted(&self, muted: bool);
    /// Shows another of the side tracks it was given, or none. False if it
    /// cannot, and the film must be given to it again.
    fn set_subtitle(&self, id: Option<i32>) -> bool;
    /// Ends the session on the device.
    fn stop(&self);
}

/// Where the AirPlay picker is to open from: the cast button, in the
/// window's coordinates, from its top left.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub x: crate::ipc::Real,
    pub y: crate::ipc::Real,
    pub width: crate::ipc::Real,
    pub height: crate::ipc::Real,
}

/// What the platform must provide for AirPlay.
pub trait AirPlayHost: Send + Sync {
    /// Routes to the selected receiver, or opens the picker for an explicit choice.
    fn open(
        &self,
        anchor: Anchor,
        device: Option<CastDevice>,
        events: EventSink,
    ) -> Arc<dyn AirPlayTarget>;
    /// Starts finding AirPlay devices ahead of being asked to play on one.
    fn warm(&self);
}

pub trait AirPlayTarget: CastTarget {
    /// Shows the picker again, to change device or to stop.
    fn show_picker(&self, anchor: Anchor);
}

/// How seeking works for what is loaded.
#[derive(Debug, Clone, PartialEq)]
enum Seeking {
    /// The device seeks in the file by itself.
    Free,
    /// A stream made as it is read: a seek starts it again from there.
    Restart,
    /// HTTP Live Streaming being written to this folder: seeks within what
    /// is written so far are the device's; beyond it, it starts again.
    Hls(PathBuf),
}

struct Loaded {
    source: String,
    token: Option<String>,
    plan: Plan,
    choice: Choice,
    /// Seconds into the film that the device's time 0 is.
    offset: f64,
    seeking: Seeking,
    /// FFmpeg writing HTTP Live Streaming, stopped when dropped.
    hls: Option<tokio::process::Child>,
}

struct Session {
    generation: u64,
    device: CastDevice,
    phase: CastPhase,
    profile: Profile,
    target: Option<Arc<dyn CastTarget>>,
    airplay: Option<Arc<dyn AirPlayTarget>>,
    /// This Mac's address as the device reaches it.
    host: Option<IpAddr>,
    loaded: Option<Loaded>,
    /// Bumped with each film given to the device, so a slower plan for an
    /// older one is thrown away.
    loads: u64,
    /// Where the film is, in its own time, as last heard.
    position: f64,
    /// The film played to its end on the device, which has let go of it:
    /// anything asked of it now needs it given again.
    finished: bool,
    /// The Mac was playing when the session began.
    was_playing: bool,
    /// The remote has been handed playback.
    remote: bool,
    probes: HashMap<String, Arc<Probe>>,
}

struct Inner {
    generation: u64,
    session: Option<Session>,
}

pub type Notify = Arc<dyn Fn(CastSnapshot) + Send + Sync>;
pub type Fail = Arc<dyn Fn(String) + Send + Sync>;

pub struct Caster {
    player: Arc<Player>,
    discovery: Discovery,
    server: tokio::sync::OnceCell<Arc<MediaServer>>,
    notify: Notify,
    fail: Fail,
    airplay: Option<Arc<dyn AirPlayHost>>,
    /// Where HTTP Live Streaming is written.
    scratch: PathBuf,
    inner: Mutex<Inner>,
    me: Weak<Caster>,
}

/// The player's controls, passed to the session there is.
struct Controls(Weak<Caster>);

impl Remote for Controls {
    fn set_paused(&self, paused: bool) {
        if let Some(caster) = self.0.upgrade() {
            caster.set_paused(paused);
        }
    }
    fn seek_to(&self, seconds: f64) {
        if let Some(caster) = self.0.upgrade() {
            caster.seek(seconds);
        }
    }
    fn set_volume(&self, percent: f64) {
        if let Some(target) = self.0.upgrade().and_then(|caster| caster.target()) {
            target.set_volume(percent / 100.0);
        }
    }
    fn set_muted(&self, muted: bool) {
        if let Some(target) = self.0.upgrade().and_then(|caster| caster.target()) {
            target.set_muted(muted);
        }
    }
}

fn spawn<F>(future: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    tauri::async_runtime::spawn(future);
}

impl Caster {
    pub fn new(
        player: Arc<Player>,
        scratch: PathBuf,
        airplay: Option<Arc<dyn AirPlayHost>>,
        notify: Notify,
        fail: Fail,
    ) -> Arc<Self> {
        // What an earlier run left behind.
        let _ = std::fs::remove_dir_all(&scratch);
        Arc::new_cyclic(|me| Self {
            player,
            discovery: Discovery::new(),
            server: tokio::sync::OnceCell::new(),
            notify,
            fail,
            airplay,
            scratch,
            inner: Mutex::new(Inner {
                generation: 0,
                session: None,
            }),
            me: me.clone(),
        })
    }

    pub fn snapshot(&self) -> CastSnapshot {
        let session = self
            .inner
            .lock()
            .session
            .as_ref()
            .map(|session| CastSession {
                device: session.device.name.clone(),
                protocol: session.device.protocol,
                phase: session.phase,
                delivery: session.loaded.as_ref().map(|loaded| loaded.plan.delivery),
            });
        CastSnapshot {
            searching: self.discovery.is_running(),
            devices: self
                .discovery
                .devices()
                .into_iter()
                .map(|found| found.device)
                .collect(),
            session,
        }
    }

    fn changed(&self) {
        (self.notify)(self.snapshot());
    }

    /// Starts looking for devices, if not already.
    pub fn search(&self) {
        if self.discovery.is_running() {
            return;
        }
        if let Some(airplay) = &self.airplay {
            airplay.warm();
        }
        let me = self.me.clone();
        self.discovery.start(Arc::new(move || {
            if let Some(caster) = me.upgrade() {
                caster.changed();
            }
        }));
        self.changed();
    }

    pub fn shutdown(&self) {
        self.end(None);
        self.discovery.stop();
    }

    async fn server(&self) -> AppResult<Arc<MediaServer>> {
        self.server
            .get_or_try_init(MediaServer::start)
            .await
            .cloned()
            .map_err(|error| AppError::Internal(format!("could not serve the film: {error}")))
    }

    fn target(&self) -> Option<Arc<dyn CastTarget>> {
        self.inner
            .lock()
            .session
            .as_ref()
            .and_then(|session| session.target.clone())
    }

    fn open_source(&self) -> AppResult<String> {
        self.player
            .snapshot()
            .source
            .ok_or_else(|| AppError::Invalid("open something to cast first".to_owned()))
    }

    /// A sink for one session's events, deaf once that session is over.
    fn sink(&self, generation: u64) -> EventSink {
        let me = self.me.clone();
        Arc::new(move |event| {
            if let Some(caster) = me.upgrade() {
                caster.heard(generation, event);
            }
        })
    }

    /// Casts to a Google Cast device.
    pub fn start(&self, device_id: &str, anchor: Anchor) -> AppResult<()> {
        let found = self.discovery.find(device_id).ok_or_else(|| {
            AppError::NotFound("that device is no longer on the network".to_owned())
        })?;
        if found.device.protocol == CastProtocol::AirPlay {
            return self.open_airplay(anchor, Some(found));
        }
        let source = self.open_source()?;
        if is_address(&source) && !source.starts_with("http") {
            return Err(AppError::Invalid("this can't be cast".to_owned()));
        }
        // One session at a time: whatever was being cast to stops.
        self.end(None);
        let position = self.player.snapshot().position;
        let generation = {
            let mut inner = self.inner.lock();
            inner.generation += 1;
            let generation = inner.generation;
            inner.session = Some(Session::new(
                generation,
                found.device.clone(),
                Profile::Chromecast { hevc: found.hevc },
                position,
            ));
            generation
        };
        self.hand_over(generation);
        self.changed();
        let me = self.me.clone();
        let sink = self.sink(generation);
        spawn(async move {
            let connected = chromecast::connect(found.address, sink).await;
            let Some(caster) = me.upgrade() else {
                return;
            };
            match connected {
                Ok((target, host)) => {
                    let target: Arc<dyn CastTarget> = Arc::new(target);
                    let kept = caster.with_session(generation, |session| {
                        session.target = Some(target.clone());
                        session.host = Some(host);
                    });
                    if kept.is_none() {
                        // Stopped while connecting.
                        target.stop();
                        return;
                    }
                    caster.load_open(generation, false).await;
                }
                Err(error) => {
                    if caster.end(Some(generation)) {
                        (caster.fail)(format!("Could not cast to {}: {error}", found.device.name));
                    }
                }
            }
        });
        Ok(())
    }

    /// Opens the AirPlay picker of macOS at `anchor`. Choosing a device
    /// there starts casting; choosing this Mac stops it.
    pub fn choose_airplay(&self, anchor: Anchor) -> AppResult<()> {
        let existing = self
            .inner
            .lock()
            .session
            .as_ref()
            .and_then(|session| session.airplay.clone());
        if let Some(airplay) = existing {
            airplay.show_picker(anchor);
            return Ok(());
        }
        self.open_airplay(anchor, None)
    }

    /// Starts an AirPlay session: on `device` if one was chosen from the list,
    /// otherwise through the system's picker.
    fn open_airplay(&self, anchor: Anchor, receiver: Option<discovery::Found>) -> AppResult<()> {
        let host = self
            .airplay
            .clone()
            .ok_or_else(|| AppError::Invalid("AirPlay is not available".to_owned()))?;
        let source = self.open_source()?;
        if is_address(&source) && !source.starts_with("http") {
            return Err(AppError::Invalid("this can't be cast".to_owned()));
        }
        self.end(None);
        let position = self.player.snapshot().position;
        let generation = {
            let mut inner = self.inner.lock();
            inner.generation += 1;
            inner.generation
        };
        let address = receiver
            .as_ref()
            .and_then(|found| server::local_address_toward(found.address.ip()))
            .or_else(server::local_address);
        let direct = receiver.as_ref().filter(|found| found.paired_video);
        let (target, picker): (Arc<dyn CastTarget>, Option<Arc<dyn AirPlayTarget>>) = match direct {
            Some(found) => (
                apple_tv::AppleTv::open(
                    found.address.ip(),
                    &found.device.id,
                    self.sink(generation),
                ),
                None,
            ),
            None => {
                let target = host.open(
                    anchor,
                    receiver.as_ref().map(|f| f.device.clone()),
                    self.sink(generation),
                );
                (target.clone(), Some(target))
            }
        };
        let device = receiver.map(|found| found.device);
        {
            let chosen = device.is_some();
            let mut session = Session::new(
                generation,
                device.unwrap_or_else(|| CastDevice {
                    id: "airplay".to_owned(),
                    name: "AirPlay".to_owned(),
                    model: String::new(),
                    protocol: CastProtocol::AirPlay,
                    video: true,
                }),
                Profile::AirPlay,
                position,
            );
            session.phase = if chosen {
                CastPhase::Connecting
            } else {
                CastPhase::Choosing
            };
            session.target = Some(target);
            session.airplay = picker;
            session.host = address;
            self.inner.lock().session = Some(session);
        }
        self.changed();
        // The film is made ready while the picker is open, so it starts as
        // soon as a device is chosen.
        let me = self.me.clone();
        spawn(async move {
            if let Some(caster) = me.upgrade() {
                caster.load_open(generation, false).await;
            }
        });
        Ok(())
    }

    pub fn pair(&self, pin: &str) -> AppResult<()> {
        if pin.len() != 4 || !pin.bytes().all(|c| c.is_ascii_digit()) {
            return Err(AppError::Invalid(
                "Enter the four-digit code on the TV.".into(),
            ));
        }
        let inner = self.inner.lock();
        let target = inner
            .session
            .as_ref()
            .filter(|s| s.phase == CastPhase::Pairing)
            .and_then(|s| s.target.as_ref())
            .ok_or_else(|| AppError::Invalid("This pairing request has ended.".into()))?;
        target.pair(pin);
        Ok(())
    }

    /// Stops casting. The Mac takes over, paused where the TV was.
    pub fn stop(&self) {
        self.end(None);
    }

    fn with_session<T>(&self, generation: u64, f: impl FnOnce(&mut Session) -> T) -> Option<T> {
        let mut inner = self.inner.lock();
        inner
            .session
            .as_mut()
            .filter(|session| session.generation == generation)
            .map(f)
    }

    /// Puts the player in remote mode for this session.
    fn hand_over(&self, generation: u64) {
        let playing = matches!(
            self.player.snapshot().status,
            PlaybackStatus::Playing | PlaybackStatus::Buffering
        );
        let first = self
            .with_session(generation, |session| {
                !std::mem::replace(&mut session.remote, true)
            })
            .unwrap_or(false);
        if !first {
            return;
        }
        let position = self.player.snapshot().position;
        self.with_session(generation, |session| {
            session.position = position;
            session.was_playing = playing;
        });
        self.player
            .set_remote(Some(Arc::new(Controls(self.me.clone()))));
        self.player.publish_remote(PlayerChange::Status {
            status: PlaybackStatus::Buffering,
        });
    }

    /// Ends the session (`generation`, or whichever there is), on the device
    /// too. Returns whether there was one.
    fn end(&self, generation: Option<u64>) -> bool {
        let session = {
            let mut inner = self.inner.lock();
            match &inner.session {
                Some(session) if generation.is_none_or(|g| g == session.generation) => {
                    inner.session.take()
                }
                _ => None,
            }
        };
        let Some(mut session) = session else {
            return false;
        };
        if let Some(target) = &session.target {
            target.stop();
        }
        if let Some(loaded) = session.loaded.take() {
            self.unload(loaded);
        }
        if session.remote {
            let position = session.position;
            let took_over = session.phase == CastPhase::Casting;
            self.player.set_remote(None);
            // The Mac carries on from where the TV was, paused: a film does
            // not suddenly play out of the laptop. If the TV never took it,
            // the Mac simply goes on as it was.
            if took_over {
                let _ = self.player.set_paused(true);
                if position > 0.0 {
                    let _ = self.player.seek_to(position, false);
                }
            } else if session.was_playing {
                let _ = self.player.set_paused(false);
            }
        }
        self.changed();
        true
    }

    fn unload(&self, mut loaded: Loaded) {
        if let (Some(token), Some(server)) = (&loaded.token, self.server.get()) {
            server.withdraw(token);
        }
        if let Some(mut child) = loaded.hls.take() {
            let _ = child.start_kill();
        }
        if let Seeking::Hls(dir) = &loaded.seeking {
            let dir = dir.clone();
            std::thread::spawn(move || {
                // FFmpeg may still be writing for a moment.
                std::thread::sleep(Duration::from_millis(500));
                let _ = std::fs::remove_dir_all(dir);
            });
        }
    }

    fn heard(&self, generation: u64, event: TargetEvent) {
        match event {
            TargetEvent::Pairing(waiting) => {
                self.with_session(generation, |session| {
                    session.phase = if waiting {
                        CastPhase::Pairing
                    } else {
                        CastPhase::Connecting
                    }
                });
                self.changed();
            }
            TargetEvent::Active(name) => {
                let was_choosing = self
                    .with_session(generation, |session| {
                        if let Some(name) = name.filter(|name| !name.is_empty()) {
                            session.device.name = name;
                        }
                        // AirPlay: the TV has taken the film, from the picker or the list.
                        let was = session.profile == Profile::AirPlay && !session.remote;
                        session.phase = CastPhase::Casting;
                        was
                    })
                    .unwrap_or(false);
                if was_choosing {
                    // AirPlay: a device was chosen in the picker. The TV takes
                    // over from where the Mac has got to while it was open.
                    self.hand_over(generation);
                    let position = self.player.snapshot().position;
                    if !self
                        .target()
                        .is_some_and(|target| target.seeks_with_new_stream())
                    {
                        self.seek(position);
                    }
                    if let Some(target) = self.target() {
                        target.play();
                    }
                }
                self.changed();
            }
            TargetEvent::State { state, at } => {
                let position = self.with_session(generation, |session| {
                    if session.phase == CastPhase::Connecting {
                        session.phase = CastPhase::Casting;
                    }
                    let offset = session.loaded.as_ref().map_or(0.0, |loaded| loaded.offset);
                    if let Some(at) = at {
                        session.position = offset + at;
                    }
                    (session.remote, session.position)
                });
                let Some((true, position)) = position else {
                    return;
                };
                self.player
                    .publish_remote(PlayerChange::Position { seconds: position });
                self.player.publish_remote(PlayerChange::Status {
                    status: match state {
                        RemoteState::Playing => PlaybackStatus::Playing,
                        RemoteState::Paused => PlaybackStatus::Paused,
                        RemoteState::Buffering => PlaybackStatus::Buffering,
                    },
                });
            }
            TargetEvent::Volume { level, muted } => {
                if self.with_session(generation, |session| session.remote) == Some(true) {
                    self.player.publish_remote(PlayerChange::Volume {
                        percent: (level * 100.0).round(),
                    });
                    self.player.publish_remote(PlayerChange::Muted { muted });
                }
            }
            TargetEvent::Finished => {
                let duration = self.player.snapshot().duration;
                self.with_session(generation, |session| {
                    session.finished = true;
                    if let Some(duration) = duration {
                        session.position = duration;
                    }
                });
                if let Some(duration) = duration {
                    self.player
                        .publish_remote(PlayerChange::Position { seconds: duration });
                }
                // The conductor hears this and moves the queue along, which
                // opens the next item: see `observe`.
                self.player.publish_remote(PlayerChange::Status {
                    status: PlaybackStatus::Ended,
                });
            }
            TargetEvent::Failed(reason) => {
                let device = self.with_session(generation, |session| session.device.name.clone());
                if let Some(device) = device {
                    if self.end(Some(generation)) {
                        (self.fail)(format!("{device} stopped: {reason}"));
                    }
                }
            }
            TargetEvent::Closed(reason) => {
                let device = self.with_session(generation, |session| session.device.name.clone());
                if self.end(Some(generation)) {
                    if let (Some(reason), Some(device)) = (reason, device) {
                        (self.fail)(format!("Casting to {device} ended: {reason}"));
                    }
                }
            }
        }
    }

    fn set_paused(&self, paused: bool) {
        let Some(target) = self.target() else {
            return;
        };
        if paused {
            target.pause();
        } else {
            target.play();
        }
    }

    /// Seeks to `seconds` into the film, whichever way what is loaded allows.
    fn seek(&self, seconds: f64) {
        let decided = {
            let mut inner = self.inner.lock();
            let Some(session) = inner.session.as_mut() else {
                return;
            };
            session.position = seconds;
            let generation = session.generation;
            match (&session.loaded, &session.target) {
                _ if session.finished => Some((generation, None)),
                (Some(loaded), Some(target)) => match &loaded.seeking {
                    Seeking::Free => Some((generation, Some((target.clone(), seconds)))),
                    Seeking::Restart => Some((generation, None)),
                    Seeking::Hls(_) if target.seeks_with_new_stream() => Some((generation, None)),
                    Seeking::Hls(dir) => {
                        let (written, _) = server::hls_progress(dir);
                        let at = seconds - loaded.offset;
                        if at >= 0.0 && at <= written - 2.0 {
                            Some((generation, Some((target.clone(), at))))
                        } else {
                            Some((generation, None))
                        }
                    }
                },
                _ => None,
            }
        };
        self.player
            .publish_remote(PlayerChange::Position { seconds });
        match decided {
            Some((_, Some((target, at)))) => target.seek(at),
            Some((generation, None)) => {
                self.player.publish_remote(PlayerChange::Status {
                    status: PlaybackStatus::Buffering,
                });
                let me = self.me.clone();
                spawn(async move {
                    if let Some(caster) = me.upgrade() {
                        caster.load_open(generation, true).await;
                    }
                });
            }
            None => {}
        }
    }

    /// Hears every change the player reports, to follow it on the TV: the
    /// next item of the queue, another audio or subtitle track, a new
    /// subtitle delay.
    pub fn observe(&self, change: &PlayerChange) {
        let Some((generation, loaded_source, choice, can_switch)) = ({
            let inner = self.inner.lock();
            inner.session.as_ref().map(|session| {
                (
                    session.generation,
                    session.loaded.as_ref().map(|loaded| loaded.source.clone()),
                    session.loaded.as_ref().map(|loaded| loaded.choice.clone()),
                    session.loaded.as_ref().map(|loaded| {
                        (
                            loaded.plan.burn.is_none(),
                            loaded.plan.side.iter().map(|t| t.id).collect::<Vec<_>>(),
                        )
                    }),
                )
            })
        }) else {
            return;
        };
        match change {
            PlayerChange::Media { source: None, .. } => {
                // Nothing is open any more. Not from inside the player's report.
                let me = self.me.clone();
                spawn(async move {
                    if let Some(caster) = me.upgrade() {
                        caster.end(Some(generation));
                    }
                });
            }
            PlayerChange::Media {
                source: Some(source),
                ..
            } => {
                if loaded_source
                    .as_deref()
                    .is_some_and(|loaded| loaded != source)
                {
                    let me = self.me.clone();
                    spawn(async move {
                        if let Some(caster) = me.upgrade() {
                            caster.load_next(generation).await;
                        }
                    });
                }
            }
            PlayerChange::Tracks { .. } | PlayerChange::SubtitleDelay { .. } => {
                let (Some(choice), Some((nothing_burnt, side))) = (choice, can_switch) else {
                    return;
                };
                let snapshot = self.player.snapshot();
                if snapshot.source != loaded_source {
                    return;
                }
                let now = media::choice_from(&snapshot.tracks, snapshot.subtitle_delay);
                if now == choice {
                    return;
                }
                let only_subtitle = now.audio == choice.audio
                    && (now.subtitle_delay - choice.subtitle_delay).abs() < 1e-6;
                let switchable = only_subtitle
                    && nothing_burnt
                    && now.subtitle.is_none_or(|id| side.contains(&id));
                if switchable {
                    if let Some(target) = self.target() {
                        if target.set_subtitle(now.subtitle) {
                            self.with_session(generation, |session| {
                                if let Some(loaded) = session.loaded.as_mut() {
                                    loaded.choice = now;
                                    loaded.plan.side_active = loaded.choice.subtitle;
                                }
                            });
                            return;
                        }
                    }
                }
                // Anything else means making the film again from where it is.
                // A delay is dragged: wait for it to settle.
                let loads = self.with_session(generation, |session| {
                    session.loads += 1;
                    session.loads
                });
                let me = self.me.clone();
                spawn(async move {
                    tokio::time::sleep(Duration::from_millis(600)).await;
                    let Some(caster) = me.upgrade() else {
                        return;
                    };
                    let still = caster.with_session(generation, |session| session.loads) == loads;
                    if still {
                        caster.load_open(generation, true).await;
                    }
                });
            }
            _ => {}
        }
    }

    /// The queue moved on: once mpv has the next file open, it goes to the TV.
    async fn load_next(&self, generation: u64) {
        for _ in 0..100 {
            if self.player.local_position().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let start = self.player.local_position().unwrap_or(0.0);
        self.with_session(generation, |session| {
            session.position = start;
            session.finished = true;
        });
        self.player
            .publish_remote(PlayerChange::Position { seconds: start });
        self.player.publish_remote(PlayerChange::Status {
            status: PlaybackStatus::Buffering,
        });
        self.load_open(generation, false).await;
    }

    async fn probe(&self, generation: u64, source: &str) -> AppResult<Arc<Probe>> {
        let known = self
            .with_session(generation, |session| session.probes.get(source).cloned())
            .flatten();
        if let Some(probe) = known {
            return Ok(probe);
        }
        let owned = source.to_owned();
        let probe = tauri::async_runtime::spawn_blocking(move || Probe::of(&owned))
            .await
            .map_err(|error| AppError::Internal(error.to_string()))??;
        let probe = Arc::new(probe);
        self.with_session(generation, |session| {
            session.probes.insert(source.to_owned(), probe.clone());
        });
        Ok(probe)
    }

    /// Gives the device what is open, from where the session says it is.
    /// `resume` keeps the device's play state (a seek, a track change);
    /// otherwise it starts as the session's autoplay says.
    async fn load_open(&self, generation: u64, resume: bool) {
        if let Err(error) = self.try_load_open(generation, resume).await {
            let device = self.with_session(generation, |session| session.device.name.clone());
            if let Some(device) = device {
                if self.end(Some(generation)) {
                    (self.fail)(format!("Could not cast to {device}: {error}"));
                }
            }
        }
    }

    async fn try_load_open(&self, generation: u64, resume: bool) -> AppResult<()> {
        let snapshot = self.player.snapshot();
        let source = snapshot
            .source
            .clone()
            .ok_or_else(|| AppError::Invalid("nothing is open".to_owned()))?;
        let Some((loads, profile, host, at, autoplay)) = self.with_session(generation, |session| {
            session.loads += 1;
            let playing = snapshot.status == PlaybackStatus::Playing
                || snapshot.status == PlaybackStatus::Buffering;
            // A film the device finished plays again when given again; one
            // made again for a seek or a track keeps playing or paused; an
            // AirPlay film waits for a device to be chosen; otherwise casting
            // starts the film on the TV.
            let autoplay = if session.finished {
                true
            } else if session.profile == Profile::AirPlay && !session.remote {
                // Not until the TV has it, or it would play out of the Mac.
                false
            } else if resume {
                playing
            } else {
                true
            };
            session.finished = false;
            (
                session.loads,
                session.profile,
                session.host,
                session.position,
                autoplay,
            )
        }) else {
            return Ok(());
        };
        let host = host.ok_or_else(|| {
            AppError::Invalid("this Mac is not on a network the device can reach".to_owned())
        })?;
        let probe = self.probe(generation, &source).await?;
        let choice = media::choice_from(&snapshot.tracks, snapshot.subtitle_delay);
        let subtitles = media::subtitle_tracks(&snapshot.tracks, &probe);
        let plan = media::plan(&probe, profile, &choice, &subtitles);
        let server = self.server().await?;
        let local_file = !is_address(&source);
        let title = snapshot
            .title
            .clone()
            .unwrap_or_else(|| crate::media::sources::display_name(&source));
        let duration = snapshot.duration.or(probe.duration);
        let at = at.clamp(0.0, duration.map_or(f64::MAX, |d| (d - 1.0).max(0.0)));
        let delay = choice.subtitle_delay;

        let mut published = Published::default();
        let mut hls = None;
        let paired_video = self
            .with_session(generation, |s| {
                s.target.as_ref().is_some_and(|t| t.seeks_with_new_stream())
            })
            .unwrap_or(false);
        let (url_path, content_type, start, offset, seeking) = match (plan.delivery, profile) {
            (Delivery::Direct, _) if local_file && !paired_video => {
                published.file = Some(PathBuf::from(&source));
                (
                    "file".to_owned(),
                    media::content_type(Path::new(&source)).to_owned(),
                    at,
                    0.0,
                    Seeking::Free,
                )
            }
            (Delivery::Direct, _) if !paired_video => (
                String::new(),
                "video/mp4".to_owned(),
                at,
                0.0,
                Seeking::Free,
            ),
            (_, Profile::Chromecast { .. }) => {
                let film = source.clone();
                let plan_for_stream = plan.clone();
                published.stream = Some(Arc::new(move || {
                    let command = tools::command(Tool::Ffmpeg)?;
                    let mut command = tokio::process::Command::from(command);
                    command.args(media::ffmpeg_args(
                        &film,
                        &plan_for_stream,
                        at,
                        delay,
                        &Output::Fragmented,
                    ));
                    Some(command)
                }));
                (
                    "stream.mp4".to_owned(),
                    "video/mp4".to_owned(),
                    0.0,
                    at,
                    Seeking::Restart,
                )
            }
            (_, Profile::AirPlay) => {
                let dir = self.scratch.join(server::token());
                std::fs::create_dir_all(&dir).map_err(|error| {
                    AppError::Internal(format!("could not make room for the stream: {error}"))
                })?;
                let command = tools::command(Tool::Ffmpeg)
                    .ok_or_else(|| AppError::Internal("ffmpeg is missing".to_owned()))?;
                let mut command = tokio::process::Command::from(command);
                command
                    .args(media::ffmpeg_args(
                        &source,
                        &plan,
                        at,
                        delay,
                        &Output::Hls { dir: dir.clone() },
                    ))
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::piped())
                    .kill_on_drop(true);
                let mut child = command.spawn().map_err(|error| {
                    AppError::Internal(format!("ffmpeg would not start: {error}"))
                })?;
                if let Some(mut stderr) = child.stderr.take() {
                    spawn(async move {
                        use tokio::io::AsyncReadExt;
                        let mut said = String::new();
                        let _ = stderr.read_to_string(&mut said).await;
                        if !said.trim().is_empty() {
                            tracing::warn!(ffmpeg = %said.trim(), "the AirPlay stream had trouble");
                        }
                    });
                }
                hls = Some(child);
                published.hls = Some(dir.clone());
                (
                    "hls/index.m3u8".to_owned(),
                    "application/vnd.apple.mpegurl".to_owned(),
                    0.0,
                    at,
                    Seeking::Hls(dir),
                )
            }
        };
        for track in &plan.side {
            published.subtitles.insert(
                track.id,
                Arc::new(Subtitles::new(
                    source.clone(),
                    track.source.clone(),
                    delay - offset,
                )),
            );
        }
        let token = server.publish(published);
        let url = if url_path.is_empty() {
            source.clone()
        } else {
            server.url(host, &token, &url_path)
        };
        let side: Vec<SideSubtitle> = plan
            .side
            .iter()
            .map(|track| SideSubtitle {
                id: track.id,
                url: server.url(host, &token, &format!("subs/{}.vtt", track.id)),
                name: track.name.clone(),
                language: track.language.clone(),
            })
            .collect();
        let loadable = Loadable {
            url,
            content_type,
            title,
            duration,
            start,
            autoplay,
            subtitles: side,
            active_subtitle: plan.side_active,
        };
        tracing::info!(delivery = ?plan.delivery, video = ?plan.video, audio = ?plan.audio, burn = plan.burn.is_some(), at, "casting");

        let replaced = {
            let mut inner = self.inner.lock();
            match inner.session.as_mut() {
                Some(session) if session.generation == generation && session.loads == loads => {
                    let old = session.loaded.replace(Loaded {
                        source: source.clone(),
                        token: Some(token.clone()),
                        plan,
                        choice,
                        offset,
                        seeking,
                        hls,
                    });
                    Some((old, session.target.clone()))
                }
                _ => None,
            }
        };
        let Some((old, target)) = replaced else {
            // A newer load, or the session ended, while this one was made.
            server.withdraw(&token);
            return Ok(());
        };
        if let Some(old) = old {
            self.unload(old);
        }
        self.changed();
        if let Some(target) = target {
            target.load(loadable);
        }
        Ok(())
    }
}

impl Session {
    fn new(generation: u64, device: CastDevice, profile: Profile, position: f64) -> Self {
        Self {
            generation,
            device,
            phase: CastPhase::Connecting,
            profile,
            target: None,
            airplay: None,
            host: None,
            loaded: None,
            loads: 0,
            position,
            finished: false,
            was_playing: false,
            remote: false,
            probes: HashMap::new(),
        }
    }
}
