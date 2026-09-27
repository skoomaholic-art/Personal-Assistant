// Reused only within one Apps Script execution; never shared between requests.

var mamutSpreadsheet_ = null;

var mamutStorageReady_ = false;

var mamutSheets_ = {};
var mamutRows_ = {};

const EMAILS_SHEET =

  'Emails';

const TASKS_SHEET =

  'Tasks';

const DRAFTS_SHEET =

  'Drafts';

const EMAIL_HEADERS = [

  'email_id',

  'thread_id',

  'received_at',

  'from_name',

  'from_email',

  'to_line',

  'subject',

  'category',

  'priority',

  'summary',

  'action',

  'deadline_text',

  'deadline_iso',

  'clean_body',

  'attachment_names',

  'has_attachments',

  'gmail_url',

  'status',

  'created_at',

  'updated_at'

];

const TASK_HEADERS = [

  'task_id',

  'email_id',

  'title',

  'description',

  'status',

  'priority',

  'due_iso',

  'due_text',

  'source_from',

  'source_subject',

  'created_at',

  'updated_at',

  'last_reminded_at'

];

const DRAFT_HEADERS = [

  'draft_id',

  'email_id',

  'gmail_draft_id',

  'to_email',

  'subject',

  'body',

  'body_hash',

  'status',

  'created_at',

  'updated_at',

  'sent_at',
  'from_email', 'cc_line', 'bcc_line', 'attachment_manifest',
  'snapshot_hash', 'preview_token', 'sent_message_id', 'last_error'
];

/* =========================================================

   STORAGE INIT

========================================================= */

function ensureStorage() {

  const ss = getDataSpreadsheet();

  if (!mamutStorageReady_) {

    mamutSheets_[EMAILS_SHEET] = ensureSheet(ss, EMAILS_SHEET, EMAIL_HEADERS);

    mamutSheets_[TASKS_SHEET] = ensureSheet(ss, TASKS_SHEET, TASK_HEADERS);

    mamutSheets_[DRAFTS_SHEET] = ensureSheet(ss, DRAFTS_SHEET, DRAFT_HEADERS);

    mamutStorageReady_ = true;

  }

  return ss;

}

function getMamutSheet_(name) {

  ensureStorage();

  const sheet = mamutSheets_[name];

  if (!sheet) throw new Error('Unknown data table');

  return sheet;

}

function getMamutHeaders_(name) {

  if (name === EMAILS_SHEET) return EMAIL_HEADERS;

  if (name === TASKS_SHEET) return TASK_HEADERS;

  if (name === DRAFTS_SHEET) return DRAFT_HEADERS;

  throw new Error('Unknown data table');

}

function getDataSpreadsheet() {

  if (mamutSpreadsheet_) return mamutSpreadsheet_;

  const props = PropertiesService.getScriptProperties();

  const id = props.getProperty('DATA_SHEET_ID');

  if (id) {

    // A transient access failure must never switch the bot to an empty database.

    mamutSpreadsheet_ = SpreadsheetApp.openById(id);

    return mamutSpreadsheet_;

  }

  const ss = SpreadsheetApp.create('Mamut Rahal Data');

  props.setProperty('DATA_SHEET_ID', ss.getId());

  props.setProperty('DATA_SHEET_URL', ss.getUrl());

  mamutSpreadsheet_ = ss;

  return ss;

}

function ensureSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  // Existing columns must not be reordered or overwritten. Extend at the end only.
  const oldCount = Math.min(sheet.getLastColumn(), headers.length);
  const oldHeaders = sheet.getRange(1, 1, 1, oldCount).getValues()[0];
  oldHeaders.forEach(function(h, i) {
    if (String(h) !== headers[i]) {
      throw new Error('Неверная структура листа ' + name + ', колонка ' + (i + 1));
    }
  });
  if (oldCount < headers.length) {
    const missing = headers.slice(oldCount);
    sheet.getRange(1, oldCount + 1, 1, missing.length).setValues([missing]);
  }
  return sheet;
}


