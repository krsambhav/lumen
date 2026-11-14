-- What was chosen for a file the last time it was open (its tracks, its
-- delays, how its picture was shaped), as JSON; NULL when nothing was.
ALTER TABLE history ADD COLUMN state TEXT;
