use tauri::{AppHandle, State};
use tauri_specta::Event;

use crate::error::AppResult;
use crate::events::SettingsChanged;
use crate::settings::Settings;
use crate::state::AppState;

#[tauri::command]
#[specta::specta]
pub fn settings_get(state: State<'_, AppState>) -> Settings {
    state.settings.read().clone()
}

/// Replaces the settings, persists them, applies their side effects and tells
/// every window.
#[tauri::command]
#[specta::specta]
pub async fn settings_set(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> AppResult<()> {
    let settings = settings.sanitised();
    let before = state.settings.read().clone();
    if before == settings {
        return Ok(());
    }
    settings.save_changes(&state.db, &before)?;
    *state.settings.write() = settings.clone();
    crate::apply_settings(&app, &settings, Some(&before));
    SettingsChanged(settings).emit(&app)?;
    Ok(())
}
