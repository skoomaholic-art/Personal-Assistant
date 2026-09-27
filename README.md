# Рахал Мамут | Cloudflare migration

Ветка `cloudflare-staging` содержит **тестовый** сервер. Рабочий бот остаётся на Google Apps Script; его webhook, Gmail, таблицы и триггеры не изменены. Второго бота нет.

## Исходники и компоненты

- `legacy/Code.gs`, `legacy/Storage.gs`, `legacy/Webhook.gs`, `legacy/MailActions.gs` - копии исходных скриптов v1.1 как reference, **не запускаются** в Cloudflare.
- `src/router.js` - команды/кнопки и чистые функции.
- `src/worker.js` - Telegram webhook, очередь, D1, Groq, read-only диагностика.
- `src/gmail.js` - Gmail REST: чтение писем и цепочек, метаданные вложений, рабочий фильтр, Groq-анализ, задачи и дедупликация. Для обработки писем достаточно разрешения `gmail.readonly`.
- `src/reminders.js` - выбор задач и защита от повторных Telegram-уведомлений с D1 claim до отправки.
- `src/drafts.js` - локальные черновики. `src/gmail-compose.js` - создание настоящего Gmail Draft, полный предварительный просмотр, проверка адресатов и корпоративного alias, отдельное подтверждение и однонаправленный статус отправки. `GMAIL_DRAFTS_ENABLED` и `GMAIL_SEND_ENABLED` по умолчанию выключены.
- `src/google-oauth.js` - вход Google для владельца с CSRF-защитой и шифрованным refresh token в D1. Запускается только при отдельном включении. `migrations/0004_gmail_draft_delivery.sql` и `0005_google_oauth.sql` пока не подтверждены на живой D1. Никаких реальных писем не импортировали.
- `test/` - синтетические тесты без доступа к Gmail и Telegram, в том числе с настоящим SQLite по схеме D1. Проверяются конкурирующие обработчики, повторы Telegram, откат транзакции письма и задачи.

## Текущий статус

| Функция | Состояние |
|---|---|
| Telegram webhook, меню, поиск, задачи, Groq | Реализовано в staging; действующий webhook не переключён |
| D1: emails / tasks / history / states / telegram_updates | Проверено через `/health/db` |
| Gmail REST-опрос, анализ и задачи | Код есть; `GMAIL_POLL_ENABLED=false`, OAuth не настроен |
| Доставка новых Gmail-уведомлений | Код есть с атомарным claim; `WORKER_EMAIL_NOTIFICATIONS=false` |
| Напоминания | Код есть; таблица `reminder_deliveries` подтверждена на live staging D1; `REMINDERS_ENABLED=false`, Cron не включён |
| Локальные черновики | Код есть; таблица `reply_drafts` подтверждена на live staging D1; `REPLY_PREVIEWS_ENABLED=false`, отправка Gmail отключена |
| Gmail thread, вложения, реальный Draft и отправка | Чтение последних четырёх писем и метаданные вложений реализованы. Создание/отправка Gmail Draft реализованы с защитами, но не подключены к реальной почте. Содержимое вложений не переносится. |
| Google OAuth и переключение основного бота | OAuth код готов, но отсутствуют Cloudflare Secrets и разрешение владельца. Текущий webhook работает через Apps Script. |

Не изменяйте флаги на `true` до применения соответствующих миграций, предоставления разрешений и сквозных проверок.

## Запуск тестов

Node.js 20+:

```bash
npm run check
npm test
```

[Тестовый Worker](https://rahal-mamut-staging.alexandr-petrossov.workers.dev/health)
| [D1 health](https://rahal-mamut-staging.alexandr-petrossov.workers.dev/health/db)

В CI запускаются Node-тесты после обновления ветки. Это **не** заменяет живую проверку Gmail/OAuth/Telegram и не доказывает скорость реального бота.

## Будущая безопасная настройка

1. Все семь нужных таблиц D1 подтверждены живыми `/health/db` и `/health/features`. Проверить соответствие колонок и индексов, затем состояние журнала Wrangler migrations. Не повторять миграции без предварительной проверки, не выполнять DROP/DELETE и не импортировать корпоративную почту без согласования.
2. Выполнить инструкцию `docs/CONNECT.md`: Google OAuth Web client, Gmail API, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SETUP_PASSWORD` как Cloudflare Secrets. Через защищённый вход владельца получить Gmail consent (`gmail.readonly` и `gmail.compose`); refresh token сохранится зашифрованным в D1. Для ручной установки Cloudflare Secret `GMAIL_REFRESH_TOKEN` также поддерживается. Никогда не отправлять секреты в чат и GitHub.
3. Только после проверки включить опрос `GMAIL_POLL_ENABLED=true` и Cron Trigger (например, раз в 5 минут в UTC). Пока он отсутствует.
4. Отдельно проверить дедупликацию новых писем, задачи, историю, уведомления и откат. На время тестов `WORKER_EMAIL_NOTIFICATIONS` оставлять выключенным, потому что исходный Apps Script уже шлёт уведомления.
5. Перед включением напоминаний и локальных черновиков сверить реальные схемы таблиц с миграциями 0002 и 0003 и провести синтетические end-to-end проверки.
6. Только при достигнутом функциональном соответствии и после замеров согласовать переключение **одного существующего** Telegram webhook на Worker с заранее зафиксированным старым URL для отката. Ключи не публиковать.
7. Код создания и отправки существующего Gmail Draft добавлен. Он **не активирован**: для включения нужны миграция 0004, OAuth с `gmail.compose`, корпоративный send-as alias и отдельное явное разрешение. HTML, вложения, дополнительные получатели и изменённые Gmail-черновики автоматически не отправляются. Установить `GMAIL_SEND_ENABLED=true` только после согласования запуска.

**Важно:** GitHub содержит код, а не скопированные из Apps Script Script Properties. Подключение репозитория к Cloudflare не даёт прав читать Gmail автоматически.
