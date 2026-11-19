use std::sync::Arc;

use tauri::State;

use crate::cast::{Anchor, CastSnapshot, Caster};
use crate::error::AppResult;

/// The devices found so far and the session there is. Follow `CastChanged`
/// after this.
#[tauri::command]
#[specta::specta]
pub fn cast_snapshot(cast: State<'_, Arc<Caster>>) -> CastSnapshot {
    cast.snapshot()
}

/// Starts looking for cast devices on the network, if not already. The first
/// time, macOS may ask whether Lumen may use the local network.
#[tauri::command]
#[specta::specta]
pub fn cast_search(cast: State<'_, Arc<Caster>>) {
    cast.search();
}

/// Casts what is open to a device found by the search.
#[tauri::command]
#[specta::specta]
pub async fn cast_start(
    cast: State<'_, Arc<Caster>>,
    device: String,
    anchor: Anchor,
) -> AppResult<()> {
    cast.start(&device, anchor)
}

/// Opens the AirPlay picker of macOS over `anchor`, the cast button.
#[tauri::command]
#[specta::specta]
pub async fn cast_airplay(cast: State<'_, Arc<Caster>>, anchor: Anchor) -> AppResult<()> {
    cast.choose_airplay(anchor)
}

/// Stops casting; the Mac takes over, paused where the TV was.
#[tauri::command]
#[specta::specta]
pub async fn cast_stop(cast: State<'_, Arc<Caster>>) -> AppResult<()> {
    cast.stop();
    Ok(())
}
