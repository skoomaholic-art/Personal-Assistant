# Rahal Mamut | Cloudflare staging status

This is an **isolated staging Worker**, not the production Telegram bot. The existing Google Apps Script deployment and Telegram webhook have not been changed.

- Repository: `skoomaholic-art/Personal-Assistant`, production branch for this staging Worker: `cloudflare-staging`.
- Worker: `https://rahal-mamut-staging.alexandr-petrossov.workers.dev/`.
- Worker health: `/health`, staging version 0.1.0.
- D1: `rahal-mamut-staging` (ID `0b294974-73c7-40b1-93c3-dfb6dcb797e7`).
- D1 schema: all five required tables `emails`, `history`, `states`, `tasks`, `telegram_updates` were reported present by the live `/health/db` endpoint after applying idempotent schema statements on 2026-09-27.
- Queue: `rahal-mamut-jobs`; dead-letter queue: `rahal-mamut-dead-letter`.
- The temporary schema bootstrap route has been **removed from the code**, and the env flag removed from Wrangler configuration; `/health/db` is read-only. Verify this cleanup is deployed after CI passes.
- The canonical idempotent migration remains in `migrations/0001_init.sql`. A future Wrangler migration run can create its migration ledger without dropping existing tables.
- No production bot token, Gmail data or outbound email functionality is configured in staging.
- `MAIL_INGEST_ENABLED=false` and `WORKER_EMAIL_NOTIFICATIONS=false`.

## Remaining work

1. Verify CI and the cleaned-up staging deployment. Re-check `/health/db`; it must report all five tables.
2. Test synthetic Telegram requests directly against the Worker (without changing the live bot webhook or creating another bot).
3. Migrate remaining Gmail, reminders, task, and guarded email-draft functionality; reconcile state before any switch.
4. Provision secrets in Cloudflare **only when needed**, never commit secrets or copy tokens into issue comments.
5. When feature parity and real speed tests are confirmed, schedule a reversible cutover of the existing bot with an explicit rollback plan.

There is **no second Telegram bot** in this plan.
