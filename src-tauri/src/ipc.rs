//! The typed IPC surface: every command and event, in one place.
//!
//! `tauri-specta` turns this list into `src/ipc/bindings.ts`, so the web UI
//! calls commands through generated, typed functions and never through a raw
//! `invoke`.

use serde::Deserialize;
use specta::Type;
use specta_typescript::Number;
use tauri_specta::{collect_commands, collect_events, Builder, ErrorHandlingMode};

use crate::commands;
use crate::events;

/// A number sent by the interface: seconds, a percentage, a rate.
///
/// A bare `f64` argument would be typed `number | null` in TypeScript,
/// because JSON cannot carry NaN or infinity. This is plain `number`; commands
/// still reject values that are not finite.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Type)]
#[serde(transparent)]
pub struct Real(#[specta(type = Number)] pub f64);

pub fn builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::app::app_ready,
            commands::app::menu_set,
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::window::window_set_chrome_visible,
            commands::window::window_set_fullscreen,
            commands::window::window_toggle_fullscreen,
            commands::window::window_is_fullscreen,
            commands::window::window_is_hdr,
            commands::window::window_set_panel_width,
            commands::window::window_set_always_on_top,
            commands::window::window_set_backdrop_blur,
            commands::session::session_get,
            commands::session::session_set_interface,
            commands::player::player_snapshot,
            commands::player::player_set_paused,
            commands::player::player_toggle_paused,
            commands::player::player_seek_to,
            commands::player::player_seek_by,
            commands::player::player_step_frame,
            commands::player::player_preview_frame,
            commands::player::player_set_volume,
            commands::player::player_set_muted,
            commands::player::player_set_speed,
            commands::player::player_select_track,
            commands::player::player_select_second_subtitle,
            commands::player::player_add_subtitles,
            commands::player::player_add_subtitles_dialog,
            commands::player::player_set_audio_delay,
            commands::player::player_set_subtitle_delay,
            commands::player::player_toggle_subtitles,
            commands::player::player_set_shape,
            commands::player::player_set_subtitle_lift,
            commands::player::fonts_list,
            commands::playlist::playlist_snapshot,
            commands::playlist::playlist_open,
            commands::playlist::playlist_open_dialog,
            commands::playlist::playlist_add,
            commands::playlist::playlist_add_dialog,
            commands::playlist::playlist_play,
            commands::playlist::playlist_remove,
            commands::playlist::playlist_move,
            commands::playlist::playlist_clear,
            commands::playlist::playlist_next,
            commands::playlist::playlist_previous,
            commands::playlist::playlist_set_repeat,
            commands::playlist::playlist_set_shuffle,
            commands::playlist::playlist_close,
            commands::playlist::playlists_list,
            commands::playlist::playlists_save,
            commands::playlist::playlists_open,
            commands::playlist::playlists_rename,
            commands::playlist::playlists_delete,
            commands::playlist::playlists_undelete,
            commands::history::history_recent,
            commands::history::history_forget,
            commands::history::history_restore,
            commands::history::history_clear,
            commands::files::files_show_in_finder,
            commands::torrents::torrents_search,
            commands::torrents::torrents_prepare,
            commands::torrents::torrents_status,
            commands::torrents::torrents_play,
            commands::torrents::torrents_play_next,
            commands::torrents::torrents_download,
            commands::sync::subtitles_sync_status,
            commands::sync::subtitles_sync,
            commands::sync::subtitles_sync_cancel,
            commands::sync::subtitles_sync_undo,
            commands::cast::cast_snapshot,
            commands::cast::cast_search,
            commands::cast::cast_start,
            commands::cast::cast_airplay,
            commands::cast::cast_stop,
        ])
        .events(collect_events![
            events::SettingsChanged,
            events::PlayerChanged,
            events::QueueChanged,
            events::PlaybackSkipped,
            events::HistoryChanged,
            events::PlaylistsChanged,
            events::PosterReady,
            events::MenuAction,
            events::Scrolled,
            events::FullscreenChanged,
            events::DynamicRangeChanged,
            events::SubtitleSyncChanged,
            events::CastChanged,
            events::CastFailed,
        ])
        // Commands resolve to `{ status: "ok", data } | { status: "error", error }`
        // so the UI handles `AppError` as a value with a known shape.
        .error_handling(ErrorHandlingMode::Result)
        // One TypeScript type per Rust type: the UI always sends whole objects.
        .disable_serde_phases()
        .mocks()
}

#[cfg(test)]
mod tests {
    use specta_typescript::Typescript;

    const BINDINGS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/ipc/bindings.ts");

    /// Regenerates the TypeScript bindings. `cargo test` therefore keeps them
    /// current, and a stale checked-in file shows up as a diff.
    #[test]
    fn export_bindings() {
        let dir = std::env::temp_dir().join(format!("lumen-bindings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fresh = dir.join("bindings.ts");
        super::builder()
            .export(
                Typescript::default()
                    .header("// @ts-nocheck\n/* biome-ignore-all lint: generated */"),
                &fresh,
            )
            .expect("export bindings");
        let generated = std::fs::read_to_string(&fresh).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();

        // Only touch the real file when it changes, so the dev server does not
        // reload for nothing.
        if std::fs::read_to_string(BINDINGS).ok().as_deref() != Some(generated.as_str()) {
            std::fs::create_dir_all(std::path::Path::new(BINDINGS).parent().unwrap()).unwrap();
            std::fs::write(BINDINGS, generated).unwrap();
        }
    }
}
