//! Schema migrations, applied in order and tracked in `PRAGMA user_version`.

use rusqlite::Connection;

/// Append only. Never edit a migration that has shipped.
const MIGRATIONS: &[&str] = &[
    include_str!("../../migrations/0001_settings.sql"),
    include_str!("../../migrations/0002_history_playlists.sql"),
    include_str!("../../migrations/0003_file_state.sql"),
];

pub fn run(conn: &mut Connection) -> rusqlite::Result<()> {
    let current: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let latest = MIGRATIONS.len() as u32;
    if current > latest {
        // A newer Lumen wrote this file. Refuse rather than guess at its schema.
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "database schema {current} is newer than this version of Lumen supports ({latest})"
        )));
    }
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", index as u32 + 1)?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(conn: &Connection) -> u32 {
        conn.pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn applies_every_migration_once() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn).unwrap();
        assert_eq!(version(&conn), MIGRATIONS.len() as u32);
        // Running again must be a no-op, not a "table already exists" error.
        run(&mut conn).unwrap();
        assert_eq!(version(&conn), MIGRATIONS.len() as u32);
    }

    #[test]
    fn refuses_a_database_from_a_newer_version() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", MIGRATIONS.len() as u32 + 1)
            .unwrap();
        assert!(run(&mut conn).is_err());
    }
}
