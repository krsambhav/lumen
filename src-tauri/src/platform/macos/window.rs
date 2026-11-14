//! NSWindow adjustments Tauri does not expose.

use std::ptr::NonNull;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::{MainThreadMarker, Message};
use objc2_app_kit::{
    NSAnimatablePropertyContainer, NSAnimationContext, NSBackingStoreType, NSColor, NSEvent,
    NSWindow, NSWindowButton, NSWindowStyleMask,
};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use tauri::WebviewWindow;

use crate::platform::geometry::{
    fitted_frame, in_title_bar_lead,
    traffic_light_inset as traffic_light_inset_for, widened_frame, Rect,
};
use crate::{MIN_WINDOW_SIZE, TITLEBAR_HEIGHT, TITLEBAR_LEAD};

const WINDOW_BUTTONS: [NSWindowButton; 3] = [
    NSWindowButton::CloseButton,
    NSWindowButton::MiniaturizeButton,
    NSWindowButton::ZoomButton,
];

/// Seconds the traffic lights take to come back; `--dur-fast` in the design tokens.
const FADE_IN: f64 = 0.15;
/// Seconds they take to leave with the rest of the stage chrome; `--dur-leave`.
const FADE_OUT: f64 = 0.5;

fn ns_window(window: &WebviewWindow) -> Option<Retained<NSWindow>> {
    let ptr = window.ns_window().ok()?.cast::<NSWindow>();
    // SAFETY: Tauri hands out the live NSWindow backing this WebviewWindow, and
    // we retain it for as long as we use it.
    unsafe { Retained::retain(ptr) }
}

/// The NSWindow of a webview window, for other platform modules.
pub(super) fn ns_window_of(window: &WebviewWindow) -> Option<Retained<NSWindow>> {
    ns_window(window)
}

/// Runs `f` with the NSWindow on the main thread, where AppKit requires it.
fn on_main(window: &WebviewWindow, f: impl FnOnce(&NSWindow, MainThreadMarker) + Send + 'static) {
    let target = window.clone();
    let result = window.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        if let Some(ns_window) = ns_window(&target) {
            f(&ns_window, mtm);
        }
    });
    if let Err(error) = result {
        tracing::warn!(%error, "could not reach the main thread");
    }
}

/// Sets the colour behind the web view.
///
/// The web view is transparent so the video layer beneath it can show
/// through, which leaves the window's own background visible for a moment
/// while the window is resized. It therefore matches the theme's base colour
/// (`void` in dark, `bg` in light), and is always opaque, so nothing of the
/// desktop ever shows through.
pub fn set_window_background(window: &WebviewWindow, dark: bool) {
    on_main(window, move |ns_window, _| {
        let color = if dark {
            NSColor::colorWithSRGBRed_green_blue_alpha(0.016, 0.016, 0.012, 1.0)
        } else {
            NSColor::colorWithSRGBRed_green_blue_alpha(0.957, 0.957, 0.937, 1.0)
        };
        ns_window.setBackgroundColor(Some(&color));
    });
}

/// The vertical inset to give Tauri so the traffic lights are centred
/// `centre` points below the top of the window, on this version of macOS.
/// Must be called on the main thread.
///
/// The size of the buttons and where macOS puts them in the title bar have
/// both changed between versions, so they are read from a window that is
/// made for the purpose and never shown.
pub fn traffic_light_inset(centre: f64) -> f64 {
    // What macOS 26 and later need; used if the probe cannot be made.
    const FALLBACK: f64 = 24.0;
    let Some(mtm) = MainThreadMarker::new() else {
        return FALLBACK;
    };
    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable
        | NSWindowStyleMask::FullSizeContentView;
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(480.0, 320.0));
    // SAFETY: an ordinary window, created and dropped here on the main thread
    // without ever being shown or closed, so nothing else holds or frees it.
    let probe = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            mtm.alloc(),
            frame,
            style,
            NSBackingStoreType::Buffered,
            true,
        )
    };
    probe.layoutIfNeeded();
    let Some(close) = probe.standardWindowButton(NSWindowButton::CloseButton) else {
        return FALLBACK;
    };
    // In the title bar's own coordinates, whose origin is its bottom edge.
    let button = close.frame();
    if button.size.height <= 0.0 {
        return FALLBACK;
    }
    traffic_light_inset_for(
        centre,
        button.size.height,
        button.origin.y + button.size.height / 2.0,
    )
}

