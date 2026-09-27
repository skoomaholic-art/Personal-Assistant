/* =========================================================

   WEBHOOK ENTRY

========================================================= */

function doPostTimedImpl_(e) {

  try {

    const cfg =

      getConfig();

    const props =

      PropertiesService

        .getScriptProperties();

    const expectedSecret =

      props.getProperty(

        'WEBHOOK_SECRET'

      );

    const receivedSecret =

      e &&

      e.parameter &&

      e.parameter.secret

        ? e.parameter.secret

        : '';

    if (

      !expectedSecret ||

      receivedSecret !==

        expectedSecret

    ) {

      return ContentService

        .createTextOutput(

          'forbidden'

        );

    }

    const update =

      JSON.parse(

        e.postData.contents

      );

    if (

      update.update_id !==

      undefined &&

      !claimTelegramUpdate(

        update.update_id

      )

    ) {

      return ContentService

        .createTextOutput(

          'duplicate'

        );

    }

    if (

      update.callback_query

    ) {

      handleCallbackQuery(

        update.callback_query,

        cfg

      );

    }

    if (

      update.message

    ) {

      handleTelegramMessage(

        update.message,

        cfg

      );

    }

    return ContentService

      .createTextOutput(

        'ok'

      );

  } catch (error) {

    Logger.log(

      'doPost ERROR: ' +

      error.stack

    );

    return ContentService

      .createTextOutput(

        'error'

      );

  }

}

/* =========================================================

   DUPLICATE PROTECTION

========================================================= */

function claimTelegramUpdate(

  updateId

) {

  const lock =

    LockService.getScriptLock();

  lock.waitLock(

    5000

  );

  try {

    const cache =

      CacheService

        .getScriptCache();

    const key =

      'TG_UPDATE_' +

      String(

        updateId

      );

    if (

      cache.get(key) ===

      '1'

    ) {

      return false;

    }

    cache.put(

      key,

      '1',

      21600

    );

    return true;

  } finally {

    if (

      lock.hasLock()

    ) {

      lock.releaseLock();

    }

  }

}

function claimTelegramAction(chatId, messageId, action) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return false;
  try {
    const cache = CacheService.getScriptCache();
    const key = 'TG_ACTION_' + sha256Text(String(chatId) + ':' + String(messageId) + ':' + action).slice(0,30);
    if (cache.get(key) === '1') return false;
    cache.put(key,'1',3);
    return true;
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}


function handleTelegramMessage(

  message,

  cfg

) {

  const chatId =

    String(

      message.chat.id

    );

  if (

    chatId !==

    String(

      cfg.chatId

    )

  ) {

    return;

  }

  const text =

    String(

      message.text ||

      ''

    ).trim();

  if (!text) {

    return;

  }

  const command = text.toLowerCase().replace(/@[a-z0-9_]+$/i, '');

  if (['/start', '/menu', 'меню', '/cancel', 'отмена'].indexOf(command) !== -1) {

    clearMamutState(chatId);

    sendMainMenu(chatId, cfg);

    return;

  }

  if (command === '/reset') {

    clearMamutState(chatId);

    askResetConfirmation(chatId, cfg);

    return;

  }

  const state =

    getMamutState(

      chatId

    );

  if (

    state &&

    state.mode ===

      'AWAITING_SEARCH'

  ) {

    clearMamutState(

      chatId

    );

    showSearchResults(

      chatId,

      text,

      cfg

    );

    return;

  }

  if (

    state &&

    state.mode ===

      'AWAITING_REPLY_INSTRUCTION'

  ) {

    prepareReplyFromInstruction(

      chatId,

      state.emailId,

      text,

      cfg

    );

    return;

  }

  if (

    state &&

    state.mode ===

      'AWAITING_DRAFT_EDIT'

  ) {

    applyDraftEdit(

      chatId,

      state.draftId,

      text,

      cfg

    );

    return;

  }

  if (

    tryReactToSimpleMessage(

      message,

      cfg

    )

  ) {

    return;

  }

  if (

    text === '/start' ||

    text === '/menu' ||

    text.toLowerCase() ===

      'меню'

  ) {

    sendMainMenu(

      chatId,

      cfg

    );

    return;

  }

  if (

    text === '/reset'

  ) {

    askResetConfirmation(

      chatId,

      cfg

    );

    return;

  }

  const lower =

    text.toLowerCase();

  if (

    lower.indexOf(

      'что важного'

    ) !== -1

  ) {

    showImportant(

      chatId,

      cfg

    );

    return;

  }

  if (

    lower.indexOf(

      'что у меня сегодня'

    ) !== -1 ||

    lower ===

      'задачи на сегодня'

  ) {

    showToday(

      chatId,

      cfg

    );

    return;

  }

  if (

    lower.indexOf(

      'на неделю'

    ) !== -1

  ) {

    showWeek(

      chatId,

      cfg

    );

    return;

  }

  if (

    lower.indexOf(

      'новост'

    ) !== -1

  ) {

    showNews(

      chatId,

      cfg

    );

    return;

  }

  if (

    lower.indexOf(

      'коллег'

    ) !== -1 &&

    lower.indexOf(

      'письм'

    ) !== -1

  ) {

    showColleagues(

      chatId,

      cfg

    );

    return;

  }

  if (

    lower.indexOf(

      'проверь почт'

    ) !== -1

  ) {

    performMailCheck(

      chatId,

      cfg

    );

    return;

  }

  chatWithMamut(

    chatId,

    text,

    cfg

  );

}

