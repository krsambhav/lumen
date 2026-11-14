//! A safe handle to one libmpv player.
//!
//! This is the only module that calls the client API. Everything above it
//! (the player, the preview engine) works with `Mpv`, `Event` and plain Rust
//! values.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::ptr::{self, NonNull};

use serde_json::Value as Json;

use super::ffi;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MpvError {
    #[error("libmpv could not be created")]
    Create,
    #[error("this libmpv speaks client API {found:#x}; Lumen needs major version 2")]
    Version { found: u64 },
    /// An mpv API call failed. `what` names the call, `message` is mpv's text.
    #[error("{what}: {message}")]
    Api { what: String, message: String },
    #[error("text passed to mpv contains a NUL byte")]
    Nul,
}

pub type MpvResult<T> = Result<T, MpvError>;

impl From<std::ffi::NulError> for MpvError {
    fn from(_: std::ffi::NulError) -> Self {
        Self::Nul
    }
}

/// A property value as mpv reports it.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// The property is currently unavailable (no file, no video, ...).
    None,
    Flag(bool),
    Int(i64),
    Double(f64),
    String(String),
    /// Structured data: track lists, chapter lists, video parameters.
    Node(Json),
}

impl Value {
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Flag(flag) => Some(*flag),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Double(value) => Some(*value),
            Self::Int(value) => Some(*value as f64),
            _ => None,
        }
    }

    #[expect(dead_code, reason = "first used by playlists and chapters")]
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Int(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_node(&self) -> Option<&Json> {
        match self {
            Self::Node(node) => Some(node),
            _ => None,
        }
    }
}

/// The wire format to observe or read a property in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Flag,
    #[expect(dead_code, reason = "first used by playlists and chapters")]
    Int,
    Double,
    String,
    Node,
}

impl Format {
    fn raw(self) -> ffi::mpv_format {
        match self {
            Self::Flag => ffi::MPV_FORMAT_FLAG,
            Self::Int => ffi::MPV_FORMAT_INT64,
            Self::Double => ffi::MPV_FORMAT_DOUBLE,
            Self::String => ffi::MPV_FORMAT_STRING,
            Self::Node => ffi::MPV_FORMAT_NODE,
        }
    }
}

/// Why playback of a file stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndReason {
    /// It played to the end.
    Eof,
    /// Something told it to stop (another file was loaded, `stop`).
    Stop,
    Quit,
    /// It could not be opened or decoding failed.
    Error,
    Redirect,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// The wait timed out with nothing to report.
    None,
    Shutdown,
    StartFile,
    FileLoaded,
    EndFile {
        reason: EndReason,
        /// mpv's description of the failure when `reason` is `Error`.
        error: Option<String>,
    },
    Seek,
    PlaybackRestart,
    VideoReconfig,
    AudioReconfig,
    PropertyChange {
        id: u64,
        name: String,
        value: Value,
    },
    Log {
        /// mpv's numeric level: 10 fatal, 20 error, 30 warn, 40 info, 50 v.
        level: i32,
        prefix: String,
        text: String,
    },
    /// Events were dropped because the queue was not drained fast enough.
    QueueOverflow,
    Other,
}

pub struct Mpv {
    handle: NonNull<ffi::mpv_handle>,
}

// SAFETY: libmpv's client API is thread-safe; every function taking an
// `mpv_handle` may be called from any thread. `wait_event` alone must not run
// concurrently with itself, which `Player` guarantees by owning the one loop.
unsafe impl Send for Mpv {}
unsafe impl Sync for Mpv {}

impl Mpv {
    /// Creates and initialises a player. `options` are set before
    /// initialisation, which is the only time some of them (such as `vo`) can
    /// be set.
    pub fn new(options: &[(&str, &str)]) -> MpvResult<Self> {
        // SAFETY: plain FFI calls with no preconditions.
        // `unsigned long`, which is 64 bits on every Mac Lumen runs on.
        let version: u64 = unsafe { ffi::mpv_client_api_version() };
        if version >> 16 != 2 {
            return Err(MpvError::Version { found: version });
        }
        let handle = NonNull::new(unsafe { ffi::mpv_create() }).ok_or(MpvError::Create)?;
        let mpv = Self { handle };
        for (name, value) in options {
            let c_name = CString::new(*name)?;
            let c_value = CString::new(*value)?;
            // SAFETY: both strings are valid for the call; mpv copies them.
            let code = unsafe {
                ffi::mpv_set_option_string(mpv.as_ptr(), c_name.as_ptr(), c_value.as_ptr())
            };
            check(code, || format!("option {name}={value}"))?;
        }
        // SAFETY: the handle is valid and not yet initialised.
        check(unsafe { ffi::mpv_initialize(mpv.as_ptr()) }, || {
            "initialise".to_owned()
        })?;
        Ok(mpv)
    }

