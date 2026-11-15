//! Lumen's backend.
//!
//! All playback, media, casting and file work lives in this crate and is
//! exposed to the web UI as typed commands and events (see `ipc`). The UI
//! never touches an engine or the file system directly.

mod cast;
mod commands;
mod conductor;
mod db;
#[cfg(debug_assertions)]
mod devtools;
mod engine;
mod error;
mod events;
mod ipc;
mod library;
mod media;
mod menu;
mod platform;
mod playlist;
mod session;
mod settings;
mod state;
mod sync;
mod torrents;
mod updates;

use std::sync::atomic::Ordering;
use std::sync::Arc;

use objc2::MainThreadMarker;
use tauri::{
    AppHandle, LogicalPosition, Manager, RunEvent, Theme, TitleBarStyle, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_specta::Event;

use crate::conductor::{Conductor, Notice};
use crate::db::Db;
use crate::engine::player::{Output, OutputRange, Player};
use crate::engine::types::{DynamicRange, PlaybackStatus, PlayerChange};
use crate::error::{AppError, AppResult};
use crate::events::{
    CastChanged, CastFailed, DynamicRangeChanged, FullscreenChanged, HistoryChanged, MenuAction,
    PlaybackSkipped, PlayerChanged, PosterReady, QueueChanged, SubtitleSyncChanged, UpdateChanged,
};
use crate::library::posters::Posters;
use crate::platform::geometry::reserved_share;
use crate::platform::VideoSurface;
use crate::session::{Session, SessionStore};
use crate::settings::{Settings, ThemeMode};
use crate::state::{AppState, Early};

pub const MAIN_WINDOW: &str = "main";

/// The smallest the main window may be, in points (DESIGN.md §4).
pub const MIN_WINDOW_SIZE: (f64, f64) = (560.0, 360.0);

/// The height of the title bar the interface draws, in points: `--titlebar-h`
/// in the design tokens (DESIGN.md §4).
pub const TITLEBAR_HEIGHT: f64 = 44.0;

/// The traffic lights start at the stage gutter: `--gutter` in the design
/// tokens.
pub const TRAFFIC_LIGHTS_X: f64 = 20.0;

/// The width kept clear for the traffic lights at the start of the title
/// bar: `--titlebar-lead` in the design tokens.
pub const TITLEBAR_LEAD: f64 = 88.0;

/// Where the traffic lights sit: at the gutter, and centred on the title
/// bar's middle line whatever size this version of macOS draws them.
fn traffic_lights() -> LogicalPosition<f64> {
    LogicalPosition::new(
        TRAFFIC_LIGHTS_X,
        platform::traffic_light_inset(TITLEBAR_HEIGHT / 2.0),
    )
}

pub fn run() {
    init_tracing();

    let ipc = ipc::builder();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(ipc.invoke_handler())
        .setup(move |app| {
            ipc.mount_events(app);
            setup(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Lumen failed to start");

    app.run(|app, event| match event {
        // Files opened from Finder, the Dock or "Open With".
        RunEvent::Opened { urls } => {
            let sources: Vec<String> = urls
                .iter()
                .map(|url| match url.scheme() {
                    // `to_file_path` takes any address on "localhost" for a
                    // path, so only a file: URL is asked for one.
                    "file" => url
                        .to_file_path()
                        .map(|path| path.to_string_lossy().into_owned())
                        .unwrap_or_else(|()| url.to_string()),
                    _ => url.to_string(),
                })
                .collect();
            if let Some(state) = app.try_state::<AppState>() {
                if let Err(error) = state.conductor.open(&sources, true) {
                    tracing::error!(%error, ?sources, "could not open");
                }
            }
        }
        RunEvent::Exit => teardown(app),
        _ => {}
    });
}

fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_env("LUMEN_LOG").unwrap_or_else(|_| {
        EnvFilter::new(if cfg!(debug_assertions) {
            "lumen_lib=debug,mpv=warn,warn"
        } else {
            "lumen_lib=info,mpv=warn,warn"
        })
    });
    // A second initialisation (tests) is harmless.
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
}

fn setup(app: &AppHandle) -> AppResult<()> {
    let data_dir = data_dir(app)?;
    let db = Arc::new(Db::open(&data_dir.join("lumen.db"))?);
    let settings = Settings::load(&db)?.sanitised();
    let session = Arc::new(SessionStore::load(db.clone())?);
    // Playlists deleted in the last run could be brought back until now.
    if let Err(error) = playlist::saved::purge(&db) {
        tracing::warn!(%error, "could not clear out deleted playlists");
    }
    tracing::info!(dir = %data_dir.display(), "storage ready");

    let remembered = session.get();
    let window = create_main_window(app, &settings, &remembered)?;

    let player = Arc::new(Player::new(Output::Embedded, player_listener(app.clone()))?);
    // The sound is as it was left, before anything can make any.
    player.set_volume(remembered.volume)?;
    player.set_muted(remembered.muted)?;
    let conductor = Conductor::new(
        player.clone(),
        db.clone(),
        session.clone(),
        conductor_notices(app.clone()),
        Arc::new(conductor::wall_clock),
        Arc::new(media::probe::duration),
    );
    let posters = Arc::new(Posters::new(cache_dir(app)?.join("posters"), {
        let app = app.clone();
        Arc::new(move |source, url| {
            if let Err(error) = (PosterReady { source, url }).emit(&app) {
                tracing::warn!(%error, "could not say that a poster is ready");
            }
        })
    }));
    // The one folder the web view may load files from.
    if let Err(error) = app
        .asset_protocol_scope()
        .allow_directory(posters.dir(), false)
    {
        tracing::warn!(%error, "posters will not be shown");
    }
    // The speech model for syncing subtitles is kept in the real data folder
    // even by a development run that keeps its library elsewhere: it is
    // large, and the same for every library.
    let syncer = sync::Syncer::new(player.clone(), app.path().app_data_dir()?, {
        let app = app.clone();
        Arc::new(move |status| {
            if let Err(error) = SubtitleSyncChanged(status).emit(&app) {
                tracing::warn!(%error, "could not say how the subtitle sync is going");
            }
        })
    });
    app.manage(syncer);
    let caster = cast::Caster::new(
        player.clone(),
        cache_dir(app)?.join("cast"),
        Some(Arc::new(platform::AirPlayHost::new(window.clone()))),
        {
            let app = app.clone();
            Arc::new(move |snapshot| {
                if let Err(error) = CastChanged(snapshot).emit(&app) {
                    tracing::warn!(%error, "could not say how casting stands");
                }
            })
        },
        {
            let app = app.clone();
            Arc::new(move |message| {
                tracing::warn!(%message, "casting failed");
                if let Err(error) = CastFailed(message).emit(&app) {
                    tracing::warn!(%error, "could not say that casting failed");
                }
            })
        },
    );
    app.manage(caster);
    app.manage(torrents::Torrents::default());
    let updates = updates::Updates::new(app.clone(), {
        let app = app.clone();
        Arc::new(move |status| {
            if let Err(error) = UpdateChanged(status).emit(&app) {
                tracing::warn!(%error, "could not say how the update stands");
            }
        })
    });
    updates.watch();
    app.manage(updates);
    app.manage(AppState::new(
        db,
        settings.clone(),
        session,
        player.clone(),
        conductor,
        posters,
    ));
    apply_settings(app, &settings, None);

    // The menus every Mac app has, until the interface says what goes
    // between them; and word to the interface when one of its items is chosen.
    if let Err(error) = app.state::<AppState>().menu.apply(app, &[], &[]) {
        tracing::warn!(%error, "could not make the menu bar");
    }
    app.on_menu_event(|app, event| {
        if let Some(action) = event.id().as_ref().strip_prefix(menu::ACTION_PREFIX) {
            if let Err(error) = MenuAction(action.to_owned()).emit(app) {
                tracing::warn!(%error, "could not say that a menu item was chosen");
            }
        }
    });

    // `setup` runs on the main thread, which is where the layer must be made.
    let main = MainThreadMarker::new()
        .ok_or_else(|| AppError::Internal("setup is not on the main thread".to_owned()))?;
    match VideoSurface::attach(&window, player.mpv(), main) {
        Some(surface) => app.state::<AppState>().surface.set(surface, main),
        None => tracing::error!("could not attach the video layer; video will not be shown"),
    }

    // Scrolling over the picture changes the volume and seeks; the page
    // decides what was scrolled over.
    {
        let handle = app.clone();
        platform::watch_scrolling(&window, move |scroll| {
            let platform::Scroll {
                x,
                y,
                right,
                up,
                precise,
                phase,
            } = scroll;
            let _ = events::Scrolled {
                x,
                y,
                right,
                up,
                precise,
                phase,
            }
            .emit(&handle);
        });
    }

    if !platform::tab_reaches_every_control(&window) {
        tracing::warn!("Tab will follow the Keyboard navigation setting of macOS");
    }

    let handle = app.clone();
    window.on_window_event(move |event| on_window_event(&handle, event));

    #[cfg(debug_assertions)]
    devtools::install(app, &window);
    Ok(())
}

/// Receives every player change, on the player's thread.
fn player_listener(app: AppHandle) -> engine::player::ChangeListener {
    Arc::new(move |change: PlayerChange| {
        match &change {
            // A new file: whatever it is, the window may need fitting again.
            PlayerChange::Media { title, .. } => {
                if let Some(state) = app.try_state::<AppState>() {
                    *state.fitted.lock() = None;
                    // Until its own picture is known, the last one's is no guide.
                    *state.picture.lock() = None;
                }
                // The interface draws the title bar, but the system still uses
                // the window's own title: in Mission Control, in the Window
                // menu and for VoiceOver.
                if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                    platform::set_window_title(&window, title.as_deref().unwrap_or("Lumen"));
                }
            }
            // A crop changes the picture's shape, and the window follows it.
            PlayerChange::Shape { .. } => fit_window(&app),
            // Its length is the last thing needed to pick a frame for its poster.
            PlayerChange::Duration {
                seconds: Some(seconds),
            } => {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Some(source) = state.player.snapshot().source {
                        state.posters.request(&source, Some(*seconds));
                    }
                }
            }
            PlayerChange::Video { video } => {
                if let Some(state) = app.try_state::<AppState>() {
                    *state.picture.lock() = video.as_ref().map(|video| (video.width, video.height));
                }
                fit_window(&app);
                let wants_hdr = video
                    .as_ref()
                    .is_some_and(|video| video.dynamic_range != DynamicRange::Sdr);
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || update_dynamic_range(&handle, wants_hdr));
            }
            _ => {}
        }
        if let PlayerChange::Status { status } = &change {
            // The layer is polled for frames only while there are frames coming.
            let playing = matches!(status, PlaybackStatus::Playing | PlaybackStatus::Buffering);
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let (Some(main), Some(state)) =
                    (MainThreadMarker::new(), handle.try_state::<AppState>())
                {
                    state
                        .surface
                        .with(main, |surface| surface.set_playing(playing));
                }
            });
        }
        // A session on a TV follows what is open, and its tracks.
        if let Some(caster) = app.try_state::<Arc<cast::Caster>>() {
            caster.observe(&change);
        }
        // The conductor is shown everything: it keeps the history and moves
        // the queue along. It passes the change on to the interface itself,
        // before it acts on it, unless it has its own way of saying it.
        match app.try_state::<AppState>() {
            Some(state) => state
                .conductor
                .observe(&change, || tell_interface(&app, change.clone())),
            None => tell_interface(&app, change),
        }
    })
}

