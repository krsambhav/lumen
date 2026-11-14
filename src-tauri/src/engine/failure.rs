//! Why something would not open, in the terms a person would use.
//!
//! mpv says "loading failed" for a file that has been moved, for one Lumen
//! may not read, and for an address that does not answer. The interface has
//! to say which, because what to do next is different each time, so the
//! file system is asked as well.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum FailureReason {
    /// Nothing is at that path any more.
    Missing,
    /// It is there, but Lumen is not allowed to read it.
    NoPermission,
    /// It is a folder with nothing in it that could be played.
    Folder,
    /// It is not video or audio that Lumen can read.
    NotMedia,
    /// It was read, but no picture or sound in it could be played.
    NothingPlayable,
    /// It is an address, and the network or the server would not give it.
    Unreachable,
    /// Anything else, in the engine's own words.
    Other { message: String },
}

/// True for an address rather than a path on this Mac.
pub fn is_address(source: &str) -> bool {
    source.contains("://")
}

/// Works out why `source` failed, from what the engine said and what the
/// file system says now.
pub fn classify(source: &str, engine_message: &str) -> FailureReason {
    if is_address(source) {
        return match engine_message {
            "loading failed" => FailureReason::Unreachable,
            other => by_engine_message(other),
        };
    }
    let path = Path::new(source);
    match fs::metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => return FailureReason::Missing,
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            return FailureReason::NoPermission
        }
        Ok(metadata) if metadata.is_dir() => return FailureReason::Folder,
        Ok(_) => {
            // Metadata can be read where the contents cannot.
            if let Err(error) = fs::File::open(path) {
                if error.kind() == ErrorKind::PermissionDenied {
                    return FailureReason::NoPermission;
                }
            }
        }
        Err(_) => {}
    }
    match engine_message {
        // The file is there and readable, so the trouble is what is in it.
        "loading failed" => FailureReason::NotMedia,
        other => by_engine_message(other),
    }
}

fn by_engine_message(message: &str) -> FailureReason {
    match message {
        "unrecognized file format" => FailureReason::NotMedia,
        "no audio or video data played" => FailureReason::NothingPlayable,
        other => FailureReason::Other {
            message: other.to_owned(),
        },
    }
}

/// What to show in the Finder for a source that failed: the file itself if
/// it is still there, otherwise the nearest folder that is. `None` for an
/// address, or when nothing of the path is left.
pub fn reveal_target(source: &str) -> Option<PathBuf> {
    if is_address(source) {
        return None;
    }
    let path = Path::new(source);
    if !path.is_absolute() {
        return None;
    }
    path.ancestors()
        .find(|candidate| candidate.exists())
        // The root of the disk is not somewhere worth sending anyone.
        .filter(|found| found.parent().is_some())
        .map(Path::to_path_buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lumen-failure-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_path_with_nothing_at_it_is_missing() {
        let dir = scratch("missing");
        let gone = dir.join("Gone.mkv");
        assert_eq!(
            classify(gone.to_str().unwrap(), "loading failed"),
            FailureReason::Missing
        );
    }

    #[test]
    fn a_folder_is_called_a_folder() {
        let dir = scratch("folder");
        assert_eq!(
            classify(dir.to_str().unwrap(), "loading failed"),
            FailureReason::Folder
        );
    }

    #[test]
    fn a_readable_file_the_engine_cannot_load_is_not_media() {
        let dir = scratch("text");
        let notes = dir.join("notes.mkv");
        fs::write(&notes, "not a film").unwrap();
        let path = notes.to_str().unwrap();
        assert_eq!(classify(path, "loading failed"), FailureReason::NotMedia);
        assert_eq!(
            classify(path, "unrecognized file format"),
            FailureReason::NotMedia
        );
        assert_eq!(
            classify(path, "no audio or video data played"),
            FailureReason::NothingPlayable
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_file_lumen_may_not_read_says_so() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("locked");
        let locked = dir.join("Locked.mkv");
        fs::write(&locked, "secret").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let reason = classify(locked.to_str().unwrap(), "loading failed");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(reason, FailureReason::NoPermission);
    }

    #[test]
    fn an_address_that_does_not_answer_is_unreachable() {
        assert_eq!(
            classify("https://example.invalid/film.mkv", "loading failed"),
            FailureReason::Unreachable
        );
        assert_eq!(
            classify(
                "https://example.invalid/film.mkv",
                "unrecognized file format"
            ),
            FailureReason::NotMedia
        );
    }

    #[test]
    fn anything_else_keeps_the_engines_words() {
        let dir = scratch("other");
        let file = dir.join("a.mkv");
        fs::write(&file, "x").unwrap();
        assert_eq!(
            classify(file.to_str().unwrap(), "audio output initialization failed"),
            FailureReason::Other {
                message: "audio output initialization failed".to_owned()
            }
        );
    }

    #[test]
    fn reveals_the_file_if_it_is_there_and_its_folder_if_it_is_not() {
        let dir = scratch("reveal");
        let there = dir.join("There.mkv");
        fs::write(&there, "x").unwrap();
        assert_eq!(reveal_target(there.to_str().unwrap()), Some(there.clone()));

        let gone = dir.join("Season 2").join("Gone.mkv");
        assert_eq!(reveal_target(gone.to_str().unwrap()), Some(dir.clone()));
    }

    #[test]
    fn reveals_nothing_for_an_address_or_a_path_that_is_wholly_gone() {
        assert_eq!(reveal_target("https://example.com/a.mkv"), None);
        assert_eq!(reveal_target("/no-such-volume-xyz/films/a.mkv"), None);
        assert_eq!(reveal_target("relative/a.mkv"), None);
    }
}
