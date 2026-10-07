const PROCESSED_LABEL = 'GPT-Telegram/Processed';

const MAX_SEEN_IDS = 350;

/* =========================================================

   CONFIG

========================================================= */

function getConfig() {

  const props =

    PropertiesService.getScriptProperties();

  return {

    botToken:

      props.getProperty('TELEGRAM_BOT_TOKEN'),

    chatId:

      props.getProperty('TELEGRAM_CHAT_ID'),

    groqApiKey:

      props.getProperty('GROQ_API_KEY'),

    groqModel:

      props.getProperty('GROQ_MODEL') ||

      'openai/gpt-oss-20b',

    gmailQuery:

      props.getProperty('GMAIL_QUERY') ||

      'in:inbox newer_than:2d -in:spam -in:trash',

    workEmail:

      props.getProperty('WORK_EMAIL') ||

      'alexandr.petrossov@fmedia.kz',

    internalDomain:

      props.getProperty('INTERNAL_DOMAIN') ||

      'fmedia.kz',

    outboundAlias:

      props.getProperty('OUTBOUND_FROM_ALIAS') ||

      '',

    webAppUrl:

      props.getProperty('WEB_APP_URL') ||

      ''

  };

}

function validateCoreConfig(cfg) {

  if (!cfg.botToken) {

    throw new Error(

      'TELEGRAM_BOT_TOKEN не указан'

    );

  }

  if (!cfg.chatId) {

    throw new Error(

      'TELEGRAM_CHAT_ID не указан'

    );

  }

  if (!cfg.groqApiKey) {

    throw new Error(

      'GROQ_API_KEY не указан'

    );

  }

}

/* =========================================================

   INITIALIZATION

========================================================= */

function initializeMamutV1() {

  const cfg =

    getConfig();

  const spreadsheet =

    ensureStorage();

  Logger.log(

    'Mamut Storage: ' +

    spreadsheet.getUrl()

  );

  Logger.log(

    'Старые SEEN_MESSAGE_IDS не изменены.'

  );

  if (

    cfg.botToken &&

    cfg.chatId

  ) {

    sendInteractiveTelegram(

      cfg.chatId,

      '✅ Хранилище Мамута готово.\n\n' +

      'Письма, задачи и черновики будут сохраняться в Google Sheets.\n\n' +

      'Старые SEEN_MESSAGE_IDS сохранены.',

      mainMenuKeyboard(),

      cfg

    );

  }

  return spreadsheet.getUrl();

}

/* =========================================================

   MAIL CHECK

========================================================= */

