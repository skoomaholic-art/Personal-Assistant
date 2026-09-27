// MailActions.gs - email drafts are never sent without a complete, fresh preview.
// Status SENDING / SEND_UNKNOWN intentionally requires manual reconciliation.

function startReplyFlow(emailId, chatId, cfg) {
  cfg = cfg || getConfig();
  chatId = chatId || String(cfg.chatId);
  if (!emailId) throw new Error('Нажми "Ответить" под конкретным письмом, а не запускай функцию вручную.');
  const email = getEmailRecord(emailId);
  if (!email) {
    sendInteractiveTelegram(chatId, 'Письмо не найдено.', smallMenuKeyboard(), cfg);
    return;
  }
  setMamutState(chatId, {mode:'AWAITING_REPLY_INSTRUCTION', emailId:emailId});
  sendInteractiveTelegram(chatId,
    'Что ответить на письмо:\n\n' + email.subject +
    '\n\nНапиши своими словами. Я подготовлю ответ. /cancel - отмена.',
    null, cfg);
}

function prepareReplyFromInstruction(chatId, emailId, instruction, cfg) {
  cfg = cfg || getConfig();
  const email = getEmailRecord(emailId);
  if (!email) throw new Error('Исходное письмо не найдено');
  const body = generateReplyWithGroq(email, instruction, cfg);
  const alias = getValidOutboundAlias(cfg);
  let gmailDraftId = '';
  let snapshot = null;
  if (alias) {
    // An unexpected draft-creation failure must not cause an email to be sent.
    try {
      gmailDraftId = createGmailReplyDraft(emailId, body, alias);
      snapshot = captureGmailDraftSnapshot_(findGmailDraft(gmailDraftId));
    } catch (e) {
      console.error(JSON.stringify({event:'mamut_draft_create_error'}));
    }
  }
  const draft = {
    draft_id: shortId(), email_id:emailId, gmail_draft_id:gmailDraftId,
    to_email:email.from_email, subject:buildReplySubject(email.subject),
    body:body, body_hash:sha256Text(body), status:'PREVIEWING',
    created_at:new Date().toISOString(), updated_at:new Date().toISOString(), sent_at:'',
    from_email:alias, cc_line:'', bcc_line:'', attachment_manifest:'[]',
    snapshot_hash:'', preview_token:'', sent_message_id:'', last_error:''
  };
  if (snapshot) mergeSnapshotIntoDraft_(draft, snapshot);
  saveDraftRecord(draft);
  clearMamutState(chatId);
  showDraftPreview(chatId, draft, cfg);
  return draft;
}

function generateReplyWithGroq(email, instruction, cfg) {
  cfg = cfg || getConfig();
  if (!cfg.groqApiKey) throw new Error('GROQ_API_KEY не указан');
  const context = getEmailThreadContext(email.email_id);
  const payload = {
    model:cfg.groqModel,
    messages:[
      {role:'system', content:
        'Ты Рахал Мамут. Подготовь только готовый текст рабочего письма, без markdown и объяснений. ' +
        'Не выдумывай факты, не добавляй корпоративную подпись и юридические дисклеймеры. ' +
        'Соблюдай язык переписки; пиши естественно и кратко.'},
      {role:'user', content:
        'От: ' + email.from_name + '\nТема: ' + email.subject +
        '\nСуть: ' + email.summary + '\nКонтекст:\n' + context +
        '\nИнструкция пользователя:\n' + instruction}
    ],
    temperature:0.4, max_completion_tokens:1000
  };
  const started = Date.now();
  const response = UrlFetchApp.fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:'post', contentType:'application/json',
    headers:{Authorization:'Bearer ' + cfg.groqApiKey},
    payload:JSON.stringify(payload), muteHttpExceptions:true
  });
  console.log(JSON.stringify({event:'mamut_timing',phase:'groq_reply',ms:Date.now()-started}));
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) throw new Error('Groq reply HTTP ' + status);
  const data = JSON.parse(response.getContentText());
  const answer = data.choices && data.choices[0] && data.choices[0].message &&
    data.choices[0].message.content;
  if (!answer || !String(answer).trim()) throw new Error('Groq вернул пустой ответ');
  return String(answer).trim();
}

