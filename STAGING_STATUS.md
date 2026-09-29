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


## 2026-09-28 - Gmail work-only provenance gate
- Commit 1bd459e: Gmail work ingestion now requires the exact configured corporate sender and an aligned Gmail authentication result. Recipient address alone no longer classifies a message as work.
- A forwarded copy with explicit original From/To headers addressed to WORK_EMAIL can be attributed to its original author. Copies without those headers are stored as WORK_REVIEW with a subject-only summary and create no task or Groq request.
- In ASSISTANT_SCOPE=work, Groq analysis of forwarded corporate mail requires OUTLOOK_AI_ENABLED=true. Without approved external AI processing the copy remains review-only, with no automatic task. Gmail message IDs and task IDs continue to suppress duplicates. Existing Telegram notification gate remains off.
- Code saved on cloudflare-staging. Cloudflare publication and delivery of an actual forwarded Outlook message have not been established. Current Telegram webhook still belongs to Apps Script.
- Next: confirm the permitted forwarded message format and corporate AI approval; then implement source-aware task extraction, work inbox and reply preview without enabling corporate sending.


## 2026-09-28 - Telegram task menu
- Primary Telegram menu now opens separate pending tasks (NEW), tasks in progress (IN_PROGRESS), completed tasks (DONE), and news. Existing secondary actions remain under More.
- Pending mail tasks display the classifier's provisional priority. Taking one into work first asks the owner to select high, medium or low; a guarded D1 update sets both IN_PROGRESS and the selected priority once. Completed items remain browsable.
- News shows public RSS headlines plus work email items classified as news/FYI only when their saved action says no action is needed. Personal Gmail remains outside work mode.
- Code commits: 7e4e9b1 and 722aaf1. No tests or live Telegram calls were run. Cloudflare publication and existing Telegram webhook attachment remain unconfirmed and unchanged respectively.
- Next: align Mini App task tabs with the new lifecycle and continue the Gmail forwarding path once its actual delivered format is available.

## Pending prerequisites
1. Check latest CI and current public `/health`. The Cloudflare preview/build being successful does not imply Gmail access.
2. Core and extra table names are now confirmed on the live D1. Verify each table's indexes and the Wrangler migration ledger before any migration replay. Do not drop tables or reapply migration scripts merely because ledger entries are missing.
3. Owner already confirmed Google token refresh, Groq model and a successful real Gmail Cron from protected `/admin/connections`. Next: owner explicitly pairs Google Calendar at `/oauth/google/calendar/start`; personal Google Calendar scope was not included in earlier Gmail OAuth.
4. Groq key and the configured model were confirmed by the owner's real protected status response. Cloudflare needs the existing bot's token, webhook secret and chat id as Secrets before an authorized single-bot cutover. Do not change the live webhook without owner authorization.
5. Google pairing is complete and migration 0005 was executed in the D1 console. Migration 0004 for Gmail draft delivery status remains unverified. `src/gmail-compose.js` provides guarded draft/send and strict preview; real Gmail writes are not yet activated. HTML drafts, additional recipients and attachments are blocked from automatic send pending explicit design/approval.
6. Compare real response latency and confirm rollback path before any cutover of the existing Telegram webhook.

Old Google Sheets tasks and Telegram chat history have not been bulk-migrated. New personal/work Gmail messages are ingested in staging; personal Gmail sends require per-message confirmation but have not been exercised on the real bot. Existing corporate alias Gmail send remains disabled. Outlook requires company consent. See the project README for the consolidated design.

## 2026-09-28 - Личный Telegram / MTProto (код в staging)
- Добавлены независимый Telethon listener и защищённый endpoint `/internal/telegram/mention`; существующий Bot API webhook не тронут. Listener требует отдельного долгоживущего процесса и Telegram user session.
- `migrations/0006_telegram_mentions.sql` хранит сообщения, dedupe по chat_id/message_id, временный статус, источник и предварительную сортировку TASK/NEWS. Задачи попадают в NEW; при взятии в работу владелец выбирает важность. Новости Telegram видны в штатном разделе.
- Внешний Groq анализ текста Telegram по умолчанию выключен; отправка Telegram-уведомлений от существующего бота также выключена. Есть обязательный выбор чатов и отдельный ключ приёма.
- Личная авторизация, конфигурация секретов и чатов, D1-миграция, непрерывный запуск слушателя и публикация на Worker **ещё не выполнены**. Нет подтверждения живой доставки. Без тестов и без переключения webhook по просьбе владельца. См. `docs/TELEGRAM_MENTIONS.md`.

- Уведомления о Telegram-упоминаниях до переключения webhook отправляются только текстом, без неработающих кнопок. `TELEGRAM_MENTION_WORKER_CALLBACKS_ENABLED` остаётся выключенным.

## 2026-09-28 - Единая цепочка почта / Telegram

