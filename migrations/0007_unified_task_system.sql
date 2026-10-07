-- Unified source context, task metadata, comments and durable change history.
-- All objects are additive so existing emails, tasks and Telegram records stay intact.
CREATE TABLE IF NOT EXISTS task_metadata (
  task_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_id TEXT NOT NULL DEFAULT '',
  source_thread_key TEXT NOT NULL DEFAULT '',
  source_author TEXT NOT NULL DEFAULT '',
  source_title TEXT NOT NULL DEFAULT '',
  source_link TEXT NOT NULL DEFAULT '',
  original_text TEXT NOT NULL DEFAULT '',
  suggested_priority TEXT NOT NULL DEFAULT 'средний',
  manual_priority TEXT NOT NULL DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT '',
  restored_at TEXT NOT NULL DEFAULT '',
  last_source_at TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_metadata_source
  ON task_metadata(source_type,source_id) WHERE source_id!='';
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_metadata_thread
  ON task_metadata(source_thread_key) WHERE source_thread_key!='';
CREATE INDEX IF NOT EXISTS idx_task_metadata_author
  ON task_metadata(source_author);

CREATE TABLE IF NOT EXISTS inbound_events (
  event_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  thread_key TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  source_title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  source_link TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL DEFAULT 'PENDING',
  task_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_source
  ON inbound_events(source_type,source_id);
CREATE INDEX IF NOT EXISTS idx_inbound_recent
  ON inbound_events(classification,created_at DESC);

CREATE TABLE IF NOT EXISTS task_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  source_link TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_updates_task
  ON task_updates(task_id,id DESC);

CREATE TABLE IF NOT EXISTS task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task
  ON task_comments(task_id,id DESC);

CREATE TABLE IF NOT EXISTS task_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_history_task
  ON task_history(task_id,id DESC);

CREATE TABLE IF NOT EXISTS telegram_message_context (
  mention_id TEXT PRIMARY KEY,
  thread_key TEXT NOT NULL DEFAULT '',
  reply_to_message_id INTEGER NOT NULL DEFAULT 0,
  addressed_to_owner INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notification_events (
  dedupe_key TEXT PRIMARY KEY,
  event_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed',
  created_at TEXT NOT NULL,
  delivered_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_notification_status
  ON notification_events(status,created_at);
