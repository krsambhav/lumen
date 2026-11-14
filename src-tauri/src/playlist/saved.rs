//! Playlists saved by name.
//!
//! A saved playlist is a copy of the queue as it was when it was saved.
//! Opening one copies it back; nothing here follows the queue afterwards.

use rusqlite::{params, OptionalExtension, Transaction};
use serde::Serialize;
use specta::Type;
use specta_typescript::Number;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::media::sources::shown_title;

/// The longest name a playlist may have, in characters.
pub const MAX_NAME: usize = 120;

/// A saved playlist, without its items.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedPlaylist {
    pub id: u32,
    pub name: String,
    /// How many items it holds.
    pub count: u32,
    /// The length of the items whose length is known, in seconds.
    #[specta(type = Number)]
    pub duration: f64,
    /// Unix seconds.
    #[specta(type = Number)]
    pub updated_at: i64,
}

/// One item of a saved playlist.
#[derive(Debug, Clone, PartialEq)]
pub struct SavedItem {
    pub source: String,
    pub title: String,
    pub duration: Option<f64>,
}

/// A name as it is stored: trimmed, and refused if nothing is left or it is
/// too long to be a name.
pub fn clean_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Invalid("a playlist needs a name".to_owned()));
    }
    if name.chars().count() > MAX_NAME {
        return Err(AppError::Invalid(format!(
            "a playlist's name can be at most {MAX_NAME} characters"
        )));
    }
    Ok(name.to_owned())
}

/// Two names are the same playlist if they differ only in case.
fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

const SUMMARY: &str = "SELECT p.id, p.name, p.updated_at,
            count(i.position), coalesce(sum(i.duration), 0)
       FROM playlists p LEFT JOIN playlist_items i ON i.playlist_id = p.id";

fn summary(row: &rusqlite::Row) -> rusqlite::Result<SavedPlaylist> {
    Ok(SavedPlaylist {
        id: row.get(0)?,
        name: row.get(1)?,
        updated_at: row.get(2)?,
        count: row.get(3)?,
        duration: row.get(4)?,
    })
}

/// Every playlist that has not been deleted.
fn all(tx: &rusqlite::Connection) -> rusqlite::Result<Vec<SavedPlaylist>> {
    let mut statement = tx.prepare(&format!(
        "{SUMMARY} WHERE p.deleted_at IS NULL GROUP BY p.id"
    ))?;
    let rows = statement.query_map([], summary)?;
    rows.collect()
}

fn one(tx: &rusqlite::Connection, id: u32) -> rusqlite::Result<Option<SavedPlaylist>> {
    tx.query_row(
        &format!("{SUMMARY} WHERE p.id = ?1 AND p.deleted_at IS NULL GROUP BY p.id"),
        [id],
        summary,
    )
    .optional()
}

fn write_items(tx: &Transaction, id: u32, items: &[SavedItem]) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM playlist_items WHERE playlist_id = ?1", [id])?;
    let mut insert = tx.prepare(
        "INSERT INTO playlist_items (playlist_id, position, source, title, duration)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for (position, item) in items.iter().enumerate() {
        insert.execute(params![
            id,
            position as i64,
            item.source,
            item.title,
            item.duration
        ])?;
    }
    Ok(())
}

/// Every saved playlist, by name.
pub fn list(db: &Db) -> AppResult<Vec<SavedPlaylist>> {
    let mut playlists = db.read(all)?;
    playlists.sort_by(|a, b| crate::media::sources::natural_cmp(&a.name, &b.name));
    Ok(playlists)
}

/// Saves `items` under `name`. If a playlist of that name exists it is
/// replaced when `replace` is set, and otherwise the save is refused with
/// `AppError::Exists`, so nothing is ever overwritten by accident.
pub fn save(
    db: &Db,
    name: &str,
    items: &[SavedItem],
    replace: bool,
    now: i64,
) -> AppResult<SavedPlaylist> {
    let name = clean_name(name)?;
    if items.is_empty() {
        return Err(AppError::Invalid(
            "there is nothing in the playlist to save".to_owned(),
        ));
    }
    let saved = db.write(|tx| {
        let existing = all(tx)?
            .into_iter()
            .find(|playlist| same_name(&playlist.name, &name));
        let id = match existing {
            Some(_) if !replace => return Ok(None),
            Some(playlist) => {
                // The name is taken as typed this time: its case may have changed.
                tx.execute(
                    "UPDATE playlists SET name = ?2, updated_at = ?3 WHERE id = ?1",
                    params![playlist.id, name, now],
                )?;
                playlist.id
            }
            None => {
                tx.execute(
                    "INSERT INTO playlists (name, created_at, updated_at) VALUES (?1, ?2, ?2)",
                    params![name, now],
                )?;
                tx.last_insert_rowid() as u32
            }
        };
        write_items(tx, id, items)?;
        one(tx, id)
    })?;
    saved.ok_or_else(|| AppError::Exists(format!("there is already a playlist called “{name}”")))
}

