//! Turning what the user opened into things to play: a file is itself, a
//! folder is the media in it, a playlist file is its entries.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use super::formats;
use crate::engine::failure::is_address;

/// One thing to play.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// A path or an address.
    pub source: String,
    pub title: String,
}

impl Entry {
    fn of(source: String) -> Self {
        Self {
            title: display_name(&source),
            source,
        }
    }
}

/// The most entries one request can add. A whole disk dropped on the window
/// should not become a playlist a hundred thousand rows long.
pub const MAX_ENTRIES: usize = 2000;

/// How many folders deep a dropped folder is searched.
const MAX_DEPTH: usize = 6;

const PLAYLIST_EXTENSIONS: &[&str] = &["m3u", "m3u8", "pls"];

/// A playlist file larger than this is not a playlist file.
const MAX_PLAYLIST_BYTES: u64 = 4 * 1024 * 1024;

/// What to call a source: for a path, the file's name as the Finder shows
/// it, without the extension of a kind of file Lumen knows; for an address,
/// the whole thing (DESIGN.md §3).
///
/// Only a known extension is dropped. "Dr. No" and "S01E03.Pilot" end in
/// what looks like one, and a file of some other kind keeps its own, which
/// is then the only thing that says what it is.
pub fn display_name(source: &str) -> String {
    if is_address(source) {
        return source.to_owned();
    }
    let path = Path::new(source);
    let known = formats::kind_of(path).is_some()
        || path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                PLAYLIST_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
            });
    let name = if known {
        path.file_stem()
    } else {
        path.file_name()
    };
    name.map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| source.to_owned())
}

/// The last part of an address's path, as a player names a stream that has
/// no title of its own: `0` for `https://host/dl/tb-…/0`. Such a name says
/// nothing about what is playing, so it is never taken as a title.
pub fn address_tail(source: &str) -> Option<&str> {
    if !is_address(source) {
        return None;
    }
    let path = source.split(['?', '#']).next().unwrap_or(source);
    let after_host = path.split_once("://").map_or(path, |(_, rest)| rest);
    let (_, path) = after_host.split_once('/')?;
    path.rsplit('/').find(|part| !part.is_empty())
}

/// A name given to an address, if `title` is one: not the address itself,
/// nor the last part of its path.
pub fn given_name<'a>(source: &str, title: &'a str) -> Option<&'a str> {
    let title = title.trim();
    (!title.is_empty() && title != source && Some(title) != address_tail(source)).then_some(title)
}

/// A stored title as it is shown now.
///
/// A file with no title of its own is stored under its name, and until
/// names were shown without their extension that was the whole file name.
/// Such a title says nothing the path does not, so it is read back as the
/// path is named today. A title that came from somewhere else, as a
/// playlist file's name for an entry does, is kept as it is.
pub fn shown_title(source: &str, title: String) -> String {
    if is_address(source) {
        return title;
    }
    let whole = Path::new(source)
        .file_name()
        .map(|name| name.to_string_lossy());
    if whole.as_deref() == Some(title.as_str()) {
        display_name(source)
    } else {
        title
    }
}

/// Everything there is to play in `sources`, in order.
pub fn expand(sources: &[String]) -> Vec<Entry> {
    let mut entries = Vec::new();
    for source in sources {
        if entries.len() >= MAX_ENTRIES {
            break;
        }
        let source = source.trim();
        if source.is_empty() {
            continue;
        }
        if is_address(source) {
            entries.push(Entry::of(source.to_owned()));
            continue;
        }
        let path = Path::new(source);
        if path.is_dir() {
            walk(path, 0, &mut entries);
        } else if let Some(listed) = playlist_file(path) {
            entries.extend(listed);
        } else {
            // Whatever it is, the user chose it: the player decides.
            entries.push(Entry::of(source.to_owned()));
        }
    }
    entries.truncate(MAX_ENTRIES);
    entries
}

/// Adds the media files under `dir`, each folder's contents in natural order
/// with its subfolders in their place among the files.
fn walk(dir: &Path, depth: usize, entries: &mut Vec<Entry>) {
    let Ok(listing) = std::fs::read_dir(dir) else {
        return;
    };
    let mut children: Vec<PathBuf> = listing
        .filter_map(Result::ok)
        .map(|child| child.path())
        .filter(|path| {
            // Hidden files, and the "._" halves that macOS leaves on other
            // file systems.
            path.file_name()
                .is_some_and(|name| !name.to_string_lossy().starts_with('.'))
        })
        .collect();
    children.sort_by(|a, b| natural_cmp(&a.to_string_lossy(), &b.to_string_lossy()));
    for child in children {
        if entries.len() >= MAX_ENTRIES {
            return;
        }
        if child.is_dir() {
            if depth < MAX_DEPTH {
                walk(&child, depth + 1, entries);
            }
        } else if formats::kind_of(&child).is_some() {
            entries.push(Entry::of(child.to_string_lossy().into_owned()));
        }
    }
}

