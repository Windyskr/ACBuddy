ALTER TABLE progress
  ADD COLUMN tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags));
