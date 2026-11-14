use std::path::Path;

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppResult};

/// Shows a file or folder in the Finder: a file is selected in its folder, a
/// folder is opened.
#[tauri::command]
#[specta::specta]
pub async fn files_show_in_finder(app: AppHandle, path: String) -> AppResult<()> {
    let target = Path::new(&path);
    if !target.is_absolute() || !target.exists() {
        return Err(AppError::NotFound(format!(
            "there is nothing at {path} to show"
        )));
    }
    let shown = if target.is_dir() {
        app.opener().open_path(path.clone(), None::<&str>)
    } else {
        app.opener().reveal_item_in_dir(target)
    };
    shown.map_err(|error| AppError::Io(format!("the Finder would not show {path}: {error}")))
}
