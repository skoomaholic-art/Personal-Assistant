# Персональный помощник | Cloudflare staging status

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
- Gmail personal and work inbox ingestion is enabled in staging: new personal mail and work mail are both classified, and only work mail may create an automatic task. Previously ignored personal IDs are not backfilled. Staging still sends no email notifications to Telegram while the old bot is active.
- Work-email Telegram notifications with a durable claim; disabled to avoid duplicate notices from the existing bot.
- Durable reminders (0002 schema present on live D1); `REMINDERS_ENABLED=false`. Cron exists for Gmail, but reminder delivery is disabled.
- Local reply preview/edit/cancel on D1 and gated Gmail Draft creation/full preview/one-way send in `src/gmail-compose.js`. All real Gmail writes remain disabled. `0004_gmail_draft_delivery.sql` has NOT been applied to staging D1.
- Synthetic Node tests and GitHub Actions CI. The suite now also uses actual SQLite D1-compatible SQL, not just permissive in-memory mocks.
- Telegram outgoing messages: persisted `delivery_unknown` before sending. A Queue retry cannot send the same response twice after an ambiguous network error or failed final D1 write. A queue enqueue error retains the durable queued update for webhook redelivery. Unknown deliveries require manual reconciliation, not blind retry.
- Gmail ingestion: an atomic `ANALYZING` claim in `emails` is acquired before OAuth/Groq. Competing workers back off. Final email and derived task are committed in one D1 batch; errors roll back both. Stale claims have a guarded takeover path, with cleanup only for the current claim.
- Gmail thread context (last four messages) and attachment metadata via Gmail REST. Attachment contents and arbitrary HTML drafts are intentionally not auto-sent.
- Owner paired Gmail OAuth on 2026-09-28. The owner displayed a real protected status response confirming Google token refresh and Groq model access, followed by a successful Gmail Cron (10 scanned, 10 previously non-work, 0 tasks at that time). The original Gmail refresh token is encrypted in D1, pairing is disabled, and a fixed after-consent checkpoint avoids historical bulk import.
- The user supplied a transcript of Astra reporting additional edits and migration results, but no Astra commits appeared in the shared GitHub branch at inspection time. The safeguards above were added and tested here in GitHub. Do not claim that Astra's own unpublished workspace was merged.

## Current staged capabilities and flags
- Implemented: context-aware text/voice chat, confirmed task create/update/postpone/soft-delete, own Google Calendar, opt-in recipient Telegram relay, personal Gmail drafts/replies with explicit send approval, morning briefing, explicit memory, RSS news, owner-authenticated Telegram Mini App.
- Gmail classification for new personal and work messages is enabled; read-only Outlook Graph integration is coded but remains disabled pending company approval.
- `GMAIL_POLL_ENABLED=true`, `GMAIL_PERSONAL_INGEST_ENABLED=true`, `PERSONAL_GMAIL_SEND_ENABLED=true`, `TASK_CONVERSATION_ENABLED=true`, `TASK_VOICE_ENABLED=true`, `GOOGLE_CALENDAR_SETUP_ENABLED=true`, `GOOGLE_CALENDAR_ENABLED=true`, `TELEGRAM_RELAY_ENABLED=true`. Calendar access still requires separate account consent; personal Gmail sending still requires approval for each message.
- `OUTLOOK_SETUP_ENABLED=false`, `OUTLOOK_POLL_ENABLED=false`, `OUTLOOK_CALENDAR_READ_ENABLED=false`, `OUTLOOK_CALENDAR_WRITE_ENABLED=false`, `OUTLOOK_AI_ENABLED=false`, `REMINDERS_ENABLED=false`, `DAILY_BRIEF_ENABLED=false`, `WORKER_EMAIL_NOTIFICATIONS=false`, `GMAIL_SEND_ENABLED=false`, `GMAIL_DRAFTS_ENABLED=false`. No production Telegram handoff.
- User requested proceeding directly without manual test cycles. Changes after this request are code commits only; do not describe new email, calendar, relay, Mini App or actual Telegram features as live-proven.

## Pending prerequisites
1. Check latest CI and current public `/health`. The Cloudflare preview/build being successful does not imply Gmail access.
2. Core and extra table names are now confirmed on the live D1. Verify each table's indexes and the Wrangler migration ledger before any migration replay. Do not drop tables or reapply migration scripts merely because ledger entries are missing.
3. Owner already confirmed Google token refresh, Groq model and a successful real Gmail Cron from protected `/admin/connections`. Next: owner explicitly pairs Google Calendar at `/oauth/google/calendar/start`; personal Google Calendar scope was not included in earlier Gmail OAuth.
4. Groq key and the configured model were confirmed by the owner's real protected status response. Cloudflare needs the existing bot's token, webhook secret and chat id as Secrets before an authorized single-bot cutover. Do not change the live webhook without owner authorization.
5. Google pairing is complete and migration 0005 was executed in the D1 console. Migration 0004 for Gmail draft delivery status remains unverified. `src/gmail-compose.js` provides guarded draft/send and strict preview; real Gmail writes are not yet activated. HTML drafts, additional recipients and attachments are blocked from automatic send pending explicit design/approval.
6. Compare real response latency and confirm rollback path before any cutover of the existing Telegram webhook.

Old Google Sheets tasks and Telegram chat history have not been bulk-migrated. New personal/work Gmail messages are ingested in staging; personal Gmail sends require per-message confirmation but have not been exercised on the real bot. Existing corporate alias Gmail send remains disabled. Outlook requires company consent. See the project README for the consolidated design.
