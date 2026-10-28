CREATE INDEX IF NOT EXISTS idx_progress_user_done_last_attempt
  ON progress(user_id, done, last_attempt_at DESC);
