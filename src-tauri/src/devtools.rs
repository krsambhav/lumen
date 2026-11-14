//! Development aids. Compiled into debug builds only.
//!
//! `LUMEN_SHOT=/path/out.png` makes the app photograph its own main window
//! and quit, so a change can be checked against the real web view and the
//! real video layer. It needs the launching terminal to hold the Screen
//! Recording permission:
//!
//! ```sh
//! LUMEN_SHOT=/tmp/shot.png LUMEN_SHOT_EVAL="document.documentElement.dataset.theme='light'" \
//!   src-tauri/target/debug/lumen
//! ```
//!
//! - `LUMEN_OPEN`       What to open once the window is up: files, folders or addresses, one per
//!   line (works without `LUMEN_SHOT`).
//! - `LUMEN_SHOT_HASH`  URL fragment to open, e.g. `gallery` for the component gallery.
//! - `LUMEN_SHOT_EVAL`  JavaScript to run in the page before the photograph.
//! - `LUMEN_SHOT_SCROLL` A trackpad gesture to make over the middle of the window after that
//!   script, as `DX,DY`: the points a scroll event reports in all, e.g. `0,42`. The glide macOS
//!   adds once the fingers have lifted follows it, three times as far, which the app must ignore.
//! - `LUMEN_SHOT_MENU`  An item of the menu bar to choose after that script, as the titles on the
//!   way to it: `Playback>Repeat>All`. It is chosen the way a click chooses it.
//! - `LUMEN_SHOT_DELAY` Milliseconds to wait after that script (default 700).
//! - `LUMEN_SHOT_SIZE`  Window size as `WIDTHxHEIGHT` in points.
//! - `LUMEN_SHOT_VERBOSE` Says more as it goes: each synthetic scroll event, and where the
//!   traffic lights are every time they move, are hidden or are shown, with the time. The
//!   last line about them only says where they ended up; this says what put them there.
//!
//! Each run also prints, to standard error: how playback is going, the menu
//! bar as macOS has it, and where the traffic lights are. A script can add a
//! line of its own, which is how it reports what it measured in the page:
//!
//! ```js
//! window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "devtools-say", payload: "…" })
//! ```

use std::path::{Path, PathBuf};
use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{msg_send, sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSMenu, NSScreen, NSWindow};
use objc2_core_foundation::CGPoint;
use objc2_core_graphics::{CGEvent, CGEventField, CGScrollEventUnit};
use tauri::{AppHandle, LogicalSize, WebviewWindow};

/// Time for the page to load and paint before any script runs.
const SETTLE: Duration = Duration::from_millis(900);

/// Script appended to the page's boot script: opens the requested fragment
/// before the app's own code reads it.
pub fn init_script() -> String {
    match std::env::var("LUMEN_SHOT_HASH") {
        Ok(hash) => format!(
            "if (!window.location.hash) window.location.hash = {};",
            serde_json::Value::String(format!("#{hash}"))
        ),
        Err(_) => String::new(),
    }
}

