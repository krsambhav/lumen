//! State shared by every command.

use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};

use crate::conductor::Conductor;
use crate::db::Db;
use crate::engine::player::Player;
use crate::engine::types::PlayerChange;
use crate::events::PlaybackSkipped;
use crate::library::posters::Posters;
use crate::menu::MenuBar;
use crate::platform::VideoSurface;
use crate::session::SessionStore;
use crate::settings::Settings;

pub struct AppState {
    pub db: Arc<Db>,
    pub settings: RwLock<Settings>,
    pub session: Arc<SessionStore>,
    pub player: Arc<Player>,
    pub conductor: Arc<Conductor>,
    pub posters: Arc<Posters>,
    pub surface: SurfaceSlot,
    /// The last full-screen state reported to the interface.
    pub fullscreen: AtomicBool,
    /// The picture size the window was last fitted to, so it is fitted once
    /// per file and not again when only the decoder changes.
    pub fitted: Mutex<Option<(i32, i32)>>,
    /// The size the picture of the open file is shown at, turned but not
    /// cut, so that a new crop can shape the window without asking mpv.
    pub picture: Mutex<Option<(i32, i32)>>,
    /// The video layer is in extended dynamic range.
    pub hdr: AtomicBool,
    /// Bumped each time HDR output starts, so an older headroom watcher knows
    /// to stop.
    pub hdr_generation: AtomicU64,
    /// Things that happened before the interface was listening.
    pub early: Held<Early>,
    /// Counts the interface's requests to show or hide the chrome, so that a
    /// request still waiting (for the pointer to leave the traffic lights)
    /// knows when a later one has replaced it.
    pub chrome_requests: AtomicU64,
    /// The panel beside the picture.
    pub panel: Mutex<Panel>,
    pub menu: MenuBar,
}

/// The room a panel beside the picture takes, in points.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Panel {
    /// The width the interface has asked for; 0 when the panel is closed.
    pub wanted: f64,
    /// How much of the window the picture is kept out of right now, in
    /// points. It glides to `wanted` as the panel slides in or out.
    pub shown: f64,
    /// The window's width in points, as last laid out.
    pub window_width: f64,
    /// Bumped each time a glide starts, so an older one knows to stop.
    pub glide: u64,
}

impl AppState {
    pub fn new(
        db: Arc<Db>,
        settings: Settings,
        session: Arc<SessionStore>,
        player: Arc<Player>,
        conductor: Arc<Conductor>,
        posters: Arc<Posters>,
    ) -> Self {
        Self {
            db,
            settings: RwLock::new(settings),
            session,
            player,
            conductor,
            posters,
            surface: SurfaceSlot::default(),
            fullscreen: AtomicBool::new(false),
            fitted: Mutex::new(None),
            picture: Mutex::new(None),
            hdr: AtomicBool::new(false),
            hdr_generation: AtomicU64::new(0),
            early: Held::new(),
            chrome_requests: AtomicU64::new(0),
            panel: Mutex::new(Panel::default()),
            menu: MenuBar::default(),
        }
    }
}

/// Something that happened, as opposed to a new value of some state: the
/// interface cannot read it back later, so it must not be said to nobody.
#[derive(Debug, Clone)]
pub enum Early {
    Player(PlayerChange),
    Skipped(PlaybackSkipped),
}

/// Things said before anyone was listening, kept until someone is.
///
/// Nearly everything the interface needs when it starts is state, which it
/// reads as a snapshot. A failure is not: it is said once, and a file opened
/// from the Finder can fail before the page has even loaded. Such events
/// wait here until the interface reports that it is listening.
pub struct Held<T>(Mutex<Option<Vec<T>>>);

impl<T> Held<T> {
    pub fn new() -> Self {
        Self(Mutex::new(Some(Vec::new())))
    }

    /// Keeps `item` if nobody is listening yet. Otherwise hands it back, to
    /// be delivered now.
    pub fn hold(&self, item: T) -> Option<T> {
        match self.0.lock().as_mut() {
            Some(held) => {
                held.push(item);
                None
            }
            None => Some(item),
        }
    }

    /// Someone is listening: returns what was kept, oldest first. Nothing is
    /// kept from now on.
    pub fn release(&self) -> Vec<T> {
        self.0.lock().take().unwrap_or_default()
    }
}

/// Holds the video surface, which is made of main-thread-only AppKit objects.
#[derive(Default)]
pub struct SurfaceSlot(Mutex<Option<VideoSurface>>);

// SAFETY: the slot is only ever filled, read and emptied on the main thread;
// every method takes a `MainThreadMarker` as proof. It is `Send + Sync` only
// so that it can live in Tauri's managed state.
unsafe impl Send for SurfaceSlot {}
unsafe impl Sync for SurfaceSlot {}

impl SurfaceSlot {
    pub fn set(&self, surface: VideoSurface, _main: objc2::MainThreadMarker) {
        *self.0.lock() = Some(surface);
    }

    pub fn with(&self, _main: objc2::MainThreadMarker, f: impl FnOnce(&VideoSurface)) {
        if let Some(surface) = self.0.lock().as_ref() {
            f(surface);
        }
    }

    pub fn take(&self, _main: objc2::MainThreadMarker) -> Option<VideoSurface> {
        self.0.lock().take()
    }
}

#[cfg(test)]
mod tests {
    use super::Held;

    #[test]
    fn keeps_what_is_said_until_someone_listens() {
        let held = Held::new();
        assert_eq!(held.hold("first"), None);
        assert_eq!(held.hold("second"), None);
        assert_eq!(held.release(), vec!["first", "second"]);
    }

    #[test]
    fn hands_everything_straight_back_once_someone_listens() {
        let held = Held::new();
        assert!(held.release().is_empty());
        assert_eq!(held.hold("late"), Some("late"));
        // Releasing again finds nothing: it was delivered, not kept.
        assert!(held.release().is_empty());
    }
}