function getSheetObjects(sheetName, options) {
  const optionsKey = sheetName + (options && options.includeBody ? ':full' : ':light');
  if (mamutRows_[optionsKey]) {
    return mamutRows_[optionsKey].map(function(x) { return Object.assign({}, x); });
  }
  const sheet = getMamutSheet_(sheetName);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const headers = getMamutHeaders_(sheetName);
  const started = Date.now();
  let values;
  if (sheetName === EMAILS_SHEET && !(options && options.includeBody)) {
    // clean_body is column 14; skip large raw email bodies for menus.
    const left = sheet.getRange(2, 1, last - 1, 13).getValues();
    const right = sheet.getRange(2, 15, last - 1, headers.length - 14).getValues();
    values = left.map(function(row, i) { return row.concat([''], right[i]); });
  } else {
    values = sheet.getRange(2, 1, last - 1, headers.length).getValues();
  }
  const rows = values.map(function(row, i) {
    const obj = {_row: i + 2};
    headers.forEach(function(h, j) { obj[h] = row[j]; });
    return obj;
  });
  mamutRows_[optionsKey] = rows;
  console.log(JSON.stringify({
    event:'mamut_timing', phase:'sheet_read', table:sheetName,
    rows:rows.length, ms:Date.now()-started
  }));
  return rows.map(function(x) { return Object.assign({}, x); });
}


function findRowByKey(sheetName, keyName, keyValue) {

  const sheet = getMamutSheet_(sheetName);

  const headers = getMamutHeaders_(sheetName);

  const column = headers.indexOf(keyName) + 1;

  if (!column) throw new Error('Unknown lookup key');

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return null;

  const cell = sheet.getRange(2, column, lastRow - 1, 1)

    .createTextFinder(String(keyValue)).matchEntireCell(true)

    .matchCase(true).useRegularExpression(false).findNext();

  if (!cell) return null;

  const row = cell.getRow();

  const values = sheet.getRange(row, 1, 1, headers.length).getValues()[0];

  const result = {_row: row};

  headers.forEach(function(header, i) { result[header] = values[i]; });

  return result;

}

function upsertObject(sheetName, headers, keyName, object) {
  const sheet = getMamutSheet_(sheetName);
  const existing = findRowByKey(sheetName, keyName, object[keyName]);
  const values = headers.map(function(header) {
    return object[header] !== undefined ? object[header] : '';
  });
  let row;
  if (existing) {
    row = existing._row;
    sheet.getRange(row, 1, 1, headers.length).setValues([values]);
  } else {
    sheet.appendRow(values);
    row = sheet.getLastRow();
  }
  mamutRows_ = {};
  return row;
}


function saveEmailRecord(record) {

  return upsertObject(

    EMAILS_SHEET,

    EMAIL_HEADERS,

    'email_id',

    record

  );

}

function getEmailRecord(

  emailId

) {

  return findRowByKey(

    EMAILS_SHEET,

    'email_id',

    emailId

  );

}

function updateEmailStatus(

  emailId,

  status

) {

  const email =

    getEmailRecord(

      emailId

    );

  if (!email) {

    return false;

  }

  delete email._row;

  email.status =

    status;

  email.updated_at =

    new Date().toISOString();

  saveEmailRecord(

    email

  );

  return true;

}

function getImportantEmails() {

  return getSheetObjects(

    EMAILS_SHEET

  )

    .filter(

      function(email) {

        return (

          email.priority ===

            'высокий' ||

          email.category ===

            'ВАЖНО'

        );

      }

    )

    .slice(-10)

    .reverse();

}

function getNewsEmails() {

  return getSheetObjects(

    EMAILS_SHEET

  )

    .filter(

      function(email) {

        return (

          email.category ===

            'НОВОСТЬ' ||

          email.category ===

            'FYI'

        );

      }

    )

    .slice(-10)

    .reverse();

}

