//! The native video layer.
//!
//! Video is drawn by libmpv into a `CAOpenGLLayer` that sits *beneath* the
//! window's transparent web view, so the React interface composites over the
//! picture. Core Animation asks the layer to draw; the layer hands mpv the
//! framebuffer.
//!
//! The OpenGL context is created here, up front, and given to Core Animation
//! when it asks for one. Core Animation would otherwise create it lazily at
//! first display, which can be after a file is already loading (a file opened
//! from Finder at launch), and mpv cannot start video without its renderer.
//!
//! Threads: Core Animation calls `canDraw…`/`draw…` on the main thread while
//! the layer is synchronous (paused, idle) and on its own render thread while
//! it is asynchronous (playing). mpv calls the update callback from its own
//! threads. Every use of the render context holds the CGL context lock.
//!
//! OpenGL is deprecated on macOS but is the only GPU path libmpv's render API
//! offers there. Everything that knows about it is in this file.

#![allow(deprecated)] // CAOpenGLLayer and CGL are deprecated as a whole.

use std::cell::Cell;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::Arc;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{
    define_class, msg_send, sel, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
    NSAnimationContext, NSAppearance, NSAppearanceCustomization, NSAppearanceNameDarkAqua,
    NSAutoresizingMaskOptions, NSView, NSVisualEffectBlendingMode, NSVisualEffectMaterial,
    NSVisualEffectState, NSVisualEffectView, NSWindowOrderingMode,
};
use objc2_core_foundation::{CFRetained, CFTimeInterval, CGFloat};
use objc2_core_graphics::{CGColor, CGColorSpace};
use objc2_core_video::CVTimeStamp;
use objc2_foundation::NSObject;
use objc2_open_gl::{
    CGLChoosePixelFormat, CGLContextEnable, CGLContextObj, CGLContextParameter, CGLCreateContext,
    CGLEnable, CGLLockContext, CGLOpenGLProfile, CGLPixelFormatAttribute, CGLPixelFormatObj,
    CGLReleaseContext, CGLReleasePixelFormat, CGLRetainContext, CGLRetainPixelFormat,
    CGLSetCurrentContext, CGLSetParameter, CGLUnlockContext,
};
use objc2_quartz_core::{CAAutoresizingMask, CALayer, CAOpenGLLayer};
use parking_lot::Mutex;
use tauri::WebviewWindow;

use crate::engine::mpv::Mpv;
use crate::engine::render::RenderContext;
use crate::platform::macos::web_view::web_view_of;

type GLint = i32;

#[link(name = "OpenGL", kind = "framework")]
extern "C" {
    fn glGetIntegerv(name: u32, data: *mut GLint);
    fn glClearColor(red: f32, green: f32, blue: f32, alpha: f32);
    fn glClear(mask: u32);
    fn glFlush();
}

const GL_VIEWPORT: u32 = 0x0BA2;
const GL_DRAW_FRAMEBUFFER_BINDING: u32 = 0x8CA6;
const GL_COLOR_BUFFER_BIT: u32 = 0x4000;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGColorSpaceCreateCalibratedRGB(
        white_point: *const CGFloat,
        black_point: *const CGFloat,
        gamma: *const CGFloat,
        matrix: *const CGFloat,
    ) -> *mut CGColorSpace;
}

/// What the update callback needs, shared between mpv's threads and the layer.
struct FrameSignal {
    /// The layer is being polled every display refresh, so it will notice a
    /// new frame by itself.
    continuous: AtomicBool,
    /// Redraw even though mpv has no new frame (the layer changed size).
    force: AtomicBool,
    /// The layer to wake when it is not being polled. Null once detached.
    layer: AtomicPtr<AnyObject>,
}

struct LayerState {
    signal: Arc<FrameSignal>,
    /// mpv's renderer. Lives from the layer's creation until `detach`.
    render: Mutex<Option<RenderContext>>,
    /// The layer's own pixel format and context, retained until `detach`.
    /// Main thread only.
    pixel_format: Cell<CGLPixelFormatObj>,
    context: Cell<CGLContextObj>,
}

