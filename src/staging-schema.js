// Temporary staging-only bootstrap. Generated from migrations/0001_init.sql.
// Never use on the production bot; remove flag after first successful staging setup.
export const STAGING_SCHEMA_STATEMENTS = Object.freeze([
  "CREATE TABLE IF NOT EXISTS telegram_updates (\n  update_id INTEGER PRIMARY KEY,\n  status TEXT NOT NULL DEFAULT 'queued',\n  response_json TEXT NOT NULL DEFAULT '',\n  attempts INTEGER NOT NULL DEFAULT 0,\n  claimed_at INTEGER NOT NULL DEFAULT 0,\n  created_at INTEGER NOT NULL\n)",
  "CREATE INDEX IF NOT EXISTS idx_telegram_updates_state ON telegram_updates(status, claimed_at)",
  "CREATE TABLE IF NOT EXISTS emails (\n  email_id TEXT PRIMARY KEY,\n  received_at TEXT NOT NULL,\n  from_name TEXT NOT NULL DEFAULT '',\n  from_email TEXT NOT NULL DEFAULT '',\n  subject TEXT NOT NULL DEFAULT '',\n  summary TEXT NOT NULL DEFAULT '',\n  action TEXT NOT NULL DEFAULT '',\n  category TEXT NOT NULL DEFAULT 'ПИСЬМО',\n  priority TEXT NOT NULL DEFAULT 'средний',\n  deadline_text TEXT NOT NULL DEFAULT '',\n  deadline_iso TEXT NOT NULL DEFAULT '',\n  has_attachments INTEGER NOT NULL DEFAULT 0,\n  status TEXT NOT NULL DEFAULT 'NEW',\n  notification_status TEXT NOT NULL DEFAULT 'disabled'\n)",
  "CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_emails_category ON emails(category, priority)",
  "CREATE TABLE IF NOT EXISTS tasks (\n  task_id TEXT PRIMARY KEY,\n  email_id TEXT UNIQUE,\n  title TEXT NOT NULL,\n  description TEXT NOT NULL DEFAULT '',\n  status TEXT NOT NULL DEFAULT 'NEW',\n  priority TEXT NOT NULL DEFAULT 'средний',\n  due_iso TEXT NOT NULL DEFAULT '',\n  due_text TEXT NOT NULL DEFAULT '',\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n)",
  "CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_iso)",
  "CREATE TABLE IF NOT EXISTS history (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  chat_id TEXT NOT NULL,\n  event_id TEXT NOT NULL UNIQUE,\n  role TEXT NOT NULL,\n  content TEXT NOT NULL,\n  created_at INTEGER NOT NULL\n)",
  "CREATE INDEX IF NOT EXISTS idx_history_chat ON history(chat_id, id DESC)",
  "CREATE TABLE IF NOT EXISTS states (\n  chat_id TEXT PRIMARY KEY,\n  mode TEXT NOT NULL,\n  data TEXT NOT NULL DEFAULT '',\n  updated_at INTEGER NOT NULL\n)"
]);
