//! Typed events sent from Rust to every window.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use specta_typescript::Number;

use crate::cast::CastSnapshot;
use crate::engine::failure::FailureReason;
use crate::engine::types::PlayerChange;
use crate::platform::geometry::ScrollPhase;
use crate::playlist::queue::QueueSnapshot;
use crate::playlist::saved::SavedPlaylist;
use crate::settings::Settings;
use crate::sync::SyncStatus;

/// Settings changed, in this window or another one.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SettingsChanged(pub Settings);

/// The player's state changed. The interface folds each change into the
/// snapshot it got from `player_snapshot`.
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct PlayerChanged(pub PlayerChange);

/// The queue changed: what is in it, its order, which item is open, or how
/// it repeats. The whole queue is sent each time.
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct QueueChanged(pub QueueSnapshot);

/// An item of the queue would not play, and the next one is playing instead.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSkipped {
    pub source: String,
    pub title: String,
    pub reason: FailureReason,
}

/// What has been played is not what it was: something was opened, forgotten
/// or put back, or all of it was cleared. `history_recent` has it as it is
/// now. The list is not sent with this, because each entry's poster is
/// looked up, and made if need be, on the way out.
///
/// Where a file was left is written far more often than this is said: only
/// which things were played, and in what order, is worth saying.
#[derive(Debug, Clone, Copy, Serialize, Type, Event)]
pub struct HistoryChanged;

/// The saved playlists changed: one was saved, renamed, deleted or brought
/// back. All of them are sent each time, so everything that lists them
/// (the home screen, the menu bar, the palette) says the same.
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct PlaylistsChanged(pub Vec<SavedPlaylist>);

/// A poster that was not there when the history was read now is.
#[derive(Debug, Clone, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct PosterReady {
    /// What it is a poster for.
    pub source: String,
    /// Where the web view loads it from.
    pub url: String,
}

/// Fingers or a wheel scrolled over the main window. The glide macOS adds
/// after the fingers lift is left out, which is why the page uses this and
/// not its own wheel events for volume and seeking.
#[derive(Debug, Clone, Copy, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct Scrolled {
    /// Where the pointer is, in points from the window's top-left corner.
    #[specta(type = Number)]
    pub x: f64,
    #[specta(type = Number)]
    pub y: f64,
    /// How far the fingers moved, in points: right and up are positive.
    #[specta(type = Number)]
    pub right: f64,
    #[specta(type = Number)]
    pub up: f64,
    /// Fine movement (a trackpad), as opposed to the notches of a wheel.
    pub precise: bool,
    pub phase: ScrollPhase,
}

/// An item of the menu bar that runs an action was chosen. The payload is
/// the action's id.
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct MenuAction(pub String);

/// A window entered or left full screen, by any means: a command, the green
/// button, or a Mission Control gesture.
#[derive(Debug, Clone, Copy, Serialize, Type, Event)]
pub struct FullscreenChanged(pub bool);

/// The picture began or stopped being shown in high dynamic range. While it
/// is, its highlights can be several times brighter than the interface's
/// white, so the chrome drawn over it outlines its marks (DESIGN.md §2).
#[derive(Debug, Clone, Copy, Serialize, Type, Event)]
pub struct DynamicRangeChanged(pub bool);

/// Syncing the subtitles to the speech moved on: the model is downloading,
/// samples are being listened to, or it is done.
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct SubtitleSyncChanged(pub SyncStatus);

/// Casting changed: devices were found or lost, or a session started,
/// moved on or ended. The whole state is sent each time.
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct CastChanged(pub CastSnapshot);

/// Casting failed or ended on the device's account: what to tell the user.
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct CastFailed(pub String);