/* =========================================================

   CALLBACK HANDLER

========================================================= */

function handleCallbackQuery(

  callback,

  cfg

) {

  const chatId =

    String(

      callback.message.chat.id

    );

  if (

    chatId !==

    String(

      cfg.chatId

    )

  ) {

    return;

  }

  answerCallback(

    callback.id,

    cfg

  );

  const action =

    callback.data ||

    '';

  if (

    !claimTelegramAction(

      chatId,

      callback.message.message_id,

      action

    )

  ) {

    return;

  }

  if (

    action ===

    'open_menu'

  ) {

    clearMamutState(chatId);

    sendMainMenu(

      chatId,

      cfg

    );

    return;

  }

  if (

    action ===

    'menu_important'

  ) {

    showImportant(

      chatId,

      cfg

    );

    return;

  }

  if (

    action ===

    'menu_today'

  ) {

    showToday(

      chatId,

      cfg

    );

    return;

  }

  if (

    action ===

    'menu_week'

  ) {

    showWeek(

      chatId,

      cfg

    );

    return;

  }

  if (

    action ===

    'menu_colleagues'

  ) {

    showColleagues(

      chatId,

      cfg

    );

    return;

  }

  if (

    action ===

    'menu_news'

  ) {

    showNews(

      chatId,

      cfg

    );

    return;

  }

  if (

    action ===

    'menu_search'

  ) {

    setMamutState(

      chatId,

      {

        mode:

          'AWAITING_SEARCH'

      }

    );

    sendInteractiveTelegram(

      chatId,

      'Что искать в письмах?',

      null,

      cfg

    );

    return;

  }

  if (

    action ===

    'menu_mail'

  ) {

    performMailCheck(

      chatId,

      cfg

    );

    return;

  }

  if (

    action ===

    'menu_reset'

  ) {

    askResetConfirmation(

      chatId,

      cfg

    );

    return;

  }

  if (

    action ===

    'confirm_reset'

  ) {

    clearMamutHistory(

      chatId

    );

    clearMamutState(

      chatId

    );

    sendInteractiveTelegram(

      chatId,

      '✅ Контекст очищен.',

      smallMenuKeyboard(),

      cfg

    );

    return;

  }

  if (

    action ===

    'cancel_reset'

  ) {

    sendInteractiveTelegram(

      chatId,

      'Отменено.',

      smallMenuKeyboard(),

      cfg

    );

    return;

  }

  if (

    action.indexOf(

      'email_view:'

    ) === 0

  ) {

    showEmailDetails(

      chatId,

      action.split(':')[1],

      cfg

    );

    return;

  }

  if (

    action.indexOf(

      'email_reply:'

    ) === 0

  ) {

    startReplyFlow(

      action.split(':')[1],

      chatId,

      cfg

    );

    return;

  }

  if (

    action.indexOf(

      'email_task:'

    ) === 0

  ) {

    const task =

      createManualTaskFromEmail(

        action.split(':')[1]

      );

    sendInteractiveTelegram(

      chatId,

      '✅ Задача сохранена:\n\n' +

      task.title,

      taskActionKeyboard(

        task.task_id

      ),

      cfg

    );

    return;

  }

  if (

    action.indexOf(

      'email_atts:'

    ) === 0

  ) {

    showEmailAttachments(

      chatId,

      action.split(':')[1],

      cfg

    );

    return;

  }

  if (

    action.indexOf(

      'attget:'

    ) === 0

  ) {

    const parts =

      action.split(':');

    sendEmailAttachmentToTelegram(

      chatId,

      parts[1],

      Number(

        parts[2]

      ),

      cfg

    );

    return;

  }

  if (

    action.indexOf(

      'task_view:'

    ) === 0

  ) {

    showTaskDetails(

      chatId,

      action.split(':')[1],

      cfg

    );

    return;

  }

  if (

    action.indexOf(

      'task_done:'

    ) === 0

  ) {

    const task =

      updateTaskStatus(

        action.split(':')[1],

        'DONE'

      );

    sendInteractiveTelegram(

      chatId,

      task

        ? '✅ Выполнено:\n\n' +

          task.title

        : 'Задача не найдена.',

      smallMenuKeyboard(),

      cfg

    );

    return;

  }

  if (

    action.indexOf(

      'task_progress:'

    ) === 0

  ) {

    const task =

      updateTaskStatus(

        action.split(':')[1],

        'IN_PROGRESS'

      );

    sendInteractiveTelegram(

      chatId,

      task

        ? '🟡 В работе:\n\n' +

          task.title

        : 'Задача не найдена.',

      smallMenuKeyboard(),

      cfg

    );

    return;

  }

  if (

    action.indexOf(

      'senddraft:'

    ) === 0

  ) {

    const parts = action.split(':');
    confirmSendDraft(chatId, parts[1], cfg, parts[2] || '');


    return;

  }

  if (

    action.indexOf(

      'editdraft:'

    ) === 0

  ) {

    beginDraftEdit(

      chatId,

      action.split(':')[1],

      cfg

    );

    return;

  }

  if (

    action.indexOf(

      'canceldraft:'

    ) === 0

  ) {

    cancelDraft(

      chatId,

      action.split(':')[1],

      cfg

    );

    return;

  }

  if (

    action.indexOf(

      'refreshdraft:'

    ) === 0

  ) {

    refreshChangedDraft(

      chatId,

      action.split(':')[1],

      cfg

    );

    return;

  }

}