function getColleagueEmails() {

  const cfg =

    getConfig();

  const domain =

    '@' +

    cfg.internalDomain

      .toLowerCase();

  return getSheetObjects(

    EMAILS_SHEET

  )

    .filter(

      function(email) {

        return String(

          email.from_email ||

          ''

        )

          .toLowerCase()

          .indexOf(

            domain

          ) !== -1;

      }

    )

    .slice(-10)

    .reverse();

}

function searchStoredEmails(

  query,

  limit

) {

  const q =

    String(

      query ||

      ''

    )

      .trim()

      .toLowerCase();

  if (!q) {

    return [];

  }

  return getSheetObjects(

    EMAILS_SHEET, {includeBody:true}

  )

    .filter(

      function(email) {

        const text =

          [

            email.from_name,

            email.from_email,

            email.subject,

            email.summary,

            email.action,

            email.clean_body

          ]

            .join(' ')

            .toLowerCase();

        return (

          text.indexOf(q) !==

          -1

        );

      }

    )

    .slice(

      -(limit || 10)

    )

    .reverse();

}

/* =========================================================

   TASKS

========================================================= */

function saveTask(task) {

  return upsertObject(

    TASKS_SHEET,

    TASK_HEADERS,

    'task_id',

    task

  );

}

function getTask(

  taskId

) {

  return findRowByKey(

    TASKS_SHEET,

    'task_id',

    taskId

  );

}

function findTaskByEmailId(emailId) {

  return findRowByKey(TASKS_SHEET, 'email_id', emailId);

}

function createTaskFromEmailIfNeeded(

  emailRecord

) {

  const action =

    String(

      emailRecord.action ||

      ''

    ).trim();

  if (

    !action ||

    action ===

      'Действий не требуется' ||

    action ===

      'AI-анализ не выполнен'

  ) {

    return null;

  }

  const existing =

    findTaskByEmailId(

      emailRecord.email_id

    );

  if (existing) {

    return existing;

  }

  const task = {

    task_id:

      shortId(),

    email_id:

      emailRecord.email_id,

    title:

      action.substring(

        0,

        180

      ),

    description:

      emailRecord.summary,

    status:

      'NEW',

    priority:

      emailRecord.priority,

    due_iso:

      emailRecord.deadline_iso ||

      '',

    due_text:

      emailRecord.deadline_text ||

      'Не указан',

    source_from:

      emailRecord.from_name,

    source_subject:

      emailRecord.subject,

    created_at:

      new Date().toISOString(),

    updated_at:

      new Date().toISOString(),

    last_reminded_at:

      ''

  };

  saveTask(

    task

  );

  return task;

}

function createManualTaskFromEmail(

  emailId

) {

  const email =

    getEmailRecord(

      emailId

    );

  if (!email) {

    throw new Error(

      'Письмо не найдено'

    );

  }

  const existing =

    findTaskByEmailId(

      emailId

    );

  if (existing) {

    return existing;

  }

  const task = {

    task_id:

      shortId(),

    email_id:

      emailId,

    title:

      String(

        email.action ||

        email.subject

      ).substring(

        0,

        180

      ),

    description:

      email.summary,

    status:

      'NEW',

    priority:

      email.priority ||

      'средний',

    due_iso:

      email.deadline_iso ||

      '',

    due_text:

      email.deadline_text ||

      'Не указан',

    source_from:

      email.from_name,

    source_subject:

      email.subject,

    created_at:

      new Date().toISOString(),

    updated_at:

      new Date().toISOString(),

    last_reminded_at:

      ''

  };

  saveTask(

    task

  );

  return task;

}

function updateTaskStatus(

  taskId,

  status

) {

  const task =

    getTask(

      taskId

    );

  if (!task) {

    return null;

  }

  delete task._row;

  task.status =

    status;

  task.updated_at =

    new Date().toISOString();

  saveTask(

    task

  );

  return task;

}

