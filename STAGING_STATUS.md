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
- Local reply preview/edit/cancel based on D1 email summary (0003 schema present on live D1), **no email send**; disabled until OAuth and end-to-end checks.
- Synthetic Node tests and GitHub Actions CI. The suite now also uses actual SQLite D1-compatible SQL, not just permissive in-memory mocks.
- Telegram outgoing messages: persisted `delivery_unknown` before sending. A Queue retry cannot send the same response twice after an ambiguous network error or failed final D1 write. A queue enqueue error retains the durable queued update for webhook redelivery. Unknown deliveries require manual reconciliation, not blind retry.
- Gmail ingestion: an atomic `ANALYZING` claim in `emails` is acquired before OAuth/Groq. Competing workers back off. Final email and derived task are committed in one D1 batch; errors roll back both. Stale claims have a guarded takeover path, with cleanup only for the current claim.
- The user supplied a transcript of Astra reporting additional edits and migration results, but no Astra commits appeared in the shared GitHub branch at inspection time. The safeguards above were added and tested here in GitHub. Do not claim that Astra's own unpublished workspace was merged.

## Staging flags (all intentionally false)
`GMAIL_POLL_ENABLED`, `REMINDERS_ENABLED`, `REPLY_PREVIEWS_ENABLED`, `MAIL_INGEST_ENABLED`, `WORKER_EMAIL_NOTIFICATIONS`.

## Pending prerequisites
1. Check latest CI and current public `/health`. The Cloudflare preview/build being successful does not imply Gmail access.
2. Core and extra table names are now confirmed on the live D1. Verify each table's indexes and the Wrangler migration ledger before any migration replay. Do not drop tables or reapply migration scripts merely because ledger entries are missing.
3. Google OAuth client, owner consent to Gmail read-only access and encrypted Cloudflare secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`. The user must consent; no existing Script Properties were copied. Configure the scheduled trigger only after auth is verified.
4. Connect a sanctioned Groq key as Cloudflare secret. Continue testing without live bot webhook. No second Telegram bot is being created.
5. Still missing: full Gmail thread/attachment access and safe real Gmail draft/send flow. Never enable mail sending before alias/recipients/subject/body/attachments are independently checked and status is reconciled.
6. Compare real response latency and confirm rollback path before any cutover of the existing Telegram webhook.

No production email, tokens, or Telegram chat history was migrated. No email can be sent by the Cloudflare Worker.