define_class!(
    // SAFETY:
    // - CAOpenGLLayer is designed to be subclassed by overriding these
    //   methods; no other subclassing requirement applies.
    // - `VideoLayer` does not implement `Drop`.
    #[unsafe(super(CAOpenGLLayer, CALayer, NSObject))]
    #[name = "LumenVideoLayer"]
    #[ivars = LayerState]
    struct VideoLayer;

    impl VideoLayer {
        /// Core Animation asks for a pixel format and a context; it gets the
        /// ones this layer already made. Both are returned retained, and Core
        /// Animation releases them through the default `release…` methods.
        #[unsafe(method(copyCGLPixelFormatForDisplayMask:))]
        fn copy_pixel_format(&self, _mask: u32) -> CGLPixelFormatObj {
            let format = self.ivars().pixel_format.get();
            if format.is_null() {
                return format;
            }
            // SAFETY: a live pixel format owned by this layer.
            unsafe { CGLRetainPixelFormat(format) }
        }

        #[unsafe(method(copyCGLContextForPixelFormat:))]
        fn copy_context(&self, _pixel_format: CGLPixelFormatObj) -> CGLContextObj {
            let context = self.ivars().context.get();
            if context.is_null() {
                return context;
            }
            // SAFETY: a live context owned by this layer.
            unsafe { CGLRetainContext(context) }
        }

        #[unsafe(method(canDrawInCGLContext:pixelFormat:forLayerTime:displayTime:))]
        fn can_draw(
            &self,
            _context: CGLContextObj,
            _pixel_format: CGLPixelFormatObj,
            _time: CFTimeInterval,
            _timestamp: *const CVTimeStamp,
        ) -> bool {
            let state = self.ivars();
            match state.render.lock().as_ref() {
                Some(render) => {
                    let fresh = render.frame_due();
                    let forced = state.signal.force.swap(false, Ordering::AcqRel);
                    // While synchronous, Core Animation only asks when a redraw
                    // was requested, so the answer is always yes.
                    fresh || forced || !state.signal.continuous.load(Ordering::Acquire)
                }
                None => false,
            }
        }

        #[unsafe(method(drawInCGLContext:pixelFormat:forLayerTime:displayTime:))]
        fn draw(
            &self,
            context: CGLContextObj,
            _pixel_format: CGLPixelFormatObj,
            _time: CFTimeInterval,
            _timestamp: *const CVTimeStamp,
        ) {
            let state = self.ivars();
            // SAFETY: Core Animation made `context` current for this call. The
            // lock keeps teardown on another thread from freeing the renderer
            // in the middle of a frame.
            unsafe {
                CGLLockContext(context);
                let render = state.render.lock();
                match render.as_ref() {
                    Some(render) => {
                        let mut framebuffer: GLint = 0;
                        let mut viewport: [GLint; 4] = [0; 4];
                        glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &mut framebuffer);
                        glGetIntegerv(GL_VIEWPORT, viewport.as_mut_ptr());
                        render.render(framebuffer, viewport[2], viewport[3]);
                        glFlush();
                        render.report_swap();
                    }
                    None => {
                        glClearColor(0.0, 0.0, 0.0, 1.0);
                        glClear(GL_COLOR_BUFFER_BIT);
                        glFlush();
                    }
                }
                drop(render);
                CGLUnlockContext(context);
            }
        }
    }
);