function getOpenTasks() {

  return getSheetObjects(

    TASKS_SHEET

  )

    .filter(

      function(task) {

        return (

          task.status !==

          'DONE'

        );

      }

    );

}

function getTodayTasks() {

  const now =

    new Date();

  const today =

    Utilities.formatDate(

      now,

      Session.getScriptTimeZone(),

      'yyyy-MM-dd'

    );

  return getOpenTasks()

    .filter(

      function(task) {

        if (task.due_iso) {

          const due =

            new Date(

              task.due_iso

            );

          if (

            !isNaN(

              due.getTime()

            )

          ) {

            const dueDay =

              Utilities.formatDate(

                due,

                Session.getScriptTimeZone(),

                'yyyy-MM-dd'

              );

            return (

              due <= now ||

              dueDay === today

            );

          }

        }

        if (task.created_at) {

          const created =

            new Date(

              task.created_at

            );

          const createdDay =

            Utilities.formatDate(

              created,

              Session.getScriptTimeZone(),

              'yyyy-MM-dd'

            );

          return (

            createdDay === today

          );

        }

        return false;

      }

    );

}

function getWeekTasks() {

  const now =

    new Date();

  const limit =

    new Date(

      now.getTime() +

      7 *

      24 *

      60 *

      60 *

      1000

    );

  return getOpenTasks()

    .filter(

      function(task) {

        if (!task.due_iso) {

          return true;

        }

        const due =

          new Date(

            task.due_iso

          );

        if (

          isNaN(

            due.getTime()

          )

        ) {

          return true;

        }

        return (

          due <= limit

        );

      }

    );

}

/* =========================================================

   DRAFTS

========================================================= */

function saveDraftRecord(

  draft

) {

  return upsertObject(

    DRAFTS_SHEET,

    DRAFT_HEADERS,

    'draft_id',

    draft

  );

}

function getDraftRecord(

  draftId

) {

  return findRowByKey(

    DRAFTS_SHEET,

    'draft_id',

    draftId

  );

}

function updateDraftRecord(

  draftId,

  updates

) {

  const draft =

    getDraftRecord(

      draftId

    );

  if (!draft) {

    throw new Error(

      'Черновик не найден'

    );

  }

  delete draft._row;

  Object

    .keys(

      updates ||

      {}

    )

    .forEach(

      function(key) {

        draft[key] =

          updates[key];

      }

    );

  draft.updated_at =

    new Date().toISOString();

  saveDraftRecord(

    draft

  );

  return draft;

}

/* =========================================================

   REMINDERS

========================================================= */

function runReminders() {
  const cfg = getConfig();
  if (!cfg.botToken || !cfg.chatId) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const now = new Date();
    getOpenTasks().forEach(function(task) {
      if (!task.due_iso || task.status === 'DONE') return;
      const due = new Date(task.due_iso);
      if (isNaN(due.getTime())) return;
      const diff = due.getTime() - now.getTime();
      if (diff > 2 * 60 * 60 * 1000) return;
      if (task.last_reminded_at) {
        const last = new Date(task.last_reminded_at);
        if (!isNaN(last.getTime()) && now.getTime() - last.getTime() < 4 * 60 * 60 * 1000) return;
      }
      // Claim BEFORE calling Telegram to prevent duplicate reminders.
      delete task._row;
      task.last_reminded_at = now.toISOString();
      task.updated_at = now.toISOString();
      saveTask(task);
      SpreadsheetApp.flush();
      try {
        sendInteractiveTelegram(
          cfg.chatId,
          (diff < 0 ? '🚨 Задача просрочена' : '⏰ Скоро дедлайн') +
          '\n\n' + task.title + '\n\nДедлайн: ' + task.due_text,
          taskActionKeyboard(task.task_id), cfg
        );
      } catch (e) {
        console.error(JSON.stringify({event:'mamut_reminder_delivery_unknown',taskId:task.task_id}));
      }
    });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}
