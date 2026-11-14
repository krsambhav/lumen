//! The file types Lumen opens, by extension.
//!
//! mpv decides what it can actually play from the file's contents; this list
//! only drives the open panel's filter, folder scanning and (at packaging)
//! the file associations.

use std::path::Path;

pub const VIDEO: &[&str] = &[
    "mkv", "mp4", "m4v", "mov", "avi", "wmv", "flv", "f4v", "webm", "mpg", "mpeg", "m2v", "ts",
    "m2ts", "mts", "3gp", "3g2", "ogv", "vob", "divx", "asf", "rm", "rmvb", "mxf",
];

pub const AUDIO: &[&str] = &[
    "mp3", "flac", "aac", "m4a", "ogg", "oga", "opus", "wav", "aiff", "aif", "wma", "ac3", "eac3",
    "dts", "mka", "ape", "alac", "wv",
];

/// Files of subtitles, which are added to what is playing and not played.
pub const SUBTITLES: &[&str] = &[
    "srt", "ass", "ssa", "vtt", "smi", "sami", "sub", "idx", "sup", "pgs", "lrc", "rt", "sbv",
    "scc", "mks", "srv3", "ytt",
];

/// True if a path looks like a file of subtitles, from its extension alone.
pub fn is_subtitles(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| SUBTITLES.contains(&extension.to_ascii_lowercase().as_str()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Video,
    Audio,
}

/// What kind of media a path looks like, from its extension alone.
pub fn kind_of(path: &Path) -> Option<MediaKind> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if VIDEO.contains(&extension.as_str()) {
        Some(MediaKind::Video)
    } else if AUDIO.contains(&extension.as_str()) {
        Some(MediaKind::Audio)
    } else {
        None
    }
}

/// Every extension, for an open panel filter.
pub fn all_extensions() -> Vec<&'static str> {
    VIDEO.iter().chain(AUDIO).copied().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_a_file_of_subtitles_from_something_to_play() {
        assert!(is_subtitles(Path::new("/films/Solaris.en.srt")));
        assert!(is_subtitles(Path::new("/films/Solaris.ASS")));
        assert!(is_subtitles(Path::new("captions.vtt")));
        assert!(is_subtitles(Path::new("old.smi")));
        assert!(!is_subtitles(Path::new("/films/Solaris.mkv")));
        assert!(!is_subtitles(Path::new("/films/srt")));
        // Subtitles are not media: they are never queued or played.
        assert_eq!(kind_of(Path::new("/films/Solaris.en.srt")), None);
    }

    #[test]
    fn recognises_media_by_extension_whatever_its_case() {
        assert_eq!(
            kind_of(Path::new("/films/Solaris.MKV")),
            Some(MediaKind::Video)
        );
        assert_eq!(
            kind_of(Path::new("album/01 - Intro.flac")),
            Some(MediaKind::Audio)
        );
        assert_eq!(kind_of(Path::new("notes.txt")), None);
        assert_eq!(kind_of(Path::new("no-extension")), None);
        assert_eq!(kind_of(Path::new(".mkv")), None);
    }

    #[test]
    fn covers_the_formats_in_the_product_brief() {
        for extension in [
            "mkv", "mp4", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpeg", "3gp",
        ] {
            assert!(VIDEO.contains(&extension), "{extension}");
        }
        for extension in ["flac", "mp3", "aac", "ogg", "dts", "ac3"] {
            assert!(AUDIO.contains(&extension), "{extension}");
        }
    }

    #[test]
    fn has_no_duplicates_and_no_overlap() {
        let all = all_extensions();
        let mut unique = all.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), all.len());
    }
}