pub fn install(app: &AppHandle, window: &WebviewWindow) {
    if let Ok(listed) = std::env::var("LUMEN_OPEN") {
        use tauri::Manager;
        let sources: Vec<String> = listed.lines().map(str::to_owned).collect();
        if let Some(state) = app.try_state::<crate::state::AppState>() {
            if let Err(error) = state.conductor.open(&sources, true) {
                eprintln!("devtools: could not open {listed}: {error}");
            }
        }
    }
    let Some(path) = std::env::var_os("LUMEN_SHOT").map(PathBuf::from) else {
        return;
    };
    {
        use tauri::Listener;
        app.listen_any("devtools-say", |event| {
            eprintln!("devtools: page says {}", event.payload());
        });
    }
    let script = std::env::var("LUMEN_SHOT_EVAL").ok();
    let delay = std::env::var("LUMEN_SHOT_DELAY")
        .ok()
        .and_then(|value| value.parse().ok())
        .map_or(Duration::from_millis(700), Duration::from_millis);
    let gesture = std::env::var("LUMEN_SHOT_SCROLL")
        .ok()
        .and_then(|value| parse_travel(&value));
    let chosen = std::env::var("LUMEN_SHOT_MENU").ok();

    if let Some((width, height)) = std::env::var("LUMEN_SHOT_SIZE")
        .ok()
        .and_then(|value| parse_size(&value))
    {
        let _ = window.set_size(LogicalSize::new(width, height));
    }

    keep_rendering_when_covered(window);
    if std::env::var_os("LUMEN_SHOT_VERBOSE").is_some() {
        trace_traffic_lights(window);
    }

    let app = app.clone();
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SETTLE);
        if let Some(script) = script {
            if let Err(error) = window.eval(script) {
                eprintln!("devtools: script failed: {error}");
            }
        }
        if let Some((dx, dy)) = gesture {
            // Time for the script to have done what it set out to do.
            std::thread::sleep(Duration::from_millis(500));
            let over = window.clone();
            let handle = app.clone();
            let _ = window.run_on_main_thread(move || match scroll(&handle, &over, dx, dy) {
                Ok(()) => eprintln!("devtools: scrolled dx={dx} dy={dy}, then a glide"),
                Err(error) => eprintln!("devtools: could not scroll: {error}"),
            });
        }
        if let Some(path) = chosen {
            // Time for the script to have done what it set out to do, and
            // for the menu bar to have caught up with it.
            std::thread::sleep(Duration::from_millis(500));
            let _ = window.run_on_main_thread(move || match choose_from_menu_bar(&path) {
                Ok(()) => eprintln!("devtools: chose {path}"),
                Err(error) => eprintln!("devtools: could not choose {path}: {error}"),
            });
        }
        std::thread::sleep(delay);
        print_playback_stats(&app);

        let target = window.clone();
        let quitter = app.clone();
        let _ = window.run_on_main_thread(move || {
            print_menu_bar();
            print_traffic_lights(&target);
            match capture(&target, &path) {
                Ok(()) => eprintln!("devtools: saved {}", path.display()),
                Err(error) => eprintln!("devtools: capture failed: {error}"),
            }
            quitter.exit(0);
        });
    });
}

/// A window launched from a terminal opens behind whatever the developer is
/// working in, and WebKit stops animations and timers in a covered window.
/// Turning its occlusion detection off lets the page finish rendering where
/// it is, so the photograph never has to bring the window to the front.
fn keep_rendering_when_covered(window: &WebviewWindow) {
    let result = window.with_webview(|webview| {
        let web_view = webview.inner().cast::<AnyObject>();
        // SAFETY: `inner()` is the live WKWebView, and this closure runs on
        // the main thread. The selector is checked before it is sent.
        unsafe {
            let Some(web_view) = web_view.as_ref() else {
                return;
            };
            let selector = sel!(_setWindowOcclusionDetectionEnabled:);
            let responds: bool = msg_send![web_view, respondsToSelector: selector];
            if responds {
                let _: () = msg_send![web_view, _setWindowOcclusionDetectionEnabled: false];
            } else {
                eprintln!("devtools: this WebKit cannot disable occlusion detection");
            }
        }
    });
    if let Err(error) = result {
        eprintln!("devtools: could not reach the web view: {error}");
    }
}

/// Prints how playback is going: which decoder is in use and whether frames
/// are being dropped or shown late.
fn print_playback_stats(app: &AppHandle) {
    use crate::engine::mpv::Format;
    use tauri::Manager;
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return;
    };
    let mpv = state.player.mpv();
    let read = |name: &str| match mpv.get(name, Format::String) {
        Ok(value) => value.as_str().unwrap_or("-").to_owned(),
        Err(_) => "-".to_owned(),
    };
    let names = [
        "hwdec-current",
        "video-format",
        "estimated-vf-fps",
        "frame-drop-count",
        "decoder-frame-drop-count",
        "vo-delayed-frame-count",
        "mistimed-frame-count",
        "time-pos",
        "volume",
    ];
    let line: Vec<String> = names
        .iter()
        .map(|name| format!("{name}={}", read(name)))
        .collect();
    eprintln!("devtools: {}", line.join(" "));
    // What the system knows this window as (Mission Control, the Window menu).
    if let Some(window) = app.get_webview_window(crate::MAIN_WINDOW) {
        eprintln!(
            "devtools: window-title={:?}",
            window.title().unwrap_or_default()
        );
    }
}

