//! Still frames from media files, made with Lumen's own FFmpeg: posters for
//! the home screen and previews for the timeline.
//!
//! Each frame is one short run of `ffmpeg`, which is asked for the keyframe
//! at or before a time rather than the exact frame: that costs the same
//! (a few hundredths of a second) wherever in the file it is, where the
//! exact frame can mean decoding ten seconds of 4K video to reach it.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc;
use std::time::{Duration, SystemTime};

use super::tools::{self, Tool};

/// Posters are shown up to 320 px wide, on displays of twice the density.
pub const POSTER_WIDTH: u32 = 640;
/// The timeline's preview is 192 px wide (DESIGN.md §7).
pub const PREVIEW_WIDTH: u32 = 384;

/// A frame that takes longer than this is not worth having.
const PATIENCE: Duration = Duration::from_secs(6);

/// A poster this large, in bytes, has something in it. A black frame or a
/// plain title card compresses to almost nothing, so the size of the JPEG
/// tells a picture from an empty one without decoding it again.
const SOMETHING_IN_IT: usize = 12_000;

/// Where in a file to look for a poster, as shares of its length, in order.
const POSTER_PLACES: [f64; 3] = [0.1, 0.3, 0.55];

/// One frame of the video at `path` as a JPEG `width` pixels wide: the
/// keyframe at or before `seconds`, or the first frame (for a file with only
/// cover art, the cover) if no time is given. `None` if there is no picture
/// to be had.
pub fn frame(path: &Path, seconds: Option<f64>, width: u32) -> Option<Vec<u8>> {
    let mut command = tools::command(Tool::Ffmpeg)?;
    command.args(["-hide_banner", "-loglevel", "error", "-nostdin"]);
    if let Some(seconds) = seconds.filter(|seconds| seconds.is_finite() && *seconds > 0.0) {
        command
            .arg("-noaccurate_seek")
            .args(["-ss", &format!("{seconds:.3}")]);
    }
    command
        .arg("-i")
        .arg(path)
        .args(["-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn"])
        .args(["-vf", &filters(width)])
        .args(["-q:v", "4", "-f", "mjpeg", "pipe:1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let jpeg = output_within(command, PATIENCE)?;
    // Past the end of the file FFmpeg succeeds and writes nothing.
    is_jpeg(&jpeg).then_some(jpeg)
}

/// The filter chain for a frame `width` pixels wide.
///
/// The height follows the display aspect ratio, so anamorphic video comes
/// out in its real shape with square pixels. The second stage brings the
/// picture to BT.709: for standard video it has nothing to do, and for HDR it
/// tone-maps, where a plain conversion would leave the frame washed out. The
/// last gives JPEG the full-range pixels it expects.
fn filters(width: u32) -> String {
    format!(
        "scale=w={width}:h='trunc({width}/dar/2)*2',setsar=1,\
         scale=out_transfer=bt709:out_primaries=bt709:out_color_matrix=bt709:intent=perceptual,\
         format=yuvj420p"
    )
}

fn is_jpeg(bytes: &[u8]) -> bool {
    bytes.len() > 4 && bytes.starts_with(&[0xFF, 0xD8]) && bytes.ends_with(&[0xFF, 0xD9])
}

/// Runs a command and returns what it wrote, if it finished in time and
/// succeeded. A command that takes too long is killed.
fn output_within(mut command: std::process::Command, patience: Duration) -> Option<Vec<u8>> {
    let mut child = command.spawn().ok()?;
    let mut pipe = child.stdout.take()?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut written = Vec::new();
        let read = pipe.read_to_end(&mut written);
        let _ = sender.send(read.map(|_| written));
    });
    match receiver.recv_timeout(patience) {
        Ok(Ok(written)) => child.wait().ok()?.success().then_some(written),
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

/// A poster for the file at `path`, which runs `duration` seconds if that is
/// known: a frame from a tenth of the way in, or from further on if that
/// one has nothing in it.
pub fn poster(path: &Path, duration: Option<f64>) -> Option<Vec<u8>> {
    let Some(duration) = duration.filter(|seconds| seconds.is_finite() && *seconds > 1.0) else {
        return frame(path, None, POSTER_WIDTH);
    };
    let mut best: Option<Vec<u8>> = None;
    for place in POSTER_PLACES {
        let Some(candidate) = frame(path, Some(duration * place), POSTER_WIDTH) else {
            continue;
        };
        if candidate.len() >= SOMETHING_IN_IT {
            return Some(candidate);
        }
        if best
            .as_ref()
            .is_none_or(|kept| candidate.len() > kept.len())
        {
            best = Some(candidate);
        }
    }
    // A file with only cover art has one frame, at no particular time.
    best.or_else(|| frame(path, None, POSTER_WIDTH))
}

/// Posters kept on disk, one JPEG per file, named for the file's identity
/// (its path, size and modification time) so a file that is replaced gets a
/// new poster.
pub struct PosterCache {
    dir: PathBuf,
}

impl PosterCache {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn key(source: &Path) -> Option<String> {
        let about = std::fs::metadata(source).ok()?;
        if !about.is_file() {
            return None;
        }
        let modified = about
            .modified()
            .ok()
            .and_then(|at| at.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map_or(0, |since| since.as_nanos());
        let identity = format!("{}\n{}\n{modified}", source.display(), about.len());
        Some(format!("{:016x}", fnv1a(identity.as_bytes())))
    }

    /// The poster for `source`, if one has been made.
    pub fn find(&self, source: &Path) -> Option<PathBuf> {
        let poster = self.dir.join(format!("{}.jpg", Self::key(source)?));
        poster.is_file().then_some(poster)
    }

    /// True if a poster has been tried for `source` and there was none to
    /// be had, so that it is not tried again every time.
    fn known_to_have_none(&self, source: &Path) -> bool {
        Self::key(source).is_some_and(|key| self.dir.join(format!("{key}.none")).is_file())
    }

    /// True if there is anything left to do for `source`: it is a file, and
    /// it has neither a poster nor a note that it has none.
    pub fn wants(&self, source: &Path) -> bool {
        Self::key(source).is_some()
            && self.find(source).is_none()
            && !self.known_to_have_none(source)
    }

    /// Makes the poster for `source` if it has none yet. Returns where it is.
    pub fn make(&self, source: &Path, duration: Option<f64>) -> Option<PathBuf> {
        if let Some(poster) = self.find(source) {
            return Some(poster);
        }
        let key = Self::key(source)?;
        if self.known_to_have_none(source) {
            return None;
        }
        std::fs::create_dir_all(&self.dir).ok()?;
        let Some(jpeg) = poster(source, duration) else {
            let _ = std::fs::write(self.dir.join(format!("{key}.none")), b"");
            return None;
        };
        // Written under another name first, so a half-written poster is
        // never shown.
        let partial = self.dir.join(format!("{key}.{}.part", std::process::id()));
        let poster = self.dir.join(format!("{key}.jpg"));
        std::fs::write(&partial, jpeg).ok()?;
        std::fs::rename(&partial, &poster).ok()?;
        Some(poster)
    }
}

/// FNV-1a, 64 bits: a name for a cache file needs to be stable, not secret.
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

/// The address the web view loads a local file from, through Tauri's asset
/// protocol.
pub fn asset_url(path: &Path) -> String {
    let mut url = String::from("asset://localhost/");
    for byte in path.to_string_lossy().bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            url.push(char::from(byte));
        } else {
            url.push_str(&format!("%{byte:02X}"));
        }
    }
    url
}

/// A JPEG as an address the web view can show without asking for a file.
pub fn data_url(jpeg: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut url = String::with_capacity(23 + jpeg.len().div_ceil(3) * 4);
    url.push_str("data:image/jpeg;base64,");
    for chunk in jpeg.chunks(3) {
        let group = u32::from(chunk[0]) << 16
            | u32::from(chunk.get(1).copied().unwrap_or(0)) << 8
            | u32::from(chunk.get(2).copied().unwrap_or(0));
        for place in 0..4 {
            if place <= chunk.len() {
                let six = (group >> (18 - 6 * place)) & 0x3F;
                url.push(char::from(ALPHABET[six as usize]));
            } else {
                url.push('=');
            }
        }
    }
    url
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::test_support::test_clip;

    /// The size a JPEG says it is: the numbers in its start-of-frame header.
    fn size_of(jpeg: &[u8]) -> (u32, u32) {
        let mut at = 2;
        while at + 9 < jpeg.len() {
            assert_eq!(jpeg[at], 0xFF, "not at a marker");
            let marker = jpeg[at + 1];
            let length = usize::from(jpeg[at + 2]) << 8 | usize::from(jpeg[at + 3]);
            if (0xC0..=0xC2).contains(&marker) {
                let height = u32::from(jpeg[at + 5]) << 8 | u32::from(jpeg[at + 6]);
                let width = u32::from(jpeg[at + 7]) << 8 | u32::from(jpeg[at + 8]);
                return (width, height);
            }
            at += 2 + length;
        }
        panic!("no frame header");
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lumen-posters-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn takes_a_frame_of_the_width_asked_for_in_the_pictures_shape() {
        // The clip is 320 x 180.
        let jpeg = frame(test_clip(), Some(1.0), 160).expect("a frame");
        assert!(is_jpeg(&jpeg));
        assert_eq!(size_of(&jpeg), (160, 90));
        let first = frame(test_clip(), None, PREVIEW_WIDTH).expect("the first frame");
        assert_eq!(size_of(&first), (384, 216));
    }

    #[test]
    fn has_nothing_for_a_time_past_the_end_or_a_file_that_is_not_video() {
        assert_eq!(frame(test_clip(), Some(500.0), 160), None);
        let text = std::env::temp_dir().join(format!("lumen-frame-{}.txt", std::process::id()));
        std::fs::write(&text, "not a film").unwrap();
        assert_eq!(frame(&text, None, 160), None);
        std::fs::remove_file(&text).unwrap();
        assert_eq!(frame(Path::new("/no/such/film.mkv"), Some(1.0), 160), None);
    }

    #[test]
    fn makes_a_poster_whether_or_not_the_length_is_known() {
        let known = poster(test_clip(), Some(2.0)).expect("a poster");
        assert_eq!(size_of(&known), (POSTER_WIDTH, 360));
        let unknown = poster(test_clip(), None).expect("a poster");
        assert_eq!(size_of(&unknown), (POSTER_WIDTH, 360));
    }

    #[test]
    fn keeps_posters_and_makes_each_only_once() {
        let cache = PosterCache::new(scratch("cache"));
        assert!(cache.wants(test_clip()));
        assert_eq!(cache.find(test_clip()), None);

        let made = cache.make(test_clip(), Some(2.0)).expect("a poster");
        assert!(made.starts_with(cache.dir()));
        assert!(is_jpeg(&std::fs::read(&made).unwrap()));
        assert_eq!(cache.find(test_clip()), Some(made.clone()));
        assert!(!cache.wants(test_clip()));

        // Asking again hands back the same file, untouched.
        let before = std::fs::metadata(&made).unwrap().modified().unwrap();
        assert_eq!(cache.make(test_clip(), Some(2.0)), Some(made.clone()));
        assert_eq!(
            std::fs::metadata(&made).unwrap().modified().unwrap(),
            before
        );
        std::fs::remove_dir_all(cache.dir()).unwrap();
    }

    #[test]
    fn remembers_that_a_file_has_no_picture() {
        let cache = PosterCache::new(scratch("none"));
        let text = std::env::temp_dir().join(format!("lumen-poster-{}.txt", std::process::id()));
        std::fs::write(&text, "not a film").unwrap();
        assert!(cache.wants(&text));
        assert_eq!(cache.make(&text, None), None);
        assert!(!cache.wants(&text), "it would be tried again every time");
        std::fs::remove_file(&text).unwrap();
        std::fs::remove_dir_all(cache.dir()).unwrap();
    }

    #[test]
    fn a_file_that_is_not_there_wants_nothing() {
        let cache = PosterCache::new(scratch("missing"));
        assert!(!cache.wants(Path::new("/no/such/film.mkv")));
        assert_eq!(cache.make(Path::new("/no/such/film.mkv"), None), None);
    }

    #[test]
    fn a_replaced_file_gets_a_new_poster() {
        let dir = scratch("replaced");
        std::fs::create_dir_all(&dir).unwrap();
        let film = dir.join("film.mp4");
        std::fs::write(&film, b"one").unwrap();
        let first = PosterCache::key(&film).unwrap();
        std::fs::write(&film, b"another").unwrap();
        assert_ne!(PosterCache::key(&film).unwrap(), first);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn writes_addresses_the_web_view_can_load() {
        assert_eq!(
            asset_url(Path::new("/Users/me/Library/Caches/Lumen/a b/é.jpg")),
            "asset://localhost/%2FUsers%2Fme%2FLibrary%2FCaches%2FLumen%2Fa%20b%2F%C3%A9.jpg"
        );
        assert_eq!(data_url(b""), "data:image/jpeg;base64,");
        assert_eq!(data_url(b"f"), "data:image/jpeg;base64,Zg==");
        assert_eq!(data_url(b"fo"), "data:image/jpeg;base64,Zm8=");
        assert_eq!(data_url(b"foo"), "data:image/jpeg;base64,Zm9v");
        assert_eq!(data_url(b"foob"), "data:image/jpeg;base64,Zm9vYg==");
        assert_eq!(data_url(&[0xFF, 0xD8, 0xFF]), "data:image/jpeg;base64,/9j/");
    }
}
