CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,                       -- "<action>:<identity>"
  hits INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL                  -- Unix 秒
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);

ALTER TABLE progress ADD COLUMN last_result TEXT;

UPDATE progress SET last_result = (
  SELECT a.result FROM attempts a
  WHERE a.user_id = progress.user_id AND a.slug = progress.slug
  ORDER BY a.id DESC LIMIT 1
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
