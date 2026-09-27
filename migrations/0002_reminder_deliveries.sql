-- Cloudflare staging: claim reminder attempts durably before Telegram delivery.
-- Prevent concurrent Cron invocations from sending the same reminder twice.
-- This is not an outbound email table. No historical Gmail data is copied.
CREATE TABLE IF NOT EXISTS reminder_deliveries (
  task_id TEXT PRIMARY KEY,
  attempted_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  FOREIGN KEY(task_id) REFERENCES tasks(task_id)
);
CREATE INDEX IF NOT EXISTS idx_reminder_deliveries_attempted
  ON reminder_deliveries(attempted_at);