/// Says where the traffic lights are whenever they move, with the time since
/// the app started watching: the final photograph only shows where they
/// ended up, not what put them there.
fn trace_traffic_lights(window: &WebviewWindow) {
    let window = window.clone();
    let started = std::time::Instant::now();
    let last = std::sync::Arc::new(parking_lot::Mutex::new(
        None::<(i64, i64, bool, bool, bool)>,
    ));
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(10));
        let target = window.clone();
        let last = last.clone();
        let sent = window.run_on_main_thread(move || {
            let Some((x, centre)) = crate::platform::traffic_light_origin(&target) else {
                return;
            };
            let (shown, hidden, alpha) =
                crate::platform::traffic_light_state(&target).unwrap_or((false, false, 1.0));
            let now = (
                (x * 10.0).round() as i64,
                (centre * 10.0).round() as i64,
                shown,
                hidden,
                alpha > 0.01,
            );
            let mut last = last.lock();
            if *last != Some(now) {
                *last = Some(now);
                eprintln!(
                    "devtools: +{} ms traffic-lights x={x:.1} centre-from-top={centre:.1} window-on-screen={shown} buttons-hidden={hidden} alpha={alpha:.2}",
                    started.elapsed().as_millis()
                );
            }
        });
        if sent.is_err() {
            break;
        }
    });
}

/// Where the traffic lights are, and whether that is where the design puts
/// them. Runs on the main thread, with the capture.
fn print_traffic_lights(window: &WebviewWindow) {
    let Some((x, centre)) = crate::platform::traffic_light_origin(window) else {
        return;
    };
    eprintln!("devtools: traffic-lights x={x:.1} centre-from-top={centre:.1}");
    let misplaced = (x - crate::TRAFFIC_LIGHTS_X).abs() > 0.5
        || (centre - crate::TITLEBAR_HEIGHT / 2.0).abs() > 0.5;
    if misplaced {
        eprintln!(
            "devtools: TRAFFIC LIGHTS MISPLACED: expected x={:.1} centre-from-top={:.1}",
            crate::TRAFFIC_LIGHTS_X,
            crate::TITLEBAR_HEIGHT / 2.0
        );
    }
}

fn parse_size(text: &str) -> Option<(f64, f64)> {
    let (width, height) = text.split_once('x')?;
    Some((width.parse().ok()?, height.parse().ok()?))
}

fn parse_travel(text: &str) -> Option<(i32, i32)> {
    let (dx, dy) = text.split_once(',')?;
    Some((dx.trim().parse().ok()?, dy.trim().parse().ok()?))
}