function getEmailThreadContext(emailId) {
  if (!emailId) return '';
  try {
    const message = GmailApp.getMessageById(emailId);
    if (!message) return '';
    return message.getThread().getMessages().slice(-4).map(function(item) {
      return 'От: ' + item.getFrom() +
        '\nДата: ' + formatDate(item.getDate()) +
        '\nТема: ' + item.getSubject() +
        '\n' + cleanEmailBody(item.getPlainBody() || '').slice(0, 1400);
    }).join('\n\n-----\n\n');
  } catch (e) { return ''; }
}

function buildReplySubject(subject) {
  const s = String(subject || 'Без темы').trim();
  return /^re:/i.test(s) ? s : 'Re: ' + s;
}

function getValidOutboundAlias(cfg) {
  cfg = cfg || getConfig();
  const desired = String(cfg.outboundAlias || '').trim().toLowerCase();
  const work = String(cfg.workEmail || '').trim().toLowerCase();
  if (!desired || desired !== work) return '';
  const aliases = GmailApp.getAliases().map(function(a){return String(a).toLowerCase();});
  return aliases.indexOf(desired) === -1 ? '' : desired;
}

function createGmailReplyDraft(emailId, body, alias) {
  if (!emailId || !body || !alias) throw new Error('Нет письма, текста или корпоративного alias');
  const message = GmailApp.getMessageById(emailId);
  if (!message) throw new Error('Gmail message не найден');
  return message.createDraftReply(body, {from:alias}).getId();
}

function findGmailDraft(id) {
  if (!id) return null;
  const drafts = GmailApp.getDrafts();
  for (let i = 0; i < drafts.length; i++) {
    if (drafts[i].getId() === id) return drafts[i];
  }
  return null;
}

function canonicalRecipients_(value) {
  const s = String(value || '');
  const matches = s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return matches.map(function(a){return a.toLowerCase();}).sort().join(', ');
}

function captureGmailDraftSnapshot_(draft) {
  if (!draft) throw new Error('Gmail draft не найден');
  const m = draft.getMessage();
  if (!m) throw new Error('Не удалось прочитать Gmail draft');
  const atts = m.getAttachments({includeInlineImages:false,includeAttachments:true}).map(function(a) {
    return {name:a.getName() || '',size:a.getSize(),type:a.getContentType()};
  });
  atts.sort(function(a,b){return JSON.stringify(a).localeCompare(JSON.stringify(b));});
  const s = {
    from_email:extractEmailAddress(m.getFrom()).toLowerCase(),
    to_email:canonicalRecipients_(m.getTo()),
    cc_line:canonicalRecipients_(m.getCc()),
    bcc_line:canonicalRecipients_(m.getBcc()),
    subject:String(m.getSubject() || '').trim(),
    body:String(m.getPlainBody() || '').trim(),
    attachment_manifest:JSON.stringify(atts)
  };
  s.snapshot_hash = sha256Text(JSON.stringify(s));
  return s;
}

function mergeSnapshotIntoDraft_(record, snap) {
  ['from_email','to_email','cc_line','bcc_line','subject','body',
   'attachment_manifest','snapshot_hash'].forEach(function(key) {
     record[key] = snap[key];
   });
  record.body_hash = sha256Text(snap.body);
  return record;
}

