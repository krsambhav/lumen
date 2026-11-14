//! Play history: what was played, when, and where it was left.
//!
//! Resume, "Continue watching" and "Recently played" all read this table.

use std::path::Path;

use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Number;

use crate::db::Db;
use crate::engine::failure::is_address;
use crate::engine::types::FileState;
use crate::error::AppResult;
use crate::media::sources::shown_title;

/// Nothing shorter than this is resumed. A song or a clip is meant to be
/// heard from its start, and is quicker to play again than to be dropped
/// into the middle of; an episode, a film or a lecture is not.
const SHORTEST_RESUMABLE: f64 = 600.0;
/// Having barely started is not having started.
const BARELY_STARTED: f64 = 10.0;
/// On resuming, go back this far, for context.
const REWIND: f64 = 3.0;

/// One thing that was played.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub source: String,
    pub title: String,
    #[specta(type = Option<Number>)]
    pub duration: Option<f64>,
    /// Seconds from the start, where playback last was. 0 once finished.
    #[specta(type = Number)]
    pub position: f64,
    pub finished: bool,
    /// Unix seconds.
    #[specta(type = Number)]
    pub played_at: i64,
    /// What was chosen for it the last time it was open: its tracks, its
    /// delays, how its picture was shaped. `None` when nothing was.
    pub state: Option<FileState>,
    /// The playlist it was last played in, if it was not played alone.
    pub playlist: Option<PlayedIn>,
}

/// A playlist as it stood when one of its items was played: enough to
/// bring the whole of it back from Recently played.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayedIn {
    /// Names this playlist across its items: the same for every item played
    /// in one opening of it, and for a saved playlist every time it is opened.
    pub key: String,
    /// The saved playlist's name, if it is one.
    pub name: Option<String>,
    pub items: Vec<PlayedItem>,
}

/// One item of a playlist that was played.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayedItem {
    pub source: String,
    pub title: String,
    #[specta(type = Option<Number>)]
    pub duration: Option<f64>,
}

/// A history entry as the home screen shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    #[serde(flatten)]
    pub entry: HistoryEntry,
    /// The file is where it was: false if it has been moved or deleted, or
    /// its disk is not connected. Always true for an address.
    pub available: bool,
    /// Where the web view loads its poster from, once it has one.
    pub poster: Option<String>,
    /// Where opening it would start, in seconds, if not at its beginning:
    /// the one rule for what resumes (`resume_point`), so the home screen
    /// never promises a resume that will not happen.
    #[specta(type = Option<Number>)]
    pub resumes_at: Option<f64>,
}

impl Recent {
    pub fn of(entry: HistoryEntry, poster: Option<String>) -> Self {
        let available = is_address(&entry.source) || Path::new(&entry.source).exists();
        let resumes_at = if entry.finished {
            None
        } else {
            resume_point(entry.position, entry.duration)
        };
        Self {
            entry,
            available,
            poster,
            resumes_at,
        }
    }
}

/// How much of the end counts as the end: the last 3%, and at least 10 s.
/// Credits are rarely watched, and "resume" two seconds before the end is
/// no help to anyone.
fn tail(duration: f64) -> f64 {
    (duration * 0.03).max(10.0)
}

/// True if `position` is close enough to the end to count as finished.
pub fn is_finished(position: f64, duration: f64) -> bool {
    duration > 0.0 && position >= duration - tail(duration)
}

/// Where to start a file that was left at `position`: a little before it,
/// or `None` to start from the beginning.
pub fn resume_point(position: f64, duration: Option<f64>) -> Option<f64> {
    let duration = duration?;
    if duration < SHORTEST_RESUMABLE || position < BARELY_STARTED || is_finished(position, duration)
    {
        return None;
    }
    Some((position - REWIND).max(0.0))
}

fn entry(row: &Row) -> rusqlite::Result<HistoryEntry> {
    let source: String = row.get(0)?;
    let title = shown_title(&source, row.get(1)?);
    Ok(HistoryEntry {
        source,
        title,
        duration: row.get(2)?,
        position: row.get(3)?,
        finished: row.get::<_, i64>(4)? != 0,
        played_at: row.get(5)?,
        state: row
            .get::<_, Option<String>>(6)?
            .and_then(|json| read_state(&json)),
        // One that does not read is as good as none: the file comes back alone.
        playlist: row
            .get::<_, Option<String>>(7)?
            .and_then(|json| serde_json::from_str::<PlayedIn>(&json).ok())
            .filter(|playlist| playlist.items.len() > 1),
    })
}

const COLUMNS: &str = "source, title, duration, position, finished, played_at, state, playlist";

