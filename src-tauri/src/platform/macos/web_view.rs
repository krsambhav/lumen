//! WKWebView adjustments Tauri does not expose.

use std::sync::Arc;

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::NSView;
use parking_lot::Mutex;
use tauri::WebviewWindow;

/// The WKWebView behind a window. Must be called on the main thread.
pub(super) fn web_view_of(window: &WebviewWindow) -> Option<Retained<NSView>> {
    let slot: Arc<Mutex<Option<usize>>> = Arc::new(Mutex::new(None));
    let out = slot.clone();
    // On the main thread `with_webview` runs its closure before returning.
    window
        .with_webview(move |web_view| {
            *out.lock() = Some(web_view.inner() as usize);
        })
        .ok()?;
    let pointer = (*slot.lock())? as *mut NSView;
    // SAFETY: Tauri hands out its live WKWebView, which is an NSView.
    unsafe { Retained::retain(pointer) }
}

/// Lets Tab stop at every control in the page. Must be called on the main
/// thread. Returns whether the preference is now on.
///
/// WebKit follows the Keyboard navigation setting of macOS: with it off,
/// which is the default, Tab stops only at text fields and lists and passes
/// over buttons and sliders. Lumen's controls are all reachable with Tab
/// regardless (DESIGN.md §8), which is what this WebKit preference turns on.
pub fn tab_reaches_every_control(window: &WebviewWindow) -> bool {
    let Some(web_view) = web_view_of(window) else {
        return false;
    };
    // SAFETY: `web_view` is the live WKWebView and this is the main thread.
    // `configuration`, `preferences` and `tabFocusesLinks` are public WebKit
    // API (the last since macOS 10.12.3). The configuration returned is a
    // copy, but it shares the live preferences object.
    unsafe {
        let configuration: Option<Retained<AnyObject>> = msg_send![&*web_view, configuration];
        let Some(configuration) = configuration else {
            return false;
        };
        let preferences: Option<Retained<AnyObject>> = msg_send![&*configuration, preferences];
        let Some(preferences) = preferences else {
            return false;
        };
        let _: () = msg_send![&*preferences, setTabFocusesLinks: true];
        msg_send![&*preferences, tabFocusesLinks]
    }
}
