-- Local, unsent D1 previews only. No Gmail draft is created and no email is sent.
-- Before implementing real send, require explicit alias/recipient/subject/attachments
-- reconciliation with Gmail plus a durable send-unknown state machine.
CREATE TABLE IF NOT EXISTS reply_drafts (
  draft_id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PREVIEW',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(email_id) REFERENCES emails(email_id)
);
CREATE INDEX IF NOT EXISTS idx_reply_drafts_email ON reply_drafts(email_id,created_at DESC);
