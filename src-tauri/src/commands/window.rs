use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::error::{AppError, AppResult};
use crate::ipc::Real;
use crate::platform;
use crate::state::AppState;

/// Shows or hides the native traffic lights together with the web chrome, so
/// the whole title bar dims as one (DESIGN.md §5, "house lights").
///
/// Hiding waits for the pointer to leave the lights: see
/// `hide_window_buttons_when_clear`.
#[tauri::command]
#[specta::specta]
pub fn window_set_chrome_visible(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    visible: bool,
) -> AppResult<()> {
    let request = state.chrome_requests.fetch_add(1, Ordering::AcqRel) + 1;
    if visible {
        platform::set_window_buttons_visible(&window, true);
        return Ok(());
    }
    platform::hide_window_buttons_when_clear(&window, move || {
        app.try_state::<AppState>()
            .is_some_and(|state| state.chrome_requests.load(Ordering::Acquire) == request)
    });
    Ok(())
}

/// Enters or leaves native full screen.
#[tauri::command]
#[specta::specta]
pub fn window_set_fullscreen(window: WebviewWindow, fullscreen: bool) -> AppResult<()> {
    Ok(window.set_fullscreen(fullscreen)?)
}

#[tauri::command]
#[specta::specta]
pub fn window_toggle_fullscreen(window: WebviewWindow) -> AppResult<()> {
    let fullscreen = window.is_fullscreen()?;
    Ok(window.set_fullscreen(!fullscreen)?)
}

#[tauri::command]
#[specta::specta]
pub fn window_is_fullscreen(window: WebviewWindow) -> AppResult<bool> {
    Ok(window.is_fullscreen()?)
}

/// Whether the picture is being shown in high dynamic range right now.
#[tauri::command]
#[specta::specta]
pub fn window_is_hdr(state: tauri::State<'_, crate::state::AppState>) -> bool {
    state.hdr.load(std::sync::atomic::Ordering::Acquire)
}

/// Makes room beside the picture for a panel `width` points wide, or with 0
/// takes it away again. The window grows by that much where the screen has
/// room, so the picture stays where it is and the size it was; otherwise the
/// picture is fitted into what is left.
#[tauri::command]
#[specta::specta]
pub fn window_set_panel_width(app: AppHandle, width: Real) -> AppResult<()> {
    if !width.0.is_finite() || width.0 < 0.0 {
        return Err(AppError::Invalid(
            "a panel's width is a number that is not negative".to_owned(),
        ));
    }
    crate::set_panel_width(&app, width.0);
    Ok(())
}

/// Keeps the window above the windows of other apps, or lets it go behind
/// them again.
#[tauri::command]
#[specta::specta]
pub fn window_set_always_on_top(window: WebviewWindow, on_top: bool) -> AppResult<()> {
    Ok(window.set_always_on_top(on_top)?)
}

/// Blurs the picture beneath the interface while the command palette is
/// open over a film; the film goes on playing. CSS cannot blur the picture,
/// which is a native layer under the page.
#[tauri::command]
#[specta::specta]
pub fn window_set_backdrop_blur(state: State<'_, AppState>, on: bool) -> AppResult<()> {
    // Synchronous commands run on the main thread.
    let main = objc2::MainThreadMarker::new()
        .ok_or_else(|| AppError::Internal("blur asked for off the main thread".to_owned()))?;
    state.surface.with(main, |surface| surface.set_veiled(on));
    Ok(())
}