/// A float pixel format when the GPU offers one (needed for HDR), otherwise a
/// standard 8-bit one.
fn choose_pixel_format() -> CGLPixelFormatObj {
    const BASE: [u32; 5] = [
        CGLPixelFormatAttribute::CGLPFAOpenGLProfile.0,
        CGLOpenGLProfile::CGLOGLPVersion_3_2_Core.0,
        CGLPixelFormatAttribute::CGLPFAAccelerated.0,
        CGLPixelFormatAttribute::CGLPFADoubleBuffer.0,
        CGLPixelFormatAttribute::CGLPFAAllowOfflineRenderers.0,
    ];
    const FLOAT: [u32; 3] = [
        CGLPixelFormatAttribute::CGLPFAColorSize.0,
        64,
        CGLPixelFormatAttribute::CGLPFAColorFloat.0,
    ];
    const SWITCHING: u32 = CGLPixelFormatAttribute::CGLPFASupportsAutomaticGraphicsSwitching.0;

    let candidates: [Vec<u32>; 3] = [
        [&BASE[..], &FLOAT[..], &[SWITCHING, 0]].concat(),
        [&BASE[..], &[SWITCHING, 0]].concat(),
        [&BASE[..], &[0]].concat(),
    ];
    for attributes in candidates {
        let mut attributes: Vec<CGLPixelFormatAttribute> = attributes
            .into_iter()
            .map(CGLPixelFormatAttribute)
            .collect();
        let mut format: CGLPixelFormatObj = std::ptr::null_mut();
        let mut count: GLint = 0;
        // SAFETY: a zero-terminated attribute list and valid out-pointers.
        unsafe {
            CGLChoosePixelFormat(
                NonNull::new_unchecked(attributes.as_mut_ptr()),
                NonNull::from(&mut format),
                NonNull::from(&mut count),
            );
        }
        if !format.is_null() {
            return format;
        }
    }
    std::ptr::null_mut()
}

impl VideoLayer {
    /// Makes the OpenGL context, starts mpv's renderer in it, and wraps both
    /// in a layer. If any step fails the layer still exists and draws black;
    /// the failure is logged.
    fn new(mpv: Arc<Mpv>) -> Retained<Self> {
        let signal = Arc::new(FrameSignal {
            continuous: AtomicBool::new(false),
            force: AtomicBool::new(false),
            layer: AtomicPtr::new(std::ptr::null_mut()),
        });

        let pixel_format = choose_pixel_format();
        let mut context: CGLContextObj = std::ptr::null_mut();
        let mut render = None;
        if pixel_format.is_null() {
            tracing::error!("no usable OpenGL pixel format; video cannot be shown");
        } else {
            // SAFETY: `pixel_format` is valid; the context is created, made
            // current and used only on this (the main) thread here.
            unsafe {
                CGLCreateContext(
                    pixel_format,
                    std::ptr::null_mut(),
                    NonNull::from(&mut context),
                );
                if context.is_null() {
                    tracing::error!("could not create an OpenGL context; video cannot be shown");
                } else {
                    let mut vsync: GLint = 1;
                    CGLSetParameter(
                        context,
                        CGLContextParameter::CGLCPSwapInterval,
                        NonNull::from(&mut vsync),
                    );
                    // Let the GL driver do its work on a second thread.
                    CGLEnable(context, CGLContextEnable::CGLCEMPEngine);

                    CGLLockContext(context);
                    CGLSetCurrentContext(context);
                    match RenderContext::new_opengl(mpv) {
                        Ok(created) => {
                            created.set_update_callback(
                                on_mpv_update,
                                Arc::as_ptr(&signal).cast_mut().cast(),
                            );
                            render = Some(created);
                        }
                        Err(error) => {
                            tracing::error!(%error, "mpv could not start its renderer");
                        }
                    }
                    CGLSetCurrentContext(std::ptr::null_mut());
                    CGLUnlockContext(context);
                }
            }
        }

        let this = Self::alloc().set_ivars(LayerState {
            signal,
            render: Mutex::new(render),
            pixel_format: Cell::new(pixel_format),
            context: Cell::new(context),
        });
        // SAFETY: `init` is CAOpenGLLayer's designated initialiser.
        let layer: Retained<Self> = unsafe { msg_send![super(this), init] };
        layer.ivars().signal.layer.store(
            Retained::as_ptr(&layer).cast_mut().cast(),
            Ordering::Release,
        );
        layer
    }

    /// Frees mpv's renderer and then the context and pixel format. After
    /// this the layer draws nothing. Safe to call twice.
    fn release_graphics(&self) {
        let state = self.ivars();
        let context = state.context.replace(std::ptr::null_mut());
        let pixel_format = state.pixel_format.replace(std::ptr::null_mut());
        // SAFETY: both were created by this layer and are released once.
        unsafe {
            if !context.is_null() {
                CGLLockContext(context);
                CGLSetCurrentContext(context);
                if let Some(render) = state.render.lock().take() {
                    render.clear_update_callback();
                    drop(render);
                }
                CGLSetCurrentContext(std::ptr::null_mut());
                CGLUnlockContext(context);
                CGLReleaseContext(context);
            }
            if !pixel_format.is_null() {
                CGLReleasePixelFormat(pixel_format);
            }
        }
    }
}