/// Sends a player change to the interface.
///
/// Something that happened, as opposed to a new value of the state, is said
/// once: if the interface is not listening yet it is kept until it is.
/// Everything else the interface will read as a snapshot when it starts.
fn tell_interface(app: &AppHandle, change: PlayerChange) {
    let change = if change.is_event() {
        match app.try_state::<AppState>() {
            Some(state) => match state.early.hold(Early::Player(change)) {
                Some(Early::Player(change)) => change,
                _ => return,
            },
            None => change,
        }
    } else {
        change
    };
    if let Err(error) = PlayerChanged(change).emit(app) {
        tracing::warn!(%error, "could not deliver a player change");
    }
}

/// Sends what the conductor has to say to the interface.
fn conductor_notices(app: AppHandle) -> conductor::Notify {
    Arc::new(move |notice| {
        let sent = match notice {
            Notice::Queue(queue) => QueueChanged(queue).emit(&app),
            Notice::Played => HistoryChanged.emit(&app),
            Notice::Skipped {
                source,
                title,
                reason,
            } => {
                let skipped = PlaybackSkipped {
                    source,
                    title,
                    reason,
                };
                let held = match app.try_state::<AppState>() {
                    Some(state) => state.early.hold(Early::Skipped(skipped)),
                    None => Some(Early::Skipped(skipped)),
                };
                match held {
                    Some(Early::Skipped(skipped)) => skipped.emit(&app),
                    _ => Ok(()),
                }
            }
        };
        if let Err(error) = sent {
            tracing::warn!(%error, "could not deliver a change to the queue");
        }
    })
}

