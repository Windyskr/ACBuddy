CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,                 -- pbkdf2$iterations$salt_b64$hash_b64
  api_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS progress (
  user_id INTEGER NOT NULL REFERENCES users(id),
  slug TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  mastery INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  first_attempt_at TEXT,
  last_attempt_at TEXT,
  total_time_ms INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, slug)
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  slug TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('pass', 'fail')),
  time_ms INTEGER NOT NULL,
  language TEXT,
  submission_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attempts_user_id_id_desc ON attempts(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_user_slug ON attempts(user_id, slug);
CREATE INDEX IF NOT EXISTS idx_progress_user_recent ON progress(user_id, last_attempt_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
