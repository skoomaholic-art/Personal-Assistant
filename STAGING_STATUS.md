# Rahal Mamut | Cloudflare staging status

Existing Google Apps Script bot remains the only live Telegram bot. No existing Telegram webhook has been changed.

## Deployed infrastructure
- Private GitHub repo: `skoomaholic-art/Personal-Assistant`, Worker build branch: `cloudflare-staging`.
- Test Worker: `https://rahal-mamut-staging.alexandr-petrossov.workers.dev/`.
- D1 database `rahal-mamut-staging` has five core tables `emails`, `tasks`, `history`, `states`, `telegram_updates` verified earlier via `/health/db`, plus `reminder_deliveries` and `reply_drafts` verified via the live `/health/features` on 2026-09-28. The Wrangler migration ledger has not been independently verified.
- Queues: `rahal-mamut-jobs`, `rahal-mamut-dead-letter`.
- `GET /health`, `GET /health/db`, `GET /health/features` are read-only checks. Confirm Cloudflare has deployed the latest GitHub revision after CI completes.

## Ported code on this branch
- Archived legacy source: `legacy/{Code,Storage,Webhook,MailActions}.gs`.
- Telegram fast commands, menu, D1 search/tasks, background Groq.
- Gmail REST read-only polling + original work-mail filter + strict Groq email classification and durable task creation; disabled until Google consent.
- Work-email Telegram notifications with a durable claim; disabled to avoid duplicate notices from the existing bot.
- Durable reminders (0002 schema present on live D1); disabled, no Cron configured.
- Local reply preview/edit/cancel on D1 and gated Gmail Draft creation/full preview/one-way send in `src/gmail-compose.js`. All real Gmail writes remain disabled. `0004_gmail_draft_delivery.sql` has NOT been applied to staging D1.
- Synthetic Node tests and GitHub Actions CI. The suite now also uses actual SQLite D1-compatible SQL, not just permissive in-memory mocks.
- Telegram outgoing messages: persisted `delivery_unknown` before sending. A Queue retry cannot send the same response twice after an ambiguous network error or failed final D1 write. A queue enqueue error retains the durable queued update for webhook redelivery. Unknown deliveries require manual reconciliation, not blind retry.
- Gmail ingestion: an atomic `ANALYZING` claim in `emails` is acquired before OAuth/Groq. Competing workers back off. Final email and derived task are committed in one D1 batch; errors roll back both. Stale claims have a guarded takeover path, with cleanup only for the current claim.
- Gmail thread context (last four messages) and attachment metadata via Gmail REST. Attachment contents and arbitrary HTML drafts are intentionally not auto-sent.
- Google OAuth consent completed by the owner on 2026-09-28. Callback confirmed Gmail connected and no mail imported or sent. The encrypted refresh token is stored in D1; Google client ID, secret and owner setup password were added to Cloudflare Secrets. The one-time `oauth_credentials` table exists. Pairing switch was returned to `false`. Gmail polling and real email sending remain disabled. Refresh-token usability on scheduled invocations has not yet been verified.
- The user supplied a transcript of Astra reporting additional edits and migration results, but no Astra commits appeared in the shared GitHub branch at inspection time. The safeguards above were added and tested here in GitHub. Do not claim that Astra's own unpublished workspace was merged.

## Staging flags (all intentionally false)
`GMAIL_POLL_ENABLED`, `REMINDERS_ENABLED`, `REPLY_PREVIEWS_ENABLED`, `MAIL_INGEST_ENABLED`, `WORKER_EMAIL_NOTIFICATIONS`, `GMAIL_THREAD_CONTEXT_ENABLED`, `GOOGLE_OAUTH_SETUP_ENABLED`, `GMAIL_DRAFTS_ENABLED`, `GMAIL_SEND_ENABLED` are all explicitly `false` in `wrangler.jsonc`. Do not enable send without explicit owner approval.

## Pending prerequisites
1. Check latest CI and current public `/health`. The Cloudflare preview/build being successful does not imply Gmail access.
2. Core and extra table names are now confirmed on the live D1. Verify each table's indexes and the Wrangler migration ledger before any migration replay. Do not drop tables or reapply migration scripts merely because ledger entries are missing.
3. Owner Google consent and encrypted token persistence completed. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `SETUP_PASSWORD` were entered directly as Cloudflare Secrets; do not copy them to GitHub. Next: verify token refresh and mailbox scope in a deliberately read-only owner-authorized flow, configure Groq and only then schedule polling. No Cron is active.
4. Connect a sanctioned Groq key as Cloudflare secret. Continue testing without live bot webhook. No second Telegram bot is being created.
5. Google pairing is complete and migration 0005 was executed in the D1 console. Migration 0004 for Gmail draft delivery status remains unverified. `src/gmail-compose.js` provides guarded draft/send and strict preview; real Gmail writes are not yet activated. HTML drafts, additional recipients and attachments are blocked from automatic send pending explicit design/approval.
6. Compare real response latency and confirm rollback path before any cutover of the existing Telegram webhook.

No production email, tokens, or Telegram chat history was migrated. No email can be sent by the Cloudflare Worker with current flags. Setup guide: `docs/CONNECT.md`. No TinyFish is needed or used.