/// Shapes the window to the picture as it is shown (turned and cut), once
/// per file and shape, or frees its shape when there is no picture.
fn fit_window(app: &AppHandle) {
    let (Some(state), Some(window)) = (
        app.try_state::<AppState>(),
        app.get_webview_window(MAIN_WINDOW),
    ) else {
        return;
    };
    let crop = state.player.snapshot().shape.crop;
    let size = (*state.picture.lock())
        .map(|(width, height)| engine::adjust::cropped_size(width, height, crop));
    {
        let mut fitted = state.fitted.lock();
        if *fitted == size && size.is_some() {
            return;
        }
        *fitted = size;
    }
    let reserved = state.panel.lock().wanted;
    match size {
        Some((width, height)) => platform::fit_window_to_video(&window, width, height, reserved),
        None => platform::release_window_aspect(&window),
    }
}

/// Makes room beside the picture for a panel `width` points wide, or with 0
/// takes it away again, gliding the picture to its new place over `glide_ms`.
pub(crate) fn set_panel_width(app: &AppHandle, width: f64, glide_ms: u32) {
    if let Some(state) = app.try_state::<AppState>() {
        state.panel.lock().wanted = width;
    }
    settle_panel(app, glide_ms);
}

/// Brings the picture into line with the panel that is wanted. The panel
/// lies inside the window, as in full screen: the window keeps its frame and
/// the picture is fitted into what is left, gliding there as the panel
/// slides in. Only a window too narrow to leave the picture its minimum
/// beside the panel grows, by the shortfall.
fn settle_panel(app: &AppHandle, glide_ms: u32) {
    let (Some(state), Some(window)) = (
        app.try_state::<AppState>(),
        app.get_webview_window(MAIN_WINDOW),
    ) else {
        return;
    };
    let wanted = state.panel.lock().wanted;
    // With the panel open the picture still needs its own minimum beside it.
    let _ = window.set_min_size(Some(tauri::LogicalSize::new(
        MIN_WINDOW_SIZE.0 + wanted,
        MIN_WINDOW_SIZE.1,
    )));
    // The panel has gone: the window is held to the picture's shape again.
    let refit = (*state.fitted.lock()).filter(|_| wanted == 0.0);
    let handle = app.clone();
    platform::change_window_width(&window, wanted, refit, move |width| {
        if let Some(state) = handle.try_state::<AppState>() {
            state.panel.lock().window_width = width;
        }
        glide_panel(&handle, wanted, glide_ms);
    });
}

