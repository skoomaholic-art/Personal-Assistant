-- Only staging data lives here until a separate reconciliation/migration is approved.
CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued',
  response_json TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telegram_updates_state ON telegram_updates(status, claimed_at);
CREATE TABLE IF NOT EXISTS emails (
  email_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  from_name TEXT NOT NULL DEFAULT '',
  from_email TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'ПИСЬМО',
  priority TEXT NOT NULL DEFAULT 'средний',
  deadline_text TEXT NOT NULL DEFAULT '',
  deadline_iso TEXT NOT NULL DEFAULT '',
  has_attachments INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'NEW',
  notification_status TEXT NOT NULL DEFAULT 'disabled'
);
CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_category ON emails(category, priority);
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  email_id TEXT UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'NEW',
  priority TEXT NOT NULL DEFAULT 'средний',
  due_iso TEXT NOT NULL DEFAULT '',
  due_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_iso);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_chat ON history(chat_id, id DESC);
CREATE TABLE IF NOT EXISTS states (
  chat_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