function showDraftPreview(chatId, draft, cfg) {
  cfg = cfg || getConfig();
  chatId = chatId || String(cfg.chatId);
  if (!draft) throw new Error('Черновик не передан');

  const alias = getValidOutboundAlias(cfg);
  const canSend = !!(alias && draft.gmail_draft_id &&
    String(draft.from_email).toLowerCase() === alias && draft.snapshot_hash);
  const body = String(draft.body || '');
  const MAX_PREVIEW = 30000;
  // No confirmation button if we cannot display the complete draft.
  const bodyFits = body.length <= MAX_PREVIEW;
  const token = shortId();
  const updated = updateDraftRecord(draft.draft_id, {
    status:'PREVIEWING', preview_token:token
  });

  let manifest = [];
  try { manifest = JSON.parse(String(updated.attachment_manifest || '[]')); } catch (e) {}
  const files = manifest.length ? manifest.map(function(a) {
    return a.name + ' (' + a.size + ' байт)';
  }).join('\n') : 'Нет';
  const meta = '✉️ Предпросмотр письма\n\n' +
    'От: ' + (updated.from_email || 'Не настроено') +
    '\nКому: ' + (updated.to_email || 'Не указан') +
    '\nКопия: ' + (updated.cc_line || 'Нет') +
    '\nСкрытая копия: ' + (updated.bcc_line || 'Нет') +
    '\nТема: ' + updated.subject +
    '\nВложения: ' + files +
    '\n\nПолный текст ниже:';
  const metaFits = meta.length <= 3500;
  if (metaFits) {
    sendInteractiveTelegram(chatId, meta, null, cfg);
  } else {
    sendInteractiveTelegram(chatId,
      '⛔ Слишком много адресатов или вложений. Полный предпросмотр невозможен. Отправка заблокирована.',
      null, cfg);
  }
  const fullPreview = bodyFits && metaFits;
  if (bodyFits) {
    const codepoints = Array.from(body);
    const total = Math.max(1, Math.ceil(codepoints.length / 2700));
    for (let i = 0; i < total; i++) {
      sendInteractiveTelegram(chatId,
        'Текст ' + (i+1) + '/' + total + ':\n\n' +
        codepoints.slice(i*2700,(i+1)*2700).join(''), null, cfg);
    }
  } else {
    sendInteractiveTelegram(chatId,
      '⛔ Текст слишком длинный для полного предпросмотра в Telegram. ' +
      'Отправка заблокирована. Проверь его целиком в Gmail.', null, cfg);
  }
  const keyboard = {inline_keyboard:[
    canSend && fullPreview
      ? [{text:'✅ Отправить',callback_data:'senddraft:' + draft.draft_id + ':' + token},
         {text:'✏️ Изменить',callback_data:'editdraft:' + draft.draft_id}]
      : [{text:'✏️ Изменить',callback_data:'editdraft:' + draft.draft_id}],
    [{text:'❌ Отмена',callback_data:'canceldraft:' + draft.draft_id}]
  ]};
  // A response with this button is the explicit confirmation for the entire preview above.
  updateDraftRecord(draft.draft_id, {status:'PREVIEWED'});
  sendInteractiveTelegram(chatId,
    canSend && fullPreview
      ? 'Проверь получателя, тему, вложения и весь текст выше. Отправлять?'
      : '⛔ Отправка отключена: нужен действующий корпоративный alias, Gmail-черновик и полный предпросмотр.',
    keyboard, cfg);
}

function beginDraftEdit(chatId, draftId, cfg) {
  cfg = cfg || getConfig();
  const draft = getDraftRecord(draftId);
  if (!draft) throw new Error('Черновик не найден');
  if (['SENT','SENDING','SEND_UNKNOWN','CANCELED'].indexOf(String(draft.status)) !== -1) {
    sendInteractiveTelegram(chatId,'Черновик уже завершён либо требует ручной проверки отправки.',smallMenuKeyboard(),cfg);
    return;
  }
  // Starting an edit invalidates the old confirmation button immediately.
  updateDraftRecord(draftId,{status:'EDITING',preview_token:''});
  setMamutState(chatId,{mode:'AWAITING_DRAFT_EDIT',draftId:draftId});
  sendInteractiveTelegram(chatId,'Пришли новый текст письма целиком. /cancel - выход.',null,cfg);
}

