-- Topic segment of an email or a task (sport, content, promo codes, other work,
-- news, non-work). Additive and idempotent: safe to run on every deploy.
CREATE TABLE IF NOT EXISTS item_segments (
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  segment TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, item_id)
);
CREATE INDEX IF NOT EXISTS idx_item_segments_segment
  ON item_segments(kind, segment);
