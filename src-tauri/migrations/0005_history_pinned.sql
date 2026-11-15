-- 1 when the user has pinned it to Recently played: "Clear" leaves it, and
-- it is listed before everything else. A playlist counts as pinned if any
-- of its items is.
ALTER TABLE history ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