/* =========================================================

   MAIL CHECK UI

========================================================= */

function performMailCheck(

  chatId,

  cfg

) {

  sendInteractiveTelegram(

    chatId,

    '🔄 Проверяю почту...',

    null,

    cfg

  );

  try {

    const stats =

      checkNewMail();

    sendInteractiveTelegram(

      chatId,

      formatMailCheckResult(

        stats

      ),

      mailCheckResultKeyboard(),

      cfg

    );

  } catch (error) {

    Logger.log(

      'Mail check error: ' +

      error.stack

    );

    sendInteractiveTelegram(

      chatId,

      '❌ Не удалось проверить почту.\n\n' +

      error.message,

      smallMenuKeyboard(),

      cfg

    );

  }

}

function formatMailCheckResult(stats) {
  if (!stats) return '✅ Почта проверена.';
  if (stats.busy) return '⏳ Проверка уже выполняется. Подожди её завершения.';
  let text = '📨 Почта проверена\n\n';
  text += stats.newEmails
    ? 'Новых писем: ' + stats.newEmails +
      '\nСоздано задач: ' + stats.tasksCreated +
      '\nВажных: ' + stats.important +
      '\nНовости / FYI: ' + stats.news +
      '\nС вложениями: ' + stats.attachments
    : 'Новых рабочих писем нет.';
  if (stats.pendingReview) text += '\n\n⚠️ Требуют проверки доставки: ' + stats.pendingReview;
  if (stats.errors) text += '\n⚠️ Ошибок обработки: ' + stats.errors;
  return text;
}