    /// The raw handle, for creating a render context.
    pub fn as_ptr(&self) -> *mut ffi::mpv_handle {
        self.handle.as_ptr()
    }

    /// Runs an mpv input command, e.g. `["seek", "10", "relative"]`.
    pub fn command(&self, args: &[&str]) -> MpvResult<()> {
        let owned: Vec<CString> = args
            .iter()
            .map(|arg| CString::new(*arg))
            .collect::<Result<_, _>>()?;
        let mut pointers: Vec<*const c_char> = owned.iter().map(|arg| arg.as_ptr()).collect();
        pointers.push(ptr::null());
        // SAFETY: `pointers` is a NULL-terminated array of valid C strings that
        // outlive the call.
        let code = unsafe { ffi::mpv_command(self.as_ptr(), pointers.as_mut_ptr()) };
        check(code, || format!("command {}", args.join(" ")))
    }

    pub fn set_flag(&self, name: &str, value: bool) -> MpvResult<()> {
        let mut raw: c_int = value.into();
        self.set_raw(name, ffi::MPV_FORMAT_FLAG, ptr::from_mut(&mut raw).cast())
    }

    pub fn set_double(&self, name: &str, value: f64) -> MpvResult<()> {
        let mut raw = value;
        self.set_raw(name, ffi::MPV_FORMAT_DOUBLE, ptr::from_mut(&mut raw).cast())
    }

    pub fn set_int(&self, name: &str, value: i64) -> MpvResult<()> {
        let mut raw = value;
        self.set_raw(name, ffi::MPV_FORMAT_INT64, ptr::from_mut(&mut raw).cast())
    }

    pub fn set_string(&self, name: &str, value: &str) -> MpvResult<()> {
        let c_name = CString::new(name)?;
        let c_value = CString::new(value)?;
        // SAFETY: both strings are valid for the call; mpv copies them.
        let code = unsafe {
            ffi::mpv_set_property_string(self.as_ptr(), c_name.as_ptr(), c_value.as_ptr())
        };
        check(code, || format!("set {name}={value}"))
    }

    fn set_raw(&self, name: &str, format: ffi::mpv_format, data: *mut c_void) -> MpvResult<()> {
        let c_name = CString::new(name)?;
        // SAFETY: `data` points to a live value of the type `format` names.
        let code = unsafe { ffi::mpv_set_property(self.as_ptr(), c_name.as_ptr(), format, data) };
        check(code, || format!("set {name}"))
    }

    /// Reads a property. An unavailable property is `Ok(Value::None)`, not an
    /// error: "no duration yet" is a normal state.
    pub fn get(&self, name: &str, format: Format) -> MpvResult<Value> {
        let c_name = CString::new(name)?;
        let mut storage = PropertyStorage::default();
        // SAFETY: `storage` is large and aligned enough for every format, and
        // mpv writes exactly the type that `format` names.
        let code = unsafe {
            ffi::mpv_get_property(
                self.as_ptr(),
                c_name.as_ptr(),
                format.raw(),
                ptr::from_mut(&mut storage).cast(),
            )
        };
        if code == MPV_ERROR_PROPERTY_UNAVAILABLE {
            return Ok(Value::None);
        }
        check(code, || format!("get {name}"))?;
        // SAFETY: the call succeeded, so `storage` holds a value of `format`.
        Ok(unsafe { storage.take(format.raw()) })
    }

    pub fn get_double(&self, name: &str) -> MpvResult<Option<f64>> {
        Ok(self.get(name, Format::Double)?.as_f64())
    }

    #[cfg_attr(not(test), expect(dead_code, reason = "used by this module's tests"))]
    pub fn get_flag(&self, name: &str) -> MpvResult<Option<bool>> {
        Ok(self.get(name, Format::Flag)?.as_bool())
    }

    pub fn get_string(&self, name: &str) -> MpvResult<Option<String>> {
        Ok(match self.get(name, Format::String)? {
            Value::String(text) => Some(text),
            _ => None,
        })
    }