/// mpv has a new frame, or the current one must be redrawn. Runs on mpv's
/// threads; it only flags the layer and, if nobody is polling, wakes it.
unsafe extern "C" fn on_mpv_update(context: *mut c_void) {
    let signal = &*context.cast::<FrameSignal>();
    if signal.continuous.load(Ordering::Acquire) {
        return;
    }
    let layer = signal.layer.load(Ordering::Acquire);
    if layer.is_null() {
        return;
    }
    let _: () = msg_send![
        layer,
        performSelectorOnMainThread: sel!(setNeedsDisplay),
        withObject: std::ptr::null::<AnyObject>(),
        waitUntilDone: false
    ];
}

/// The video layer and the view that hosts it. Created, used and dropped on
/// the main thread only.
pub struct VideoSurface {
    view: Retained<NSView>,
    layer: Retained<VideoLayer>,
    /// A blur of the picture, between it and the web view, shown while the
    /// command palette is open over a film. CSS cannot blur the picture: it
    /// is not in the page.
    veil: Retained<NSVisualEffectView>,
}

impl VideoSurface {
    /// Creates the surface and puts it under the window's web view.
    pub fn attach(window: &WebviewWindow, mpv: Arc<Mpv>, mtm: MainThreadMarker) -> Option<Self> {
        let web_view = web_view_of(window)?;
        // SAFETY: plain message sends to live AppKit objects on the main thread.
        let parent: Option<Retained<NSView>> = unsafe { msg_send![&*web_view, superview] };
        let parent = parent?;
        let scale = web_view
            .window()
            .map_or(2.0, |window| window.backingScaleFactor());

        let layer = VideoLayer::new(mpv);
        layer.setOpaque(true);
        layer.setAsynchronous(false);
        layer.setNeedsDisplayOnBoundsChange(true);
        layer.setContentsScale(scale);
        layer.setAutoresizingMask(
            CAAutoresizingMask::LayerWidthSizable | CAAutoresizingMask::LayerHeightSizable,
        );
        layer.setBackgroundColor(Some(&CGColor::new_generic_gray(0.0, 1.0)));
        layer.setColorspace(sdr_color_space().as_deref());

        let view = NSView::initWithFrame(NSView::alloc(mtm), parent.bounds());
        view.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        // Layer-hosting: the layer is set before the view is told to want one.
        view.setLayer(Some(&layer));
        view.setWantsLayer(true);
        parent.addSubview_positioned_relativeTo(
            &view,
            NSWindowOrderingMode::Below,
            Some(&web_view),
        );
        layer.setNeedsDisplay();

        let veil =
            NSVisualEffectView::initWithFrame(NSVisualEffectView::alloc(mtm), parent.bounds());
        veil.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        // Blurs what is beneath it in this window (the picture), not the desktop.
        veil.setBlendingMode(NSVisualEffectBlendingMode::WithinWindow);
        veil.setMaterial(NSVisualEffectMaterial::FullScreenUI);
        veil.setState(NSVisualEffectState::Active);
        if let Some(dark) = NSAppearance::appearanceNamed(unsafe { NSAppearanceNameDarkAqua }) {
            veil.setAppearance(Some(&dark));
        }
        veil.setAlphaValue(0.0);
        veil.setHidden(true);
        parent.addSubview_positioned_relativeTo(&veil, NSWindowOrderingMode::Above, Some(&view));

        Some(Self { view, layer, veil })
    }