function mailCheckResultKeyboard() {

  return {

    inline_keyboard: [

      [

        {

          text:

            '🔥 Важное',

          callback_data:

            'menu_important'

        },

        {

          text:

            '✅ Сегодня',

          callback_data:

            'menu_today'

        }

      ],

      [

        {

          text:

            '📰 Новости',

          callback_data:

            'menu_news'

        },

        {

          text:

            '👥 Коллеги',

          callback_data:

            'menu_colleagues'

        }

      ],

      [

        {

          text:

            '☰ Меню',

          callback_data:

            'open_menu'

        }

      ]

    ]

  };

}

/* =========================================================

   MENUS

========================================================= */

function mainMenuKeyboard() {

  return {

    inline_keyboard: [

      [

        {

          text:

            '🔥 Важное',

          callback_data:

            'menu_important'

        },

        {

          text:

            '✅ Сегодня',

          callback_data:

            'menu_today'

        }

      ],

      [

        {

          text:

            '📅 Неделя',

          callback_data:

            'menu_week'

        },

        {

          text:

            '👥 Коллеги',

          callback_data:

            'menu_colleagues'

        }

      ],

      [

        {

          text:

            '📰 Новости',

          callback_data:

            'menu_news'

        },

        {

          text:

            '🔎 Поиск',

          callback_data:

            'menu_search'

        }

      ],

      [

        {

          text:

            '📨 Проверить почту',

          callback_data:

            'menu_mail'

        }

      ],

      [

        {

          text:

            '🧠 Сбросить контекст',

          callback_data:

            'menu_reset'

        }

      ]

    ]

  };

}

function smallMenuKeyboard() {

  return {

    inline_keyboard: [

      [

        {

          text:

            '☰ Меню',

          callback_data:

            'open_menu'

        }

      ]

    ]

  };

}

function sendMainMenu(

  chatId,

  cfg

) {

  sendInteractiveTelegram(

    chatId,

    'Что делаем?',

    mainMenuKeyboard(),

    cfg

  );

}

/* =========================================================

   EMAIL BUTTONS

========================================================= */

function emailActionKeyboard(

  emailId,

  hasAttachments

) {

  const rows = [

    [

      {

        text:

          '↩️ Ответить',

        callback_data:

          'email_reply:' +

          emailId

      },

      {

        text:

          '✅ В задачи',

        callback_data:

          'email_task:' +

          emailId

      }

    ]

  ];

  if (hasAttachments) {

    rows.push([

      {

        text:

          '📎 Вложения',

        callback_data:

          'email_atts:' +

          emailId

      }

    ]);

  }

  rows.push([

    {

      text:

        '☰ Меню',

      callback_data:

        'open_menu'

    }

  ]);

  return {

    inline_keyboard:

      rows

  };

}

/* =========================================================

   TASK BUTTONS

========================================================= */

function taskActionKeyboard(

  taskId

) {

  return {

    inline_keyboard: [

      [

        {

          text:

            '🟡 В работу',

          callback_data:

            'task_progress:' +

            taskId

        },

        {

          text:

            '✅ Выполнено',

          callback_data:

            'task_done:' +

            taskId

        }

      ],

      [

        {

          text:

            '☰ Меню',

          callback_data:

            'open_menu'

        }

      ]

    ]

  };

}

/* =========================================================

   IMPORTANT / NEWS / COLLEAGUES

========================================================= */

function showImportant(

  chatId,

  cfg

) {

  showEmailCollection(

    chatId,

    '🔥 Важное',

    getImportantEmails(),

    cfg

  );

}

function showNews(

  chatId,

  cfg

) {

  showEmailCollection(

    chatId,

    '📰 Новости / FYI',

    getNewsEmails(),

    cfg

  );

}

function showColleagues(

  chatId,

  cfg

) {

  showEmailCollection(

    chatId,

    '👥 Письма коллег',

    getColleagueEmails(),

    cfg

  );

}