function applyDraftEdit(chatId, draftId, newBody, cfg) {
  cfg = cfg || getConfig();
  const body = String(newBody || '').trim();
  if (!body) throw new Error('Новый текст письма пустой');
  const old = getDraftRecord(draftId);
  if (!old) throw new Error('Черновик не найден');
  if (['SENT','SENDING','SEND_UNKNOWN','CANCELED'].indexOf(String(old.status)) !== -1) {
    throw new Error('Редактирование недоступно для завершённого черновика');
  }
  const alias = getValidOutboundAlias(cfg);
  let newId = '', snap = null;
  if (alias) {
    // First create the replacement; do not destroy the original on a failed create.
    newId = createGmailReplyDraft(old.email_id, body, alias);
    snap = captureGmailDraftSnapshot_(findGmailDraft(newId));
  }
  const data = {body:body, body_hash:sha256Text(body),
    gmail_draft_id:newId, snapshot_hash:'', preview_token:'', status:'PREVIEWING'};
  if (snap) mergeSnapshotIntoDraft_(data,snap);
  const updated = updateDraftRecord(draftId,data);
  if (newId && old.gmail_draft_id && newId !== old.gmail_draft_id) {
    try {
      const previous = findGmailDraft(old.gmail_draft_id);
      if (previous) previous.deleteDraft();
    } catch (e) {
      console.error(JSON.stringify({event:'mamut_old_draft_cleanup_failed'}));
    }
  }
  clearMamutState(chatId);
  showDraftPreview(chatId,updated,cfg);
}