function checkNewMail() {
  const cfg = getConfig();
  validateCoreConfig(cfg);
  const lock = LockService.getScriptLock();
  const stats = {
    checkedThreads: 0, checkedMessages: 0, newEmails: 0,
    tasksCreated: 0, important: 0, news: 0, attachments: 0,
    skippedSeen: 0, skippedNonWork: 0, pendingReview: 0,
    errors: 0, busy: false
  };
  if (!lock.tryLock(1000)) {
    stats.busy = true;
    return stats;
  }
  try {
    ensureStorage();
    const props = PropertiesService.getScriptProperties();
    let seenIds = [];
    try {
      seenIds = JSON.parse(props.getProperty('SEEN_MESSAGE_IDS') || '[]');
      if (!Array.isArray(seenIds)) seenIds = [];
    } catch (e) { seenIds = []; }
    const seen = new Set(seenIds);
    let label = GmailApp.getUserLabelByName(PROCESSED_LABEL);
    if (!label) label = GmailApp.createLabel(PROCESSED_LABEL);
    const threads = GmailApp.search(cfg.gmailQuery, 0, 40);
    stats.checkedThreads = threads.length;
    threads.reverse().forEach(function(thread) {
      thread.getMessages().forEach(function(message) {
        stats.checkedMessages++;
        const id = message.getId();
        try {
          if (seen.has(id)) {
            stats.skippedSeen++;
            return;
          }
          const prior = getEmailRecord(id);
          if (prior) {
            // Only a never-attempted notification is automatically retried.
            // NOTIFYING / NOTIFY_UNKNOWN is ambiguous after a network failure:
            // never send twice without manual reconciliation.
            if (prior.status === 'PENDING_NOTIFY') {
              deliverStoredEmail_(prior, cfg);
            } else if (prior.status === 'NOTIFYING' || prior.status === 'NOTIFY_UNKNOWN') {
              stats.pendingReview++;
            } else {
              stats.skippedSeen++;
            }
            seen.add(id);
            return;
          }
          if (!isWorkMessage(message, cfg)) {
            stats.skippedNonWork++;
            seen.add(id);
            return;
          }
          const result = processIncomingMessage(message, cfg);
          stats.newEmails++;
          if (result.task) stats.tasksCreated++;
          if (result.attachmentsCount) stats.attachments++;
          if (result.record.category === 'ВАЖНО' || result.record.priority === 'высокий') stats.important++;
          if (result.record.category === 'НОВОСТЬ' || result.record.category === 'FYI') stats.news++;
          seen.add(id);
        } catch (error) {
          stats.errors++;
          console.error(JSON.stringify({
            event:'mamut_mail_error', messageId:id,
            error: String(error && error.message || error).slice(0,180)
          }));
          // If persisted as NOTIFYING it remains visible in Sheets for review.
        }
      });
      // Gmail labels are thread-wide; do not use the label as message idempotency.
      try { thread.addLabel(label); } catch (e) { stats.errors++; }
    });
    // Script Properties values have a 9 KB limit; keep a small bounded hint.
    const small = Array.from(seen).slice(-MAX_SEEN_IDS);
    while (small.length && Utilities.newBlob(JSON.stringify(small)).getBytes().length > 7800) {
      small.shift();
    }
    props.setProperty('SEEN_MESSAGE_IDS', JSON.stringify(small));
    // Durable visibility of uncertain notification deliveries, even after
    // their Gmail IDs fall out of the bounded SEEN_MESSAGE_IDS hint.
    stats.pendingReview = getSheetObjects(EMAILS_SHEET).filter(function(row) {
      return row.status === 'NOTIFYING' || row.status === 'NOTIFY_UNKNOWN';
    }).length;
    console.log(JSON.stringify({event:'mamut_mail_check', stats:stats}));
    return stats;
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}


function processIncomingMessage(message, cfg) {
  const emailId = message.getId();
  const receivedAt = message.getDate();
  const from = message.getFrom() || 'Неизвестный отправитель';
  let body = '';
  try { body = cleanEmailBody(message.getPlainBody() || ''); } catch (e) {}
  body = body.slice(0, 40000);
  const attachments = getAttachmentMetadata(message);
  let analysis;
  try {
    analysis = analyzeEmailWithGroq({
      from: from, subject: message.getSubject() || 'Без темы',
      date: formatDate(receivedAt), body: body
    }, cfg);
  } catch (e) {
    console.error(JSON.stringify({event:'mamut_ai_error', messageId:emailId}));
    analysis = {
      category:'ПИСЬМО', priority:'средний',
      summary:body.slice(0,500) || 'Текст письма отсутствует',
      action:'AI-анализ не выполнен',
      deadline_text:'Не указан', deadline_iso:''
    };
  }
  const record = {
    email_id:emailId, thread_id:message.getThread().getId(),
    received_at:receivedAt.toISOString(), from_name:from,
    from_email:extractEmailAddress(from), to_line:message.getTo() || '',
    subject:message.getSubject() || 'Без темы',
    category:analysis.category, priority:analysis.priority,
    summary:analysis.summary, action:analysis.action,
    deadline_text:analysis.deadline_text, deadline_iso:analysis.deadline_iso,
    clean_body:body,
    attachment_names:attachments.map(function(a){return a.name;}).join(' | '),
    has_attachments:attachments.length > 0 ? 'YES' : 'NO',
    gmail_url:buildGmailUrl(emailId),
    status:analysis.category === 'МУСОР' ? 'IGNORED' : 'PENDING_NOTIFY',
    created_at:new Date().toISOString(), updated_at:new Date().toISOString()
  };
  saveEmailRecord(record);
  let task = null;
  if (record.category !== 'МУСОР') {
    task = createTaskFromEmailIfNeeded(record);
    deliverStoredEmail_(record, cfg, task);
  }
  return {record:record, task:task, attachmentsCount:attachments.length};
}

function deliverStoredEmail_(record, cfg, task) {
  if (record.status !== 'PENDING_NOTIFY') return false;
  if (!task) task = findTaskByEmailId(record.email_id);
  // Persist the attempt BEFORE calling Telegram. An interrupted attempt
  // must be manually reconciled rather than silently duplicated.
  updateEmailStatus(record.email_id, 'NOTIFYING');
  try {
    sendInteractiveTelegram(
      cfg.chatId, formatIncomingEmailMessage(record, task),
      emailActionKeyboard(record.email_id, record.has_attachments === 'YES'), cfg
    );
  } catch (e) {
    try { updateEmailStatus(record.email_id, 'NOTIFY_UNKNOWN'); } catch (_) {}
    throw e;
  }
  try { updateEmailStatus(record.email_id, 'NOTIFIED'); }
  catch (e) {
    console.error(JSON.stringify({event:'mamut_notify_status_failed',messageId:record.email_id}));
  }
  return true;
}


function analyzeEmailWithGroq(

  email,

  cfg

) {

  const url =

    'https://api.groq.com/openai/v1/chat/completions';

  const systemPrompt =

    `

Ты Рахал Мамут, персональный рабочий помощник Александра.

Твоя задача - анализировать рабочие письма.

Категории:

ЗАДАЧА

ВАЖНО

НОВОСТЬ

FYI

ВСТРЕЧА

ДОКУМЕНТ

ПИСЬМО

МУСОР

Приоритет:

высокий

средний

низкий

Правила:

- summary: максимум 3 коротких предложения.

- action: конкретно указать, что требуется сделать Александру.

- если никаких действий не требуется, action = "Действий не требуется".

- дедлайн не придумывать.

- deadline_text: понятный текст дедлайна или "Не указан".

- deadline_iso: ISO 8601 только если дедлайн реально указан или однозначно следует из письма.

- если дедлайна нет, deadline_iso = "".

- не учитывать подписи, телефоны, юридические дисклеймеры, footer и технический мусор.

- отвечать на русском языке.

- не выдумывать факты.

`.trim();

  const userPrompt =

    `

ОТПРАВИТЕЛЬ:

${email.from}

ТЕМА:

${email.subject}

ДАТА:

${email.date}

ТЕКСТ:

${email.body}

`.trim();

  const payload = {

    model:

      cfg.groqModel,

    messages: [

      {

        role:

          'system',

        content:

          systemPrompt

      },

      {

        role:

          'user',

        content:

          userPrompt

      }

    ],

    temperature:

      0.2,

    max_completion_tokens:

      700,

    response_format: {

      type:

        'json_schema',

      json_schema: {

        name:

          'email_analysis',

        strict:

          true,

        schema: {

          type:

            'object',

          properties: {

            category: {

              type:

                'string',

              enum: [

                'ЗАДАЧА',

                'ВАЖНО',

                'НОВОСТЬ',

                'FYI',

                'ВСТРЕЧА',

                'ДОКУМЕНТ',

                'ПИСЬМО',

                'МУСОР'

              ]

            },

            priority: {

              type:

                'string',

              enum: [

                'высокий',

                'средний',

                'низкий'

              ]

            },

            summary: {

              type:

                'string'

            },

            action: {

              type:

                'string'

            },

            deadline_text: {

              type:

                'string'

            },

            deadline_iso: {

              type:

                'string'

            }

          },

          required: [

            'category',

            'priority',

            'summary',

            'action',

            'deadline_text',

            'deadline_iso'

          ],

          additionalProperties:

            false

        }

      }

    }

  };

  const groqStarted = Date.now();
  const response =

    UrlFetchApp.fetch(

      url,

      {

        method:

          'post',

        contentType:

          'application/json',

        headers: {

          Authorization:

            'Bearer ' +

            cfg.groqApiKey

        },

        payload:

          JSON.stringify(

            payload

          ),

        muteHttpExceptions:

          true

      }

    );

  console.log(JSON.stringify({
    event:'mamut_timing', phase:'groq_mail', ms:Date.now()-groqStarted
  }));
  const status =

    response.getResponseCode();

  const raw =

    response.getContentText();

  if (

    status < 200 ||

    status >= 300

  ) {

    throw new Error(

      'Groq API ' +

      status +

      ': ' +

      raw

    );

  }

  const data =

    JSON.parse(raw);

  if (

    !data.choices ||

    !data.choices[0] ||

    !data.choices[0].message ||

    !data.choices[0].message.content

  ) {

    throw new Error(

      'Groq вернул пустой ответ'

    );

  }

  return JSON.parse(

    data

      .choices[0]

      .message

      .content

  );

}

/* =========================================================

   MAIL FORMAT

========================================================= */

function formatIncomingEmailMessage(

  record,

  task

) {

  const emojiMap = {

    'ЗАДАЧА':

      '✅',

    'ВАЖНО':

      '🔴',

    'НОВОСТЬ':

      '📰',

    'FYI':

      'ℹ️',

    'ВСТРЕЧА':

      '📅',

    'ДОКУМЕНТ':

      '📎',

    'ПИСЬМО':

      '📨'

  };

  const emoji =

    emojiMap[

      record.category

    ] ||

    '📨';

  let text =

    emoji +

    ' ' +

    record.category +

    '\n\nОт: ' +

    record.from_name +

    '\n\nТема: ' +

    record.subject +

    '\n\nКратко:\n' +

    record.summary +

    '\n\nЧто требуется:\n' +

    record.action +

    '\n\nПриоритет: ' +

    record.priority +

    '\nДедлайн: ' +

    (

      record.deadline_text ||

      'Не указан'

    );

  if (task) {

    text +=

      '\n\n✅ Задача сохранена.';

  }

  text +=

    '\n\nПерсональный помощник' +

    '\nРахал Мамут';

  return text;

}

/* =========================================================

   WORK EMAIL FILTER

========================================================= */

function isWorkMessage(

  message,

  cfg

) {

  const to =

    String(

      message.getTo() ||

      ''

    ).toLowerCase();

  const cc =

    String(

      message.getCc() ||

      ''

    ).toLowerCase();

  const from =

    String(

      message.getFrom() ||

      ''

    ).toLowerCase();

  const workEmail =

    cfg.workEmail

      .toLowerCase();

  const domain =

    cfg.internalDomain

      .toLowerCase();

  if (

    to.indexOf(

      workEmail

    ) !== -1 ||

    cc.indexOf(

      workEmail

    ) !== -1

  ) {

    return true;

  }

  if (

    from.indexOf(

      '@' + domain

    ) !== -1

  ) {

    return true;

  }

  return false;

}

/* =========================================================

   ATTACHMENT METADATA

========================================================= */

function getAttachmentMetadata(

  message

) {

  try {

    const attachments =

      message.getAttachments({

        includeInlineImages:

          false,

        includeAttachments:

          true

      });

    return attachments.map(

      function(blob, index) {

        return {

          index:

            index,

          name:

            blob.getName() ||

            (

              'attachment_' +

              index

            ),

          type:

            blob.getContentType(),

          size:

            blob.getSize()

        };

      }

    );

  } catch (error) {

    return [];

  }

}

/* =========================================================

   BODY CLEANING

========================================================= */

function cleanEmailBody(body) {

  if (!body) {

    return '';

  }

  let text =

    body

      .replace(

        /\r/g,

        ''

      )

      .replace(

        /\u00A0/g,

        ' '

      )

      .replace(

        /\n{3,}/g,

        '\n\n'

      )

      .trim();

  const stopMarkers = [

    'Александр Петросов | Alexandr Petrossov',

    'Alexandr Petrossov | Александр Петросов',

    'Редактор контента | OTT Content Editor',

    'This communication contains information which is confidential',

    'This communication contains informa',

    'This footer also confirms that this e-mail message',

    'This footer also confirms',

    'Microsoft Cloud email gateway'

  ];

  let cutPosition =

    text.length;

  stopMarkers.forEach(

    function(marker) {

      const position =

        text.indexOf(

          marker

        );

      if (

        position !== -1 &&

        position <

          cutPosition

      ) {

        cutPosition =

          position;

      }

    }

  );

  text =

    text

      .substring(

        0,

        cutPosition

      )

      .replace(

        /\[cid:[^\]]+\]/gi,

        ''

      )

      .replace(

        /\n{3,}/g,

        '\n\n'

      )

      .trim();

  return text;

}

