-- Staging-only inbox for messages that mention the owner or reply to them.
-- Apply once to the existing D1 after checking its migration ledger.
CREATE TABLE IF NOT EXISTS telegram_mentions (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  sender_id TEXT NOT NULL DEFAULT '',
  chat_title TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  source_link TEXT NOT NULL DEFAULT '',
  signal TEXT NOT NULL DEFAULT 'mention',
  category TEXT NOT NULL DEFAULT 'PENDING',
  summary TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'средний',
  task_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  claimed_at INTEGER NOT NULL DEFAULT 0,
  notification_status TEXT NOT NULL DEFAULT 'disabled',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telegram_mentions_news
  ON telegram_mentions(category,status,created_at DESC);
