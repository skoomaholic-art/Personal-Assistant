# Rahal Mamut | Cloudflare staging status

Existing Google Apps Script bot remains the only live Telegram bot. No existing Telegram webhook has been changed.

## Deployed infrastructure
- Private GitHub repo: `skoomaholic-art/Personal-Assistant`, Worker build branch: `cloudflare-staging`.
- Test Worker: `https://rahal-mamut-staging.alexandr-petrossov.workers.dev/`.
- D1 database `rahal-mamut-staging` has the five original tables `emails`, `tasks`, `history`, `states`, `telegram_updates` (previously verified with `/health/db`).
- Queues: `rahal-mamut-jobs`, `rahal-mamut-dead-letter`.
- `GET /health`, `GET /health/db`, `GET /health/features` are read-only checks. Confirm Cloudflare has deployed the latest GitHub revision after CI completes.

## Ported code on this branch
- Archived legacy source: `legacy/{Code,Storage,Webhook,MailActions}.gs`.
- Telegram fast commands, menu, D1 search/tasks, background Groq.
- Gmail REST read-only polling + original work-mail filter + strict Groq email classification and durable task creation; disabled until Google consent.
- Work-email Telegram notifications with a durable claim; disabled to avoid duplicate notices from the existing bot.
- Durable reminders (0002 schema); disabled, no Cron configured.
- Local reply preview/edit/cancel based on D1 email summary (0003 schema), **no email send**; disabled until migration.
- Synthetic Node tests and GitHub Actions CI.

## Staging flags (all intentionally false)
`GMAIL_POLL_ENABLED`, `REMINDERS_ENABLED`, `REPLY_PREVIEWS_ENABLED`, `MAIL_INGEST_ENABLED`, `WORKER_EMAIL_NOTIFICATIONS`.

## Pending prerequisites
1. Check latest CI and current public `/health`. The Cloudflare preview/build being successful does not imply Gmail access.
2. Apply `migrations/0002_reminder_deliveries.sql` and `0003_local_reply_previews.sql` to staging D1 by an authorized Wrangler session. `0001` uses idempotent CREATE statements; verify migration ledger before replaying. Do not drop old tables.
3. Google OAuth client, owner consent to Gmail read-only access and encrypted Cloudflare secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`. The user must consent; no existing Script Properties were copied. Configure the scheduled trigger only after auth is verified.
4. Connect a sanctioned Groq key as Cloudflare secret. Continue testing without live bot webhook. No second Telegram bot is being created.
5. Still missing: full Gmail thread/attachment access and safe real Gmail draft/send flow. Never enable mail sending before alias/recipients/subject/body/attachments are independently checked and status is reconciled.
6. Compare real response latency and confirm rollback path before any cutover of the existing Telegram webhook.

No production email, tokens, or Telegram chat history was migrated. No email can be sent by the Cloudflare Worker.