function showEmailCollection(

  chatId,

  title,

  emails,

  cfg

) {

  if (!emails.length) {

    sendInteractiveTelegram(

      chatId,

      title +

      '\n\nПока ничего нет.',

      smallMenuKeyboard(),

      cfg

    );

    return;

  }

  let text =

    title +

    '\n';

  const buttons = [];

  emails

    .slice(

      0,

      8

    )

    .forEach(

      function(email, index) {

        text +=

          '\n' +

          (index + 1) +

          '. ' +

          email.subject +

          '\n' +

          email.summary +

          '\n';

        buttons.push([

          {

            text:

              String(

                index + 1

              ) +

              '. ' +

              String(

                email.subject

              ).substring(

                0,

                40

              ),

            callback_data:

              'email_view:' +

              email.email_id

          }

        ]);

      }

    );

  buttons.push([

    {

      text:

        '☰ Меню',

      callback_data:

        'open_menu'

    }

  ]);

  sendInteractiveTelegram(

    chatId,

    text,

    {

      inline_keyboard:

        buttons

    },

    cfg

  );

}

/* =========================================================

   EMAIL DETAILS

========================================================= */

function showEmailDetails(

  chatId,

  emailId,

  cfg

) {

  const email =

    getEmailRecord(

      emailId

    );

  if (!email) {

    sendInteractiveTelegram(

      chatId,

      'Письмо не найдено.',

      smallMenuKeyboard(),

      cfg

    );

    return;

  }

  const text =

    '📨 Письмо\n\n' +

    'От: ' +

    email.from_name +

    '\n\nТема: ' +

    email.subject +

    '\n\nКратко:\n' +

    email.summary +

    '\n\nЧто требуется:\n' +

    email.action +

    '\n\nПриоритет: ' +

    email.priority +

    '\nДедлайн: ' +

    email.deadline_text;

  sendInteractiveTelegram(

    chatId,

    text,

    emailActionKeyboard(

      email.email_id,

      email.has_attachments ===

        'YES'

    ),

    cfg

  );

}

/* =========================================================

   TODAY / WEEK

========================================================= */

function showToday(

  chatId,

  cfg

) {

  showTaskCollection(

    chatId,

    '✅ Сегодня',

    getTodayTasks(),

    cfg

  );

}

function showWeek(

  chatId,

  cfg

) {

  showTaskCollection(

    chatId,

    '📅 Неделя',

    getWeekTasks(),

    cfg

  );

}

function showTaskCollection(

  chatId,

  title,

  tasks,

  cfg

) {

  if (!tasks.length) {

    sendInteractiveTelegram(

      chatId,

      title +

      '\n\nОткрытых задач нет.',

      smallMenuKeyboard(),

      cfg

    );

    return;

  }

  let text =

    title +

    '\n';

  const buttons = [];

  tasks

    .slice(

      0,

      10

    )

    .forEach(

      function(task, index) {

        text +=

          '\n' +

          (index + 1) +

          '. ' +

          task.title +

          '\nСтатус: ' +

          task.status +

          '\nДедлайн: ' +

          task.due_text +

          '\n';

        buttons.push([

          {

            text:

              String(

                index + 1

              ) +

              '. ' +

              String(

                task.title

              ).substring(

                0,

                38

              ),

            callback_data:

              'task_view:' +

              task.task_id

          }

        ]);

      }

    );

  buttons.push([

    {

      text:

        '☰ Меню',

      callback_data:

        'open_menu'

    }

  ]);

  sendInteractiveTelegram(

    chatId,

    text,

    {

      inline_keyboard:

        buttons

    },

    cfg

  );

}

function showTaskDetails(

  chatId,

  taskId,

  cfg

) {

  const task =

    getTask(

      taskId

    );

  if (!task) {

    sendInteractiveTelegram(

      chatId,

      'Задача не найдена.',

      smallMenuKeyboard(),

      cfg

    );

    return;

  }

  sendInteractiveTelegram(

    chatId,

    '✅ Задача\n\n' +

    task.title +

    '\n\n' +

    task.description +

    '\n\nСтатус: ' +

    task.status +

    '\nПриоритет: ' +

    task.priority +

    '\nДедлайн: ' +

    task.due_text +

    '\nИсточник: ' +

    task.source_subject,

    taskActionKeyboard(

      task.task_id

    ),

    cfg

  );

}

