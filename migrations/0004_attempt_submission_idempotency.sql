DROP TABLE IF EXISTS migration_0004_affected_progress;
CREATE TABLE migration_0004_affected_progress AS
SELECT DISTINCT attempts.user_id, attempts.slug
FROM attempts
JOIN (
  SELECT user_id, submission_id
  FROM attempts
  WHERE submission_id IS NOT NULL
  GROUP BY user_id, submission_id
  HAVING COUNT(*) > 1
) duplicates
  ON duplicates.user_id = attempts.user_id
 AND duplicates.submission_id = attempts.submission_id;

UPDATE attempts AS keeper
SET note = COALESCE(
  keeper.note,
  (
    SELECT duplicate.note
    FROM attempts AS duplicate
    WHERE duplicate.user_id = keeper.user_id
      AND duplicate.submission_id = keeper.submission_id
      AND duplicate.note IS NOT NULL
    ORDER BY duplicate.id DESC
    LIMIT 1
  )
)
WHERE keeper.submission_id IS NOT NULL
  AND keeper.id = (
    SELECT MAX(latest.id)
    FROM attempts AS latest
    WHERE latest.user_id = keeper.user_id
      AND latest.submission_id = keeper.submission_id
  );

DELETE FROM attempts
WHERE submission_id IS NOT NULL
  AND id NOT IN (
    SELECT MAX(id) FROM attempts
    WHERE submission_id IS NOT NULL
    GROUP BY user_id, submission_id
  );

UPDATE progress
SET done = EXISTS(
      SELECT 1 FROM attempts a
      WHERE a.user_id = progress.user_id AND a.slug = progress.slug AND a.result = 'pass'
    ),
    attempt_count = (
      SELECT COUNT(*) FROM attempts a
      WHERE a.user_id = progress.user_id AND a.slug = progress.slug
    ),
    total_time_ms = (
      SELECT COALESCE(SUM(a.time_ms), 0) FROM attempts a
      WHERE a.user_id = progress.user_id AND a.slug = progress.slug
    ),
    first_attempt_at = (
      SELECT MIN(a.created_at) FROM attempts a
      WHERE a.user_id = progress.user_id AND a.slug = progress.slug
    ),
    last_attempt_at = (
      SELECT MAX(a.created_at) FROM attempts a
      WHERE a.user_id = progress.user_id AND a.slug = progress.slug
    )
WHERE EXISTS (
  SELECT 1 FROM migration_0004_affected_progress affected
  WHERE affected.user_id = progress.user_id AND affected.slug = progress.slug
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_user_submission
  ON attempts(user_id, submission_id) WHERE submission_id IS NOT NULL;

DROP TABLE migration_0004_affected_progress;
