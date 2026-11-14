use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_specta::Event;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::events::PlaylistsChanged;
use crate::media::formats;
use crate::playlist::queue::{QueueSnapshot, Repeat};
use crate::playlist::saved::{self, SavedPlaylist};
use crate::state::AppState;

/// The whole queue. Call once on start-up; after that, follow `QueueChanged`.
#[tauri::command]
#[specta::specta]
pub fn playlist_snapshot(state: State<'_, AppState>) -> QueueSnapshot {
    state.conductor.snapshot()
}

/// Replaces the queue with files, folders, playlist files and addresses, and
/// plays the first thing in them: from where it was left if `resume` is set.
#[tauri::command]
#[specta::specta]
pub async fn playlist_open(
    state: State<'_, AppState>,
    sources: Vec<String>,
    resume: bool,
) -> AppResult<()> {
    if for_what_is_open(&state, &sources) {
        state.player.add_subtitles(&sources)?;
        return Ok(());
    }
    state.conductor.open(&sources, resume)
}

/// Opens something from Recently played: one played in a playlist brings
/// the whole playlist back and plays that item of it, or the item `play`
/// names (chosen from the playlist's list); anything else opens alone.
/// From where it was left if `resume` is set.
#[tauri::command]
#[specta::specta]
pub async fn playlist_open_recent(
    state: State<'_, AppState>,
    source: String,
    play: Option<String>,
    resume: bool,
) -> AppResult<()> {
    state.conductor.open_recent(&source, play.as_deref(), resume)
}

/// True if `sources` are all files of subtitles and something is open for
/// them to belong to. Dropped on the window or chosen in the open panel,
/// they are added to what is playing; they are not something to play.
fn for_what_is_open(state: &AppState, sources: &[String]) -> bool {
    !sources.is_empty()
        && state.player.snapshot().source.is_some()
        && sources
            .iter()
            .all(|source| formats::is_subtitles(std::path::Path::new(source)))
}

/// What the user picks in the system open panel, as paths. Empty if the
/// panel was cancelled.
fn pick(app: &AppHandle, folder: bool) -> AppResult<Vec<String>> {
    let panel = app.dialog().file();
    let picked = if folder {
        panel
            .set_title("Open folder")
            .blocking_pick_folder()
            .map(|folder| vec![folder])
    } else {
        let mut extensions = formats::all_extensions();
        extensions.extend(["m3u", "m3u8", "pls"]);
        panel
            .set_title("Open")
            .add_filter("Video, audio and playlists", &extensions)
            .blocking_pick_files()
    };
    picked
        .unwrap_or_default()
        .into_iter()
        .map(|item| {
            item.into_path()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|error| AppError::Invalid(format!("that item cannot be opened: {error}")))
        })
        .collect()
}

/// Shows the system open panel, for files or for one folder, and plays what
/// the user picks. Returns false if the panel was cancelled.
#[tauri::command]
#[specta::specta]
pub async fn playlist_open_dialog(
    app: AppHandle,
    state: State<'_, AppState>,
    folder: bool,
) -> AppResult<bool> {
    let picked = pick(&app, folder)?;
    if picked.is_empty() {
        return Ok(false);
    }
    state.conductor.open(&picked, true)?;
    Ok(true)
}

/// Adds files, folders, playlist files and addresses to the queue: at
/// `index` in the list, or at its end. Returns how many items were added.
#[tauri::command]
#[specta::specta]
pub async fn playlist_add(
    state: State<'_, AppState>,
    sources: Vec<String>,
    index: Option<u32>,
) -> AppResult<u32> {
    if for_what_is_open(&state, &sources) {
        // Nothing joins the playlist: they are subtitles for what is on.
        state.player.add_subtitles(&sources)?;
        return Ok(0);
    }
    let added = state
        .conductor
        .add(&sources, index.map(|index| index as usize))?;
    Ok(added as u32)
}

/// Shows the system open panel and adds what the user picks to the end of
/// the queue. Returns how many items were added: none if it was cancelled.
#[tauri::command]
#[specta::specta]
pub async fn playlist_add_dialog(app: AppHandle, state: State<'_, AppState>) -> AppResult<u32> {
    let picked = pick(&app, false)?;
    if picked.is_empty() {
        return Ok(0);
    }
    Ok(state.conductor.add(&picked, None)? as u32)
}

