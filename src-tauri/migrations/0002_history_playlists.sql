-- What has been played, and where it was left: resume, "Continue watching"
-- and "Recently played" all read this. One row per file or address.
CREATE TABLE history (
    source    TEXT PRIMARY KEY NOT NULL,
    title     TEXT NOT NULL,
    -- Seconds. Unknown until the file has been opened far enough to tell.
    duration  REAL,
    -- Seconds from the start, where playback last was.
    position  REAL NOT NULL DEFAULT 0,
    -- 1 once it has been played to the end (or near enough).
    finished  INTEGER NOT NULL DEFAULT 0,
    -- Unix seconds.
    played_at INTEGER NOT NULL
) STRICT;

CREATE INDEX history_played_at ON history (played_at DESC);

-- Playlists the user has saved by name. The queue being played is not
-- stored here; it lives in memory until it is saved.
CREATE TABLE playlists (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    -- Set when the user deletes it. It is kept until the next launch so that
    -- the deletion can be undone, and is invisible in the meantime.
    deleted_at INTEGER
) STRICT;

CREATE TABLE playlist_items (
    playlist_id INTEGER NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    source      TEXT NOT NULL,
    title       TEXT NOT NULL,
    duration    REAL,
    PRIMARY KEY (playlist_id, position)
) STRICT, WITHOUT ROWID;