/// The entries of a playlist file, or `None` if `path` is not one (or is one
/// with nothing in it, in which case the player may as well try it).
fn playlist_file(path: &Path) -> Option<Vec<Entry>> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if !PLAYLIST_EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }
    let size = std::fs::metadata(path).ok()?.len();
    if size > MAX_PLAYLIST_BYTES {
        return None;
    }
    let text = String::from_utf8_lossy(&std::fs::read(path).ok()?).into_owned();
    let base = path.parent().unwrap_or(Path::new("/"));
    let entries = if extension == "pls" {
        parse_pls(&text, base)
    } else {
        parse_m3u(&text, base)?
    };
    (!entries.is_empty()).then_some(entries)
}

/// Where a playlist's entry points: an address as it is, a path made whole
/// against the playlist's own folder.
fn resolve(target: &str, base: &Path) -> String {
    if let Some(path) = target.strip_prefix("file://") {
        // "file:///Users/..." and the rarer "file://localhost/Users/...".
        let path = path.strip_prefix("localhost").unwrap_or(path);
        return percent_decode(path);
    }
    if is_address(target) {
        return target.to_owned();
    }
    let path = Path::new(target);
    if path.is_absolute() {
        target.to_owned()
    } else {
        base.join(path).to_string_lossy().into_owned()
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let hex = (bytes[index] == b'%')
            .then(|| text.get(index + 1..index + 3))
            .flatten()
            .and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match hex {
            Some(byte) => {
                decoded.push(byte);
                index += 3;
            }
            None => {
                decoded.push(bytes[index]);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// Reads an M3U playlist. `None` for an HLS manifest, which has the same
/// extension but is a stream for the player, not a list of things to play.
fn parse_m3u(text: &str, base: &Path) -> Option<Vec<Entry>> {
    let mut entries = Vec::new();
    let mut title: Option<String> = None;
    for line in text.lines() {
        let line = line.trim().trim_start_matches('\u{feff}');
        if line.starts_with("#EXT-X-") {
            return None;
        }
        if let Some(info) = line.strip_prefix("#EXTINF:") {
            // "#EXTINF:<seconds>,<title>"
            title = info
                .split_once(',')
                .map(|(_, title)| title.trim().to_owned())
                .filter(|title| !title.is_empty());
            continue;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let source = resolve(line, base);
        entries.push(Entry {
            title: title.take().unwrap_or_else(|| display_name(&source)),
            source,
        });
    }
    Some(entries)
}

/// Reads a PLS playlist: `FileN=` lines, each with an optional `TitleN=`.
fn parse_pls(text: &str, base: &Path) -> Vec<Entry> {
    let mut files: Vec<(u32, String)> = Vec::new();
    let mut titles: Vec<(u32, String)> = Vec::new();
    for line in text.lines() {
        let Some((key, value)) = line.trim().split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim().to_ascii_lowercase(), value.trim());
        if value.is_empty() {
            continue;
        }
        if let Some(number) = key.strip_prefix("file").and_then(|n| n.parse().ok()) {
            files.push((number, value.to_owned()));
        } else if let Some(number) = key.strip_prefix("title").and_then(|n| n.parse().ok()) {
            titles.push((number, value.to_owned()));
        }
    }
    files.sort_by_key(|(number, _)| *number);
    files
        .into_iter()
        .map(|(number, target)| {
            let source = resolve(&target, base);
            let title = titles
                .iter()
                .find(|(titled, _)| *titled == number)
                .map_or_else(|| display_name(&source), |(_, title)| title.clone());
            Entry { source, title }
        })
        .collect()
}

/// Orders names the way a person would: "Episode 2" before "Episode 10",
/// and without regard to case.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut left, mut right) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (left.peek().copied(), right.peek().copied()) {
            (None, None) => break,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let take = |side: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut digits = String::new();
                    while let Some(digit) = side.peek().copied().filter(char::is_ascii_digit) {
                        digits.push(digit);
                        side.next();
                    }
                    digits
                };
                let (x, y) = (take(&mut left), take(&mut right));
                let (x, y) = (x.trim_start_matches('0'), y.trim_start_matches('0'));
                // With no leading zeros, the longer number is the larger.
                let order = x.len().cmp(&y.len()).then_with(|| x.cmp(y));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(x), Some(y)) => {
                let order = x.to_lowercase().cmp(y.to_lowercase());
                if order != Ordering::Equal {
                    return order;
                }
                left.next();
                right.next();
            }
        }
    }
    // Equal as a person reads them: any fixed order will do, as long as it is one.
    a.cmp(b)
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_tail_of_an_address_is_not_a_name() {
        let stream = "https://host.example/dl/tb-2c82/0";
        assert_eq!(address_tail(stream), Some("0"));
        assert_eq!(
            address_tail("https://host.example/watch?v=abc"),
            Some("watch")
        );
        assert_eq!(address_tail("https://host.example/"), None);
        assert_eq!(address_tail("/Users/me/Film.mkv"), None);
        assert_eq!(given_name(stream, "0"), None);
        assert_eq!(given_name(stream, stream), None);
        assert_eq!(given_name(stream, "  "), None);
        assert_eq!(
            given_name(stream, "MobLand S02E02 Song 2 1080p"),
            Some("MobLand S02E02 Song 2 1080p")
        );
    }

    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("lumen-sources-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn file(&self, relative: &str) -> String {
            self.write(relative, "")
        }

        fn write(&self, relative: &str, contents: &str) -> String {
            let path = self.0.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, contents).unwrap();
            path.to_string_lossy().into_owned()
        }

        fn path(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn titles(entries: &[Entry]) -> Vec<&str> {
        entries.iter().map(|entry| entry.title.as_str()).collect()
    }

    #[test]
    fn orders_names_as_a_person_would() {
        let mut names = vec![
            "Episode 10.mkv",
            "episode 2.mkv",
            "Episode 1.mkv",
            "Episode 02 extras.mkv",
            "Appendix.mkv",
        ];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            names,
            [
                "Appendix.mkv",
                "Episode 1.mkv",
                "Episode 02 extras.mkv",
                "episode 2.mkv",
                "Episode 10.mkv",
            ]
        );
        assert_eq!(natural_cmp("S01E09", "S01E10"), Ordering::Less);
        assert_eq!(natural_cmp("a", "a"), Ordering::Equal);
        // Numbers too long for any integer type still compare.
        assert_eq!(
            natural_cmp("99999999999999999999999999", "100000000000000000000000000"),
            Ordering::Less
        );
    }

    #[test]
    fn names_a_path_by_its_file_without_the_extension_and_an_address_whole() {
        assert_eq!(display_name("/films/Solaris (1972).mkv"), "Solaris (1972)");
        assert_eq!(
            display_name("https://example.com/a.mp4"),
            "https://example.com/a.mp4"
        );
        assert_eq!(display_name("clip.MP4"), "clip");
        assert_eq!(display_name("/music/Night Drive.m4a"), "Night Drive");
        assert_eq!(display_name("/lists/Friday night.m3u8"), "Friday night");
    }

    #[test]
    fn keeps_what_only_looks_like_an_extension() {
        // A full stop in a name is not the start of an extension.
        assert_eq!(display_name("/films/Dr. No"), "Dr. No");
        assert_eq!(
            display_name("/series/The.Crossing.S01E03.Pilot.mkv"),
            "The.Crossing.S01E03.Pilot"
        );
        // A kind of file Lumen does not know keeps its own.
        assert_eq!(display_name("/notes/odd.xyz"), "odd.xyz");
        assert_eq!(display_name("/films/.mkv"), ".mkv");
    }

    #[test]
    fn a_stored_file_name_is_read_back_as_names_are_shown_now() {
        let shown = |source: &str, title: &str| shown_title(source, title.to_owned());
        // Stored when the whole file name was the title.
        assert_eq!(
            shown("/films/Solaris (1972).mkv", "Solaris (1972).mkv"),
            "Solaris (1972)"
        );
        // Already as it is shown, or a kind of file that keeps its extension.
        assert_eq!(
            shown("/films/Solaris (1972).mkv", "Solaris (1972)"),
            "Solaris (1972)"
        );
        assert_eq!(shown("/notes/odd.xyz", "odd.xyz"), "odd.xyz");
        // A title from somewhere else is not the file's name, even when it
        // ends as a file does.
        assert_eq!(shown("/films/a.mkv", "Solaris"), "Solaris");
        assert_eq!(shown("/films/a.mkv", "Trailer.mp4"), "Trailer.mp4");
        // An address has no file name to compare with.
        assert_eq!(shown("https://example.com/a.mp4", "a.mp4"), "a.mp4");
    }

    #[test]
    fn a_file_is_itself_whatever_its_extension() {
        let entries = expand(&["/films/Solaris.mkv".to_owned(), "/notes/odd.xyz".to_owned()]);
        assert_eq!(titles(&entries), ["Solaris", "odd.xyz"]);
        assert_eq!(entries[0].source, "/films/Solaris.mkv");
    }

    #[test]
    fn an_address_is_kept_as_it_is() {
        let entries = expand(&["https://example.com/stream.m3u8".to_owned()]);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].source, "https://example.com/stream.m3u8");
    }

    #[test]
    fn a_folder_is_the_media_in_it_in_natural_order() {
        let scratch = Scratch::new("folder");
        scratch.file("Season 1/Episode 10.mkv");
        scratch.file("Season 1/Episode 2.mkv");
        scratch.file("Season 1/Episode 1.mkv");
        scratch.file("Season 1/cover.jpg");
        scratch.file("Season 1/.hidden.mkv");
        scratch.file("Season 1/Extras/Interview.mp4");
        scratch.file("Season 2/Episode 1.mkv");
        scratch.file("Theme.flac");

        let entries = expand(&[scratch.path()]);
        assert_eq!(
            titles(&entries),
            [
                "Episode 1",
                "Episode 2",
                "Episode 10",
                "Interview",
                "Episode 1",
                "Theme",
            ]
        );
        assert!(entries[0].source.ends_with("Season 1/Episode 1.mkv"));
    }

    #[test]
    fn an_empty_folder_has_nothing_to_play() {
        let scratch = Scratch::new("empty");
        assert!(expand(&[scratch.path()]).is_empty());
    }

    #[test]
    fn stops_at_the_limit() {
        let scratch = Scratch::new("many");
        for index in 0..(MAX_ENTRIES + 5) {
            scratch.file(&format!("{index:05}.mp3"));
        }
        assert_eq!(expand(&[scratch.path()]).len(), MAX_ENTRIES);
    }

    #[test]
    fn reads_an_m3u_playlist_with_and_without_titles() {
        let scratch = Scratch::new("m3u");
        let list = scratch.write(
            "list.m3u",
            "\u{feff}#EXTM3U\n\
             #EXTINF:7305,Solaris\n\
             films/Solaris.mkv\n\
             \n\
             # a comment\n\
             /absolute/Stalker.mkv\n\
             #EXTINF:-1,\n\
             https://example.com/live\n\
             file:///Users/me/A%20film.mkv\n",
        );
        let entries = expand(&[list]);
        assert_eq!(
            titles(&entries),
            ["Solaris", "Stalker", "https://example.com/live", "A film"]
        );
        assert_eq!(
            entries[0].source,
            format!("{}/films/Solaris.mkv", scratch.path())
        );
        assert_eq!(entries[1].source, "/absolute/Stalker.mkv");
        assert_eq!(entries[3].source, "/Users/me/A film.mkv");
    }

    #[test]
    fn a_saved_stream_manifest_is_left_to_the_player() {
        let scratch = Scratch::new("hls");
        let manifest = scratch.write(
            "stream.m3u8",
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:6.0,\nsegment0.ts\n",
        );
        let entries = expand(std::slice::from_ref(&manifest));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].source, manifest);
    }

    #[test]
    fn reads_a_pls_playlist_in_numbered_order() {
        let scratch = Scratch::new("pls");
        let list = scratch.write(
            "radio.pls",
            "[playlist]\nFile2=b.mp3\nTitle2=Second\nFile1=http://example.com/a\nNumberOfEntries=2\n",
        );
        let entries = expand(&[list]);
        assert_eq!(titles(&entries), ["http://example.com/a", "Second"]);
        assert_eq!(entries[1].source, format!("{}/b.mp3", scratch.path()));
    }

    #[test]
    fn an_empty_playlist_file_is_tried_as_media() {
        let scratch = Scratch::new("blank");
        let list = scratch.write("blank.m3u", "#EXTM3U\n");
        assert_eq!(expand(std::slice::from_ref(&list))[0].source, list);
    }
}
