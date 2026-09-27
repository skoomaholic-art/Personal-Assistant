# Rahal Mamut | staging status

Cloudflare test resources were created on 2026-09-27. They are isolated from the existing Google Apps Script Telegram bot.

- GitHub branch: `cloudflare-staging`. Local and GitHub Actions tests pass (16 synthetic tests).
- D1 database: `rahal-mamut-staging` (ID `0b294974-73c7-40b1-93c3-dfb6dcb797e7`). **Schema not yet applied**.
- Queue: `rahal-mamut-jobs`.
- Dead-letter queue: `rahal-mamut-dead-letter`.
- Worker: `rahal-mamut-staging`, URL `https://rahal-mamut-staging.alexandr-petrossov.workers.dev/`.
- Current live Worker: default Hello World template; `/health` returns 404. The repository worker code is **not deployed yet**.
- `wrangler.jsonc` contains the correct Cloudflare account ID and D1 ID; it has bindings for the existing queues.

## Next technical steps

1. Authenticate Wrangler in the Cloudflare account (browser OAuth or a properly scoped token stored outside source).
2. From this branch run `npm run check && npm test`.
3. Run `npx wrangler d1 migrations apply rahal-mamut-staging --remote`.
4. Set required secrets with `npx wrangler secret put NAME`. For Telegram use **a separate test bot**, not the production token. Never commit secrets.
5. Run `npx wrangler deploy`, then verify `/health` returns `phase:staging`.
6. Only after tests, point the **test bot** webhook to the new Worker. Do not change the live bot webhook yet.

Gmail ingestion and notifications are disabled by default; Gmail replies and reminders have not been migrated. Do not import work email data without authorization. Production Apps Script remains unchanged.
