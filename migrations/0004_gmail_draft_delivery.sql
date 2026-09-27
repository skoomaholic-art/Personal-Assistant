-- Cloudflare draft-send state machine, applied only once to staging after
-- checking actual schema and Wrangler migration journal. All existing rows
-- remain local PREVIEW drafts; outbound email remains disabled by default.
ALTER TABLE reply_drafts ADD COLUMN gmail_draft_id TEXT NOT NULL DEFAULT '';
ALTER TABLE reply_drafts ADD COLUMN from_email TEXT NOT NULL DEFAULT '';
ALTER TABLE reply_drafts ADD COLUMN cc_line TEXT NOT NULL DEFAULT '';
ALTER TABLE reply_drafts ADD COLUMN bcc_line TEXT NOT NULL DEFAULT '';
ALTER TABLE reply_drafts ADD COLUMN attachment_manifest TEXT NOT NULL DEFAULT '[]';
ALTER TABLE reply_drafts ADD COLUMN snapshot_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE reply_drafts ADD COLUMN preview_token TEXT NOT NULL DEFAULT '';
ALTER TABLE reply_drafts ADD COLUMN sent_message_id TEXT NOT NULL DEFAULT '';
ALTER TABLE reply_drafts ADD COLUMN sent_at TEXT NOT NULL DEFAULT '';
ALTER TABLE reply_drafts ADD COLUMN last_error TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_reply_drafts_status ON reply_drafts(status,updated_at DESC);