function confirmSendDraft(chatId, draftId, cfg, previewToken) {
  cfg = cfg || getConfig();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    sendInteractiveTelegram(chatId,'Отправка уже обрабатывается. Не нажимай повторно.',smallMenuKeyboard(),cfg);
    return;
  }
  let sent = false, reported = false;
  try {
    const record = getDraftRecord(draftId);
    if (!record) throw new Error('Черновик не найден');
    if (record.status === 'SENT') {
      sendInteractiveTelegram(chatId,'✅ Уже отправлено. Повторно не отправляю.',smallMenuKeyboard(),cfg);
      reported = true;
      return;
    }
    if (record.status === 'SENDING' || record.status === 'SEND_UNKNOWN') {
      sendInteractiveTelegram(chatId,
        '⚠️ Статус отправки неясен. Повторно не отправляю. Проверь папку «Отправленные» вручную.',
        smallMenuKeyboard(),cfg);
      reported = true;
      return;
    }
    if (record.status !== 'PREVIEWED' || !previewToken ||
        String(record.preview_token) !== String(previewToken)) {
      sendInteractiveTelegram(chatId,'Этот предпросмотр устарел. Открой черновик снова.',smallMenuKeyboard(),cfg);
      reported = true;
      return;
    }
    const alias = getValidOutboundAlias(cfg);
    if (!alias) throw new Error('Корпоративный адрес отправки не настроен');
    const gmailDraft = findGmailDraft(record.gmail_draft_id);
    if (!gmailDraft) {
      updateDraftRecord(draftId,{status:'CHANGED',preview_token:''});
      sendInteractiveTelegram(chatId,'Gmail-черновик исчез. Отправка заблокирована.',smallMenuKeyboard(),cfg);
      reported = true;
      return;
    }
    const snap = captureGmailDraftSnapshot_(gmailDraft);
    const valid = snap.snapshot_hash === record.snapshot_hash &&
      snap.from_email === alias && !!snap.to_email && !!record.snapshot_hash;
    if (!valid) {
      updateDraftRecord(draftId,{status:'CHANGED',preview_token:''});
      sendInteractiveTelegram(chatId,
        '⚠️ Адресаты, отправитель, тема, вложения или текст были изменены. ' +
        'Отправка заблокирована. Нажми ниже, чтобы получить новый полный предпросмотр.',
        {inline_keyboard:[
          [{text:'👀 Новый предпросмотр',callback_data:'refreshdraft:' + draftId}],
          [{text:'❌ Отмена',callback_data:'canceldraft:' + draftId}]
        ]},cfg);
      reported = true;
      return;
    }
    // Commit the one-way claim before the network operation. If send succeeds
    // but writing SENT fails, this remains SENDING, never auto-retried.
    updateDraftRecord(draftId,{
      status:'SENDING', preview_token:'', last_error:'', updated_at:new Date().toISOString()
    });
    SpreadsheetApp.flush();
    let sentMessage;
    try {
      sentMessage = gmailDraft.send();
      sent = true;
    } catch (e) {
      try { updateDraftRecord(draftId,{status:'SEND_UNKNOWN',last_error:'Проверить Отправленные'}); }
      catch (_) {}
      sendInteractiveTelegram(chatId,
        '⚠️ Gmail вернул ошибку. Я НЕ буду повторять отправку автоматически. ' +
        'Проверь папку «Отправленные», затем сверим статус.',
        smallMenuKeyboard(),cfg);
      reported = true;
      return;
    }
    try {
      updateDraftRecord(draftId,{
        status:'SENT',sent_at:new Date().toISOString(),
        gmail_draft_id:'', sent_message_id:sentMessage && sentMessage.getId ? sentMessage.getId() : ''
      });
      try { updateEmailStatus(record.email_id,'REPLIED'); }
      catch (e) { console.error(JSON.stringify({event:'mamut_email_status_failed'})); }
    } catch (e) {
      // SENDING remains persisted: never resend.
      console.error(JSON.stringify({event:'mamut_sent_status_failed'}));
      sendInteractiveTelegram(chatId,
        '⚠️ Gmail подтвердил отправку, но сохранить статус не удалось. ' +
        'Повторно НЕ отправляй; проверь «Отправленные».',smallMenuKeyboard(),cfg);
      reported = true;
      return;
    }
    sendInteractiveTelegram(chatId,'✅ Письмо отправлено. Повторная отправка заблокирована.',smallMenuKeyboard(),cfg);
    reported = true;
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function refreshChangedDraft(chatId, draftId, cfg) {
  cfg = cfg || getConfig();
  const record = getDraftRecord(draftId);
  if (!record || ['SENT','SENDING','SEND_UNKNOWN','CANCELED'].indexOf(String(record.status)) !== -1) {
    throw new Error('Черновик отсутствует или уже завершён');
  }
  const gmailDraft = findGmailDraft(record.gmail_draft_id);
  if (!gmailDraft) {
    sendInteractiveTelegram(chatId,'Черновик Gmail не найден. Отправка заблокирована.',smallMenuKeyboard(),cfg);
    return;
  }
  const snap = captureGmailDraftSnapshot_(gmailDraft);
  const changes = {status:'PREVIEWING',preview_token:''};
  mergeSnapshotIntoDraft_(changes,snap);
  const updated = updateDraftRecord(draftId,changes);
  showDraftPreview(chatId,updated,cfg);
}

function cancelDraft(chatId, draftId, cfg) {
  cfg = cfg || getConfig();
  const draft = getDraftRecord(draftId);
  if (!draft) {
    sendInteractiveTelegram(chatId,'Черновик не найден.',smallMenuKeyboard(),cfg);
    return;
  }
  if (['SENT','SENDING','SEND_UNKNOWN'].indexOf(String(draft.status)) !== -1) {
    sendInteractiveTelegram(chatId,
      'Нельзя отменить: письмо уже отправлено или статус отправки неясен. Проверь «Отправленные».',
      smallMenuKeyboard(),cfg);
    return;
  }
  if (draft.status === 'CANCELED') {
    sendInteractiveTelegram(chatId,'Черновик уже отменён.',smallMenuKeyboard(),cfg);
    return;
  }
  if (draft.gmail_draft_id) {
    const gmailDraft = findGmailDraft(draft.gmail_draft_id);
    if (gmailDraft) {
      try { gmailDraft.deleteDraft(); } catch (e) {
        console.error(JSON.stringify({event:'mamut_cancel_gmail_cleanup_failed'}));
      }
    }
  }
  updateDraftRecord(draftId,{status:'CANCELED',gmail_draft_id:'',preview_token:''});
  clearMamutState(chatId);
  sendInteractiveTelegram(chatId,'❌ Отправка отменена.',smallMenuKeyboard(),cfg);
}
