//! libmpv's render API: mpv draws each frame into an OpenGL framebuffer that
//! the host provides.

use std::ffi::{c_char, c_int, c_void};
use std::ptr::{self, NonNull};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::ffi;
use super::mpv::{check, Mpv, MpvResult};

/// Called by mpv, from any of its threads, when a new frame is ready or the
/// current one needs redrawing. It must return quickly and must not call back
/// into mpv.
pub type UpdateCallback = unsafe extern "C" fn(context: *mut c_void);

pub struct RenderContext {
    raw: NonNull<ffi::mpv_render_context>,
    /// The player must outlive its render context.
    mpv: Arc<Mpv>,
    /// mpv said a new frame is coming and it has not been drawn yet.
    /// `mpv_render_context_update` reports that only once, and a frame is
    /// not drawn until it is due, so it is remembered here.
    pending: AtomicBool,
}

/// How early a frame may be shown: half a refresh at 60 Hz. Core Animation
/// asks once a refresh, so a frame goes up at the refresh nearest its time.
const EARLY_NS: i64 = 8_000_000;

// SAFETY: a render context may be used from any thread as long as its OpenGL
// context is current there and calls do not overlap; the video layer holds
// the CGL context lock around every use.
unsafe impl Send for RenderContext {}

impl RenderContext {
    /// Creates a render context that draws with OpenGL.
    ///
    /// # Safety
    /// The OpenGL context that all later rendering will use must be current
    /// on the calling thread.
    pub unsafe fn new_opengl(mpv: Arc<Mpv>) -> MpvResult<Self> {
        let mut init = ffi::mpv_opengl_init_params {
            get_proc_address: Some(get_proc_address),
            get_proc_address_ctx: ptr::null_mut(),
        };
        let mut params = [
            ffi::mpv_render_param {
                kind: ffi::MPV_RENDER_PARAM_API_TYPE,
                data: ffi::MPV_RENDER_API_TYPE_OPENGL.as_ptr().cast_mut().cast(),
            },
            ffi::mpv_render_param {
                kind: ffi::MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
                data: ptr::from_mut(&mut init).cast(),
            },
            END,
        ];
        let mut raw = ptr::null_mut();
        check(
            ffi::mpv_render_context_create(&mut raw, mpv.as_ptr(), params.as_mut_ptr()),
            || "create render context".to_owned(),
        )?;
        let raw = NonNull::new(raw).expect("mpv reported success without a render context");
        Ok(Self {
            raw,
            mpv,
            pending: AtomicBool::new(false),
        })
    }

    /// Registers the function mpv calls when there is something new to draw.
    ///
    /// # Safety
    /// `context` must stay valid until the callback is cleared or this render
    /// context is dropped.
    pub unsafe fn set_update_callback(&self, callback: UpdateCallback, context: *mut c_void) {
        ffi::mpv_render_context_set_update_callback(self.raw.as_ptr(), Some(callback), context);
    }

    pub fn clear_update_callback(&self) {
        // SAFETY: valid context; a null callback is allowed.
        unsafe {
            ffi::mpv_render_context_set_update_callback(self.raw.as_ptr(), None, ptr::null_mut());
        }
    }

    /// True when mpv has a new video frame and it is time to show it.
    ///
    /// Frames are drawn without waiting (see `render`), so the waiting is
    /// done here instead: a frame that is not yet due is left for a later
    /// refresh. Waiting inside the draw would hold up Core Animation, and
    /// with it everything drawn over the picture.
    pub fn frame_due(&self) -> bool {
        // SAFETY: valid context.
        let flags = unsafe { ffi::mpv_render_context_update(self.raw.as_ptr()) };
        if flags & ffi::MPV_RENDER_UPDATE_FRAME != 0 {
            self.pending.store(true, Ordering::Release);
        }
        if !self.pending.load(Ordering::Acquire) {
            return false;
        }
        let mut info = ffi::mpv_render_frame_info::default();
        let param = ffi::mpv_render_param {
            kind: ffi::MPV_RENDER_PARAM_NEXT_FRAME_INFO,
            data: ptr::from_mut(&mut info).cast(),
        };
        // SAFETY: valid context; `info` outlives the call.
        if unsafe { ffi::mpv_render_context_get_info(self.raw.as_ptr(), param) } < 0 {
            return true;
        }
        if info.flags & ffi::MPV_RENDER_FRAME_INFO_PRESENT == 0 {
            // Nothing new after all; drawing would only repeat the last frame.
            self.pending.store(false, Ordering::Release);
            return false;
        }
        if info.flags & ffi::MPV_RENDER_FRAME_INFO_REDRAW != 0 || info.target_time <= 0 {
            return true;
        }
        // SAFETY: the player's handle is alive for as long as `self`.
        let now = unsafe { ffi::mpv_get_time_ns(self.mpv.as_ptr()) };
        info.target_time <= now + EARLY_NS
    }

    /// Draws the current frame into `framebuffer`, which is `width` by
    /// `height` device pixels with its origin at the bottom left.
    ///
    /// # Safety
    /// The OpenGL context this render context was created with must be
    /// current, and `framebuffer` must be a complete framebuffer in it.
    pub unsafe fn render(&self, framebuffer: c_int, width: c_int, height: c_int) {
        let mut target = ffi::mpv_opengl_fbo {
            fbo: framebuffer,
            w: width,
            h: height,
            internal_format: 0,
        };
        // mpv's rows run top to bottom; OpenGL framebuffers run bottom to top.
        let mut flip: c_int = 1;
        // Never wait for the frame's time in here: `frame_due` already did.
        let mut block: c_int = 0;
        let mut params = [
            ffi::mpv_render_param {
                kind: ffi::MPV_RENDER_PARAM_OPENGL_FBO,
                data: ptr::from_mut(&mut target).cast(),
            },
            ffi::mpv_render_param {
                kind: ffi::MPV_RENDER_PARAM_FLIP_Y,
                data: ptr::from_mut(&mut flip).cast(),
            },
            ffi::mpv_render_param {
                kind: ffi::MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME,
                data: ptr::from_mut(&mut block).cast(),
            },
            END,
        ];
        self.pending.store(false, Ordering::Release);
        let code = ffi::mpv_render_context_render(self.raw.as_ptr(), params.as_mut_ptr());
        if code < 0 {
            tracing::warn!(code, "mpv failed to render a frame");
        }
    }

    /// Tells mpv the frame it just rendered has reached the screen, which it
    /// uses for frame timing.
    pub fn report_swap(&self) {
        // SAFETY: valid context.
        unsafe { ffi::mpv_render_context_report_swap(self.raw.as_ptr()) }
    }
}

impl Drop for RenderContext {
    /// The owner must make the OpenGL context current before dropping.
    fn drop(&mut self) {
        // SAFETY: valid context, freed exactly once.
        unsafe { ffi::mpv_render_context_free(self.raw.as_ptr()) }
    }
}

const END: ffi::mpv_render_param = ffi::mpv_render_param {
    kind: ffi::MPV_RENDER_PARAM_INVALID,
    data: ptr::null_mut(),
};

/// mpv resolves OpenGL functions through this. The OpenGL framework is linked
/// into the process, so the dynamic loader can find every entry point.
unsafe extern "C" fn get_proc_address(_context: *mut c_void, name: *const c_char) -> *mut c_void {
    libc::dlsym(libc::RTLD_DEFAULT, name)
}