    /// Blurs the picture (the film goes on playing beneath), or clears it.
    /// It fades over the interface's `base` duration in, `fast` out.
    pub fn set_veiled(&self, veiled: bool) {
        let veil = &self.veil;
        if veiled {
            veil.setHidden(false);
        }
        let target: CGFloat = if veiled { 1.0 } else { 0.0 };
        let duration = if veiled { 0.2 } else { 0.15 };
        let fade = block2::RcBlock::new(move |context: std::ptr::NonNull<NSAnimationContext>| {
            // SAFETY: AppKit passes a live context for the length of the block.
            unsafe { context.as_ref() }.setDuration(duration);
        });
        let animator: Retained<NSVisualEffectView> = unsafe { msg_send![veil, animator] };
        NSAnimationContext::runAnimationGroup(&fade);
        // Left in place at nothing once cleared: hiding it would cut the fade
        // short, and Core Animation draws nothing for a layer at no opacity.
        animator.setAlphaValue(target);
    }

    /// While playing, Core Animation polls the layer every display refresh;
    /// while paused or idle it is only woken when mpv asks for a redraw.
    pub fn set_playing(&self, playing: bool) {
        self.layer
            .ivars()
            .signal
            .continuous
            .store(playing, Ordering::Release);
        self.layer.setAsynchronous(playing);
        if !playing {
            self.layer.setNeedsDisplay();
        }
    }

    /// Switches the layer between standard and extended dynamic range.
    ///
    /// In HDR the layer is tagged BT.2020 with the PQ transfer and asks the
    /// system for headroom above SDR white; mpv is told separately to output
    /// PQ (see `Player::set_output_range`). In SDR it goes back to BT.709 with
    /// a 2.2 gamma.
    pub fn set_hdr(&self, hdr: bool) {
        if hdr {
            // SAFETY: a constant CFString exported by CoreGraphics.
            let name = unsafe { objc2_core_graphics::kCGColorSpaceITUR_2100_PQ };
            let space = CGColorSpace::with_name(Some(name));
            self.layer.setWantsExtendedDynamicRangeContent(true);
            self.layer.setColorspace(space.as_deref());
        } else {
            self.layer.setWantsExtendedDynamicRangeContent(false);
            self.layer.setColorspace(sdr_color_space().as_deref());
        }
        self.layer
            .ivars()
            .signal
            .force
            .store(true, Ordering::Release);
        self.layer.setNeedsDisplay();
    }

    /// The window moved to a display with a different pixel density.
    pub fn set_scale(&self, scale: f64) {
        self.layer.setContentsScale(scale);
        self.layer
            .ivars()
            .signal
            .force
            .store(true, Ordering::Release);
        self.layer.setNeedsDisplay();
    }

    /// Releases mpv's renderer and removes the layer. Must run before the
    /// player is destroyed.
    pub fn detach(self) {
        let state = self.layer.ivars();
        state
            .signal
            .layer
            .store(std::ptr::null_mut(), Ordering::Release);
        self.layer.setAsynchronous(false);
        self.layer.release_graphics();
        self.veil.removeFromSuperview();
        self.view.removeFromSuperview();
    }
}

/// How standard-dynamic-range video is tagged for the system's colour
/// management: BT.709 primaries, D65 white, and a plain 2.2 gamma.
///
/// mpv passes SDR values through unchanged, and macOS converts from this
/// space to whatever the display is, so colours are right on a wide-gamut
/// panel and midtones match what other players and browsers show.
fn sdr_color_space() -> Option<CFRetained<CGColorSpace>> {
    const WHITE_D65: [CGFloat; 3] = [0.9505, 1.0, 1.089];
    const BLACK: [CGFloat; 3] = [0.0, 0.0, 0.0];
    const GAMMA: [CGFloat; 3] = [2.2, 2.2, 2.2];
    // Columns: where red, green and blue land in XYZ.
    const BT709_TO_XYZ: [CGFloat; 9] = [
        0.4124, 0.2126, 0.0193, 0.3576, 0.7152, 0.1192, 0.1805, 0.0722, 0.9505,
    ];
    // SAFETY: four arrays of the lengths the function documents; the result
    // follows the Create rule, so ownership passes to `CFRetained`.
    unsafe {
        let space = CGColorSpaceCreateCalibratedRGB(
            WHITE_D65.as_ptr(),
            BLACK.as_ptr(),
            GAMMA.as_ptr(),
            BT709_TO_XYZ.as_ptr(),
        );
        NonNull::new(space).map(|space| CFRetained::from_raw(space))
    }
}
