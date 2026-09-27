-- Refresh tokens are encrypted with an AES-GCM key derived from Cloudflare
-- secrets. Only the owner's Google OAuth callback may update this record.
-- No tokens, passwords, or Google authorization codes belong in GitHub.
CREATE TABLE IF NOT EXISTS oauth_credentials (
  provider TEXT PRIMARY KEY,
  encrypted_refresh_token TEXT NOT NULL,
  account_email TEXT NOT NULL,
  granted_scopes TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