/// Sets the window's own title: the one the system uses in Mission Control,
/// in the Window menu and for VoiceOver. The visible one is drawn by the
/// interface.
///
/// A title change makes AppKit lay the title bar out again, so the traffic
/// lights' inset is restored with it. (Tauri's own `set_title` restores the
/// inset before that layout has happened, which does not hold.)
pub fn set_window_title(window: &WebviewWindow, title: &str) {
    let title = title.to_owned();
    on_main(window, move |ns_window, _| {
        ns_window.setTitle(&NSString::from_str(&title));
        restore_traffic_light_inset(ns_window);
    });
}

/// Puts the traffic lights back where the design has them after something
/// has made AppKit lay the title bar out again: a new title, or hiding or
/// showing the buttons. AppKit returns them to its default spot each time.
///
/// Tauri restores its inset whenever the content view is drawn, so the view
/// is marked for drawing in the same pass as the change: layout runs, then
/// drawing, and the lights are never seen in the wrong place.
fn restore_traffic_light_inset(ns_window: &NSWindow) {
    if let Some(view) = ns_window.contentView() {
        view.setNeedsDisplay(true);
    }
}

/// Fades the traffic lights in or out. Hidden buttons are also removed from
/// hit testing, so an invisible close button can never be clicked.
pub fn set_window_buttons_visible(window: &WebviewWindow, visible: bool) {
    on_main(window, move |ns_window, _| {
        let buttons: Vec<_> = WINDOW_BUTTONS
            .iter()
            .filter_map(|kind| ns_window.standardWindowButton(*kind))
            .collect();

        if visible {
            for button in &buttons {
                button.setHidden(false);
            }
        }

        let alpha = if visible { 1.0 } else { 0.0 };
        let animated = buttons.clone();
        let changes = RcBlock::new(move |context: NonNull<NSAnimationContext>| {
            // SAFETY: AppKit passes a valid context for the duration of the block.
            let context = unsafe { context.as_ref() };
            context.setDuration(if visible { FADE_IN } else { FADE_OUT });
            if !visible {
                // `--ease-leave`: the same soft curve as the bars beneath.
                let curve = objc2_quartz_core::CAMediaTimingFunction::functionWithControlPoints(
                    0.4, 0.0, 0.2, 1.0,
                );
                context.setTimingFunction(Some(&curve));
            }
            for button in &animated {
                button.animator().setAlphaValue(alpha);
            }
        });
        let window_for_block = ns_window.retain();
        let finished = RcBlock::new(move || {
            // Only hide if nothing has shown the buttons again in the meantime.
            if !visible {
                for button in &buttons {
                    if button.alphaValue() == 0.0 {
                        button.setHidden(true);
                    }
                }
                // Hiding lays the title bar out again too; keep the inset in
                // place so nothing has to move when the buttons come back.
                restore_traffic_light_inset(&window_for_block);
            }
        });
        NSAnimationContext::runAnimationGroup_completionHandler(&changes, Some(&finished));
        // Unhiding the buttons lays the title bar out again, at AppKit's
        // default spot, and so does starting to fade them, either way. The
        // inset is restored in that same pass, so the lights fade where they
        // stand instead of jumping to the corner first.
        restore_traffic_light_inset(ns_window);
    });
}

/// How often a hidden-chrome request looks again while the pointer is on
/// the traffic lights.
const POINTER_POLL: Duration = Duration::from_millis(250);