/// Plays an item of the queue. The one already playing starts again.
#[tauri::command]
#[specta::specta]
pub async fn playlist_play(state: State<'_, AppState>, id: u32) -> AppResult<()> {
    state.conductor.play(id)
}

/// Takes an item out of the queue. If it was playing, what followed it plays.
#[tauri::command]
#[specta::specta]
pub async fn playlist_remove(state: State<'_, AppState>, id: u32) -> AppResult<()> {
    state.conductor.remove(id)
}

/// Moves an item to `index` in the list.
#[tauri::command]
#[specta::specta]
pub async fn playlist_move(state: State<'_, AppState>, id: u32, index: u32) -> AppResult<()> {
    state.conductor.move_to(id, index as usize);
    Ok(())
}

/// Empties the queue of everything but what is playing.
#[tauri::command]
#[specta::specta]
pub async fn playlist_clear(state: State<'_, AppState>) -> AppResult<()> {
    state.conductor.clear_others();
    Ok(())
}

/// Goes to the next item. Returns false if there is none.
#[tauri::command]
#[specta::specta]
pub async fn playlist_next(state: State<'_, AppState>) -> AppResult<bool> {
    state.conductor.next()
}

/// Goes to the previous item. Returns false if there is none.
#[tauri::command]
#[specta::specta]
pub async fn playlist_previous(state: State<'_, AppState>) -> AppResult<bool> {
    state.conductor.previous()
}

#[tauri::command]
#[specta::specta]
pub async fn playlist_set_repeat(state: State<'_, AppState>, repeat: Repeat) -> AppResult<()> {
    state.conductor.set_repeat(repeat);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn playlist_set_shuffle(state: State<'_, AppState>, shuffle: bool) -> AppResult<()> {
    state.conductor.set_shuffle(shuffle);
    Ok(())
}

/// Closes what is open and empties the queue.
#[tauri::command]
#[specta::specta]
pub async fn playlist_close(state: State<'_, AppState>) -> AppResult<()> {
    state.conductor.close()
}

/// Every saved playlist, by name.
#[tauri::command]
#[specta::specta]
pub async fn playlists_list(state: State<'_, AppState>) -> AppResult<Vec<SavedPlaylist>> {
    saved::list(&state.db)
}

/// Tells the interface what is saved now. Everything that lists the saved
/// playlists (the home screen, the menu bar, the palette, the panel) follows
/// this, so a change made in one place is not something the others have to
/// be told about one by one.
fn announce_saved(app: &AppHandle, db: &Db) {
    match saved::list(db) {
        Ok(playlists) => {
            if let Err(error) = PlaylistsChanged(playlists).emit(app) {
                tracing::warn!(%error, "could not announce the saved playlists");
            }
        }
        Err(error) => tracing::warn!(%error, "could not list the saved playlists"),
    }
}

/// Saves the queue as a playlist. If one of that name exists, it is replaced
/// when `replace` is set and the save is refused (`exists`) otherwise.
#[tauri::command]
#[specta::specta]
pub async fn playlists_save(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    replace: bool,
) -> AppResult<SavedPlaylist> {
    let playlist = state.conductor.save_as(&name, replace)?;
    announce_saved(&app, &state.db);
    Ok(playlist)
}

/// Replaces the queue with a saved playlist and plays the first of it.
#[tauri::command]
#[specta::specta]
pub async fn playlists_open(state: State<'_, AppState>, id: u32) -> AppResult<()> {
    state.conductor.open_saved(id)
}

#[tauri::command]
#[specta::specta]
pub async fn playlists_rename(
    app: AppHandle,
    state: State<'_, AppState>,
    id: u32,
    name: String,
) -> AppResult<SavedPlaylist> {
    let playlist = state.conductor.rename_saved(id, &name)?;
    announce_saved(&app, &state.db);
    Ok(playlist)
}

/// Deletes a saved playlist. Returns whether there was one. Until Lumen is
/// next launched, `playlists_undelete` brings it back.
#[tauri::command]
#[specta::specta]
pub async fn playlists_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: u32,
) -> AppResult<bool> {
    let deleted = state.conductor.delete_saved(id)?;
    if deleted {
        announce_saved(&app, &state.db);
    }
    Ok(deleted)
}

/// Brings back a playlist deleted since the last launch.
#[tauri::command]
#[specta::specta]
pub async fn playlists_undelete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: u32,
) -> AppResult<SavedPlaylist> {
    let playlist = state.conductor.undelete_saved(id)?;
    announce_saved(&app, &state.db);
    Ok(playlist)
}
