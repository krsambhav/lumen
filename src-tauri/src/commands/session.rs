use tauri::State;

use crate::error::AppResult;
use crate::session::{Interface, Session};
use crate::state::AppState;

/// What was remembered from the last run.
#[tauri::command]
#[specta::specta]
pub fn session_get(state: State<'_, AppState>) -> Session {
    state.session.get()
}

/// Stores how the interface has been left. The interface owns this part of
/// the session and sends the whole of it each time.
///
/// (The argument is not called `interface`: that is a reserved word in the
/// JavaScript the bindings are generated as.)
#[tauri::command]
#[specta::specta]
pub async fn session_set_interface(state: State<'_, AppState>, layout: Interface) -> AppResult<()> {
    state.session.update(|session| session.interface = layout);
    Ok(())
}