/* =========================================================

   HELPERS

========================================================= */

function extractEmailAddress(value) {

  if (!value) {

    return '';

  }

  const bracket =

    value.match(

      /<([^>]+)>/

    );

  if (bracket) {

    return bracket[1]

      .trim()

      .toLowerCase();

  }

  const match =

    value.match(

      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i

    );

  return match

    ? match[0]

        .toLowerCase()

    : '';

}

function buildGmailUrl(

  messageId

) {

  return (

    'https://mail.google.com/mail/u/0/#all/' +

    messageId

  );

}

function formatDate(date) {

  return Utilities.formatDate(

    date,

    Session.getScriptTimeZone(),

    'dd.MM.yyyy HH:mm'

  );

}

function shortId() {

  return Utilities

    .getUuid()

    .replace(

      /-/g,

      ''

    )

    .substring(

      0,

      16

    );

}

function sha256Text(text) {

  const bytes =

    Utilities.computeDigest(

      Utilities.DigestAlgorithm.SHA_256,

      String(

        text || ''

      ),

      Utilities.Charset.UTF_8

    );

  return bytes

    .map(function(b) {

      const value =

        b < 0

          ? b + 256

          : b;

      return (

        '0' +

        value.toString(16)

      ).slice(-2);

    })

    .join('');

}