/// How often the picture's margin is moved while it glides.
const GLIDE_STEP: std::time::Duration = std::time::Duration::from_millis(8);

/// The interface's `--ease-out`, cubic-bezier(0.25, 1, 0.5, 1), is close to
/// a quartic ease-out; the picture follows the panel on the same curve.
fn ease_out(t: f64) -> f64 {
    1.0 - (1.0 - t).powi(4)
}

/// Moves the strip the picture is kept out of from where it is to `to`
/// points wide over `glide_ms`, on the interface's curve, so the picture
/// shrinks and grows with the panel instead of jumping. A later glide, or
/// none at all (0 ms), takes over at once.
fn glide_panel(app: &AppHandle, to: f64, glide_ms: u32) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let (generation, from) = {
        let mut panel = state.panel.lock();
        panel.glide += 1;
        (panel.glide, panel.shown)
    };
    let total = std::time::Duration::from_millis(u64::from(glide_ms));
    let handle = app.clone();
    let step = move |t: f64| -> bool {
        let Some(state) = handle.try_state::<AppState>() else {
            return false;
        };
        let width = {
            let mut panel = state.panel.lock();
            if panel.glide != generation {
                return false;
            }
            panel.shown = from + (to - from) * ease_out(t);
            reserved_share(panel.shown, panel.window_width)
        };
        if let Err(error) = state.player.set_right_margin(width) {
            tracing::warn!(%error, "could not move the picture for the panel");
            return false;
        }
        true
    };
    if total.is_zero() || (to - from).abs() < 0.5 {
        step(1.0);
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("panel-glide".to_owned())
        .spawn(move || {
            let start = std::time::Instant::now();
            loop {
                let t = (start.elapsed().as_secs_f64() / total.as_secs_f64()).min(1.0);
                if !step(t) || t >= 1.0 {
                    return;
                }
                std::thread::sleep(GLIDE_STEP);
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(%error, "could not glide the picture");
    }
}

/// The luminance, in nits of the PQ signal, that macOS shows at SDR white.
/// PQ levels above it use the display's headroom.
const PQ_NITS_AT_SDR_WHITE: f64 = 100.0;

/// How often the display's headroom is re-read while HDR is showing. It
/// changes with the brightness keys and when the window changes display.
const HEADROOM_POLL: std::time::Duration = std::time::Duration::from_millis(500);

/// Puts the layer and mpv into HDR when the video is HDR and the window's
/// display can show it, and back to SDR otherwise. Main thread only.
fn update_dynamic_range(app: &AppHandle, wants_hdr: bool) {
    let (Some(main), Some(state), Some(window)) = (
        MainThreadMarker::new(),
        app.try_state::<AppState>(),
        app.get_webview_window(MAIN_WINDOW),
    ) else {
        return;
    };
    let headroom = platform::display_headroom(&window, main);
    let hdr = wants_hdr && headroom.is_some_and(|headroom| headroom.potential > 1.0);
    let was_hdr = state.hdr.swap(hdr, Ordering::AcqRel);
    if hdr == was_hdr && !hdr {
        return;
    }
    if hdr != was_hdr {
        state.surface.with(main, |surface| surface.set_hdr(hdr));
        tracing::info!(hdr, ?headroom, "dynamic range changed");
        let _ = DynamicRangeChanged(hdr).emit(app);
    }
    let range = match (hdr, headroom) {
        (true, Some(headroom)) => OutputRange::Hdr {
            peak_nits: peak_for(headroom),
        },
        _ => OutputRange::Sdr,
    };
    if let Err(error) = state.player.set_output_range(range) {
        tracing::warn!(%error, "could not set the output range");
    }
    if hdr && !was_hdr {
        watch_headroom(app, state.hdr_generation.fetch_add(1, Ordering::AcqRel) + 1);
    }
}

/// The brightest PQ level to tone-map to. Before the system has raised the
/// display's headroom for the new HDR content, the current value still reads
/// 1.0; the potential value stands in until it moves.
fn peak_for(headroom: platform::Headroom) -> f64 {
    let usable = if headroom.current > 1.05 {
        headroom.current
    } else {
        headroom.potential
    };
    PQ_NITS_AT_SDR_WHITE * usable
}

/// Follows the display's headroom for as long as this HDR session lasts.
fn watch_headroom(app: &AppHandle, generation: u64) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(HEADROOM_POLL);
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        if !state.hdr.load(Ordering::Acquire)
            || state.hdr_generation.load(Ordering::Acquire) != generation
        {
            return;
        }
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || update_dynamic_range(&handle, true));
    });
}