fn stored_playlist(playlist: Option<&PlayedIn>) -> Option<String> {
    playlist.and_then(|playlist| serde_json::to_string(playlist).ok())
}

/// Reads a stored state. It is laid over the defaults, as the settings
/// are, so one written before a field existed still reads; one that does
/// not read at all is as good as none, and the file opens as if for the
/// first time.
fn read_state(json: &str) -> Option<FileState> {
    let stored: serde_json::Value = serde_json::from_str(json).ok()?;
    let mut document = serde_json::to_value(FileState::default()).ok()?;
    crate::settings::merge(&mut document, stored);
    serde_json::from_value::<FileState>(document)
        .ok()
        .map(FileState::sanitised)
        .filter(|state| !state.is_untouched())
}

/// A file's state as it is stored: JSON, or nothing when nothing was chosen.
fn stored(state: Option<&FileState>) -> Option<String> {
    state
        .filter(|state| !state.is_untouched())
        .and_then(|state| serde_json::to_string(state).ok())
}

/// Notes that `source` was opened at `now` (Unix seconds), in `playlist`
/// or alone. Where it was left is kept.
pub fn opened(
    db: &Db,
    source: &str,
    title: &str,
    playlist: Option<&PlayedIn>,
    now: i64,
) -> AppResult<()> {
    db.write(|tx| {
        tx.execute(
            "INSERT INTO history (source, title, played_at, playlist) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(source) DO UPDATE SET title = excluded.title, played_at = excluded.played_at,
                playlist = excluded.playlist",
            params![source, title, now, stored_playlist(playlist)],
        )?;
        Ok(())
    })
}

/// Records where playback of `source` is and, if `state` is given, what has
/// been chosen for it; without one, what was recorded as chosen stays.
/// Once it is near enough the end the entry is marked finished and its
/// position cleared, so that next time it starts from the beginning; what
/// was chosen for it is kept all the same.
pub fn progressed(
    db: &Db,
    source: &str,
    position: f64,
    duration: Option<f64>,
    state: Option<&FileState>,
    now: i64,
) -> AppResult<()> {
    let finished = duration.is_some_and(|duration| is_finished(position, duration));
    let position = if finished { 0.0 } else { position.max(0.0) };
    db.write(|tx| {
        tx.execute(
            "UPDATE history
                SET position = ?2, duration = coalesce(?3, duration), finished = ?4, played_at = ?5,
                    state = CASE WHEN ?7 THEN ?6 ELSE state END
              WHERE source = ?1",
            params![
                source,
                position,
                duration,
                i64::from(finished),
                now,
                stored(state),
                state.is_some()
            ],
        )?;
        Ok(())
    })
}

/// What is known about `source`, if it has been played.
pub fn find(db: &Db, source: &str) -> AppResult<Option<HistoryEntry>> {
    db.read(|conn| {
        conn.query_row(
            &format!("SELECT {COLUMNS} FROM history WHERE source = ?1"),
            [source],
            entry,
        )
        .optional()
    })
}

/// The most recently played things, newest first. A playlist is one of
/// them, however many of its items were played: the one played last
/// stands for it, and opening it brings the whole playlist back.
pub fn recent(db: &Db, limit: u32) -> AppResult<Vec<HistoryEntry>> {
    db.read(|conn| {
        let mut statement = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM history ORDER BY played_at DESC, source"
        ))?;
        let mut seen = std::collections::HashSet::new();
        let mut found = Vec::new();
        for row in statement.query_map([], entry)? {
            let row = row?;
            let first = row
                .playlist
                .as_ref()
                .is_none_or(|playlist| seen.insert(playlist.key.clone()));
            if first {
                found.push(row);
                if found.len() >= limit as usize {
                    break;
                }
            }
        }
        Ok(found)
    })
}

/// Puts an entry back exactly as it was, replacing any that is there.
pub fn restore(db: &Db, entry: &HistoryEntry) -> AppResult<()> {
    db.write(|tx| {
        tx.execute(
            "INSERT OR REPLACE INTO history
                (source, title, duration, position, finished, played_at, state, playlist)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                entry.source,
                entry.title,
                entry.duration,
                entry.position.max(0.0),
                i64::from(entry.finished),
                entry.played_at,
                stored(entry.state.as_ref()),
                stored_playlist(entry.playlist.as_ref())
            ],
        )?;
        Ok(())
    })
}

