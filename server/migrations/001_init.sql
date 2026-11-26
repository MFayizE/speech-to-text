CREATE TABLE IF NOT EXISTS transcriptions (
  id           BIGSERIAL PRIMARY KEY,
  title        VARCHAR(200) NOT NULL DEFAULT '',
  text         TEXT NOT NULL,
  language     VARCHAR(32),
  provider     VARCHAR(32) NOT NULL DEFAULT 'manual',
  duration_ms  INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transcriptions_created_at ON transcriptions (created_at DESC);
