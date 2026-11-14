//! AirPlay, through AVFoundation.
//!
//! macOS gives apps no list of AirPlay devices; it gives them its own picker
//! (`AVRoutePickerView`), which also asks for a TV's code or password when it
//! has one. Lumen opens that picker from its cast button, with an `AVPlayer`
//! made for the film. When a device is chosen there, AVFoundation sends the
//! film's address to the TV, which fetches it from Lumen's server and plays
//! it; the player here then only relays commands and reads back where the TV
//! is. Choosing this Mac in the picker again ends the session.
//!
//! Every AppKit and AVFoundation object lives on the main thread, in a
//! thread-local slot; the handle only sends closures there.

use std::cell::{Cell, RefCell};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSButton, NSView, NSWindowOrderingMode};
use objc2_av_foundation::{AVPlayer, AVPlayerItem, AVPlayerItemStatus, AVPlayerTimeControlStatus};
use objc2_av_kit::{AVRoutePickerView, AVRoutePickerViewDelegate};
use objc2_core_media::{CMTime, CMTimeFlags};
use objc2_foundation::{NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL};
use tauri::WebviewWindow;

use crate::cast::{
    AirPlayHost, AirPlayTarget, Anchor, CastTarget, EventSink, Loadable, RemoteState, TargetEvent,
};

/// How often the player is read back.
const POLL: Duration = Duration::from_millis(250);

/// After the picker closes with nothing chosen, how long before the session
/// is given up: a device chosen at the last moment takes a moment to report.
const CHOICE_GRACE: Duration = Duration::from_millis(1500);

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and the delegate
    // does not implement Drop.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "LumenRoutePickerDelegate"]
    #[ivars = Cell<Option<Instant>>]
    struct PickerDelegate;

    unsafe impl NSObjectProtocol for PickerDelegate {}

    unsafe impl AVRoutePickerViewDelegate for PickerDelegate {
        #[unsafe(method(routePickerViewWillBeginPresentingRoutes:))]
        fn will_present(&self, _view: &AVRoutePickerView) {
            self.ivars().set(None);
        }

        #[unsafe(method(routePickerViewDidEndPresentingRoutes:))]
        fn did_end(&self, _view: &AVRoutePickerView) {
            self.ivars().set(Some(Instant::now()));
        }
    }
);

impl PickerDelegate {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Cell::new(None));
        // SAFETY: NSObject's init on a freshly allocated object.
        unsafe { msg_send![super(this), init] }
    }
}

/// What lives on the main thread for the one AirPlay session there can be.
struct Objects {
    id: u64,
    player: Retained<AVPlayer>,
    picker: Retained<AVRoutePickerView>,
    delegate: Retained<PickerDelegate>,
    was_active: bool,
    ever_active: bool,
    said_failure: bool,
    said_finished: bool,
    volume: Option<(f32, bool)>,
}