/// Forgets one entry, and with it the rest of the playlist it was played
/// in: Recently played shows a playlist once, so removing it removes all
/// of it. Returns whether there was one.
pub fn forget(db: &Db, source: &str) -> AppResult<bool> {
    let key = find(db, source)?.and_then(|entry| entry.playlist.map(|playlist| playlist.key));
    db.write(|tx| {
        let mut forgotten = tx.execute("DELETE FROM history WHERE source = ?1", [source])?;
        if let Some(key) = key {
            forgotten += tx.execute(
                "DELETE FROM history WHERE json_extract(playlist, '$.key') = ?1",
                [key],
            )?;
        }
        Ok(forgotten > 0)
    })
}

/// Forgets everything.
pub fn clear(db: &Db) -> AppResult<()> {
    db.write(|tx| {
        tx.execute("DELETE FROM history", [])?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILM: &str = "/films/Solaris.mkv";

    #[test]
    fn resumes_a_little_before_where_it_was_left() {
        assert_eq!(resume_point(2537.0, Some(7305.0)), Some(2534.0));
    }

    #[test]
    fn starts_again_when_barely_begun_nearly_done_or_short() {
        // Ten seconds in is not worth a resume.
        assert_eq!(resume_point(9.0, Some(7305.0)), None);
        // The last 3% is the credits.
        assert_eq!(resume_point(7305.0 - 200.0, Some(7305.0)), None);
        assert_eq!(resume_point(7305.0 - 230.0, Some(7305.0)), Some(7072.0));
        // A song or a clip always starts from the top.
        assert_eq!(resume_point(30.0, Some(45.0)), None);
        assert_eq!(resume_point(200.0, Some(599.0)), None);
        assert_eq!(resume_point(200.0, Some(600.0)), Some(197.0));
        // And so does anything whose length is not known.
        assert_eq!(resume_point(500.0, None), None);
    }

    #[test]
    fn the_end_is_the_last_three_percent_and_never_less_than_ten_seconds() {
        assert!(is_finished(7100.0, 7305.0));
        assert!(!is_finished(7000.0, 7305.0));
        // Three percent of two minutes is under four seconds: ten applies.
        assert!(is_finished(111.0, 120.0));
        assert!(!is_finished(105.0, 120.0));
        assert!(!is_finished(10.0, 0.0));
    }

    #[test]
    fn keeps_what_was_chosen_for_a_film_with_where_it_was_left() {
        use crate::engine::adjust::Shape;
        use crate::engine::types::SubtitleChoice;

        let db = Db::in_memory().unwrap();
        opened(&db, FILM, "Solaris", None, 100).unwrap();
        assert_eq!(find(&db, FILM).unwrap().unwrap().state, None);

        let chosen = FileState {
            audio: Some(2),
            subtitle: Some(SubtitleChoice::Off),
            subtitle_delay: -0.25,
            shape: Shape {
                turns: 1,
                ..Shape::default()
            },
            ..FileState::default()
        };
        progressed(&db, FILM, 2537.0, Some(7305.0), Some(&chosen), 160).unwrap();
        assert_eq!(
            find(&db, FILM).unwrap().unwrap().state,
            Some(chosen.clone())
        );

        // Opened again, played to its end: where it was left is forgotten,
        // what was chosen for it is not.
        opened(&db, FILM, "Solaris", None, 900).unwrap();
        progressed(&db, FILM, 7300.0, Some(7305.0), Some(&chosen), 950).unwrap();
        let ended = find(&db, FILM).unwrap().unwrap();
        assert!(ended.finished);
        assert_eq!(ended.position, 0.0);
        assert_eq!(ended.state, Some(chosen.clone()));

        // Forgotten and put back, it is as it was.
        forget(&db, FILM).unwrap();
        restore(&db, &ended).unwrap();
        assert_eq!(find(&db, FILM).unwrap(), Some(ended.clone()));

        // Where it is can be written without a word about what was chosen.
        restore(&db, &ended).unwrap();
        progressed(&db, FILM, 40.0, Some(7305.0), None, 955).unwrap();
        let moved = find(&db, FILM).unwrap().unwrap();
        assert_eq!(moved.position, 40.0);
        assert_eq!(moved.state, Some(chosen.clone()));

        // Nothing chosen is nothing kept, and what cannot be read is the same.
        progressed(
            &db,
            FILM,
            10.0,
            Some(7305.0),
            Some(&FileState::default()),
            960,
        )
        .unwrap();
        assert_eq!(find(&db, FILM).unwrap().unwrap().state, None);
        db.write(|tx| tx.execute("UPDATE history SET state = 'not json'", []))
            .unwrap();
        assert_eq!(find(&db, FILM).unwrap().unwrap().state, None);
        // One written before a field existed, or after one was added, reads.
        db.write(|tx| {
            tx.execute(
                r#"UPDATE history SET state = '{"audio":2,"fromTheFuture":true,"shape":{"turns":1}}'"#,
                [],
            )
        })
        .unwrap();
        let read = find(&db, FILM).unwrap().unwrap().state.unwrap();
        assert_eq!(read.audio, Some(2));
        assert_eq!(read.shape.turns, 1);
        assert_eq!(read.shape.zoom, 1.0);
    }

    #[test]
    fn remembers_where_a_film_was_left() {
        let db = Db::in_memory().unwrap();
        opened(&db, FILM, "Solaris", None, 100).unwrap();
        progressed(&db, FILM, 2537.0, Some(7305.0), None, 160).unwrap();

        let found = find(&db, FILM).unwrap().unwrap();
        assert_eq!(found.position, 2537.0);
        assert_eq!(found.duration, Some(7305.0));
        assert!(!found.finished);
        assert_eq!(found.played_at, 160);
    }

    #[test]
    fn reads_a_whole_file_name_back_as_names_are_shown_now() {
        let db = Db::in_memory().unwrap();
        // Written when a file's title was its whole name.
        opened(&db, FILM, "Solaris.mkv", None, 100).unwrap();
        assert_eq!(find(&db, FILM).unwrap().unwrap().title, "Solaris");
        assert_eq!(recent(&db, 10).unwrap()[0].title, "Solaris");
    }

    #[test]
    fn opening_again_keeps_the_position() {
        let db = Db::in_memory().unwrap();
        opened(&db, FILM, "Solaris", None, 100).unwrap();
        progressed(&db, FILM, 2537.0, Some(7305.0), None, 160).unwrap();
        opened(&db, FILM, "Solaris", None, 900).unwrap();

        let found = find(&db, FILM).unwrap().unwrap();
        assert_eq!(found.position, 2537.0);
        assert_eq!(found.played_at, 900);
    }

    #[test]
    fn a_film_played_to_the_end_is_finished_and_starts_over_next_time() {
        let db = Db::in_memory().unwrap();
        opened(&db, FILM, "Solaris", None, 100).unwrap();
        progressed(&db, FILM, 7290.0, Some(7305.0), None, 7400).unwrap();

        let found = find(&db, FILM).unwrap().unwrap();
        assert!(found.finished);
        assert_eq!(found.position, 0.0);
        assert_eq!(resume_point(found.position, found.duration), None);
    }

    #[test]
    fn progress_without_a_known_length_keeps_the_length_already_known() {
        let db = Db::in_memory().unwrap();
        opened(&db, FILM, "Solaris", None, 100).unwrap();
        progressed(&db, FILM, 60.0, Some(7305.0), None, 110).unwrap();
        progressed(&db, FILM, 90.0, None, None, 120).unwrap();
        assert_eq!(find(&db, FILM).unwrap().unwrap().duration, Some(7305.0));
    }

    #[test]
    fn progress_for_something_never_opened_is_ignored() {
        let db = Db::in_memory().unwrap();
        progressed(&db, FILM, 60.0, Some(7305.0), None, 110).unwrap();
        assert_eq!(find(&db, FILM).unwrap(), None);
    }

    #[test]
    fn lists_the_most_recent_first() {
        let db = Db::in_memory().unwrap();
        opened(&db, "/a.mkv", "a.mkv", None, 100).unwrap();
        opened(&db, "/b.mkv", "b.mkv", None, 300).unwrap();
        opened(&db, "/c.mkv", "c.mkv", None, 200).unwrap();
        let sources: Vec<_> = recent(&db, 2)
            .unwrap()
            .into_iter()
            .map(|entry| entry.source)
            .collect();
        assert_eq!(sources, ["/b.mkv", "/c.mkv"]);
    }

    #[test]
    fn a_forgotten_entry_can_be_put_back_as_it_was() {
        let db = Db::in_memory().unwrap();
        opened(&db, FILM, "Solaris", None, 100).unwrap();
        progressed(&db, FILM, 2537.0, Some(7305.0), None, 160).unwrap();
        let before = find(&db, FILM).unwrap().unwrap();
        assert!(forget(&db, FILM).unwrap());
        restore(&db, &before).unwrap();
        assert_eq!(find(&db, FILM).unwrap(), Some(before));
    }

    #[test]
    fn says_whether_what_was_played_is_still_there() {
        let here = std::env::temp_dir().join(format!("lumen-history-{}.mkv", std::process::id()));
        std::fs::write(&here, "").unwrap();
        let entry = |source: &str| HistoryEntry {
            source: source.to_owned(),
            title: "x".to_owned(),
            duration: None,
            position: 0.0,
            finished: false,
            played_at: 1,
            state: None,
            playlist: None,
        };
        assert!(Recent::of(entry(&here.to_string_lossy()), None).available);
        assert!(!Recent::of(entry("/no/such/film.mkv"), None).available);
        // An address cannot be looked for; it is taken to be there.
        assert!(Recent::of(entry("https://example.com/a.mp4"), None).available);
        std::fs::remove_file(&here).unwrap();
    }

    #[test]
    fn says_where_opening_it_would_start_by_the_same_rule_that_opens_it() {
        let left_at = |position: f64, duration: f64, finished: bool| {
            Recent::of(
                HistoryEntry {
                    source: FILM.to_owned(),
                    title: "x".to_owned(),
                    duration: Some(duration),
                    position,
                    finished,
                    played_at: 1,
                    state: None,
                    playlist: None,
                },
                None,
            )
            .resumes_at
        };
        assert_eq!(left_at(2537.0, 7305.0, false), Some(2534.0));
        // A clip does not resume, so it is not said to.
        assert_eq!(left_at(4.0, 20.0, false), None);
        assert_eq!(left_at(2537.0, 7305.0, true), None);
    }

    #[test]
    fn forgets_one_entry_or_all_of_them() {
        let db = Db::in_memory().unwrap();
        opened(&db, "/a.mkv", "a.mkv", None, 100).unwrap();
        opened(&db, "/b.mkv", "b.mkv", None, 300).unwrap();
        assert!(forget(&db, "/a.mkv").unwrap());
        assert!(!forget(&db, "/a.mkv").unwrap());
        assert_eq!(recent(&db, 10).unwrap().len(), 1);
        clear(&db).unwrap();
        assert!(recent(&db, 10).unwrap().is_empty());
    }

    fn in_playlist(key: &str, sources: &[&str]) -> PlayedIn {
        PlayedIn {
            key: key.to_owned(),
            name: None,
            items: sources
                .iter()
                .map(|source| PlayedItem {
                    source: (*source).to_owned(),
                    title: (*source).to_owned(),
                    duration: None,
                })
                .collect(),
        }
    }

    #[test]
    fn a_playlist_is_listed_once_by_the_item_played_last() {
        let db = Db::in_memory().unwrap();
        let show = in_playlist("1-0", &["/e1.mkv", "/e2.mkv", "/e3.mkv"]);
        opened(&db, "/e1.mkv", "e1", Some(&show), 100).unwrap();
        opened(&db, "/film.mkv", "film", None, 150).unwrap();
        opened(&db, "/e2.mkv", "e2", Some(&show), 200).unwrap();
        let sources: Vec<_> = recent(&db, 10)
            .unwrap()
            .into_iter()
            .map(|entry| entry.source)
            .collect();
        assert_eq!(sources, ["/e2.mkv", "/film.mkv"]);
        // The limit counts what is listed, not rows.
        assert_eq!(recent(&db, 1).unwrap().len(), 1);
    }

    #[test]
    fn played_alone_later_it_is_no_longer_part_of_the_playlist() {
        let db = Db::in_memory().unwrap();
        let show = in_playlist("1-0", &["/e1.mkv", "/e2.mkv"]);
        opened(&db, "/e1.mkv", "e1", Some(&show), 100).unwrap();
        opened(&db, "/e1.mkv", "e1", None, 200).unwrap();
        assert_eq!(find(&db, "/e1.mkv").unwrap().unwrap().playlist, None);
    }

    #[test]
    fn forgetting_a_playlist_forgets_all_of_it() {
        let db = Db::in_memory().unwrap();
        let show = in_playlist("1-0", &["/e1.mkv", "/e2.mkv"]);
        opened(&db, "/e1.mkv", "e1", Some(&show), 100).unwrap();
        opened(&db, "/e2.mkv", "e2", Some(&show), 200).unwrap();
        opened(&db, "/film.mkv", "film", None, 150).unwrap();
        assert!(forget(&db, "/e2.mkv").unwrap());
        let left: Vec<_> = recent(&db, 10).unwrap().into_iter().map(|e| e.source).collect();
        assert_eq!(left, ["/film.mkv"]);
        // Put back, it is the playlist again.
        let mut entry = find(&db, "/film.mkv").unwrap().unwrap();
        entry.source = "/e2.mkv".to_owned();
        entry.playlist = Some(show.clone());
        restore(&db, &entry).unwrap();
        assert_eq!(find(&db, "/e2.mkv").unwrap().unwrap().playlist, Some(show));
    }
}