/* =========================================================

   SEARCH

========================================================= */

function showSearchResults(

  chatId,

  query,

  cfg

) {

  showEmailCollection(

    chatId,

    '🔎 Поиск: ' +

    query,

    searchStoredEmails(

      query,

      8

    ),

    cfg

  );

}

/* =========================================================

   ATTACHMENTS

========================================================= */

function showEmailAttachments(

  chatId,

  emailId,

  cfg

) {

  const message =

    GmailApp.getMessageById(

      emailId

    );

  if (!message) {

    sendInteractiveTelegram(

      chatId,

      'Письмо не найдено.',

      smallMenuKeyboard(),

      cfg

    );

    return;

  }

  const attachments =

    message.getAttachments({

      includeInlineImages:

        false,

      includeAttachments:

        true

    });

  if (!attachments.length) {

    sendInteractiveTelegram(

      chatId,

      'Вложений нет.',

      smallMenuKeyboard(),

      cfg

    );

    return;

  }

  const buttons =

    attachments.map(

      function(blob, index) {

        return [

          {

            text:

              '📎 ' +

              String(

                blob.getName()

              ).substring(

                0,

                45

              ),

            callback_data:

              'attget:' +

              emailId +

              ':' +

              index

          }

        ];

      }

    );

  buttons.push([

    {

      text:

        '☰ Меню',

      callback_data:

        'open_menu'

    }

  ]);

  sendInteractiveTelegram(

    chatId,

    'Выбери вложение:',

    {

      inline_keyboard:

        buttons

    },

    cfg

  );

}

function sendEmailAttachmentToTelegram(

  chatId,

  emailId,

  index,

  cfg

) {

  const message =

    GmailApp.getMessageById(

      emailId

    );

  if (!message) {

    throw new Error(

      'Письмо не найдено'

    );

  }

  const attachments =

    message.getAttachments({

      includeInlineImages:

        false,

      includeAttachments:

        true

    });

  if (

    index < 0 ||

    index >=

      attachments.length

  ) {

    throw new Error(

      'Вложение не найдено'

    );

  }

  const blob =

    attachments[index];

  const response =

    UrlFetchApp.fetch(

      'https://api.telegram.org/bot' +

      cfg.botToken +

      '/sendDocument',

      {

        method:

          'post',

        payload: {

          chat_id:

            chatId,

          caption:

            blob.getName(),

          document:

            blob

        },

        muteHttpExceptions:

          true

      }

    );

  Logger.log(

    response.getContentText()

  );

}

/* =========================================================

   FREE CHAT

========================================================= */

function chatWithMamutTimedImpl_(

  chatId,

  userText,

  cfg

) {

  const history =

    loadMamutHistory(

      chatId

    );

  const todayTasks =

    mamutTimedCall_("chat_tasks", getTodayTasks, [])

      .slice(

        0,

        5

      )

      .map(

        function(task) {

          return (

            '- ' +

            task.title +

            ' | ' +

            task.due_text

          );

        }

      )

      .join(

        '\n'

      );

  const messages = [

    {

      role:

        'system',

      content:

        `Ты Рахал Мамут, персональный рабочий помощник Александра в Telegram.

Веди себя как нормальный живой помощник.

Ты можешь:

- вести обычную беседу;

- задавать встречные вопросы;

- помогать с письмами;

- помогать формулировать ответы;

- помогать планировать работу;

- структурировать задачи;

- кратко объяснять информацию.

Будь естественным и кратким.

Не утверждай, что выполнил внешнее действие, если система его реально не выполнила.

Текущие задачи пользователя:

${todayTasks || 'Нет текущих задач в базе.'}`

    }

  ];

  history.forEach(

    function(item) {

      messages.push(

        item

      );

    }

  );

  messages.push({

    role:

      'user',

    content:

      userText

  });

  const payload = {

    model:

      cfg.groqModel,

    messages:

      messages,

    temperature:

      0.6,

    max_completion_tokens:

      800

  };

  const response =

    mamutTimedCall_("groq_chat", function() { return UrlFetchApp.fetch(

      'https://api.groq.com/openai/v1/chat/completions',

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

    ); }, []);

  const status =

    response.getResponseCode();

  const raw =

    response.getContentText();

  if (

    status < 200 ||

    status >= 300

  ) {

    throw new Error(

      'Groq chat ' +

      status +

      ': ' +

      raw

    );

  }

  const data =

    JSON.parse(raw);

  const answer =

    data

      .choices[0]

      .message

      .content

      .trim();

  saveMamutHistory(

    chatId,

    userText,

    answer

  );

  sendInteractiveTelegram(

    chatId,

    answer,

    smallMenuKeyboard(),

    cfg

  );

}