fn on_window_event(app: &AppHandle, event: &WindowEvent) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    match event {
        // When macOS switches appearance and the theme follows the system, the
        // colour behind the web view has to follow too.
        WindowEvent::ThemeChanged(_) => {
            let settings = state.settings.read().clone();
            apply_appearance(app, &settings);
        }
        WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
            if let Some(main) = MainThreadMarker::new() {
                state
                    .surface
                    .with(main, |surface| surface.set_scale(*scale_factor));
            }
            // A different display may or may not be able to show HDR.
            let wants_hdr = state
                .player
                .snapshot()
                .video
                .is_some_and(|video| video.dynamic_range != DynamicRange::Sdr);
            update_dynamic_range(app, wants_hdr);
        }
        // Entering and leaving full screen arrive as resizes.
        WindowEvent::Resized(_) => {
            let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
                return;
            };
            let fullscreen = window.is_fullscreen().unwrap_or(false);
            let changed = state.fullscreen.swap(fullscreen, Ordering::AcqRel) != fullscreen;
            if changed {
                let _ = FullscreenChanged(fullscreen).emit(app);
            }
            // The panel keeps its width; its share of the window changes.
            let width = window
                .inner_size()
                .ok()
                .zip(window.scale_factor().ok())
                .map_or(0.0, |(size, scale)| f64::from(size.width) / scale);
            let shown = {
                let mut panel = state.panel.lock();
                panel.window_width = width;
                panel.shown
            };
            if shown > 0.0 {
                let _ = state.player.set_right_margin(reserved_share(shown, width));
            }
        }
        _ => {}
    }
}

/// Releases the renderer before the process ends. Runs on the main thread.
fn teardown(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    // A TV is let go of before the player goes.
    if let Some(caster) = app.try_state::<Arc<cast::Caster>>() {
        caster.shutdown();
    }
    // Where playback was is written down before the player goes.
    state.conductor.shutdown();
    state.player.shutdown();
    if let Some(main) = MainThreadMarker::new() {
        if let Some(surface) = state.surface.take(main) {
            surface.detach();
        }
    }
}

