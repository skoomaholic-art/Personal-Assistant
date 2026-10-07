# Переключатели функций

> Файл создан автоматически из `config/flags.json` командой `npm run flags:doc`. Не редактируйте его вручную.

Значения в столбце «Staging» совпадают с `vars` в `wrangler.jsonc`; совпадение и полноту списка проверяет `test/flags.test.js`. В `wrangler.jsonc` задано `keep_vars: true`, поэтому значения, изменённые в панели Cloudflare, здесь не видны.

## Требует решения

- `OUTLOOK_AI_ENABLED` (включён): В wrangler.jsonc включено, а docs/WORK_ONLY.md и STAGING_STATUS.md описывают как выключенное. Нужно решение владельца.
- `TELEGRAM_MENTIONS_AI_ENABLED` (включён): В wrangler.jsonc включено, а docs/WORK_ONLY.md и STAGING_STATUS.md описывают как выключенное. Нужно решение владельца.
- `WORKER_EMAIL_NOTIFICATIONS` (включён): В wrangler.jsonc включено, а docs/WORK_ONLY.md и STAGING_STATUS.md описывают как выключенное. Нужно решение владельца.
- `TELEGRAM_MENTION_WORKER_CALLBACKS_ENABLED` (включён): STAGING_STATUS.md описывает как выключенное до переключения webhook. Нужно решение владельца.
- `REMINDERS_ENABLED` (включён): В wrangler.jsonc включено, а docs/WORK_ONLY.md и STAGING_STATUS.md описывают как выключенное. Нужно решение владельца.

## Приём входящих

| Флаг | Staging | Что включает | Что нужно для включения |
|---|---|---|---|
| `GMAIL_POLL_ENABLED` | включён | Опрос Gmail по Cron и разбор новых писем. | Google OAuth владельца |
| `GMAIL_PERSONAL_INGEST_ENABLED` | выключен | Сохранение и разбор личных писем. В ASSISTANT_SCOPE=work не действует. | - |
| `MAIL_INGEST_ENABLED` | выключен | Старый мост приёма писем из Apps Script (/ingest). | INGEST_SECRET |
| `OUTLOOK_POLL_ENABLED` | выключен | Чтение рабочей почты через Microsoft Graph. | Одобренное компанией приложение Entra ID и OAuth |
| `TELEGRAM_MENTIONS_ENABLED` | включён | Приём сообщений из выбранных Telegram-чатов от локального слушателя. | TELEGRAM_MENTION_INGEST_SECRET, списки чатов, миграция 0006 |
| `SLP_NOTICE_INGEST_ENABLED` | не задан (выключен) | Приём уведомлений SLP о расписаниях на проверку (только ID, статус, канал). | SLP_NOTICE_SECRET |

## Передача данных во внешнюю модель (Groq)

| Флаг | Staging | Что включает | Что нужно для включения |
|---|---|---|---|
| `OUTLOOK_AI_ENABLED` | включён | Разрешает передавать текст рабочих писем в Groq. В режиме work без него письма идут только на ручной разбор. | Разрешение компании на обработку рабочих данных внешней моделью |
| `TELEGRAM_MENTIONS_AI_ENABLED` | включён | Разрешает передавать текст сообщений из рабочих Telegram-чатов в Groq. | Разрешение компании на обработку рабочих данных внешней моделью |
| `TASK_CONVERSATION_ENABLED` | включён | Диалог с ботом: текст, который владелец пишет боту, уходит в Groq для распознавания намерения. | - |
| `TASK_VOICE_ENABLED` | включён | Голосовые владельца: аудио уходит в Groq Whisper, файл не сохраняется. | - |
| `GMAIL_THREAD_CONTEXT_ENABLED` | выключен | Добавляет последние письма цепочки в контекст при подготовке черновика ответа. | - |

## Уведомления владельцу

| Флаг | Staging | Что включает | Что нужно для включения |
|---|---|---|---|
| `WORKER_EMAIL_NOTIFICATIONS` | включён | Уведомления в Telegram о рабочих письмах, требующих действия. | Не должно дублировать уведомления Apps Script до переключения webhook |
| `WORKER_EMAIL_WORKER_CALLBACKS_ENABLED` | включён | Кнопки в уведомлениях о письмах. Работают только когда webhook бота указывает на Worker. | Переключение Telegram webhook на Worker |
| `TELEGRAM_MENTION_NOTIFICATIONS_ENABLED` | включён | Уведомления о новых сообщениях из рабочих Telegram-чатов. | - |
| `TELEGRAM_MENTION_WORKER_CALLBACKS_ENABLED` | включён | Кнопки в уведомлениях о Telegram-сообщениях. Работают только когда webhook указывает на Worker. | Переключение Telegram webhook на Worker |
| `SLP_NOTICE_NOTIFICATIONS` | не задан (выключен) | Уведомления в Telegram по записям SLP на проверку. | SLP_NOTICE_INGEST_ENABLED |
| `REMINDERS_ENABLED` | включён | Напоминания о сроках задач по Cron. | Миграция 0002; после подключения действующего бота |
| `DAILY_BRIEF_ENABLED` | выключен | Утренняя сводка почты, задач и календаря. | - |

## Отправка наружу

| Флаг | Staging | Что включает | Что нужно для включения |
|---|---|---|---|
| `REPLY_PREVIEWS_ENABLED` | выключен | Локальные черновики ответов с предпросмотром и редактированием. | Миграция 0003 |
| `GMAIL_DRAFTS_ENABLED` | выключен | Создание настоящего черновика в Gmail. | Миграция 0004, OAuth с gmail.compose |
| `GMAIL_SEND_ENABLED` | выключен | Отправка рабочего ответа из Gmail после отдельного подтверждения. | Корпоративный send-as alias и явное разрешение |
| `PERSONAL_GMAIL_SEND_ENABLED` | выключен | Отправка писем с личного Gmail после подтверждения. В ASSISTANT_SCOPE=work не действует. | - |
| `WORK_OUTLOOK_SEND_ENABLED` | выключен | Отправка рабочих писем через Outlook после подтверждения. | Разрешение компании, Mail.Send |
| `TELEGRAM_RELAY_ENABLED` | выключен | Сообщения контактам от имени бота по одноразовым приглашениям. | - |

## Календари

| Флаг | Staging | Что включает | Что нужно для включения |
|---|---|---|---|
| `OUTLOOK_CALENDAR_READ_ENABLED` | выключен | Чтение рабочего календаря Microsoft 365. | Разрешение компании, Calendars.ReadWrite |
| `OUTLOOK_CALENDAR_WRITE_ENABLED` | выключен | Создание встреч в рабочем календаре после подтверждения. | Разрешение компании, Calendars.ReadWrite |
| `GOOGLE_CALENDAR_ENABLED` | выключен | Личный Google Calendar. В ASSISTANT_SCOPE=work не действует. | Отдельное согласие Google |

## Разовая привязка аккаунтов

| Флаг | Staging | Что включает | Что нужно для включения |
|---|---|---|---|
| `GOOGLE_OAUTH_SETUP_ENABLED` | выключен | Разовый вход Google для привязки Gmail. Выключать сразу после привязки. | - |
| `GOOGLE_CALENDAR_SETUP_ENABLED` | выключен | Разовый вход Google для привязки календаря. Выключать сразу после привязки. | - |
| `OUTLOOK_SETUP_ENABLED` | выключен | Разовый вход Microsoft для привязки Outlook. Выключать сразу после привязки. | MS_CLIENT_ID, MS_CLIENT_SECRET |
