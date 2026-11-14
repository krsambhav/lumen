//! Everything that talks to the operating system directly.
//!
//! Lumen ships for macOS only; the functions here are the seam where another
//! platform would plug in.

pub mod geometry;
#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::airplay::Host as AirPlayHost;
#[cfg(target_os = "macos")]
pub use macos::fonts::font_families;
#[cfg(all(target_os = "macos", debug_assertions))]
pub use macos::scroll::read as read_scroll;
#[cfg(target_os = "macos")]
pub use macos::scroll::{watch_scrolling, Scroll};
#[cfg(target_os = "macos")]
pub use macos::video_surface::VideoSurface;
#[cfg(target_os = "macos")]
pub use macos::web_view::tab_reaches_every_control;
#[cfg(target_os = "macos")]
pub use macos::window::{
    change_window_width, display_headroom, fit_window_to_video, hide_window_buttons_when_clear,
    release_window_aspect, set_window_background, set_window_buttons_visible, set_window_title,
    traffic_light_inset, Headroom,
};
#[cfg(all(target_os = "macos", debug_assertions))]
pub use macos::window::{traffic_light_origin, traffic_light_state};

#[cfg(not(target_os = "macos"))]
pub fn set_window_background(_window: &tauri::WebviewWindow, _dark: bool) {}

#[cfg(not(target_os = "macos"))]
pub fn set_window_buttons_visible(_window: &tauri::WebviewWindow, _visible: bool) {}

#[cfg(not(target_os = "macos"))]
pub fn tab_reaches_every_control(_window: &tauri::WebviewWindow) -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
pub fn set_window_title(window: &tauri::WebviewWindow, title: &str) {
    let _ = window.set_title(title);
}

#[cfg(not(target_os = "macos"))]
pub fn traffic_light_inset(centre: f64) -> f64 {
    centre
}

#[cfg(not(target_os = "macos"))]
pub fn hide_window_buttons_when_clear(
    _window: &tauri::WebviewWindow,
    _still_wanted: impl Fn() -> bool + Send + 'static,
) {
}
