use std::sync::Arc;

use tauri::State;

use crate::error::AppResult;
use crate::sync::{SyncStatus, Syncer};

/// How syncing the subtitles is going. Call once on start-up; after that,
/// follow `SubtitleSyncChanged` events.
#[tauri::command]
#[specta::specta]
pub fn subtitles_sync_status(syncer: State<'_, Arc<Syncer>>) -> SyncStatus {
    syncer.status()
}

/// Lines the subtitle file that is showing up with the film's speech,
/// downloading the speech model first if it is not here yet.
#[tauri::command]
#[specta::specta]
pub async fn subtitles_sync(syncer: State<'_, Arc<Syncer>>) -> AppResult<()> {
    syncer.start()
}

/// Stops a sync that is running; the timing stays as it was.
#[tauri::command]
#[specta::specta]
pub async fn subtitles_sync_cancel(syncer: State<'_, Arc<Syncer>>) -> AppResult<()> {
    syncer.cancel();
    Ok(())
}

/// Puts back the timing from before the last sync.
#[tauri::command]
#[specta::specta]
pub async fn subtitles_sync_undo(syncer: State<'_, Arc<Syncer>>) -> AppResult<()> {
    syncer.undo()
}