/* =========================================================

   REACTIONS

========================================================= */

function tryReactToSimpleMessage(

  message,

  cfg

) {

  const text =

    String(

      message.text ||

      ''

    )

      .trim()

      .toLowerCase();

  if (

    !/^(спасибо|спс|ок|окей|понял|принято|ага|👍)$/.test(

      text

    )

  ) {

    return false;

  }

  try {

    UrlFetchApp.fetch(

      'https://api.telegram.org/bot' +

      cfg.botToken +

      '/setMessageReaction',

      {

        method:

          'post',

        contentType:

          'application/json',

        payload:

          JSON.stringify({

            chat_id:

              message.chat.id,

            message_id:

              message.message_id,

            reaction: [

              {

                type:

                  'emoji',

                emoji:

                  '👍'

              }

            ]

          }),

        muteHttpExceptions:

          true

      }

    );

    return true;

  } catch (error) {

    return false;

  }

}

/* =========================================================

   TELEGRAM SEND

========================================================= */

function sendInteractiveTelegramTimedImpl_(

  chatId,

  text,

  replyMarkup,

  cfg

) {

  cfg =

    cfg ||

    getConfig();

  text =

    String(

      text ||

      ''

    );

  if (

    text.length > 3900

  ) {

    text =

      text.substring(

        0,

        3900

      ) +

      '\n\n...';

  }

  const payload = {

    chat_id:

      chatId,

    text:

      text,

    disable_web_page_preview:

      true

  };

  if (replyMarkup) {

    payload.reply_markup =

      replyMarkup;

  }

  const response =

    UrlFetchApp.fetch(

      'https://api.telegram.org/bot' +

      cfg.botToken +

      '/sendMessage',

      {

        method:

          'post',

        contentType:

          'application/json',

        payload:

          JSON.stringify(

            payload

          ),

        muteHttpExceptions:

          true

      }

    );

  const result =

    JSON.parse(

      response.getContentText()

    );

  if (!result.ok) {

    throw new Error(

      'Telegram error: ' +

      response.getContentText()

    );

  }

  return result;

}

function answerCallback(

  callbackId,

  cfg

) {

  UrlFetchApp.fetch(

    'https://api.telegram.org/bot' +

    cfg.botToken +

    '/answerCallbackQuery',

    {

      method:

        'post',

      contentType:

        'application/json',

      payload:

        JSON.stringify({

          callback_query_id:

            callbackId

        }),

      muteHttpExceptions:

        true

    }

  );

}

/* =========================================================

   RESET

========================================================= */

function askResetConfirmation(

  chatId,

  cfg

) {

  sendInteractiveTelegram(

    chatId,

    'Очистить контекст текущей беседы?',

    {

      inline_keyboard: [

        [

          {

            text:

              '✅ Да',

            callback_data:

              'confirm_reset'

          },

          {

            text:

              '❌ Нет',

            callback_data:

              'cancel_reset'

          }

        ]

      ]

    },

    cfg

  );

}

/* =========================================================

   STATE

========================================================= */

function getMamutState(

  chatId

) {

  const raw =

    PropertiesService

      .getScriptProperties()

      .getProperty(

        'MAMUT_STATE_' +

        chatId

      );

  if (!raw) {

    return null;

  }

  try {

    return JSON.parse(

      raw

    );

  } catch (error) {

    return null;

  }

}

function setMamutState(

  chatId,

  state

) {

  PropertiesService

    .getScriptProperties()

    .setProperty(

      'MAMUT_STATE_' +

      chatId,

      JSON.stringify(

        state

      )

    );

}

