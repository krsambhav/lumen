//! What Lumen remembers between runs that is not a setting: where the volume
//! was, how the queue repeats, how the interface was left.
//!
//! Settings are chosen; these are just how things were. They are stored the
//! same way, as one JSON document, so a field added later needs no migration.

use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Number;

use crate::db::Db;
use crate::error::AppResult;
use crate::playlist::queue::Repeat;
use crate::settings::{load_section, save_section};

const KEY: &str = "session";

/// How many recently used actions the palette keeps.
pub const RECENT_ACTIONS: usize = 8;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// 0–100. A boost above 100 is not remembered: it is turned up for one
    /// quiet film, and the next one should not start at twice the level.
    #[specta(type = Number)]
    pub volume: f64,
    pub muted: bool,
    pub repeat: Repeat,
    pub shuffle: bool,
    pub interface: Interface,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            volume: 100.0,
            muted: false,
            repeat: Repeat::Off,
            shuffle: false,
            interface: Interface::default(),
        }
    }
}

/// How the interface was left. The interface owns these; the backend only
/// keeps them.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Interface {
    /// The time readout's second figure shows what is left, not the length.
    pub time_remaining: bool,
    /// The tab the panel beside the picture last showed. Whether it was
    /// open is not kept: it always starts closed.
    pub inspector_tab: InspectorTab,
    /// The actions last run from the command palette, newest first.
    pub recent_actions: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum InspectorTab {
    #[default]
    Playlist,
    Chapters,
    Video,
    Audio,
    Subtitles,
}

impl Session {
    /// Brings values that came from outside into the range the app can use.
    pub fn sanitised(mut self) -> Self {
        self.volume = if self.volume.is_finite() {
            self.volume.clamp(0.0, 100.0)
        } else {
            100.0
        };
        self.interface = self.interface.sanitised();
        self
    }
}

impl Interface {
    pub fn sanitised(mut self) -> Self {
        self.recent_actions
            .retain(|id| !id.is_empty() && id.len() <= 64);
        let mut seen = Vec::new();
        self.recent_actions.retain(|id| {
            let fresh = !seen.contains(id);
            if fresh {
                seen.push(id.clone());
            }
            fresh
        });
        self.recent_actions.truncate(RECENT_ACTIONS);
        self
    }
}

/// The session, in memory and on disk. Every change is written at once: they
/// are small, rare by a computer's measure, and must survive a crash.
pub struct SessionStore {
    db: Arc<Db>,
    value: Mutex<Session>,
}

impl SessionStore {
    pub fn load(db: Arc<Db>) -> AppResult<Self> {
        let value = load_section::<Session>(&db, KEY)?.sanitised();
        Ok(Self {
            db,
            value: Mutex::new(value),
        })
    }

    pub fn get(&self) -> Session {
        self.value.lock().clone()
    }

    /// Changes the session and stores it, if `change` changed anything.
    pub fn update(&self, change: impl FnOnce(&mut Session)) {
        let mut value = self.value.lock();
        let mut next = value.clone();
        change(&mut next);
        let next = next.sanitised();
        if next == *value {
            return;
        }
        *value = next;
        if let Err(error) = save_section(&self.db, KEY, &*value) {
            // Not being able to remember is not worth interrupting a film for.
            tracing::warn!(%error, "could not store the session");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> SessionStore {
        SessionStore::load(Arc::new(Db::in_memory().unwrap())).unwrap()
    }

    #[test]
    fn starts_at_normal_volume_with_nothing_repeating() {
        let session = store().get();
        assert_eq!(session, Session::default());
        assert_eq!(session.volume, 100.0);
        assert_eq!(session.repeat, Repeat::Off);
        assert_eq!(session.interface.inspector_tab, InspectorTab::Playlist);
    }

    #[test]
    fn remembers_across_a_restart() {
        let db = Arc::new(Db::in_memory().unwrap());
        let first = SessionStore::load(db.clone()).unwrap();
        first.update(|session| {
            session.volume = 65.0;
            session.muted = true;
            session.repeat = Repeat::All;
            session.interface.time_remaining = true;
            session.interface.inspector_tab = InspectorTab::Chapters;
            session.interface.recent_actions = vec!["playback.toggle".into()];
        });
        let second = SessionStore::load(db).unwrap();
        assert_eq!(second.get(), first.get());
        assert_eq!(second.get().volume, 65.0);
    }

    #[test]
    fn a_boost_is_not_remembered() {
        let store = store();
        store.update(|session| session.volume = 180.0);
        assert_eq!(store.get().volume, 100.0);
        store.update(|session| session.volume = f64::NAN);
        assert_eq!(store.get().volume, 100.0);
    }

    #[test]
    fn recent_actions_are_unique_and_few() {
        let store = store();
        store.update(|session| {
            session.interface.recent_actions = (0..20)
                .map(|index| format!("action.{}", index % 12))
                .chain([String::new(), "x".repeat(65)])
                .collect();
        });
        let recent = store.get().interface.recent_actions;
        assert_eq!(recent.len(), RECENT_ACTIONS);
        assert_eq!(recent[0], "action.0");
        let mut unique = recent.clone();
        unique.dedup();
        assert_eq!(unique, recent);
    }

    #[test]
    fn a_session_written_by_an_older_version_still_loads() {
        let db = Arc::new(Db::in_memory().unwrap());
        db.write(|tx| {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES ('session', ?1)",
                [r#"{"volume":40,"interface":{"timeRemaining":true}}"#],
            )
        })
        .unwrap();
        let session = SessionStore::load(db).unwrap().get();
        assert_eq!(session.volume, 40.0);
        assert!(session.interface.time_remaining);
        assert_eq!(session.interface.inspector_tab, InspectorTab::Playlist);
        assert!(!session.shuffle);
    }
}