    /// Asks to be told when a property changes. Changes arrive as
    /// `Event::PropertyChange` carrying `id`, starting with the current value.
    pub fn observe(&self, id: u64, name: &str, format: Format) -> MpvResult<()> {
        let c_name = CString::new(name)?;
        // SAFETY: the name is valid for the call; mpv copies it.
        let code =
            unsafe { ffi::mpv_observe_property(self.as_ptr(), id, c_name.as_ptr(), format.raw()) };
        check(code, || format!("observe {name}"))
    }

    /// Sets the least severe log level delivered as `Event::Log`:
    /// `"no"`, `"error"`, `"warn"`, `"info"`, `"v"`.
    pub fn request_log_messages(&self, level: &str) -> MpvResult<()> {
        let c_level = CString::new(level)?;
        // SAFETY: the level string is valid for the call.
        let code = unsafe { ffi::mpv_request_log_messages(self.as_ptr(), c_level.as_ptr()) };
        check(code, || format!("log level {level}"))
    }

    /// Waits up to `timeout` seconds for the next event.
    ///
    /// Must only be called from one thread at a time.
    pub fn wait_event(&self, timeout: f64) -> Event {
        // SAFETY: mpv returns a pointer to an event that stays valid until the
        // next `mpv_wait_event` on this handle; it is copied out before then.
        unsafe {
            let event = ffi::mpv_wait_event(self.as_ptr(), timeout);
            convert_event(&*event)
        }
    }

    /// Makes a blocked `wait_event` return at once.
    pub fn wakeup(&self) {
        // SAFETY: valid handle; callable from any thread.
        unsafe { ffi::mpv_wakeup(self.as_ptr()) }
    }
}

impl Drop for Mpv {
    fn drop(&mut self) {
        // SAFETY: the handle is valid and this is its last use. Any render
        // context has been freed first by its owner.
        unsafe { ffi::mpv_terminate_destroy(self.as_ptr()) }
    }
}

const MPV_ERROR_PROPERTY_UNAVAILABLE: c_int = -10;

pub(super) fn check(code: c_int, what: impl FnOnce() -> String) -> MpvResult<()> {
    if code >= 0 {
        return Ok(());
    }
    // SAFETY: mpv returns a static string for every error code.
    let message = unsafe { CStr::from_ptr(ffi::mpv_error_string(code)) }
        .to_string_lossy()
        .into_owned();
    Err(MpvError::Api {
        what: what(),
        message,
    })
}

/// Stack space mpv writes a property value into; big enough for any format.
#[repr(C)]
union PropertyStorage {
    flag: c_int,
    int64: i64,
    double: f64,
    string: *mut c_char,
    node: ffi::mpv_node,
}

impl Default for PropertyStorage {
    fn default() -> Self {
        // SAFETY: all-zero is a valid bit pattern for every variant.
        unsafe { std::mem::zeroed() }
    }
}

impl PropertyStorage {
    /// Converts what mpv wrote into an owned value and releases mpv's memory.
    ///
    /// # Safety
    /// The storage must hold a value of `format`, written by mpv.
    unsafe fn take(&mut self, format: ffi::mpv_format) -> Value {
        match format {
            ffi::MPV_FORMAT_FLAG => Value::Flag(self.flag != 0),
            ffi::MPV_FORMAT_INT64 => Value::Int(self.int64),
            ffi::MPV_FORMAT_DOUBLE => Value::Double(self.double),
            ffi::MPV_FORMAT_STRING => {
                let text = lossy(self.string);
                ffi::mpv_free(self.string.cast());
                Value::String(text)
            }
            ffi::MPV_FORMAT_NODE => {
                let json = node_to_json(&self.node);
                ffi::mpv_free_node_contents(&mut self.node);
                Value::Node(json)
            }
            _ => Value::None,
        }
    }
}

unsafe fn lossy(text: *const c_char) -> String {
    if text.is_null() {
        String::new()
    } else {
        CStr::from_ptr(text).to_string_lossy().into_owned()
    }
}

/// Copies an mpv node tree into JSON. Non-finite numbers become `null`, as
/// JSON has no way to write them.
unsafe fn node_to_json(node: &ffi::mpv_node) -> Json {
    match node.format {
        ffi::MPV_FORMAT_STRING => Json::String(lossy(node.u.string)),
        ffi::MPV_FORMAT_FLAG => Json::Bool(node.u.flag != 0),
        ffi::MPV_FORMAT_INT64 => Json::from(node.u.int64),
        ffi::MPV_FORMAT_DOUBLE => {
            serde_json::Number::from_f64(node.u.double_).map_or(Json::Null, Json::Number)
        }
        ffi::MPV_FORMAT_NODE_ARRAY => {
            let list = &*node.u.list;
            let count = usize::try_from(list.num).unwrap_or(0);
            Json::Array(
                (0..count)
                    .map(|index| node_to_json(&*list.values.add(index)))
                    .collect(),
            )
        }
        ffi::MPV_FORMAT_NODE_MAP => {
            let list = &*node.u.list;
            let count = usize::try_from(list.num).unwrap_or(0);
            Json::Object(
                (0..count)
                    .map(|index| {
                        (
                            lossy(*list.keys.add(index)),
                            node_to_json(&*list.values.add(index)),
                        )
                    })
                    .collect(),
            )
        }
        _ => Json::Null,
    }
}

