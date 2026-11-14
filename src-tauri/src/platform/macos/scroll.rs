//! Scrolling over the window, heard from AppKit.
//!
//! The page gets wheel events as well, but it cannot tell fingers moving on
//! the trackpad from the glide macOS adds after they have lifted, and a
//! volume that goes on rising after the hand has left is wrong. AppKit says
//! which is which, so the gesture is read here and passed to the page with
//! the glide left out.

use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventPhase, NSWindow};
use tauri::WebviewWindow;

use crate::platform::geometry::{finger_travel, ScrollPhase};

/// One movement of a scroll gesture over the window.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Scroll {
    /// Where the pointer is, in points from the window's top-left corner.
    pub x: f64,
    pub y: f64,
    /// How far the fingers (or the wheel) moved, in points: right and up
    /// are positive, whichever way the user has scrolling set.
    pub right: f64,
    pub up: f64,
    /// From a trackpad or a mouse that reports fine movement, as opposed to
    /// a wheel that turns in notches.
    pub precise: bool,
    pub phase: ScrollPhase,
}

fn phase_of(phase: NSEventPhase) -> Option<ScrollPhase> {
    if phase.contains(NSEventPhase::Began) {
        Some(ScrollPhase::Began)
    } else if phase.contains(NSEventPhase::Ended) || phase.contains(NSEventPhase::Cancelled) {
        Some(ScrollPhase::Ended)
    } else if phase.contains(NSEventPhase::MayBegin) || phase.contains(NSEventPhase::Stationary) {
        // Fingers resting on the trackpad: nothing has moved.
        None
    } else {
        // Moving, or a wheel that has no phases at all.
        Some(ScrollPhase::Moved)
    }
}

/// What a scroll event says fingers or a wheel did, or `None` for the glide
/// macOS adds after the fingers have lifted and for fingers only resting.
/// `at` is where the pointer is in the window, from its bottom-left corner as
/// AppKit has it, and `height` is how tall the window's content is.
pub fn read(event: &NSEvent, at: (f64, f64), height: f64) -> Option<Scroll> {
    if !event.momentumPhase().is_empty() {
        return None;
    }
    let phase = phase_of(event.phase())?;
    let (right, up) = finger_travel(
        event.scrollingDeltaX(),
        event.scrollingDeltaY(),
        event.isDirectionInvertedFromDevice(),
    );
    Some(Scroll {
        x: at.0,
        // AppKit measures from the bottom; the page from the top.
        y: height - at.1,
        right,
        up,
        precise: event.hasPreciseScrollingDeltas(),
        phase,
    })
}

/// Tells `heard` about every scroll over `window` that fingers or a wheel
/// made, for as long as the app runs. Must be called on the main thread.
/// The events go on to the web view as usual: lists still scroll.
pub fn watch_scrolling(window: &WebviewWindow, heard: impl Fn(Scroll) + 'static) {
    let Some(ns_window) = window
        .ns_window()
        .ok()
        // SAFETY: Tauri hands out the live NSWindow backing this window.
        .and_then(|ptr| unsafe { Retained::retain(ptr.cast::<NSWindow>()) })
    else {
        return;
    };
    let number = ns_window.windowNumber();
    let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit passes a live event for the duration of the block.
        let scrolled = unsafe { event.as_ref() };
        let ours = scrolled.windowNumber() == number;
        tracing::trace!(window = scrolled.windowNumber(), ours, "a scroll event");
        if ours {
            let at = scrolled.locationInWindow();
            let height = ns_window
                .contentView()
                .map_or(0.0, |view| view.bounds().size.height);
            if let Some(scroll) = read(scrolled, (at.x, at.y), height) {
                heard(scroll);
            }
        }
        event.as_ptr()
    });
    // SAFETY: the block takes and returns the event AppKit gave it, on the
    // main thread, as the API requires.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::ScrollWheel, &handler)
    };
    // It is wanted for as long as the app runs; AppKit holds the block.
    std::mem::forget(monitor);
}
