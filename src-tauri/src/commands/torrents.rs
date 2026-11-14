//! Searching the user's torrent server and playing what it fetches.

use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::torrents::{self, TorrentProgress, TorrentResult, Torrents};

/// Searches for films, shows and music. Results come best shared first,
/// marked ready when they would play at once.
#[tauri::command]
#[specta::specta]
pub async fn torrents_search(
    torrents: State<'_, Torrents>,
    query: String,
) -> AppResult<Vec<TorrentResult>> {
    torrents.search(&query).await
}

/// Asks for a result to be fetched. Returns the id to follow with
/// `torrents_status`.
#[tauri::command]
#[specta::specta]
pub async fn torrents_prepare(torrents: State<'_, Torrents>, magnet: String) -> AppResult<String> {
    torrents.prepare(&magnet).await
}

/// How a torrent being fetched is getting on; once ready, its files.
#[tauri::command]
#[specta::specta]
pub async fn torrents_status(
    torrents: State<'_, Torrents>,
    id: String,
) -> AppResult<TorrentProgress> {
    torrents.status(&id).await
}

/// The playlist items for a file of a fetched torrent: it, and the playable
/// files after it, so that the next episode follows.
async fn items_from(torrents: &Torrents, id: &str, index: u32) -> AppResult<Vec<(String, String)>> {
    let TorrentProgress::Ready { files, .. } = torrents.status(id).await? else {
        return Err(AppError::Invalid(
            "that torrent is not ready yet".to_owned(),
        ));
    };
    let items = torrents::queue_from(&files, index)
        .into_iter()
        .map(|file| Ok((torrents.address(id, file.index)?, torrents::title_of(file))))
        .collect::<AppResult<Vec<_>>>()?;
    if items.is_empty() {
        return Err(AppError::NotFound(
            "that file is not in the torrent".to_owned(),
        ));
    }
    Ok(items)
}

/// Plays a file of a fetched torrent in place of the playlist, with the
/// playable files after it.
#[tauri::command]
#[specta::specta]
pub async fn torrents_play(
    state: State<'_, AppState>,
    torrents: State<'_, Torrents>,
    id: String,
    index: u32,
) -> AppResult<()> {
    let items = items_from(&torrents, &id, index).await?;
    state.conductor.open_titled(items)
}

/// Puts a file of a fetched torrent (and the playable files after it) next
/// in the playlist: it plays when what is playing ends, or on Next. Returns
/// how many items were added.
#[tauri::command]
#[specta::specta]
pub async fn torrents_play_next(
    state: State<'_, AppState>,
    torrents: State<'_, Torrents>,
    id: String,
    index: u32,
) -> AppResult<u32> {
    let items = items_from(&torrents, &id, index).await?;
    Ok(state.conductor.play_next_titled(items)? as u32)
}

/// Opens a file of a fetched torrent in the browser, to download it: for
/// what Lumen does not play. What is playing goes on playing.
#[tauri::command]
#[specta::specta]
pub async fn torrents_download(
    app: AppHandle,
    torrents: State<'_, Torrents>,
    id: String,
    index: u32,
) -> AppResult<()> {
    let address = torrents.address(&id, index)?;
    app.opener()
        .open_url(address, None::<&str>)
        .map_err(|error| AppError::Io(format!("the browser could not be opened: {error}")))
}