/// Copies an event out of mpv's buffer.
///
/// # Safety
/// `event` must be the live result of `mpv_wait_event`.
unsafe fn convert_event(event: &ffi::mpv_event) -> Event {
    match event.event_id {
        ffi::MPV_EVENT_NONE => Event::None,
        ffi::MPV_EVENT_SHUTDOWN => Event::Shutdown,
        ffi::MPV_EVENT_START_FILE => Event::StartFile,
        ffi::MPV_EVENT_FILE_LOADED => Event::FileLoaded,
        ffi::MPV_EVENT_SEEK => Event::Seek,
        ffi::MPV_EVENT_PLAYBACK_RESTART => Event::PlaybackRestart,
        ffi::MPV_EVENT_VIDEO_RECONFIG => Event::VideoReconfig,
        ffi::MPV_EVENT_AUDIO_RECONFIG => Event::AudioReconfig,
        ffi::MPV_EVENT_QUEUE_OVERFLOW => Event::QueueOverflow,
        ffi::MPV_EVENT_END_FILE => {
            let data = &*event.data.cast::<ffi::mpv_event_end_file>();
            let reason = match data.reason {
                ffi::MPV_END_FILE_REASON_EOF => EndReason::Eof,
                ffi::MPV_END_FILE_REASON_QUIT => EndReason::Quit,
                ffi::MPV_END_FILE_REASON_ERROR => EndReason::Error,
                ffi::MPV_END_FILE_REASON_REDIRECT => EndReason::Redirect,
                _ => EndReason::Stop,
            };
            let error = (reason == EndReason::Error && data.error < 0)
                .then(|| lossy(ffi::mpv_error_string(data.error)));
            Event::EndFile { reason, error }
        }
        ffi::MPV_EVENT_PROPERTY_CHANGE => {
            let data = &*event.data.cast::<ffi::mpv_event_property>();
            let value = match data.format {
                ffi::MPV_FORMAT_FLAG => Value::Flag(*data.data.cast::<c_int>() != 0),
                ffi::MPV_FORMAT_INT64 => Value::Int(*data.data.cast::<i64>()),
                ffi::MPV_FORMAT_DOUBLE => Value::Double(*data.data.cast::<f64>()),
                ffi::MPV_FORMAT_STRING => Value::String(lossy(*data.data.cast::<*const c_char>())),
                ffi::MPV_FORMAT_NODE => Value::Node(node_to_json(&*data.data.cast())),
                _ => Value::None,
            };
            Event::PropertyChange {
                id: event.reply_userdata,
                name: lossy(data.name),
                value,
            }
        }
        ffi::MPV_EVENT_LOG_MESSAGE => {
            let data = &*event.data.cast::<ffi::mpv_event_log_message>();
            Event::Log {
                level: data.log_level,
                prefix: lossy(data.prefix),
                text: lossy(data.text).trim_end().to_owned(),
            }
        }
        _ => Event::Other,
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::engine::test_support::{headless, test_clip};

    /// Pumps events until `done` returns true, or fails after five seconds.
    fn wait_for(mpv: &Mpv, what: &str, mut done: impl FnMut(&Event) -> bool) -> Event {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            let event = mpv.wait_event(0.1);
            if done(&event) {
                return event;
            }
        }
        panic!("timed out waiting for {what}");
    }

    fn loaded() -> Mpv {
        let mpv = headless();
        mpv.set_flag("pause", true).unwrap();
        mpv.command(&["loadfile", test_clip().to_str().unwrap()])
            .unwrap();
        wait_for(&mpv, "file to load", |event| *event == Event::FileLoaded);
        mpv
    }

    #[test]
    fn rejects_an_unknown_option() {
        let error = Mpv::new(&[("no-such-option", "1")]).err().unwrap();
        assert!(matches!(error, MpvError::Api { .. }), "{error}");
    }

    #[test]
    fn rejects_text_with_a_nul_byte() {
        let mpv = headless();
        assert_eq!(mpv.command(&["loadfile", "a\0b"]), Err(MpvError::Nul));
    }

    #[test]
    fn reports_a_failed_command_with_mpvs_reason() {
        let mpv = headless();
        let error = mpv.command(&["no-such-command"]).unwrap_err();
        assert!(error.to_string().contains("no-such-command"), "{error}");
    }

    #[test]
    fn unavailable_properties_read_as_none() {
        let mpv = headless();
        assert_eq!(mpv.get_double("duration").unwrap(), None);
        assert_eq!(
            mpv.get("track-list", Format::Node)
                .unwrap()
                .as_node()
                .unwrap(),
            &Json::Array(vec![])
        );
    }

    #[test]
    fn loads_a_file_and_reads_its_properties() {
        let mpv = loaded();
        let duration = mpv.get_double("duration").unwrap().unwrap();
        assert!((duration - 2.0).abs() < 0.2, "duration {duration}");
        assert_eq!(mpv.get_flag("pause").unwrap(), Some(true));

        let tracks = mpv.get("track-list", Format::Node).unwrap();
        let tracks = tracks.as_node().unwrap().as_array().unwrap();
        let kinds: Vec<&str> = tracks
            .iter()
            .map(|track| track["type"].as_str().unwrap())
            .collect();
        assert!(
            kinds.contains(&"video") && kinds.contains(&"audio"),
            "{kinds:?}"
        );
        let video = tracks.iter().find(|t| t["type"] == "video").unwrap();
        assert_eq!(video["codec"], "mpeg4", "{video}");
        assert_eq!(video["demux-fps"], 30.0, "{video}");
        assert_eq!(video["selected"], true, "{video}");
    }

    #[test]
    fn sets_and_reads_back_every_property_type() {
        let mpv = loaded();
        mpv.set_double("volume", 42.5).unwrap();
        assert_eq!(mpv.get_double("volume").unwrap(), Some(42.5));
        mpv.set_flag("mute", true).unwrap();
        assert_eq!(mpv.get_flag("mute").unwrap(), Some(true));
        mpv.set_string("speed", "1.5").unwrap();
        assert_eq!(mpv.get_double("speed").unwrap(), Some(1.5));
        mpv.set_int("loop-file", 2).unwrap();
        assert_eq!(
            mpv.get("loop-file", Format::String).unwrap().as_str(),
            Some("2")
        );
    }

    #[test]
    fn observed_properties_report_changes_with_their_id() {
        let mpv = loaded();
        mpv.observe(7, "volume", Format::Double).unwrap();
        mpv.set_double("volume", 33.0).unwrap();
        let event = wait_for(
            &mpv,
            "volume change",
            |event| matches!(event, Event::PropertyChange { id: 7, value, .. } if value.as_f64() == Some(33.0)),
        );
        assert!(matches!(event, Event::PropertyChange { name, .. } if name == "volume"));
    }

    #[test]
    fn seeks_and_plays_to_the_end() {
        let mpv = loaded();
        mpv.command(&["seek", "1.5", "absolute+exact"]).unwrap();
        wait_for(&mpv, "seek to finish", |event| {
            *event == Event::PlaybackRestart
        });
        let position = mpv.get_double("time-pos").unwrap().unwrap();
        assert!((position - 1.5).abs() < 0.1, "position {position}");

        mpv.set_flag("pause", false).unwrap();
        let event = wait_for(&mpv, "end of file", |event| {
            matches!(event, Event::EndFile { .. })
        });
        assert_eq!(
            event,
            Event::EndFile {
                reason: EndReason::Eof,
                error: None
            }
        );
    }

    #[test]
    fn a_missing_file_ends_with_an_error() {
        let mpv = headless();
        mpv.command(&["loadfile", "/no/such/file.mkv"]).unwrap();
        let event = wait_for(&mpv, "load failure", |event| {
            matches!(event, Event::EndFile { .. })
        });
        match event {
            Event::EndFile {
                reason: EndReason::Error,
                error: Some(message),
            } => assert!(!message.is_empty()),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn wakeup_interrupts_a_wait() {
        let mpv = std::sync::Arc::new(headless());
        let waker = mpv.clone();
        let started = Instant::now();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            waker.wakeup();
        });
        // Drain start-up events, then block; the wakeup must end the wait early.
        while mpv.wait_event(0.0) != Event::None {}
        let _ = mpv.wait_event(5.0);
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
