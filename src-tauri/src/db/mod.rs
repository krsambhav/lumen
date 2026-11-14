//! SQLite storage for settings and the library.
//!
//! One connection behind a mutex: every statement Lumen runs is a point read
//! or a small write, so contention is not a concern, and a single writer keeps
//! WAL mode simple.

mod migrations;

use std::path::Path;

use parking_lot::Mutex;
use rusqlite::{Connection, Transaction};

use crate::error::AppResult;

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// Opens (creating if needed) the database at `path` and migrates it.
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        Self::init(Connection::open(path)?)
    }

    /// A private in-memory database, for tests.
    #[cfg(test)]
    pub fn in_memory() -> AppResult<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> AppResult<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrations::run(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Runs read-only statements.
    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> AppResult<T> {
        Ok(f(&self.conn.lock())?)
    }

    /// Runs statements inside one transaction; an error rolls all of it back.
    pub fn write<T>(&self, f: impl FnOnce(&Transaction) -> rusqlite::Result<T>) -> AppResult<T> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let value = f(&tx)?;
        tx.commit()?;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_rolls_back_on_error() {
        let db = Db::in_memory().unwrap();
        let result = db.write(|tx| {
            tx.execute("INSERT INTO settings (key, value) VALUES ('a', '1')", [])?;
            tx.execute("INSERT INTO no_such_table VALUES (1)", [])?;
            Ok(())
        });
        assert!(result.is_err());
        let rows: i64 = db
            .read(|c| c.query_row("SELECT count(*) FROM settings", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn opens_and_reopens_a_file_database() {
        let dir = std::env::temp_dir().join(format!("lumen-db-test-{}", std::process::id()));
        let path = dir.join("nested").join("lumen.db");
        {
            let db = Db::open(&path).unwrap();
            db.write(|tx| tx.execute("INSERT INTO settings (key, value) VALUES ('k', 'v')", []))
                .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let value: String = db
            .read(|c| {
                c.query_row("SELECT value FROM settings WHERE key = 'k'", [], |r| {
                    r.get(0)
                })
            })
            .unwrap();
        assert_eq!(value, "v");
        drop(db);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
