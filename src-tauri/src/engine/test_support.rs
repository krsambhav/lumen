//! Shared fixtures for engine tests: a headless player and a generated clip.
//!
//! The clip is made with Lumen's own FFmpeg build, so the tests need no media
//! files in the repository.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use super::mpv::Mpv;

fn vendor() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../vendor")
}

/// A player with no window and no sound device.
pub fn headless() -> Mpv {
    Mpv::new(&[
        ("vo", "null"),
        ("ao", "null"),
        ("config", "no"),
        ("load-scripts", "no"),
        ("idle", "yes"),
        ("terminal", "no"),
    ])
    .expect("create headless mpv")
}

/// Two seconds of 320x180 test pattern at 30 fps with a 440 Hz tone, MPEG-4
/// video and AAC audio in MP4, with two chapters.
pub fn test_clip() -> &'static Path {
    static CLIP: OnceLock<PathBuf> = OnceLock::new();
    CLIP.get_or_init(|| {
        let dir = std::env::temp_dir().join("lumen-test-media");
        std::fs::create_dir_all(&dir).expect("create test media dir");
        let clip = dir.join("clip-v1.mp4");
        if clip.exists() {
            return clip;
        }
        // Written under a private name first, so parallel test binaries never
        // read a half-written file.
        let partial = dir.join(format!("clip-v1.{}.mp4", std::process::id()));
        let metadata = dir.join(format!("chapters.{}.txt", std::process::id()));
        std::fs::write(
            &metadata,
            ";FFMETADATA1\n\
             [CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=Opening\n\
             [CHAPTER]\nTIMEBASE=1/1000\nSTART=1000\nEND=2000\ntitle=Second half\n",
        )
        .expect("write chapter metadata");
        let status = Command::new(vendor().join("bin/ffmpeg"))
            .args(["-hide_banner", "-loglevel", "error", "-y"])
            // Lumen's FFmpeg has no libavdevice, so the sources are filters
            // in a graph rather than `-f lavfi` inputs.
            .arg("-i")
            .arg(&metadata)
            .args([
                "-filter_complex",
                "testsrc2=size=320x180:rate=30[v];sine=frequency=440:sample_rate=48000[a]",
            ])
            .args([
                "-map",
                "[v]",
                "-map",
                "[a]",
                "-map_metadata",
                "0",
                "-map_chapters",
                "0",
            ])
            .args([
                "-t", "2", "-c:v", "mpeg4", "-q:v", "5", "-pix_fmt", "yuv420p",
            ])
            .args([
                "-c:a",
                "aac",
                "-b:a",
                "96k",
                "-metadata",
                "title=Lumen test clip",
            ])
            .arg(&partial)
            .status()
            .expect("run vendor ffmpeg (scripts/build-deps.sh builds it)");
        assert!(status.success(), "ffmpeg failed to make the test clip");
        let _ = std::fs::remove_file(&metadata);
        std::fs::rename(&partial, &clip).expect("publish test clip");
        clip
    })
}

/// The same clip under another name, for tests that go from one file to
/// another.
pub fn second_clip() -> &'static Path {
    static COPY: OnceLock<PathBuf> = OnceLock::new();
    COPY.get_or_init(|| {
        let original = test_clip();
        let copy = original.with_file_name("clip-v1-second.mp4");
        if !copy.exists() {
            let partial = original.with_file_name(format!("second.{}.mp4", std::process::id()));
            std::fs::copy(original, &partial).expect("copy the test clip");
            std::fs::rename(&partial, &copy).expect("publish the copy");
        }
        copy
    })
}

/// Two seconds of a 440 Hz tone with no picture: AAC in an `.m4a`.
pub fn audio_clip() -> &'static Path {
    static CLIP: OnceLock<PathBuf> = OnceLock::new();
    CLIP.get_or_init(|| {
        let dir = std::env::temp_dir().join("lumen-test-media");
        std::fs::create_dir_all(&dir).expect("create test media dir");
        let clip = dir.join("tone-v1.m4a");
        if clip.exists() {
            return clip;
        }
        let partial = dir.join(format!("tone-v1.{}.m4a", std::process::id()));
        let status = Command::new(vendor().join("bin/ffmpeg"))
            .args(["-hide_banner", "-loglevel", "error", "-y"])
            .args([
                "-filter_complex",
                "sine=frequency=440:sample_rate=48000[a]",
                "-map",
                "[a]",
                "-t",
                "2",
                "-c:a",
                "aac",
                "-b:a",
                "96k",
            ])
            .arg(&partial)
            .status()
            .expect("run vendor ffmpeg (scripts/build-deps.sh builds it)");
        assert!(status.success(), "ffmpeg failed to make the audio clip");
        std::fs::rename(&partial, &clip).expect("publish audio clip");
        clip
    })
}

/// A file of subtitles in SubRip form, with one line that is showing for
/// the whole of the test clip. Each `name` is its own file.
pub fn subtitle_file(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("lumen-test-media");
    std::fs::create_dir_all(&dir).expect("create test media dir");
    let file = dir.join(format!("{name}-v1.srt"));
    if !file.exists() {
        let partial = dir.join(format!("{name}.{}.srt", std::process::id()));
        std::fs::write(
            &partial,
            format!("1\n00:00:00,000 --> 00:00:02,000\nA line from {name}.\n"),
        )
        .expect("write subtitles");
        std::fs::rename(&partial, &file).expect("publish subtitles");
    }
    file
}
