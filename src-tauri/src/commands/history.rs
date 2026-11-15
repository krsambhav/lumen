use tauri::{AppHandle, State};
use tauri_specta::Event;

use crate::error::AppResult;
use crate::events::HistoryChanged;
use crate::library::history::{self, HistoryEntry, Recent};
use crate::state::AppState;

/// Tells the interface that what was played is not what it was. Everything
/// that lists it (the home screen, the menu bar, the palette) reads it again.
fn announce(app: &AppHandle) {
    if let Err(error) = HistoryChanged.emit(app) {
        tracing::warn!(%error, "could not announce a change to the play history");
    }
}

/// The most there is any use asking for at once.
const MOST: u32 = 200;

/// What was played most recently, newest first.
#[tauri::command]
#[specta::specta]
pub async fn history_recent(state: State<'_, AppState>, limit: u32) -> AppResult<Vec<Recent>> {
    let recent = history::recent(&state.db, limit.clamp(1, MOST))?
        .into_iter()
        .map(|entry| {
            let poster = state.posters.url_for(&entry.source);
            if poster.is_none() {
                // Made in the background; `PosterReady` says when it is there.
                state.posters.request(&entry.source, entry.duration);
            }
            Recent::of(entry, poster)
        })
        .collect();
    Ok(recent)
}

/// Forgets that something was played. Returns whether it was remembered.
#[tauri::command]
#[specta::specta]
pub async fn history_forget(
    app: AppHandle,
    state: State<'_, AppState>,
    source: String,
) -> AppResult<bool> {
    let forgotten = history::forget(&state.db, &source)?;
    if forgotten {
        announce(&app);
    }
    Ok(forgotten)
}

/// Puts back an entry that was forgotten, exactly as it was: the undo of
/// `history_forget`.
#[tauri::command]
#[specta::specta]
pub async fn history_restore(
    app: AppHandle,
    state: State<'_, AppState>,
    entry: HistoryEntry,
) -> AppResult<()> {
    history::restore(&state.db, &entry)?;
    announce(&app);
    Ok(())
}

/// Pins something to Recently played, or unpins it. A pinned entry is
/// listed first and outlasts "Clear". Returns whether it was there.
#[tauri::command]
#[specta::specta]
pub async fn history_pin(
    app: AppHandle,
    state: State<'_, AppState>,
    source: String,
    pinned: bool,
) -> AppResult<bool> {
    let changed = history::pin(&state.db, &source, pinned)?;
    if changed {
        announce(&app);
    }
    Ok(changed)
}

/// Forgets everything that was played and is not pinned.
#[tauri::command]
#[specta::specta]
pub async fn history_clear(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    history::clear(&state.db)?;
    announce(&app);
    Ok(())
}
