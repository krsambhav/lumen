use tauri::{AppHandle, State, WebviewWindow};
use tauri_specta::Event;

use crate::error::AppResult;
use crate::events::PlayerChanged;
use crate::menu::MenuSection;
use crate::state::{AppState, Early};

/// Called by a window once its first frame is painted and it is listening
/// for events. Windows are created hidden so the user never sees an unstyled
/// flash.
#[tauri::command]
#[specta::specta]
pub fn app_ready(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> AppResult<()> {
    window.show()?;
    if window.label() != crate::MAIN_WINDOW {
        return Ok(());
    }
    if !crate::is_headless_run() {
        window.set_focus()?;
    }
    // Whatever happened before the interface could hear about it is said now.
    for early in state.early.release() {
        let sent = match early {
            Early::Player(change) => PlayerChanged(change).emit(&app),
            Early::Skipped(skipped) => skipped.emit(&app),
        };
        if let Err(error) = sent {
            tracing::warn!(%error, "could not deliver an early event");
        }
    }
    Ok(())
}

/// Makes the menu bar say what the interface describes: the menus that hold
/// its actions, in order. The app's own menu, Edit, Window and Help are
/// added around them. Called again whenever a name, a shortcut, a tick or
/// what is available changes; only what changed is touched.
#[tauri::command]
#[specta::specta]
pub fn menu_set(
    app: AppHandle,
    state: State<'_, AppState>,
    sections: Vec<MenuSection>,
) -> AppResult<()> {
    state.menu.apply(&app, &sections)
}