function clearMamutState(

  chatId

) {

  PropertiesService

    .getScriptProperties()

    .deleteProperty(

      'MAMUT_STATE_' +

      chatId

    );

}

/* =========================================================

   CHAT HISTORY

========================================================= */

function loadMamutHistory(

  chatId

) {

  const raw =

    PropertiesService

      .getScriptProperties()

      .getProperty(

        'MAMUT_HISTORY_' +

        chatId

      );

  if (!raw) {

    return [];

  }

  try {

    return JSON.parse(

      raw

    ).slice(

      -12

    );

  } catch (error) {

    return [];

  }

}

function saveMamutHistory(chatId, userText, assistantText) {

  const history = loadMamutHistory(chatId);

  history.push({role: 'user', content: String(userText)});

  history.push({role: 'assistant', content: String(assistantText)});

  let bounded = history.slice(-12);

  // Script property limit is 9 KB; measure UTF-8, including Cyrillic and emoji.

  while (bounded.length && Utilities.newBlob(JSON.stringify(bounded)).getBytes().length > 8000) {

    if (bounded.length > 2) bounded.splice(0, 2);

    else {

      bounded = bounded.map(function(item) {

        return {role: item.role, content: Array.from(item.content).slice(0, Math.floor(Array.from(item.content).length / 2)).join('')};

      });

    }

  }

  PropertiesService.getScriptProperties().setProperty('MAMUT_HISTORY_' + chatId, JSON.stringify(bounded));

}

function clearMamutHistory(

  chatId

) {

  PropertiesService

    .getScriptProperties()

    .deleteProperty(

      'MAMUT_HISTORY_' +

      chatId

    );

}

/* =========================================================

   WEBHOOK SETUP

========================================================= */

function configureTelegramWebhook() {

  const props =

    PropertiesService

      .getScriptProperties();

  const cfg =

    getConfig();

  if (!cfg.botToken) {

    throw new Error(

      'TELEGRAM_BOT_TOKEN не указан'

    );

  }

  if (!cfg.webAppUrl) {

    throw new Error(

      'WEB_APP_URL не указан'

    );

  }

  let secret =

    props.getProperty(

      'WEBHOOK_SECRET'

    );

  if (!secret) {

    secret =

      Utilities

        .getUuid()

        .replace(

          /-/g,

          ''

        );

    props.setProperty(

      'WEBHOOK_SECRET',

      secret

    );

  }

  const webhookUrl =

    cfg.webAppUrl +

    '?secret=' +

    encodeURIComponent(

      secret

    );

  const response =

    UrlFetchApp.fetch(

      'https://api.telegram.org/bot' +

      cfg.botToken +

      '/setWebhook',

      {

        method:

          'post',

        contentType:

          'application/json',

        payload:

          JSON.stringify({

            url:

              webhookUrl,

            drop_pending_updates:

              false

          }),

        muteHttpExceptions:

          true

      }

    );

  Logger.log(

    response.getContentText()

  );

  return response

    .getContentText();

}

function getWebhookInfo() {
  const cfg = getConfig();
  const response = UrlFetchApp.fetch(
    'https://api.telegram.org/bot' + cfg.botToken + '/getWebhookInfo',
    {muteHttpExceptions:true}
  );
  const data = JSON.parse(response.getContentText());
  if (data.result && data.result.url) data.result.url = '[redacted]';
  console.log(JSON.stringify({
    event:'mamut_webhook_status',ok:!!data.ok,
    pending:data.result ? data.result.pending_update_count : undefined,
    lastErrorDate:data.result ? data.result.last_error_date : undefined
  }));
  return data;
}


function doPost() {

  return mamutTimedCall_("doPost", doPostTimedImpl_, arguments);

}

function chatWithMamut() {

  return mamutTimedCall_("chatWithMamut", chatWithMamutTimedImpl_, arguments);

}

function sendInteractiveTelegram() {

  return mamutTimedCall_("sendInteractiveTelegram", sendInteractiveTelegramTimedImpl_, arguments);

}

function mamutTimedCall_(phase, fn, args) {

  const started = Date.now();

  try { return fn.apply(null, args); }

  finally { console.log(JSON.stringify({event: 'mamut_timing', phase: phase, ms: Date.now() - started})); }

}