/// Makes a two-finger scroll over the middle of the window, the way AppKit
/// delivers one: fingers down, moving, lifted, and then the glide macOS adds
/// on its own. `dx` and `dy` are what the events report in all while the
/// fingers are down; the glide reports three times as much again, and none
/// of it may count.
///
/// The events are real `NSEvent`s, put on this app's own queue and nowhere
/// else, so the pointer and every other app are left alone. An event made
/// this way belongs to a window only while that window is in front; behind
/// others, where this window is photographed, the system gives it to none.
/// The app's monitor then passes it over, as it must any scroll that is not
/// over its window (`LUMEN_LOG=lumen_lib=trace` shows it doing so), and what
/// the app's own reader makes of the event is sent to the page from here.
/// Must be called on the main thread.
fn scroll(app: &AppHandle, window: &WebviewWindow, dx: i32, dy: i32) -> Result<(), String> {
    use tauri_specta::Event;

    /// How many events the fingers' travel is spread over.
    const MOVES: i32 = 6;
    // kCGScrollPhaseBegan, …Changed, …Ended.
    const BEGAN: i64 = 1;
    const CHANGED: i64 = 2;
    const ENDED: i64 = 4;
    // kCGMomentumScrollPhaseBegin, …Continue, …End.
    const GLIDE: [i64; 5] = [1, 2, 2, 2, 3];

    let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
    let ptr = window
        .ns_window()
        .map_err(|error| error.to_string())?
        .cast::<NSWindow>();
    // SAFETY: Tauri hands out the live NSWindow, and this runs on the main thread.
    let ns_window = unsafe { Retained::retain(ptr) }.ok_or("window is gone")?;
    let number = ns_window.windowNumber();

    // AppKit measures the screen from the bottom left of the first display;
    // these events are placed from its top left.
    let frame = ns_window.frame();
    let tallest = NSScreen::screens(mtm)
        .firstObject()
        .ok_or("no display")?
        .frame()
        .size
        .height;
    let on_screen = CGPoint {
        x: frame.origin.x + frame.size.width / 2.0,
        y: tallest - (frame.origin.y + frame.size.height / 2.0),
    };
    let content = ns_window
        .contentView()
        .map_or(frame.size, |view| view.bounds().size);
    let in_window = (content.width / 2.0, content.height / 2.0);
    let ns_app = NSApplication::sharedApplication(mtm);
    let verbose = std::env::var_os("LUMEN_SHOT_VERBOSE").is_some();

    let post = |x: i32, y: i32, phase: i64, glide: i64| -> Result<(), String> {
        let event = CGEvent::new_scroll_wheel_event2(None, CGScrollEventUnit::Pixel, 2, y, x, 0)
            .ok_or("no scroll event could be made")?;
        CGEvent::set_location(Some(&event), on_screen);
        for (field, value) in [
            (CGEventField::ScrollWheelEventIsContinuous, 1),
            (CGEventField::ScrollWheelEventScrollPhase, phase),
            (CGEventField::ScrollWheelEventMomentumPhase, glide),
        ] {
            CGEvent::set_integer_value_field(Some(&event), field, value);
        }
        let event = NSEvent::eventWithCGEvent(&event).ok_or("AppKit would not take the event")?;
        let ours = event.windowNumber() == number;
        let heard = crate::platform::read_scroll(&event, in_window, content.height);
        if verbose {
            eprintln!(
                "devtools: event phase={:?} glide={:?} delta=({}, {}) window={} -> {heard:?}",
                event.phase(),
                event.momentumPhase(),
                event.scrollingDeltaX(),
                event.scrollingDeltaY(),
                if ours { "ours" } else { "none" },
            );
        }
        ns_app.postEvent_atStart(&event, false);
        if !ours {
            if let Some(scroll) = heard {
                let crate::platform::Scroll {
                    x,
                    y,
                    right,
                    up,
                    precise,
                    phase,
                } = scroll;
                crate::events::Scrolled {
                    x,
                    y,
                    right,
                    up,
                    precise,
                    phase,
                }
                .emit(app)
                .map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    };

    for step in 0..MOVES {
        post(
            dx / MOVES,
            dy / MOVES,
            if step == 0 { BEGAN } else { CHANGED },
            0,
        )?;
    }
    post(0, 0, ENDED, 0)?;
    for phase in GLIDE {
        post(dx * 3 / 5, dy * 3 / 5, 0, phase)?;
    }
    Ok(())
}

/// Chooses an item of the menu bar, named by the titles on the way to it
/// ("Playback>Repeat>All"), the way a click on it would. Must be called on
/// the main thread.
fn choose_from_menu_bar(path: &str) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
    let mut menu = NSApplication::sharedApplication(mtm)
        .mainMenu()
        .ok_or("there is no menu bar")?;
    let titles: Vec<&str> = path.split('>').map(str::trim).collect();
    for (depth, title) in titles.iter().enumerate() {
        let index = menu
            .itemArray()
            .iter()
            .position(|item| item.title().to_string() == *title)
            .ok_or_else(|| format!("no item called {title:?}"))?;
        let index = isize::try_from(index).map_err(|error| error.to_string())?;
        if depth + 1 == titles.len() {
            menu.performActionForItemAtIndex(index);
            return Ok(());
        }
        menu = menu
            .itemAtIndex(index)
            .and_then(|item| item.submenu())
            .ok_or_else(|| format!("{title:?} has no menu under it"))?;
    }
    Err("no item was named".to_owned())
}

/// Prints the menu bar as macOS has it: every menu with its items, their key
/// equivalents, and which are ticked or unavailable. Must be called on the
/// main thread.
fn print_menu_bar() {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(bar) = NSApplication::sharedApplication(mtm).mainMenu() else {
        eprintln!("devtools: NO MENU BAR");
        return;
    };
    for top in bar.itemArray() {
        let Some(menu) = top.submenu() else {
            continue;
        };
        eprintln!("devtools: menu {}: {}", menu.title(), describe(&menu));
    }
}

fn describe(menu: &NSMenu) -> String {
    let items: Vec<String> = menu
        .itemArray()
        .iter()
        .map(|item| {
            if item.isSeparatorItem() {
                return "-".to_owned();
            }
            let mut text = item.title().to_string();
            if item.state() != 0 {
                text.insert_str(0, "✓ ");
            }
            let key = item.keyEquivalent().to_string();
            if !key.is_empty() {
                text.push(' ');
                text.push_str(&chord(item.keyEquivalentModifierMask(), &key));
            }
            if !item.isEnabled() {
                text.push_str(" (off)");
            }
            if let Some(inner) = item.submenu() {
                // The system fills Services itself, with whatever is installed.
                if item.title().to_string() != "Services" {
                    text.push_str(&format!(" ▸ [{}]", describe(&inner)));
                }
            }
            text
        })
        .collect();
    items.join(" | ")
}

/// A key equivalent the way the menu bar draws it.
fn chord(modifiers: NSEventModifierFlags, key: &str) -> String {
    let mut text = String::new();
    for (flag, glyph) in [
        (NSEventModifierFlags::Control, '⌃'),
        (NSEventModifierFlags::Option, '⌥'),
        (NSEventModifierFlags::Shift, '⇧'),
        (NSEventModifierFlags::Command, '⌘'),
    ] {
        if modifiers.contains(flag) {
            text.push(glyph);
        }
    }
    // An upper-case letter as a key equivalent means Shift is held.
    if key.chars().any(char::is_uppercase) && !text.contains('⇧') {
        text.push('⇧');
    }
    text.push_str(&match key {
        " " => "Space".to_owned(),
        "\u{8}" | "\u{7f}" => "⌫".to_owned(),
        "\r" => "↩".to_owned(),
        "\u{1b}" => "⎋".to_owned(),
        "\u{f700}" => "↑".to_owned(),
        "\u{f701}" => "↓".to_owned(),
        "\u{f702}" => "←".to_owned(),
        "\u{f703}" => "→".to_owned(),
        "\u{f729}" => "Home".to_owned(),
        other => other.to_uppercase(),
    });
    text
}

/// Photographs this window with the system `screencapture` tool, addressed by
/// window number so nothing else on screen is read. The result is the window
/// as composited by the window server: web view, native layers and all.
fn capture(window: &WebviewWindow, path: &Path) -> Result<(), String> {
    let ptr = window
        .ns_window()
        .map_err(|error| error.to_string())?
        .cast::<NSWindow>();
    // SAFETY: Tauri hands out the live NSWindow, and this runs on the main thread.
    let ns_window = unsafe { Retained::retain(ptr) }.ok_or("window is gone")?;
    let id = ns_window.windowNumber();

    let status = std::process::Command::new("/usr/sbin/screencapture")
        .arg("-x") // no shutter sound
        .arg("-o") // no window shadow
        .arg(format!("-l{id}"))
        .arg(path)
        .status()
        .map_err(|error| error.to_string())?;
    if !status.success() || !path.exists() {
        return Err(format!("screencapture exited with {status}"));
    }
    Ok(())
}