/// True when a development run is only photographing the window; it must
/// then not take keyboard focus from whatever the developer is doing.
pub(crate) fn is_headless_run() -> bool {
    cfg!(debug_assertions) && std::env::var_os("LUMEN_SHOT").is_some()
}

/// Where the database and caches live. Debug builds honour `LUMEN_DATA_DIR`
/// so development runs can stay away from the real library.
fn data_dir(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("LUMEN_DATA_DIR") {
        return Ok(dir.into());
    }
    Ok(app.path().app_data_dir()?)
}

/// Where things that can be made again are kept. Debug builds that keep
/// their data elsewhere keep these with it.
fn cache_dir(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("LUMEN_DATA_DIR") {
        return Ok(std::path::PathBuf::from(dir).join("cache"));
    }
    Ok(app.path().app_cache_dir()?)
}

fn create_main_window(
    app: &AppHandle,
    settings: &Settings,
    session: &Session,
) -> AppResult<WebviewWindow> {
    // The settings and how things were left travel with the page, so the
    // first paint already has the right theme, accent and layout.
    let boot = serde_json::json!({ "settings": settings, "session": session });
    #[allow(unused_mut)]
    let mut init = format!("window.__LUMEN_BOOT__ = {boot};");
    #[cfg(debug_assertions)]
    init.push_str(&devtools::init_script());
    let window = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::default())
        .title("Lumen")
        .inner_size(1120.0, 680.0)
        .min_inner_size(MIN_WINDOW_SIZE.0, MIN_WINDOW_SIZE.1)
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(traffic_lights())
        .transparent(true)
        .accept_first_mouse(true)
        .visible(false)
        .initialization_script(init)
        .build()?;
    Ok(window)
}

/// Applies the parts of the settings that the native side owns: how the
/// window looks, and everything the player is told about picture, sound
/// and subtitles.
///
/// `before` is what the settings were, when they have just changed: only
/// what differs is applied then. A scale being dragged changes one value
/// many times a second, and the player should hear about that value alone.
pub(crate) fn apply_settings(app: &AppHandle, settings: &Settings, before: Option<&Settings>) {
    if before.is_none_or(|before| before.appearance != settings.appearance) {
        apply_appearance(app, settings);
    }
    // Asked to look for updates by itself from now on: it looks now.
    if before.is_some_and(|before| !before.general.check_for_updates)
        && settings.general.check_for_updates
    {
        if let Some(updates) = app.try_state::<Arc<updates::Updates>>() {
            updates.look_soon();
        }
    }
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    state.conductor.set_incognito(settings.general.incognito);
    let player = &state.player;
    let changed = |same: fn(&Settings, &Settings) -> bool| {
        before.is_none_or(|before| !same(before, settings))
    };
    if changed(|a, b| a.video.picture == b.video.picture) {
        player.apply_picture(&settings.video.picture);
    }
    let audio = &settings.audio;
    if changed(|a, b| {
        (&a.audio.device, a.audio.channels, a.audio.passthrough)
            == (&b.audio.device, b.audio.channels, b.audio.passthrough)
    }) {
        player.apply_output(audio.device.as_deref(), audio.channels, audio.passthrough);
    }
    // Sound that is handed on undecoded cannot be equalised: see there.
    if changed(|a, b| {
        a.audio.equaliser == b.audio.equaliser && a.audio.passthrough == b.audio.passthrough
    }) {
        player.apply_equaliser(&audio.equaliser, audio.passthrough);
    }
    if changed(|a, b| a.audio.visualiser == b.audio.visualiser) {
        player.set_visualiser(audio.visualiser);
    }
    if changed(|a, b| a.subtitles.style == b.subtitles.style) {
        player.apply_subtitle_style(&settings.subtitles.style);
    }
}

/// Makes the window's own parts match the theme.
fn apply_appearance(app: &AppHandle, settings: &Settings) {
    let theme = match settings.appearance.theme {
        ThemeMode::System => None,
        ThemeMode::Dark => Some(Theme::Dark),
        ThemeMode::Light => Some(Theme::Light),
    };
    // Sets NSApp.appearance, so menus, scroll bars and the traffic lights
    // match the web UI.
    app.set_theme(theme);

    for window in app.webview_windows().values() {
        let dark = match settings.appearance.theme {
            ThemeMode::Dark => true,
            ThemeMode::Light => false,
            ThemeMode::System => !matches!(window.theme(), Ok(Theme::Light)),
        };
        platform::set_window_background(window, dark);
    }
}
