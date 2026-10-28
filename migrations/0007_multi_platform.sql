CREATE TABLE progress_v10 (
  user_id INTEGER NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL,                      -- leetcode | codeforces | atcoder | acwing | luogu
  slug TEXT NOT NULL,                          -- 力扣 titleSlug、CF "1520B"、AtCoder "abc300_a"……
  title TEXT,
  difficulty TEXT,                             -- 平台原生难度：EASY/MEDIUM/HARD、CF rating……
  done INTEGER NOT NULL DEFAULT 0,
  mastery INTEGER NOT NULL DEFAULT 0 CHECK (mastery BETWEEN 0 AND 5),
  urgency INTEGER NOT NULL DEFAULT 0 CHECK (urgency BETWEEN 0 AND 3),
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  note TEXT,
  first_attempt_at TEXT,                       -- UTC
  last_attempt_at TEXT,                        -- UTC
  total_time_ms INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_result TEXT CHECK (last_result IN ('pass', 'fail')),
  PRIMARY KEY (user_id, platform, slug)
);
INSERT INTO progress_v10 (
  user_id, platform, slug, done, mastery, urgency, tags, note,
  first_attempt_at, last_attempt_at, total_time_ms, attempt_count, last_result
)
SELECT user_id, 'leetcode', slug, done, mastery, urgency, tags, note,
       first_attempt_at, last_attempt_at, total_time_ms, attempt_count, last_result
FROM progress;

CREATE TABLE attempts_v10 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL,
  slug TEXT NOT NULL,
  site TEXT NOT NULL,                          -- leetcode.cn | leetcode.com | codeforces.com ……
  result TEXT NOT NULL CHECK (result IN ('pass', 'fail')),
  verdict TEXT,                                -- 平台原始判题结果：Accepted / Wrong Answer ……
  time_ms INTEGER,
  language TEXT,
  submission_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO attempts_v10 (id, user_id, platform, slug, site, result, time_ms, language, submission_id, note, created_at)
SELECT id, user_id, 'leetcode', slug, 'leetcode.cn', result, time_ms, language, submission_id, note, created_at
FROM attempts;

DROP TABLE progress;
DROP TABLE attempts;
ALTER TABLE progress_v10 RENAME TO progress;
ALTER TABLE attempts_v10 RENAME TO attempts;

CREATE INDEX idx_progress_user_recent ON progress(user_id, last_attempt_at DESC);
CREATE INDEX idx_attempts_user_id_id_desc ON attempts(user_id, id DESC);
CREATE INDEX idx_attempts_user_problem ON attempts(user_id, platform, slug);
CREATE UNIQUE INDEX idx_attempts_user_site_submission
  ON attempts(user_id, site, submission_id) WHERE submission_id IS NOT NULL;