/// Fades the traffic lights out with the rest of the chrome, but never from
/// under the pointer: a button must not vanish while someone is about to
/// press it. If the pointer is on them, this waits and looks again for as
/// long as `still_wanted` says the chrome should be hidden.
///
/// The web view cannot do this itself. The lights are native buttons above
/// it, so it does not hear about a pointer that has come to rest on them.
pub fn hide_window_buttons_when_clear(
    window: &WebviewWindow,
    still_wanted: impl Fn() -> bool + Send + 'static,
) {
    // Commands that are not async run on the main thread, so the usual case,
    // a pointer somewhere else, is settled here without starting a thread.
    if MainThreadMarker::new().is_some() && !pointer_on_window_buttons(window) {
        set_window_buttons_visible(window, false);
        return;
    }
    let window = window.clone();
    std::thread::spawn(move || {
        while still_wanted() {
            let (sender, receiver) = std::sync::mpsc::channel();
            let target = window.clone();
            let asked = window.run_on_main_thread(move || {
                let _ = sender.send(pointer_on_window_buttons(&target));
            });
            if asked.is_err() {
                return;
            }
            match receiver.recv_timeout(Duration::from_secs(2)) {
                Ok(true) => std::thread::sleep(POINTER_POLL),
                Ok(false) => {
                    if still_wanted() {
                        set_window_buttons_visible(&window, false);
                    }
                    return;
                }
                Err(_) => return,
            }
        }
    });
}

/// Whether the pointer is over the corner of the window that holds the
/// traffic lights. Must be called on the main thread.
fn pointer_on_window_buttons(window: &WebviewWindow) -> bool {
    let Some(ns_window) = ns_window(window) else {
        return false;
    };
    let pointer = NSEvent::mouseLocation();
    in_title_bar_lead(
        (pointer.x, pointer.y),
        rect_of(ns_window.frame()),
        TITLEBAR_LEAD,
        TITLEBAR_HEIGHT,
    )
}

fn rect_of(rect: NSRect) -> Rect {
    Rect {
        x: rect.origin.x,
        y: rect.origin.y,
        width: rect.size.width,
        height: rect.size.height,
    }
}

/// Resizes the window, with the system's animation, so a picture of the given
/// shape fills it with no bars, and keeps that shape while the user resizes.
/// In full screen only the shape is recorded, for when the window returns.
///
/// `reserved` is the width, in points, that a panel beside the picture takes
/// of the window. The picture is fitted into the rest, and the window is left
/// free to take any shape, because "the picture's shape plus a fixed strip"
/// is not a shape AppKit can hold a window to.
pub fn fit_window_to_video(window: &WebviewWindow, width: i32, height: i32, reserved: f64) {
    on_main(window, move |ns_window, _| {
        if width <= 0 || height <= 0 {
            return;
        }
        if reserved > 0.0 {
            ns_window.setResizeIncrements(NSSize::new(1.0, 1.0));
        } else {
            ns_window.setContentAspectRatio(NSSize::new(f64::from(width), f64::from(height)));
        }
        if ns_window
            .styleMask()
            .contains(NSWindowStyleMask::FullScreen)
        {
            return;
        }
        let Some(screen) = ns_window.screen() else {
            return;
        };
        let current = rect_of(ns_window.frame());
        let visible = rect_of(screen.visibleFrame());
        // Fit the part of the window that shows the picture, then put the
        // panel's strip back beside it.
        let without = |rect: Rect| Rect {
            width: (rect.width - reserved).max(1.0),
            ..rect
        };
        let picture = fitted_frame(
            without(current),
            without(visible),
            (f64::from(width), f64::from(height)),
            MIN_WINDOW_SIZE,
        );
        let target = Rect {
            width: picture.width + reserved,
            ..picture
        };
        if target != current {
            set_frame(ns_window, target, true);
        }
    });
}

fn set_frame(ns_window: &NSWindow, frame: Rect, animate: bool) {
    let frame = NSRect::new(
        NSPoint::new(frame.x, frame.y),
        NSSize::new(frame.width, frame.height),
    );
    ns_window.setFrame_display_animate(frame, true, animate);
}

