use std::sync::Arc;

use tauri::State;

use crate::error::AppResult;
use crate::updates::{UpdateStatus, Updates};

/// How Lumen stands against its newest release. Call once on start-up;
/// after that, follow `UpdateChanged` events.
#[tauri::command]
#[specta::specta]
pub fn update_status(updates: State<'_, Arc<Updates>>) -> UpdateStatus {
    updates.status()
}

/// Looks for a newer version now, because the user asked. Returns how
/// things stand afterwards; a failure to look is the error.
#[tauri::command]
#[specta::specta]
pub async fn update_check(updates: State<'_, Arc<Updates>>) -> AppResult<UpdateStatus> {
    updates.check(false).await
}

/// Fetches the newer version that was found and puts it in place. Returns
/// once it is there (or could not be); how it goes meanwhile is said in
/// `UpdateChanged` events.
#[tauri::command]
#[specta::specta]
pub async fn update_install(updates: State<'_, Arc<Updates>>) -> AppResult<UpdateStatus> {
    updates.install().await
}

/// Closes Lumen and opens the version that was put in place.
#[tauri::command]
#[specta::specta]
pub async fn update_restart(updates: State<'_, Arc<Updates>>) -> AppResult<()> {
    updates.restart()
}