Сохранено в `cloudflare-staging`. **Стадия: код в GitHub, не подтверждено опубликованным Worker и реальным Telegram.** По просьбе владельца дополнительные тесты и прогоны не запускались; автоматические GitHub Actions переведены на ручной запуск. Старый webhook в Apps Script не менялся.

- Общая детерминированная предварительная сортировка: `src/work-triage.js`. Для почты без разрешённого внешнего AI очевидные рассылки с рабочими заголовками получают `НОВОСТЬ`, остальное идёт на разбор. Содержание корпоративных писем не отправляется в Groq и не выдаётся за распознанную задачу.
- Корпоративный sender в Gmail подтверждается только аутентифицированной отправкой с точным доменом `WORK_DOMAIN` и явным `From: WORK_EMAIL`. Неподтверждённое происхождение исходного автора остаётся `WORK_REVIEW`, не превращается автоматически в рабочую задачу. Фактический формат Outlook-forward в подключённом Gmail не установлен.
- Для выбранных Telegram-групп: явные поручения => `TASK` + `tasks.NEW`, рабочие информационные сообщения => `NEWS`, неопределённые => `REVIEW`. В разрешённых личных диалогах work-only сообщения без признаков работы отбрасываются локальным слушателем до отправки в Cloudflare и повторно на уровне Worker. Это консервативный фильтр: часть коротких рабочих сообщений без контекста может быть пропущена.
- В `src/telegram-mentions.js` задачи создаются с детерминированным `tgm:` идентификатором и связью с сообщением; запись задачи и результат классификации сохраняются одной D1-транзакцией. Владелец может отнести REVIEW к задачам, новостям или исключить с очисткой текста в рабочей базе. Уникальный `chat_id:message_id` подавляет дубли.
- `src/work-inbox.js` обеспечивает общий обработчик «рабочее письмо -> одна задача», ручную смену WORK_REVIEW на NEWS и исключение нерабочей записи с очисткой данных. Уникальный `tasks.email_id` подавляет повторы; черновики Gmail и отправка от личного адреса не включались.
- В `src/worker.js` разделы «Рабочая почта», «Новости» и «На разбор» используют те же записи. Обновление почты запускается отдельно по кнопке, не при каждом открытии списка. Ссылки на источники Telegram и исходные письма сохраняются в карточках и задачах.
- В `src/miniapp.js` появился раздел новостей Telegram/почты и кнопки ручного решения для REVIEW, с аутентификацией владельца по Telegram initData.
- Пока Apps Script обслуживает webhook, уведомления из Worker должны быть только текстовыми: новых кнопок старый webhook не понимает. Gmail-уведомления Worker остаются выключенными во избежание дублей. Telegram-уведомления регулируются отдельными разрешениями и флагами.

Остались внешние блокировки, не устраняемые коммитом: применение схемы `migrations/0006_telegram_mentions.sql` на целевом D1, непрерывный запуск локального Telethon с авторизованной сессией и согласованными allowlists, публикация новой ревизии на staging Worker, реальные credentials/секреты, подтверждение допустимости передачи рабочих данных во внешние сервисы. Для **новых кнопок в действующем боте** потребуется отдельно согласованное переключение одного существующего Telegram webhook; оно не выполнялось. До него доступна только совместимая текстовая доставка, если listener и секреты действительно активны.

История старых задач Google Sheets и ранее проигнорированных сообщений не импортирована; никаких удалений или повторного применения миграций не выполнялось.

## 2026-09-30 - Почтовое внимание и SLP (код, не живой релиз)

- Фильтр Gmail ставит уведомление только по новому действию, дополнению к задаче или письму на ручной разбор. Одно лишь слово «важно» без действия не является основанием для уведомления. Почтовые спам и корзина исключаются даже при пользовательском Gmail-запросе.
- Добавлен защищённый `POST /internal/slp/notice`: принимает только ID, статус и название канала от SLP. Не принимает содержимое письма, отправителя, вложения, Excel или токен Gmail.
- Рецензирование SLP попадает в существующую таблицу задач и D1-журнал. Очередь и `notification_events` обеспечивают подавление повторной Telegram-доставки. Существующий Telegram webhook НЕ переключён.
- Выключено до настройки: `SLP_NOTICE_INGEST_ENABLED`, `SLP_NOTICE_NOTIFICATIONS`. Секрет `SLP_NOTICE_SECRET` должен совпадать с `SPORT_ASSISTANT_NOTICE_SECRET` на хосте SLP. Не вносить секрет в Git. Не включать работающие кнопки Worker, пока Telegram webhook остаётся в Apps Script.
- Статус: код в ветке `cloudflare-staging`, публикация, доступность SLP, реальная доставка и отсутствие дублей между двумя независимыми Gmail-сканерами пока НЕ подтверждены. ChatGPT hourly automation является отдельной функцией ChatGPT, в API Worker не встроена.