/// Readies the window for a panel `panel` points wide inside it (0 when it
/// has gone). The window keeps its frame: the panel takes its strip from
/// the picture, as in full screen. Only a window too narrow to leave the
/// picture its minimum beside the panel grows, by the shortfall. While the
/// panel is there the window is free to take any shape. Does nothing to the
/// frame in full screen.
///
/// `refit` is the shape of the picture, given when the panel has gone: the
/// window is then held to that shape again, as it was before the panel came.
///
/// `first` runs on the main thread just before the frame is set, with the
/// width the window is about to have, in points. Whatever must change with
/// the width (where the picture is kept out of) is done there, so that both
/// land in the same frame on screen.
pub fn change_window_width(
    window: &WebviewWindow,
    panel: f64,
    refit: Option<(i32, i32)>,
    first: impl FnOnce(f64) + Send + 'static,
) {
    on_main(window, move |ns_window, _| {
        let full_screen = ns_window
            .styleMask()
            .contains(NSWindowStyleMask::FullScreen);
        let current = rect_of(ns_window.frame());
        let visible = ns_window
            .screen()
            .map(|screen| rect_of(screen.visibleFrame()));
        let mut target = current;
        if panel > 0.0 {
            // No shape to hold to while the panel is there.
            ns_window.setResizeIncrements(NSSize::new(1.0, 1.0));
            let short = MIN_WINDOW_SIZE.0 + panel - current.width;
            if let (false, true, Some(visible)) = (full_screen, short > 0.0, visible) {
                target = widened_frame(current, visible, short);
            }
        }
        if let Some((width, height)) = refit.filter(|(width, height)| *width > 0 && *height > 0) {
            let shape = (f64::from(width), f64::from(height));
            ns_window.setContentAspectRatio(NSSize::new(shape.0, shape.1));
            if let (false, Some(visible)) = (full_screen, visible) {
                target = fitted_frame(target, visible, shape, MIN_WINDOW_SIZE);
            }
        }
        first(target.width);
        if target != current {
            set_frame(ns_window, target, false);
        }
    });
}

/// Lets the window be resized to any shape again (nothing is open, or what
/// is open has no picture).
pub fn release_window_aspect(window: &WebviewWindow) {
    on_main(window, |ns_window, _| {
        // Setting resize increments is how AppKit clears an aspect ratio.
        ns_window.setResizeIncrements(NSSize::new(1.0, 1.0));
    });
}

/// How much brighter than SDR white the window's display can go.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Headroom {
    /// The most the display could offer, at some brightness setting. 1.0
    /// means it cannot show HDR at all.
    pub potential: f64,
    /// What it offers right now. This rises once HDR content is on screen and
    /// changes with the brightness setting.
    pub current: f64,
}

/// Reads the display's EDR headroom. Main thread only.
pub fn display_headroom(window: &WebviewWindow, _main: MainThreadMarker) -> Option<Headroom> {
    let screen = ns_window(window)?.screen()?;
    Some(Headroom {
        potential: screen.maximumPotentialExtendedDynamicRangeColorComponentValue(),
        current: screen.maximumExtendedDynamicRangeColorComponentValue(),
    })
}

/// Where the close button sits: its left edge, and the distance from the top
/// of the window to its centre, in points. Must be called on the main thread.
#[cfg(debug_assertions)]
pub fn traffic_light_origin(window: &WebviewWindow) -> Option<(f64, f64)> {
    let ns_window = ns_window(window)?;
    let close = ns_window.standardWindowButton(NSWindowButton::CloseButton)?;
    // In window coordinates, whose origin is the bottom left corner.
    let frame = close.convertRect_toView(close.bounds(), None);
    let top = ns_window.frame().size.height - (frame.origin.y + frame.size.height / 2.0);
    Some((frame.origin.x, top))
}

/// Whether the window is on screen, and whether its close button is hidden,
/// for the development trace. Must be called on the main thread.
#[cfg(debug_assertions)]
pub fn traffic_light_state(window: &WebviewWindow) -> Option<(bool, bool, f64)> {
    let ns_window = ns_window(window)?;
    let close = ns_window.standardWindowButton(NSWindowButton::CloseButton)?;
    Some((ns_window.isVisible(), close.isHidden(), close.alphaValue()))
}