thread_local! {
    static OBJECTS: RefCell<Option<Objects>> = const { RefCell::new(None) };
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn seconds(time: CMTime) -> Option<f64> {
    if !time.flags.contains(CMTimeFlags::Valid)
        || time
            .flags
            .intersects(CMTimeFlags::Indefinite | CMTimeFlags::PositiveInfinity)
        || time.timescale <= 0
    {
        return None;
    }
    Some(time.value as f64 / f64::from(time.timescale))
}

fn cm_time(seconds: f64) -> CMTime {
    CMTime {
        value: (seconds.max(0.0) * 1000.0).round() as i64,
        timescale: 1000,
        flags: CMTimeFlags::Valid,
        epoch: 0,
    }
}

/// The chosen device's name, where this version of macOS says it. It is
/// read through an interface Apple does not publish, so every step is asked
/// whether it is there first; without it the session is called "AirPlay".
fn device_name(player: &AVPlayer) -> Option<String> {
    fn answers(object: &AnyObject, selector: objc2::runtime::Sel) -> bool {
        // SAFETY: respondsToSelector: is defined on every NSObject.
        unsafe { msg_send![object, respondsToSelector: selector] }
    }
    let player: &AnyObject = player.as_ref();
    if !answers(player, sel!(outputContext)) {
        return None;
    }
    // SAFETY: checked just above that it answers; it returns an object or nil.
    let context: Option<Retained<AnyObject>> = unsafe { msg_send![player, outputContext] };
    let context = context?;
    let name: Option<Retained<NSString>> = if answers(&context, sel!(deviceName)) {
        // SAFETY: checked; returns an NSString or nil.
        unsafe { msg_send![&*context, deviceName] }
    } else {
        None
    };
    name.map(|name| name.to_string())
        .filter(|name| !name.is_empty())
}

/// Places the picker over the cast button and opens it.
fn present(objects: &Objects, window: &WebviewWindow, anchor: Anchor) {
    let Some(ns_window) = super::window::ns_window_of(window) else {
        return;
    };
    let Some(content) = ns_window.contentView() else {
        return;
    };
    let bounds = content.bounds();
    let height = anchor.height.0.max(1.0);
    let y = if content.isFlipped() {
        anchor.y.0
    } else {
        bounds.size.height - anchor.y.0 - height
    };
    let frame = NSRect::new(
        NSPoint::new(anchor.x.0, y),
        NSSize::new(anchor.width.0.max(1.0), height),
    );
    objects.picker.setFrame(frame);
    let view: &NSView = &objects.picker;
    // SAFETY: reading the view's parent on the main thread.
    if unsafe { view.superview() }.is_none() {
        // Beneath the page, which draws the button the user sees: the
        // picker's own button is only there to be pressed from here.
        content.addSubview_positioned_relativeTo(view, NSWindowOrderingMode::Below, None);
    }
    let button = view
        .subviews()
        .iter()
        .find_map(|sub| sub.downcast::<NSButton>().ok());
    match button {
        // SAFETY: a button of the picker's own, pressed as a click would.
        Some(button) => unsafe { button.performClick(None) },
        None => tracing::warn!("the AirPlay picker has no button to press"),
    }
}

fn with_objects<T>(id: u64, f: impl FnOnce(&mut Objects) -> T) -> Option<T> {
    OBJECTS.with(|slot| {
        slot.borrow_mut()
            .as_mut()
            .filter(|objects| objects.id == id)
            .map(f)
    })
}

pub struct AirPlay {
    id: u64,
    window: WebviewWindow,
    alive: Arc<AtomicBool>,
}

impl AirPlay {
    fn on_main(&self, f: impl FnOnce(&mut Objects, MainThreadMarker) + Send + 'static) {
        let id = self.id;
        let _ = self.window.run_on_main_thread(move || {
            if let Some(mtm) = MainThreadMarker::new() {
                with_objects(id, |objects| f(objects, mtm));
            }
        });
    }
}

impl CastTarget for AirPlay {
    fn load(&self, media: Loadable) {
        self.on_main(move |objects, mtm| {
            let Some(url) = NSURL::URLWithString(&NSString::from_str(&media.url)) else {
                return;
            };
            // SAFETY: plain AVFoundation calls on the main thread.
            unsafe {
                let item = AVPlayerItem::playerItemWithURL(&url, mtm);
                objects.player.replaceCurrentItemWithPlayerItem(Some(&item));
                if media.start > 0.0 {
                    let tolerance = cm_time(0.0);
                    objects.player.seekToTime_toleranceBefore_toleranceAfter(
                        cm_time(media.start),
                        tolerance,
                        tolerance,
                    );
                }
                if media.autoplay {
                    objects.player.play();
                }
            }
            objects.said_failure = false;
            objects.said_finished = false;
        });
    }

    fn play(&self) {
        // SAFETY: on the main thread.
        self.on_main(|objects, _| unsafe { objects.player.play() });
    }

    fn pause(&self) {
        // SAFETY: on the main thread.
        self.on_main(|objects, _| unsafe { objects.player.pause() });
    }

    fn seek(&self, at: f64) {
        self.on_main(move |objects, _| {
            let tolerance = cm_time(0.25);
            objects.said_finished = false;
            // SAFETY: on the main thread.
            unsafe {
                objects.player.seekToTime_toleranceBefore_toleranceAfter(
                    cm_time(at),
                    tolerance,
                    tolerance,
                );
            }
        });
    }

    fn set_volume(&self, level: f64) {
        // SAFETY: on the main thread.
        self.on_main(move |objects, _| unsafe {
            objects.player.setVolume(level.clamp(0.0, 1.0) as f32)
        });
    }

    fn set_muted(&self, muted: bool) {
        // SAFETY: on the main thread.
        self.on_main(move |objects, _| unsafe { objects.player.setMuted(muted) });
    }

    fn set_subtitle(&self, _id: Option<i32>) -> bool {
        // Subtitles are drawn into the picture for AirPlay.
        false
    }

    fn stop(&self) {
        self.alive.store(false, Ordering::Release);
        let id = self.id;
        let _ = self.window.run_on_main_thread(move || {
            OBJECTS.with(|slot| {
                let mut slot = slot.borrow_mut();
                if slot.as_ref().is_some_and(|objects| objects.id == id) {
                    if let Some(objects) = slot.take() {
                        // SAFETY: on the main thread; letting go of the item
                        // ends playback on the TV.
                        unsafe {
                            objects.player.pause();
                            objects.player.replaceCurrentItemWithPlayerItem(None);
                            objects.picker.setPlayer(None);
                            objects.picker.setDelegate(None);
                        }
                        objects.picker.removeFromSuperview();
                    }
                }
            });
        });
    }
}

impl AirPlayTarget for AirPlay {
    fn show_picker(&self, anchor: Anchor) {
        let window = self.window.clone();
        self.on_main(move |objects, _| present(objects, &window, anchor));
    }
}

/// Reads the player back, on the main thread. Returns false once there is
/// nothing more to read.
fn poll(id: u64, events: &EventSink) -> bool {
    let Some(said) = with_objects(id, |objects| {
        let mut said = Vec::new();
        // SAFETY: plain AVFoundation reads on the main thread.
        unsafe {
            let player = &objects.player;
            let active = player.isExternalPlaybackActive();
            if active && !objects.was_active {
                objects.ever_active = true;
                said.push(TargetEvent::Active(device_name(player)));
            }
            if !active && objects.was_active {
                // This Mac was chosen in the picker, or the TV went away.
                objects.was_active = false;
                said.push(TargetEvent::Closed(None));
                return (said, false);
            }
            objects.was_active = active;
            if !objects.ever_active {
                let closed = objects.delegate.ivars().get();
                if closed.is_some_and(|at| at.elapsed() > CHOICE_GRACE) {
                    said.push(TargetEvent::Closed(None));
                    return (said, false);
                }
                return (said, true);
            }
            if let Some(item) = player.currentItem() {
                if item.status() == AVPlayerItemStatus::Failed && !objects.said_failure {
                    objects.said_failure = true;
                    let reason = item.error().map_or_else(
                        || "it could not be played".to_owned(),
                        |error| error.localizedDescription().to_string(),
                    );
                    said.push(TargetEvent::Failed(reason));
                }
                let at = seconds(player.currentTime());
                let status = player.timeControlStatus();
                let state = if status == AVPlayerTimeControlStatus::Playing {
                    RemoteState::Playing
                } else if status == AVPlayerTimeControlStatus::WaitingToPlayAtSpecifiedRate {
                    RemoteState::Buffering
                } else {
                    RemoteState::Paused
                };
                if item.status() == AVPlayerItemStatus::ReadyToPlay {
                    said.push(TargetEvent::State { state, at });
                }
                let ended = match (at, seconds(item.duration())) {
                    (Some(at), Some(duration)) => duration > 0.0 && at >= duration - 0.4,
                    _ => false,
                };
                if ended && state == RemoteState::Paused && !objects.said_finished {
                    objects.said_finished = true;
                    said.push(TargetEvent::Finished);
                }
            }
            let volume = (player.volume(), player.isMuted());
            if objects.volume != Some(volume) {
                objects.volume = Some(volume);
                said.push(TargetEvent::Volume {
                    level: f64::from(volume.0),
                    muted: volume.1,
                });
            }
        }
        (said, true)
    }) else {
        return false;
    };
    let (events_said, go_on) = said;
    for event in events_said {
        events(event);
    }
    go_on
}

pub struct Host {
    window: WebviewWindow,
}

impl Host {
    pub fn new(window: WebviewWindow) -> Self {
        Self { window }
    }
}

impl AirPlayHost for Host {
    fn open(&self, anchor: Anchor, events: EventSink) -> Arc<dyn AirPlayTarget> {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let alive = Arc::new(AtomicBool::new(true));
        let window = self.window.clone();
        let _ = self.window.run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            // SAFETY: AVFoundation and AVKit objects made and set up on the main thread.
            let objects = unsafe {
                let player = AVPlayer::new(mtm);
                player.setAllowsExternalPlayback(true);
                player.setUsesExternalPlaybackWhileExternalScreenIsActive(true);
                let picker = AVRoutePickerView::new(mtm);
                picker.setPlayer(Some(&player));
                picker.setPrioritizesVideoDevices(true);
                let delegate = PickerDelegate::new(mtm);
                picker.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
                Objects {
                    id,
                    player,
                    picker,
                    delegate,
                    was_active: false,
                    ever_active: false,
                    said_failure: false,
                    said_finished: false,
                    volume: None,
                }
            };
            present(&objects, &window, anchor);
            OBJECTS.with(|slot| {
                if let Some(old) = slot.borrow_mut().replace(objects) {
                    old.picker.removeFromSuperview();
                }
            });
        });
        // Read the player back until the session is over.
        {
            let window = self.window.clone();
            let alive = alive.clone();
            let events = events.clone();
            tauri::async_runtime::spawn(async move {
                // The picker takes a moment to open.
                tokio::time::sleep(Duration::from_millis(300)).await;
                while alive.load(Ordering::Acquire) {
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    let events = events.clone();
                    let posted = window.run_on_main_thread(move || {
                        let _ = tx.send(poll(id, &events));
                    });
                    if posted.is_err() {
                        break;
                    }
                    match rx.await {
                        Ok(true) => {}
                        _ => break,
                    }
                    tokio::time::sleep(POLL).await;
                }
            });
        }
        Arc::new(AirPlay {
            id,
            window: self.window.clone(),
            alive,
        })
    }
}
