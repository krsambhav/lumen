use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::engine::adjust::Shape;
use crate::engine::failure::is_address;
use crate::engine::types::{PlayerSnapshot, TrackKind};
use crate::error::{AppError, AppResult};
use crate::ipc::Real;
use crate::media::{formats, thumbnails};
use crate::state::AppState;

/// The player's whole state. Call once on start-up; after that, follow
/// `PlayerChanged` events.
#[tauri::command]
#[specta::specta]
pub fn player_snapshot(state: State<'_, AppState>) -> PlayerSnapshot {
    state.player.snapshot()
}

#[tauri::command]
#[specta::specta]
pub async fn player_set_paused(state: State<'_, AppState>, paused: bool) -> AppResult<()> {
    state.player.set_paused(paused)
}

/// Plays if paused or ended, pauses if playing.
#[tauri::command]
#[specta::specta]
pub async fn player_toggle_paused(state: State<'_, AppState>) -> AppResult<()> {
    state.player.toggle_paused()
}

/// Seeks to `seconds` from the start. `exact` lands on that frame; otherwise
/// on the nearest keyframe, which is what dragging the timeline wants.
#[tauri::command]
#[specta::specta]
pub async fn player_seek_to(
    state: State<'_, AppState>,
    seconds: Real,
    exact: bool,
) -> AppResult<()> {
    state.player.seek_to(seconds.0, exact)
}

/// Seeks forward (positive) or back (negative) by `seconds`.
#[tauri::command]
#[specta::specta]
pub async fn player_seek_by(state: State<'_, AppState>, seconds: Real) -> AppResult<()> {
    state.player.seek_by(seconds.0)
}

/// Sets the volume in percent, 0–200.
#[tauri::command]
#[specta::specta]
pub async fn player_set_volume(state: State<'_, AppState>, percent: Real) -> AppResult<()> {
    state.player.set_volume(percent.0)
}

#[tauri::command]
#[specta::specta]
pub async fn player_set_muted(state: State<'_, AppState>, muted: bool) -> AppResult<()> {
    state.player.set_muted(muted)
}

/// Sets the playback speed, 0.25–4. Pitch is preserved.
#[tauri::command]
#[specta::specta]
pub async fn player_set_speed(state: State<'_, AppState>, rate: Real) -> AppResult<()> {
    state.player.set_speed(rate.0)
}

/// Shows the next frame, or the one before it, and stays paused there.
#[tauri::command]
#[specta::specta]
pub async fn player_step_frame(state: State<'_, AppState>, forward: bool) -> AppResult<()> {
    state.player.step_frame(forward)
}

/// A small still of the open film near `seconds`, for the timeline's preview:
/// the keyframe at or before that time, as an image address the page can
/// show directly. `None` when there is no picture to preview, as for audio
/// and for anything that is not a file on this Mac.
#[tauri::command]
#[specta::specta]
pub async fn player_preview_frame(
    state: State<'_, AppState>,
    seconds: Real,
) -> AppResult<Option<String>> {
    let snapshot = state.player.snapshot();
    let Some(source) = snapshot.source.filter(|source| !is_address(source)) else {
        return Ok(None);
    };
    if snapshot.video.is_none() {
        return Ok(None);
    }
    let path = PathBuf::from(source);
    let at = seconds.0;
    // FFmpeg is run for each still; that must not hold up other commands.
    tauri::async_runtime::spawn_blocking(move || {
        thumbnails::frame(&path, Some(at), thumbnails::PREVIEW_WIDTH)
            .map(|jpeg| thumbnails::data_url(&jpeg))
    })
    .await
    .map_err(|error| AppError::Internal(format!("the preview could not be made: {error}")))
}

/// Plays another audio track, or shows another subtitle track. For
/// subtitles, no id shows none.
#[tauri::command]
#[specta::specta]
pub async fn player_select_track(
    state: State<'_, AppState>,
    kind: TrackKind,
    id: Option<i32>,
) -> AppResult<()> {
    state.player.select_track(kind, id)
}

/// Shows a second subtitle track above the first; no id stops showing one.
#[tauri::command]
#[specta::specta]
pub async fn player_select_second_subtitle(
    state: State<'_, AppState>,
    id: Option<i32>,
) -> AppResult<()> {
    state.player.select_second_subtitle(id)
}

/// Adds subtitle files to what is open and shows the first of them.
/// Returns how many were added.
#[tauri::command]
#[specta::specta]
pub async fn player_add_subtitles(
    state: State<'_, AppState>,
    files: Vec<String>,
) -> AppResult<u32> {
    Ok(state.player.add_subtitles(&files)? as u32)
}

/// Shows the system open panel for subtitle files, in the folder of what is
/// open, and adds what the user picks. Returns how many were added: none if
/// the panel was cancelled.
#[tauri::command]
#[specta::specta]
pub async fn player_add_subtitles_dialog(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<u32> {
    let mut panel = app
        .dialog()
        .file()
        .set_title("Add subtitles")
        .add_filter("Subtitles", formats::SUBTITLES);
    let open = state.player.snapshot().source;
    if let Some(folder) = open
        .as_deref()
        .filter(|source| !is_address(source))
        .and_then(|source| Path::new(source).parent())
    {
        panel = panel.set_directory(folder);
    }
    let files: Vec<String> = panel
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    if files.is_empty() {
        return Ok(0);
    }
    Ok(state.player.add_subtitles(&files)? as u32)
}

/// Plays the sound this many seconds later than the picture; negative,
/// earlier. Belongs to the file that is open.
#[tauri::command]
#[specta::specta]
pub async fn player_set_audio_delay(state: State<'_, AppState>, seconds: Real) -> AppResult<()> {
    state.player.set_audio_delay(seconds.0)
}

/// Shows subtitles this many seconds later than they are timed; negative,
/// earlier. Belongs to the file that is open.
#[tauri::command]
#[specta::specta]
pub async fn player_set_subtitle_delay(state: State<'_, AppState>, seconds: Real) -> AppResult<()> {
    state.player.set_subtitle_delay(seconds.0)
}

/// Switches subtitles off, or on again as they were. Returns whether they
/// are on afterwards.
#[tauri::command]
#[specta::specta]
pub async fn player_toggle_subtitles(state: State<'_, AppState>) -> AppResult<bool> {
    state.player.toggle_subtitles()
}

/// Turns, cuts and stretches the picture of the file that is open.
#[tauri::command]
#[specta::specta]
pub async fn player_set_shape(state: State<'_, AppState>, shape: Shape) -> AppResult<()> {
    state.player.set_shape(shape)
}

/// Keeps subtitles clear of a strip along the bottom of the picture, given
/// as a share of its height: where the control bar is, while it is up.
#[tauri::command]
#[specta::specta]
pub async fn player_set_subtitle_lift(state: State<'_, AppState>, share: Real) -> AppResult<()> {
    state.player.set_subtitle_lift(share.0)
}

/// The font families installed on this Mac, for setting subtitles in.
#[tauri::command]
#[specta::specta]
pub fn fonts_list() -> AppResult<Vec<String>> {
    // Commands that are not async run on the main thread, where AppKit
    // wants to be asked.
    let main = objc2::MainThreadMarker::new()
        .ok_or_else(|| AppError::Internal("fonts were asked for off the main thread".to_owned()))?;
    Ok(crate::platform::font_families(main))
}