/// The items of a saved playlist, in order.
pub fn items(db: &Db, id: u32) -> AppResult<Vec<SavedItem>> {
    let found = db.read(|conn| {
        if one(conn, id)?.is_none() {
            return Ok(None);
        }
        let mut statement = conn.prepare(
            "SELECT source, title, duration FROM playlist_items
              WHERE playlist_id = ?1 ORDER BY position",
        )?;
        let rows = statement.query_map([id], |row| {
            let source: String = row.get(0)?;
            let title = shown_title(&source, row.get(1)?);
            Ok(SavedItem {
                source,
                title,
                duration: row.get(2)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map(Some)
    })?;
    found.ok_or_else(|| AppError::NotFound("that playlist is no longer saved".to_owned()))
}

/// The name of a saved playlist, if it is still there.
pub fn name_of(db: &Db, id: u32) -> AppResult<Option<String>> {
    Ok(db.read(|conn| one(conn, id))?.map(|playlist| playlist.name))
}

/// Gives a saved playlist another name. Refused with `AppError::Exists` if
/// another playlist already has it.
pub fn rename(db: &Db, id: u32, name: &str, now: i64) -> AppResult<SavedPlaylist> {
    let name = clean_name(name)?;
    enum Outcome {
        Renamed(SavedPlaylist),
        Missing,
        Taken,
    }
    let outcome = db.write(|tx| {
        let playlists = all(tx)?;
        if !playlists.iter().any(|playlist| playlist.id == id) {
            return Ok(Outcome::Missing);
        }
        if playlists
            .iter()
            .any(|playlist| playlist.id != id && same_name(&playlist.name, &name))
        {
            return Ok(Outcome::Taken);
        }
        tx.execute(
            "UPDATE playlists SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now],
        )?;
        Ok(one(tx, id)?.map_or(Outcome::Missing, Outcome::Renamed))
    })?;
    match outcome {
        Outcome::Renamed(playlist) => Ok(playlist),
        Outcome::Missing => Err(AppError::NotFound(
            "that playlist is no longer saved".to_owned(),
        )),
        Outcome::Taken => Err(AppError::Exists(format!(
            "there is already a playlist called “{name}”"
        ))),
    }
}

/// Deletes a saved playlist. Returns whether there was one.
///
/// It is only marked as deleted, so that `undelete` can bring it back; what
/// is marked is cleared out by `purge` at the next launch.
pub fn delete(db: &Db, id: u32, now: i64) -> AppResult<bool> {
    db.write(|tx| {
        Ok(tx.execute(
            "UPDATE playlists SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, now],
        )? > 0)
    })
}

/// Brings back a playlist that was deleted since the last launch. Refused
/// with `AppError::Exists` if its name has been taken in the meantime.
pub fn undelete(db: &Db, id: u32) -> AppResult<SavedPlaylist> {
    enum Outcome {
        Back(SavedPlaylist),
        Missing,
        Taken(String),
    }
    let outcome = db.write(|tx| {
        let name: Option<String> = tx
            .query_row(
                "SELECT name FROM playlists WHERE id = ?1 AND deleted_at IS NOT NULL",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(name) = name else {
            return Ok(Outcome::Missing);
        };
        if all(tx)?
            .iter()
            .any(|playlist| same_name(&playlist.name, &name))
        {
            return Ok(Outcome::Taken(name));
        }
        tx.execute("UPDATE playlists SET deleted_at = NULL WHERE id = ?1", [id])?;
        Ok(one(tx, id)?.map_or(Outcome::Missing, Outcome::Back))
    })?;
    match outcome {
        Outcome::Back(playlist) => Ok(playlist),
        Outcome::Missing => Err(AppError::NotFound(
            "that playlist can no longer be brought back".to_owned(),
        )),
        Outcome::Taken(name) => Err(AppError::Exists(format!(
            "there is now another playlist called “{name}”"
        ))),
    }
}

/// Clears out what was deleted. Run once at launch: after that, a deletion
/// from the run before can no longer be undone.
pub fn purge(db: &Db) -> AppResult<()> {
    db.write(|tx| {
        tx.execute("DELETE FROM playlists WHERE deleted_at IS NOT NULL", [])?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(name: &str, duration: Option<f64>) -> SavedItem {
        SavedItem {
            source: format!("/films/{name}.mkv"),
            title: name.to_owned(),
            duration,
        }
    }

    fn trilogy() -> Vec<SavedItem> {
        vec![
            item("Blue", Some(5880.0)),
            item("White", None),
            item("Red", Some(5940.0)),
        ]
    }

    #[test]
    fn saves_a_playlist_and_reads_it_back_in_order() {
        let db = Db::in_memory().unwrap();
        let saved = save(&db, "  Three Colours ", &trilogy(), false, 100).unwrap();
        assert_eq!(saved.name, "Three Colours");
        assert_eq!(saved.count, 3);
        // The length of what is known; the item of unknown length adds nothing.
        assert_eq!(saved.duration, 11_820.0);
        assert_eq!(saved.updated_at, 100);
        assert_eq!(items(&db, saved.id).unwrap(), trilogy());
        assert_eq!(list(&db).unwrap(), vec![saved]);
    }

    #[test]
    fn reads_a_whole_file_name_back_as_names_are_shown_now() {
        let db = Db::in_memory().unwrap();
        let kept = [
            // Saved when a file's title was its whole name.
            SavedItem {
                title: "Blue.mkv".to_owned(),
                ..item("Blue", None)
            },
            // Named by a playlist file: not the file's name, so it stays.
            SavedItem {
                title: "Three Colours: White".to_owned(),
                ..item("White", None)
            },
        ];
        let saved = save(&db, "Three Colours", &kept, false, 100).unwrap();
        let titles: Vec<String> = items(&db, saved.id)
            .unwrap()
            .into_iter()
            .map(|item| item.title)
            .collect();
        assert_eq!(titles, ["Blue", "Three Colours: White"]);
    }

    #[test]
    fn never_overwrites_a_name_unless_told_to() {
        let db = Db::in_memory().unwrap();
        let first = save(&db, "Evening", &trilogy(), false, 100).unwrap();
        // Case does not make it a different playlist.
        let refused = save(&db, "evening", &[item("Other", None)], false, 200);
        assert!(matches!(refused, Err(AppError::Exists(_))), "{refused:?}");
        assert_eq!(items(&db, first.id).unwrap().len(), 3);

        let replaced = save(&db, "evening", &[item("Other", None)], true, 200).unwrap();
        assert_eq!(replaced.id, first.id);
        assert_eq!(replaced.name, "evening");
        assert_eq!(replaced.count, 1);
        assert_eq!(replaced.updated_at, 200);
        assert_eq!(list(&db).unwrap().len(), 1);
    }

    #[test]
    fn refuses_a_blank_or_endless_name_and_an_empty_playlist() {
        let db = Db::in_memory().unwrap();
        assert!(matches!(
            save(&db, "   ", &trilogy(), false, 1),
            Err(AppError::Invalid(_))
        ));
        assert!(matches!(
            save(&db, &"x".repeat(MAX_NAME + 1), &trilogy(), false, 1),
            Err(AppError::Invalid(_))
        ));
        assert!(save(&db, &"é".repeat(MAX_NAME), &trilogy(), false, 1).is_ok());
        assert!(matches!(
            save(&db, "Empty", &[], false, 1),
            Err(AppError::Invalid(_))
        ));
    }

    #[test]
    fn lists_by_name_as_a_person_would_order_them() {
        let db = Db::in_memory().unwrap();
        for name in ["Season 10", "season 2", "Albums"] {
            save(&db, name, &trilogy(), false, 1).unwrap();
        }
        let names: Vec<_> = list(&db).unwrap().into_iter().map(|p| p.name).collect();
        assert_eq!(names, ["Albums", "season 2", "Season 10"]);
    }

    #[test]
    fn renames_unless_the_name_is_taken() {
        let db = Db::in_memory().unwrap();
        let first = save(&db, "Evening", &trilogy(), false, 1).unwrap();
        let second = save(&db, "Morning", &trilogy(), false, 1).unwrap();
        assert!(matches!(
            rename(&db, second.id, "EVENING", 2),
            Err(AppError::Exists(_))
        ));
        // Its own name in another case is not a clash.
        assert_eq!(rename(&db, first.id, "evening", 3).unwrap().name, "evening");
        assert_eq!(rename(&db, second.id, "Night", 4).unwrap().updated_at, 4);
        assert!(matches!(
            rename(&db, 4242, "Nowhere", 5),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn a_deleted_playlist_is_gone_from_view_and_its_items_go_at_the_next_launch() {
        let db = Db::in_memory().unwrap();
        let saved = save(&db, "Evening", &trilogy(), false, 1).unwrap();
        assert!(delete(&db, saved.id, 2).unwrap());
        assert!(!delete(&db, saved.id, 3).unwrap());
        assert!(list(&db).unwrap().is_empty());
        assert!(matches!(items(&db, saved.id), Err(AppError::NotFound(_))));
        assert_eq!(name_of(&db, saved.id).unwrap(), None);

        purge(&db).unwrap();
        let orphans: i64 = db
            .read(|conn| conn.query_row("SELECT count(*) FROM playlist_items", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(orphans, 0);
        assert!(matches!(
            undelete(&db, saved.id),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn a_deletion_can_be_undone_until_the_name_is_taken() {
        let db = Db::in_memory().unwrap();
        let saved = save(&db, "Evening", &trilogy(), false, 1).unwrap();
        delete(&db, saved.id, 2).unwrap();
        let back = undelete(&db, saved.id).unwrap();
        assert_eq!(back, saved);
        assert_eq!(items(&db, saved.id).unwrap(), trilogy());

        // Its name is free while it is deleted; whoever takes it keeps it.
        delete(&db, saved.id, 3).unwrap();
        save(&db, "evening", &trilogy(), false, 4).unwrap();
        assert!(matches!(undelete(&db, saved.id), Err(AppError::Exists(_))));
        // Something never deleted cannot be brought back.
        assert!(matches!(undelete(&db, 4242), Err(AppError::NotFound(_))));
    }
}