/* =========================================================

   TESTS

========================================================= */

function testGroq() {

  const cfg =

    getConfig();

  validateCoreConfig(cfg);

  const result =

    analyzeEmailWithGroq(

      {

        from:

          'test@example.com',

        subject:

          'Тест Мамута',

        date:

          formatDate(

            new Date()

          ),

        body:

          'Нужно согласовать баннер Scoob! сегодня до 16:00.'

      },

      cfg

    );

  Logger.log(

    JSON.stringify(

      result,

      null,

      2

    )

  );

  return result;

}

function testTelegram() {

  const cfg =

    getConfig();

  validateCoreConfig(cfg);

  sendInteractiveTelegram(

    cfg.chatId,

    '✅ Telegram Мамута работает.',

    smallMenuKeyboard(),

    cfg

  );

}

/* =========================================================

   TRIGGERS

========================================================= */

function installMamutTriggers() {

  const handlers = [

    'checkNewMail',

    'runReminders'

  ];

  ScriptApp

    .getProjectTriggers()

    .forEach(

      function(trigger) {

        if (

          handlers.indexOf(

            trigger.getHandlerFunction()

          ) !== -1

        ) {

          ScriptApp.deleteTrigger(

            trigger

          );

        }

      }

    );

  ScriptApp

    .newTrigger(

      'checkNewMail'

    )

    .timeBased()

    .everyMinutes(5)

    .create();

  ScriptApp

    .newTrigger(

      'runReminders'

    )

    .timeBased()

    .everyMinutes(30)

    .create();

  Logger.log(

    'Триггеры Мамута установлены.'

  );

}