-- The playlist something was played in, as JSON (its key, its name if it
-- was saved, and its items in order), so Recently played can show the
-- playlist once and bring all of it back. NULL for something played alone.
ALTER TABLE history ADD COLUMN playlist TEXT;
