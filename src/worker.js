import {
  commandOf, getChatId, isQuickAction, hasValidSecret, safeText, upgradeLegacyCallback,
  menuMarkup, moreMarkup, backMarkup, emailMarkup, taskMarkup, normalizePriority,
  isEmailObject, localDayBounds
} from './router.js';
import {pollGmail, ingestGmailId} from './gmail.js';
import {runReminders} from './reminders.js';
import {createDraftPreview, editDraftPreview, cancelDraftPreview, loadDraft, draftPreview} from './drafts.js';
import {prepareGmailDraft, gmailSendPreview, confirmGmailSend} from './gmail-compose.js';
import {startGoogleOAuth,completeGoogleOAuth,startCalendarOAuth} from './google-oauth.js';
import {calendarAgenda,calendarCallback} from './calendar.js';
import {mailCallback,mailFollowup,draftPersonalReply} from './personal-mail.js';
import {workMailCallback,workMailFollowup,draftWorkReply} from './work-mail.js';
import {workOnly,WORK_EMAIL_STATUSES} from './work-mode.js';
import {createTaskFromWorkEmail,categorizeReviewedWorkEmail} from './work-inbox.js';
import {relayCallback,relayFollowup,handleRelayJoin,listRelayContacts} from './telegram-relay.js';
import {memoryCallback,showMemory} from './memory.js';
import {dailyBriefPreview,runDailyBrief} from './brief.js';
import {startOutlookOAuth,completeOutlookOAuth,pollOutlook,outlookAgenda} from './outlook.js';
import {miniApp} from './miniapp.js';
import {latestNews} from './news.js';
import {ingestTelegramMention,processTelegramMention,telegramMentionDetails,latestTelegramMentions,reviewTelegramMention} from './telegram-mentions.js';
import {connectionStatus} from './admin.js';
import {importLegacyTasks} from './legacy-import.js';
import {telegramCutoverReadiness} from './telegram-status.js';
import {telegramCutover} from './telegram-cutover.js';
import {taskMenuAction,taskCallback,taskTalk} from './task-dialog.js';
import {transcribeTelegramVoice} from './voice.js';
import {storeSourceEvent,taskHistory,claimNotification,finishNotification} from './task-store.js';
import {ingestSLPNotice} from './slp-integration.js';

const JSON_HEADERS = {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store'};
const ok = (data, status = 200) => Response.json(data, {status, headers:JSON_HEADERS});
const nowSeconds = () => Math.floor(Date.now()/1000);
const val = (value, size) => String(value ?? '').slice(0, size);
function failLog(event, err) { console.error(JSON.stringify({event, error_type: err?.name || 'Error'})); }

async function telegramCall(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN missing');
  const response = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method, {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload),
    signal:AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('Telegram HTTP ' + response.status);
  const result = await response.json();
  if (!result.ok) throw new Error('Telegram rejected ' + method);
  return result;
}
async function send(env, chatId, answer) {
  return telegramCall(env, 'sendMessage', {
    chat_id:chatId, text:safeText(answer.text),
    disable_web_page_preview:true, ...(answer.reply_markup ? {reply_markup:answer.reply_markup} : {})
  });
}
async function callbackAck(env, update) {
  if (update?.callback_query?.id) {
    try { await telegramCall(env, 'answerCallbackQuery', {callback_query_id:update.callback_query.id}); }
    catch (e) { failLog('callback_ack_failed',e); }
  }
}

export async function webhook(request, env) {
  if (!hasValidSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.TELEGRAM_WEBHOOK_SECRET)) {
    return ok({error:'unauthorized'},401);
  }
  if (!env.DB || !env.JOBS || !env.TELEGRAM_CHAT_ID) return ok({error:'unconfigured'},503);
  let update;
  try {
    const input = await request.text();
    if (input.length > 64000) return ok({error:'too_large'},413);
    update = JSON.parse(input);
  } catch { return ok({error:'bad_json'},400); }
  // Buttons under messages sent by the legacy Apps Script bot keep working.
  if(update?.callback_query&&typeof update.callback_query.data==='string')
    update.callback_query.data=upgradeLegacyCallback(update.callback_query.data);
  const chatId = getChatId(update);
  if (!chatId) return ok({error:'forbidden'},403);
  if (!Number.isSafeInteger(update.update_id)) return ok({error:'missing_update_id'},400);
  if(chatId!==String(env.TELEGRAM_CHAT_ID)) {
    // Other users may only opt in/out of receiving messages from this bot.
    // They never reach owner commands, Groq, Gmail, tasks or the calendar.
    if(!update.message||update.message.chat?.type!=='private'||
       !/^\/(?:start|stop|unsubscribe)(?:\b|@)/i.test(String(update.message.text||'')))
      return ok({error:'forbidden'},403);
    const inviteClaim=await env.DB.prepare(
      "INSERT OR IGNORE INTO telegram_updates(update_id,status,created_at) VALUES(?,'queued',?)"
    ).bind(update.update_id,nowSeconds()).run();
    if(inviteClaim.meta.changes!==1)return ok({ok:true,duplicate:true});
    let outbound=false;
    try {
      const response=await handleRelayJoin(env,update);
      if(!response?.handled||response.chat_id!==chatId)
        return ok({error:'forbidden'},403);
      await env.DB.prepare(
        "UPDATE telegram_updates SET status='delivery_unknown' WHERE update_id=? AND status='queued'"
      ).bind(update.update_id).run();
      outbound=true;
      await send(env,chatId,{text:response.text});
      await env.DB.prepare(
        "UPDATE telegram_updates SET status='done' WHERE update_id=? AND status='delivery_unknown'"
      ).bind(update.update_id).run();
      return ok({ok:true,opt_in:true});
    }catch(error){
      failLog('telegram_optin_failed',error);
      if(outbound)return ok({ok:true,delivery:'unknown'},202);
      await env.DB.prepare(
        "DELETE FROM telegram_updates WHERE update_id=? AND status='queued'"
      ).bind(update.update_id).run();
      return ok({error:'temporary'},503);
    }
  }
  const quick = isQuickAction(commandOf(update));
  const insert = await env.DB.prepare(
    "INSERT OR IGNORE INTO telegram_updates(update_id,status,created_at) VALUES(?,'queued',?)"
  ).bind(update.update_id,nowSeconds()).run();
  if (insert.meta.changes === 0) {
    // An earlier Queue send may have failed or timed out after acceptance.
    // Re-enqueue a queued update; the consumer's atomic claim prevents duplicate
    // processing. Already delivered/unknown updates must never be re-sent.
    if (!quick) {
      const existing=await env.DB.prepare('SELECT status FROM telegram_updates WHERE update_id=?')
        .bind(update.update_id).first();
      if (existing?.status==='queued') {
        try {
          await env.JOBS.send({kind:'telegram',update});
          return ok({ok:true,duplicate:true,requeued:true});
        } catch (e) {
          failLog('queue_reenqueue_failed',e);
          return ok({error:'temporary'},503);
        }
      }
    }
    return ok({ok:true,duplicate:true});
  }

  // Fast, AI-free commands return immediately without Queue or Groq.
  if (quick) {
    let outboundAttempted=false;
    try {
      await callbackAck(env, update);
      const answer=await prepareAnswer(update,env);
      // Mark delivery as unknown BEFORE touching Telegram. If the network
      // succeeds but the response is lost, retrying would send a duplicate.
      const claim=await env.DB.prepare(
        "UPDATE telegram_updates SET response_json=?,status='delivery_unknown' WHERE update_id=? AND status='queued'"
      ).bind(JSON.stringify(answer),update.update_id).run();
      if(claim.meta.changes!==1) throw new Error('Quick response claim was not acquired');
      outboundAttempted=true;
      await send(env,chatId,answer);
      await env.DB.prepare("UPDATE telegram_updates SET status='done' WHERE update_id=? AND status='delivery_unknown'")
        .bind(update.update_id).run();
      return ok({ok:true,fast:true});
    } catch (e) {
      failLog(outboundAttempted?'fast_delivery_unknown':'fast_action_failed',e);
      if(outboundAttempted) return ok({ok:true,delivery:'unknown'},202);
      // No outbound request has started. Allow Telegram to redeliver.
      await env.DB.prepare("DELETE FROM telegram_updates WHERE update_id=? AND status='queued'")
        .bind(update.update_id).run();
      return ok({error:'temporary'},503);
    }
  }
  try {
    await env.JOBS.send({kind:'telegram',update});
    return ok({ok:true,queued:true});
  } catch (e) {
    failLog('queue_enqueue_failed',e);
    // Keep the durable queued row. Telegram should retry its webhook delivery;
    // the duplicate path above will re-enqueue it. Never discard accepted work.
    return ok({error:'temporary'},503);
  }
}

async function processTelegram(job,env) {
  const update=job.update;
  const updateId=update.update_id;
  const claimed=await env.DB.prepare(
    "UPDATE telegram_updates SET status='processing', attempts=attempts+1, claimed_at=? " +
    "WHERE update_id=? AND (status='queued' OR (status='processing' AND claimed_at<?))"
  ).bind(nowSeconds(),updateId,nowSeconds()-90).run();
  if(claimed.meta.changes!==1) {
    const prior=await env.DB.prepare('SELECT status FROM telegram_updates WHERE update_id=?').bind(updateId).first();
    if(!prior || prior.status==='done' || prior.status==='delivery_unknown') return 'done';
    return 'busy';
  }
  let outboundAttempted=false;
  try {
    await callbackAck(env,update);
    const saved=await env.DB.prepare('SELECT response_json FROM telegram_updates WHERE update_id=?')
      .bind(updateId).first();
    // A prepared answer is reusable on retry; do not re-run Groq or mutate tasks.
    let answer=saved?.response_json?JSON.parse(saved.response_json):null;
    if(!answer) {
      answer=await prepareAnswer(update,env);
      await env.DB.prepare('UPDATE telegram_updates SET response_json=? WHERE update_id=? AND status=\'processing\'')
        .bind(JSON.stringify(answer),updateId).run();
    }
    const claim=await env.DB.prepare(
      "UPDATE telegram_updates SET status='delivery_unknown' WHERE update_id=? AND status='processing'"
    ).bind(updateId).run();
    if(claim.meta.changes!==1) throw new Error('Telegram delivery claim was not acquired');
    outboundAttempted=true;
    await send(env,getChatId(update),answer);
    await env.DB.prepare("UPDATE telegram_updates SET status='done' WHERE update_id=? AND status='delivery_unknown'")
      .bind(updateId).run();
    return 'done';
  } catch (e) {
    failLog(outboundAttempted?'telegram_delivery_unknown':'telegram_processing_failed',e);
    if(outboundAttempted) {
      // Queue must ACK. An uncertain Telegram send cannot be repeated safely.
      return 'unknown';
    }
    await env.DB.prepare("UPDATE telegram_updates SET status='queued' WHERE update_id=? AND status='processing'")
      .bind(updateId).run();
    throw e;
  }
}

function fromRows(title, rows, kind) {
  if (!rows.length) return {text:title+'\n\nПока ничего нет.',reply_markup:backMarkup()};
  const lines = [title];
  const buttons=[];
  rows.slice(0,8).forEach((r,index)=>{
    const value = kind === 'task' ? r.title : r.subject;
    lines.push('\n'+(index+1)+'. '+safeText(value,130));
    if (kind === 'task') {
      lines.push('Приоритет: '+r.priority+' | Дедлайн: '+(r.due_text || 'Не указан'));
      if(r.source_author)lines.push('Автор: '+safeText(r.source_author,80));
      buttons.push([{text:(index+1)+'. '+safeText(value,35),callback_data:'task:view:'+r.task_id}]);
    } else {
      lines.push(safeText(r.summary,170));
      buttons.push([{text:(index+1)+'. '+safeText(value,35),callback_data:'email:view:'+r.email_id}]);
    }
  });
  buttons.push([{text:'☰ Меню',callback_data:'menu'}]);
  return {text:safeText(lines.join('\n')),reply_markup:{inline_keyboard:buttons}};
}
const emailFields = 'email_id,from_name,from_email,subject,summary,action,category,priority,deadline_text,has_attachments,received_at,status';
async function listEmails(env,where,bind=[]) {
  const query='SELECT '+emailFields+' FROM emails WHERE ('+where+')'+
    (workOnly(env)?' AND status IN '+WORK_EMAIL_STATUSES:'')+
    ' ORDER BY received_at DESC LIMIT 8';
  const res=await env.DB.prepare(query).bind(...bind).all();
  return res.results;
}
async function getTasks(env) {
  const res=await env.DB.prepare("SELECT task_id,email_id,title,description,status,priority,due_iso,due_text,created_at FROM tasks WHERE status NOT IN ('DONE','DELETED') ORDER BY due_iso='' DESC,due_iso ASC LIMIT 80").all();
  return res.results;
}
async function setState(env,chatId,mode,data='') {
  await env.DB.prepare('INSERT INTO states(chat_id,mode,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET mode=excluded.mode,data=excluded.data,updated_at=excluded.updated_at')
    .bind(chatId,mode,data,nowSeconds()).run();
}
async function clearState(env,chatId) { await env.DB.prepare('DELETE FROM states WHERE chat_id=?').bind(chatId).run(); }

async function prepareAnswer(update, env) {
  const chatId=getChatId(update), action=commandOf(update);
  const callback=update?.callback_query?.data;
  if (action==='menu' || action==='cancel') {
    await clearState(env,chatId);
    return {text:action==='cancel'?'Ввод отменён. Что делаем?':'Что делаем?',
      reply_markup:menuMarkup(env.MINIAPP_URL||'')};
  }
  if (action==='reset') {
    await clearState(env,chatId);
    return {text:'Очистить историю нашего диалога? Письма и задачи не удалятся.',reply_markup:{inline_keyboard:[
      [{text:'✅ Да',callback_data:'reset:yes'},{text:'❌ Нет',callback_data:'reset:no'}]
    ]}};
  }
  if (action==='reset:no') return {text:'Отменено.',reply_markup:backMarkup()};
  if (action==='reset:yes') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM history WHERE chat_id IN (?,?)')
        .bind(chatId,'work:'+chatId),
      env.DB.prepare('DELETE FROM states WHERE chat_id=?').bind(chatId)
    ]);
    return {text:'✅ Контекст очищен.',reply_markup:backMarkup()};
  }
  if(action==='legacy:stale'){
    await clearState(env,chatId);
    return {text:'Эта кнопка осталась от старой версии бота и больше не работает. Вот актуальное меню.',
      reply_markup:menuMarkup(env.MINIAPP_URL||'')};
  }
  if(action==='more')return {text:'Другие разделы',reply_markup:moreMarkup()};
  if(['tasks','progress','done'].includes(action)){
    const status={tasks:'NEW',progress:'IN_PROGRESS',done:'DONE'}[action];
    const title={tasks:'📥 Задачи - ещё не взяты в работу',
      progress:'🟡 В работе',done:'✅ Выполненные'}[action];
    const rows=await env.DB.prepare(
      "SELECT t.task_id,t.title,t.status,t.priority,t.due_text,m.source_author "+
      "FROM tasks t LEFT JOIN task_metadata m ON m.task_id=t.task_id WHERE t.status=? "+
      "ORDER BY CASE priority WHEN 'высокий' THEN 0 WHEN 'средний' THEN 1 ELSE 2 END, "+
      "t.updated_at DESC LIMIT 8"
    ).bind(status).all();
    return fromRows(title,rows.results||[],'task');
  }
  if (['report','newtask','voicehelp'].includes(action))
    return taskMenuAction(env,chatId,action);
  if(action==='app')
    return {text:'📱 Открой панель помощника:',
      reply_markup:{inline_keyboard:[[
        {text:'Открыть панель',web_app:{url:String(env.MINIAPP_URL||new URL('/app','https://rahal-mamut-staging.alexandr-petrossov.workers.dev').href)}}
      ],[{text:'☰ Меню',callback_data:'menu'}]]}};
  if(action==='calendar')return workOnly(env)?outlookAgenda(env,1):calendarAgenda(env,'today');
  if(action==='compose'){
    await setState(env,chatId,workOnly(env)?'WORK_MAIL_INPUT':'PERSONAL_MAIL_INPUT','{}');
    return {text:'✉️ Кому написать с рабочего Outlook? Укажи точный email, тему и текст. Сначала покажу черновик, отправка только после подтверждения.',
      reply_markup:backMarkup()};
  }
  if(action==='contacts')
    return env.TELEGRAM_RELAY_ENABLED==='true'?listRelayContacts(env):
      {text:'Контакты для отправки от имени бота пока не подключены. Сейчас работаем с корпоративным Outlook.',
        reply_markup:backMarkup()};
  if(action==='memory')return showMemory(env,chatId);
  if(action==='brief')return dailyBriefPreview(env);
  if(action==='mail'||action==='mail:refresh'){
    let info='';
    if(action==='mail:refresh'){
      if(env.GMAIL_POLL_ENABLED!=='true')
        return {text:'Проверка Gmail сейчас выключена.',reply_markup:backMarkup()};
      const result=await pollGmail(env);
      info='Обновление запущено: найдено '+result.queued+
        ' новых писем. Обработка идёт в очереди.\n\n';
    }
    const rows=await listEmails(env,"status IN ('NEW','WORK_REVIEW','WORK_OUTLOOK')");
    const view=fromRows('📨 Рабочая почта',rows,'email');
    return {...view,text:info+view.text,
      reply_markup:{inline_keyboard:[
        ...view.reply_markup.inline_keyboard.slice(0,-1),
        [{text:'🔄 Обновить',callback_data:'mail:refresh'},
         {text:'⚠️ На разбор',callback_data:'review'}],
        [{text:'☰ Меню',callback_data:'menu'}]
      ]}};
  }
  if(action==='review'){
    const [letters,telegram]=await Promise.all([
      listEmails(env,"status='WORK_REVIEW'"),
      latestTelegramMentions(env,8,'REVIEW')
    ]);
    if(!letters.length&&!telegram.length)
      return {text:'⚠️ На разбор\n\nНовых неопределённых рабочих сообщений нет.',
        reply_markup:backMarkup()};
    const lines=['⚠️ На разбор'];
    const keyboard=[];
    for(const letter of letters.slice(0,5)){
      lines.push('\n📨 '+safeText(letter.subject,140)+
        '\n'+safeText(letter.summary,200));
      keyboard.push([{text:'📨 '+safeText(letter.subject,36),
        callback_data:'email:view:'+letter.email_id}]);
    }
    for(const msg of telegram.slice(0,5)){
      lines.push('\n💬 '+safeText(msg.summary,180)+
        '\nОт: '+safeText(msg.sender_name,80));
      keyboard.push([{text:'💬 '+safeText(msg.summary,36),
        callback_data:'mention:view:'+msg.id}]);
    }
    keyboard.push([{text:'☰ Меню',callback_data:'menu'}]);
    return {text:safeText(lines.join('\n')),
      reply_markup:{inline_keyboard:keyboard}};
  }
  if (action==='important') return fromRows('🔥 Важное',await listEmails(env,"priority='высокий' OR category='ВАЖНО'"),'email');
  if (action==='news'){
    const userText=String(update?.message?.text||'').trim();
    const topical=/(?:новост[ьи]|что нового)\s+(?:про|о|об|в|по|за|на)?\s*\S+/i.test(userText);
    const query=userText.replace(/^.*?(?:новост[ьи]|что нового)/i,'')
      .replace(/^(?:про|о|об|в|по|за|на)\s+/i,'').trim().slice(0,90);
    const [fromMail,fromTelegram,external]=await Promise.all([
      listEmails(env,"action='Действий не требуется' AND (category IN ('НОВОСТЬ','FYI','ВАЖНО') OR "+
        "EXISTS(SELECT 1 FROM inbound_events i WHERE i.source_id=emails.email_id AND i.classification IN ('NEWS','INFO')))"),
      latestTelegramMentions(env,5),
      topical?latestNews(query||'OTT Казахстан'):
        (!workOnly(env)?latestNews('Казахстан'):Promise.resolve(null))
    ]);
    const inbox=fromMail.slice(0,5).map(x=>'• '+val(x.subject,115)).join('\n');
    const mentions=fromTelegram.map(x=>'• '+val(x.summary,120)+
      ' ('+val(x.chat_title,55)+')').join('\n');
    const sections=[
      '📰 Рабочие новости',
      mentions?'💬 Из Telegram:\n'+mentions:'',
      inbox?'📨 Из почты:\n'+inbox:'',
      external?external.text:'',
      !mentions&&!inbox&&!external?'Пока новых рабочих новостей нет.':''
    ].filter(Boolean);
    return {text:safeText(sections.join('\n\n')),
      reply_markup:{inline_keyboard:[
        ...fromTelegram.map(x=>[{text:'💬 '+safeText(x.summary,35),
          callback_data:'mention:view:'+x.id}]),
        ...fromMail.slice(0,3).map(x=>[{text:'📨 '+safeText(x.subject,35),
          callback_data:'email:view:'+x.email_id}]),
        [{text:'⚠️ На разбор',callback_data:'review'},
         {text:'☰ Меню',callback_data:'menu'}]
      ]}};
  }
  if (action==='colleagues') {
    const domain=String(env.WORK_DOMAIN || 'fmedia.kz').toLowerCase();
    return fromRows('👥 Коллеги',await listEmails(env,'lower(from_email) LIKE ?',['%@'+domain]),'email');
  }
  if(action==='today')return dailyBriefPreview(env);
  if (action==='week') {
    const tasks=await getTasks(env);
    const bounds=localDayBounds(new Date(),env.TZ_OFFSET_MINUTES ?? 300);
    const end=new Date(bounds.end.getTime()+6*86400000);
    const filtered=tasks.filter(t=>{
      if (!t.due_iso) {
        if (action==='week') return true;
        const created=Date.parse(t.created_at||'');
        return Number.isFinite(created) && created>=bounds.start.getTime() && created<bounds.end.getTime();
      }
      const due=Date.parse(t.due_iso);
      return Number.isFinite(due) && due<end.getTime();
    });
    return fromRows('📅 Неделя',filtered,'task');
  }
  if (action==='search') {
    await setState(env,chatId,'SEARCH');
    return {text:'Что ищем в сохранённых письмах? /cancel - отмена.',reply_markup:backMarkup()};
  }
  if(/^mention:(task|news|ignore):/.test(callback||'')){
    return reviewTelegramMention(env,callback);
  }
  if (callback?.startsWith('mention:view:')) {
    return telegramMentionDetails(env,callback.slice('mention:view:'.length));
  }
  if (callback?.startsWith('email:view:')) {
    const id=callback.slice('email:view:'.length);
    const e=await env.DB.prepare('SELECT '+emailFields+' FROM emails WHERE email_id=?'+
      (workOnly(env)?' AND status IN '+WORK_EMAIL_STATUSES:'')).bind(id).first();
    if (!e) return {text:'Письмо не найдено.',reply_markup:backMarkup()};
    const preview={text:safeText('📨 Письмо\n\nОт: '+e.from_name+
      '\nТема: '+e.subject+'\n\n'+e.summary+
      '\n\nЧто требуется: '+e.action+
      '\nДедлайн: '+(e.deadline_text||'Не указан'))};
    return {...preview,reply_markup:e.status==='WORK_REVIEW'?
      {inline_keyboard:[
        [{text:'✅ В задачи',callback_data:'email:task:'+id},
         {text:'📰 В новости',callback_data:'email:news:'+id}],
        [{text:'🗑 Не рабочее',callback_data:'email:ignore:'+id},
         {text:'☰ Меню',callback_data:'menu'}]
      ]}:emailMarkup(e.email_id)};
  }
  if(callback?.startsWith('email:task:'))
    return createTaskFromWorkEmail(env,callback.slice('email:task:'.length));
  if(callback?.startsWith('email:news:'))
    return categorizeReviewedWorkEmail(env,callback.slice('email:news:'.length),'news');
  if(callback?.startsWith('email:ignore:'))
    return categorizeReviewedWorkEmail(env,callback.slice('email:ignore:'.length),'ignore');
  if(callback?.startsWith('cal:'))return calendarCallback(env,chatId,callback);
  if(callback?.startsWith('workmail:'))return workMailCallback(env,chatId,callback);
  if(callback?.startsWith('mail:'))return mailCallback(env,chatId,callback);
  if(callback?.startsWith('relay:'))return env.TELEGRAM_RELAY_ENABLED==='true'?
    relayCallback(env,chatId,callback):
    {text:'Рабочая отправка в Telegram пока не включена.',reply_markup:backMarkup()};
  if(callback?.startsWith('memory:'))return memoryCallback(env,chatId,callback);
  if(callback?.startsWith('task:')){
    const result=await taskCallback(env,chatId,callback,update.update_id);
    if(result)return result;
  }
  if (callback?.startsWith('email:reply:')) {
    if(workOnly(env)){
      const id=callback.slice('email:reply:'.length);
      const mail=await env.DB.prepare(
        "SELECT subject,status FROM emails WHERE email_id=? AND status IN "+WORK_EMAIL_STATUSES
      ).bind(id).first();
      if(!mail)return {text:'Это письмо недоступно в рабочем режиме.',reply_markup:backMarkup()};
      if(mail.status!=='WORK_OUTLOOK')
        return {text:'Это копия письма, пересланная в Gmail. Чтобы ответить именно с рабочего адреса, нужен согласованный доступ к Outlook. Личный Gmail не использую.',
          reply_markup:backMarkup()};
      await setState(env,chatId,'WORK_REPLY_INSTRUCTION',id);
      return {text:'✉️ Что ответить на рабочее письмо «'+safeText(mail.subject,180)+'»? Покажу черновик. Отправка только с разрешённого Outlook.',
        reply_markup:backMarkup()};
    }
    if(env.PERSONAL_GMAIL_SEND_ENABLED==='true'){
      const id=callback.slice('email:reply:'.length);
      const mail=await env.DB.prepare(
        "SELECT subject,status FROM emails WHERE email_id=?"
      ).bind(id).first();
      if(!mail||['WORK_OUTLOOK','ANALYZING','IGNORED_NONWORK'].includes(mail.status))
        return {text:'Это письмо нельзя открыть как ответ из личного Gmail.',
          reply_markup:backMarkup()};
      await setState(env,chatId,'PERSONAL_REPLY_INSTRUCTION',id);
      return {text:'✉️ Что ответить на письмо «'+safeText(mail.subject,180)+'»? '+
        'Сначала покажу полный черновик с адресом получателя. Ничего не отправлю до твоего подтверждения.',
        reply_markup:backMarkup()};
    }
    if (env.REPLY_PREVIEWS_ENABLED!=='true') {
      return {text:'Подготовка черновиков пока выключена. Отправка писем с этого сервера также выключена.',reply_markup:backMarkup()};
    }
    const id=callback.slice('email:reply:'.length);
    const email=await env.DB.prepare('SELECT subject FROM emails WHERE email_id=?').bind(id).first();
    if (!email) return {text:'Исходное письмо не найдено.',reply_markup:backMarkup()};
    await setState(env,chatId,'REPLY_INSTRUCTION',id);
    return {text:'Что ответить на письмо «'+safeText(email.subject,180)+'»? Напиши своими словами. Я подготовлю локальный черновик. /cancel - отмена.',reply_markup:backMarkup()};
  }
  if (callback?.startsWith('preparegmail:')) {
    if(workOnly(env))return {text:'Отправка из личного Gmail в рабочем режиме отключена.',reply_markup:backMarkup()};
    if (env.GMAIL_DRAFTS_ENABLED!=='true'||env.REPLY_PREVIEWS_ENABLED!=='true')
      return {text:'Создание Gmail-черновиков пока выключено.',reply_markup:backMarkup()};
    const id=callback.slice('preparegmail:'.length);
    const draft=await prepareGmailDraft(env,id);
    return gmailSendPreview(draft,env.GMAIL_SEND_ENABLED==='true');
  }
  if (callback?.startsWith('editdraft:')) {
    if(env.REPLY_PREVIEWS_ENABLED!=='true') return {text:'Редактор черновиков выключен.',reply_markup:backMarkup()};
    const id=callback.slice('editdraft:'.length);
    const draft=await loadDraft(env,id);
    if(!draft || draft.status!=='PREVIEW')return {text:'Черновик не найден или отменён.',reply_markup:backMarkup()};
    await setState(env,chatId,'DRAFT_EDIT',id);
    return {text:'Пришли новый полный текст черновика. /cancel - отмена.\n\nПисьмо не будет отправлено.',reply_markup:backMarkup()};
  }
  if (callback?.startsWith('canceldraft:')) {
    if(env.REPLY_PREVIEWS_ENABLED!=='true') return {text:'Редактор черновиков выключен.',reply_markup:backMarkup()};
    const id=callback.slice('canceldraft:'.length);
    const cancelled=await cancelDraftPreview(env,id);
    await clearState(env,chatId);
    return {text:cancelled?'Черновик отменён. Письмо не отправлено. Если Gmail-черновик был создан, он остаётся в папке «Черновики» для ручного удаления.':'Черновик уже отправлен, обрабатывается, отменён или не найден.',reply_markup:backMarkup()};
  }
  if (callback?.startsWith('senddraft:')) {
    if(workOnly(env))return {text:'Отправка из личного Gmail в рабочем режиме отключена.',reply_markup:backMarkup()};
    // A one-time preview token is required even after the global send flag
    // has been enabled. No other Telegram text can trigger outbound Gmail.
    const parts=callback.split(':');
    if(parts.length!==3) return {text:'Подтверждение устарело. Письмо не отправлено.',reply_markup:backMarkup()};
    const result=await confirmGmailSend(env,parts[1],parts[2]);
    return {...result,reply_markup:backMarkup()};
  }
  if (callback) return {text:'Эта кнопка пока недоступна в тестовой версии.',reply_markup:backMarkup()};
  let text=String(update?.message?.text||'').trim();
  let transcript='';
  if(update?.message?.voice){
    const audio=await transcribeTelegramVoice(env,update.message.voice);
    if(!audio.ok)return {text:audio.message,reply_markup:backMarkup()};
    text=audio.text;
    transcript=text;
  }
  if (!text) return {text:'Пришли текстовое или голосовое сообщение.',reply_markup:backMarkup()};
  const state=await env.DB.prepare('SELECT mode,data FROM states WHERE chat_id=?').bind(chatId).first();
  if(['WORK_MAIL_DRAFT','WORK_MAIL_EDIT'].includes(state?.mode)){
    const result=await workMailFollowup(env,chatId,text);
    if(result)return result;
  }
  if(['PERSONAL_MAIL_DRAFT','PERSONAL_MAIL_EDIT'].includes(state?.mode)){
    const result=await mailFollowup(env,chatId,text);
    if(result)return result;
  }
  if(['RELAY_DRAFT','RELAY_EDIT'].includes(state?.mode)){
    const result=await relayFollowup(env,chatId,text);
    if(result)return result;
  }
  if(state?.mode==='WORK_REPLY_INSTRUCTION'){
    return draftWorkReply(env,chatId,state.data,text);
  }
  if(state?.mode==='PERSONAL_REPLY_INSTRUCTION'){
    const draft=await draftPersonalReply(env,chatId,state.data,text);
    if(!draft.needs_clarification)await env.DB.prepare(
      "DELETE FROM states WHERE chat_id=? AND mode='PERSONAL_REPLY_INSTRUCTION'"
    ).bind(chatId).run();
    return draft;
  }
  if (state?.mode==='SEARCH') {
    await clearState(env,chatId);
    const term='%'+text.slice(0,80).toLowerCase()+'%';
    return fromRows('🔎 '+safeText(text,80),await listEmails(env,'lower(subject) LIKE ? OR lower(summary) LIKE ? OR lower(from_name) LIKE ?',[term,term,term]),'email');
  }
  if (state?.mode==='REPLY_INSTRUCTION' && !workOnly(env) &&
    env.REPLY_PREVIEWS_ENABLED==='true') {
    const draft=await createDraftPreview(env,state.data,text);
    await clearState(env,chatId);
    return draftPreview(draft,env);
  }
  if (state?.mode==='DRAFT_EDIT' && !workOnly(env) &&
    env.REPLY_PREVIEWS_ENABLED==='true') {
    const draft=await editDraftPreview(env,state.data,text);
    await clearState(env,chatId);
    return draftPreview(draft,env);
  }
  if(env.TASK_CONVERSATION_ENABLED==='true') {
    const result=await taskTalk(env,chatId,text,update.update_id,transcript);
    if(result)return result;
  }
  return await groqChat(env,chatId,text,update.update_id);
}

async function groqChat(env,chatId,userText,updateId) {
  if(workOnly(env)&&env.OUTLOOK_AI_ENABLED!=='true')
    return {text:'В рабочем режиме внешний AI-анализ пока выключен. Открой задачи через меню или напиши «Добавь задачу: ...».',reply_markup:backMarkup()};
  if (!env.GROQ_API_KEY) return {text:'AI пока не настроен. Меню и сохранённые задачи доступны.',reply_markup:backMarkup()};
  const start=Date.now();
  const [hist,tasks]=await env.DB.batch([
    env.DB.prepare('SELECT role,content FROM history WHERE chat_id=? ORDER BY id DESC LIMIT 10').bind(chatId),
    env.DB.prepare("SELECT title,due_text FROM tasks WHERE status!='DONE' ORDER BY due_iso='' DESC,due_iso ASC LIMIT 3")
  ]);
  const system='Ты Персональный помощник, рабочий помощник Александра. Отвечай по-русски, кратко и по существу. Не придумывай факты и не утверждай, что совершил действие, если оно не выполнено. Не цитируй секреты. Текущие задачи: '+tasks.results.map(t=>t.title+' ('+(t.due_text||'без срока')+')').join('; ');
  const messages=[{role:'system',content:system},...hist.results.reverse().map(h=>({role:h.role,content:h.content})),{role:'user',content:safeText(userText,2400)}];
  let res;
  try {
    res=await fetch('https://api.groq.com/openai/v1/chat/completions',{
      method:'POST',headers:{Authorization:'Bearer '+env.GROQ_API_KEY,'content-type':'application/json'},
      body:JSON.stringify({model:env.GROQ_MODEL||'openai/gpt-oss-20b',temperature:0.4,max_completion_tokens:550,messages}),
      signal:AbortSignal.timeout(15000)
    });
  } catch (err) {
    failLog('groq_network_or_timeout',err);
    return {text:'⚠️ AI не ответил вовремя. Попробуй ещё раз. Меню и задачи доступны.',reply_markup:backMarkup()};
  }
  if (!res.ok) { failLog('groq_http_'+res.status,new Error('AI unavailable')); return {text:'⚠️ AI сейчас не отвечает. Попробуй ещё раз чуть позже.',reply_markup:backMarkup()}; }
  const data=await res.json();
  const reply=val(data?.choices?.[0]?.message?.content?.trim()||'Не получилось сформировать ответ.',3800);
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO history(chat_id,event_id,role,content,created_at) VALUES(?,?,?,?,?)').bind(chatId,updateId+':u','user',safeText(userText,2400),nowSeconds()),
    env.DB.prepare('INSERT OR IGNORE INTO history(chat_id,event_id,role,content,created_at) VALUES(?,?,?,?,?)').bind(chatId,updateId+':a','assistant',reply,nowSeconds()),
    env.DB.prepare('DELETE FROM history WHERE chat_id=? AND id NOT IN (SELECT id FROM history WHERE chat_id=? ORDER BY id DESC LIMIT 12)').bind(chatId,chatId)
  ]);
  console.log(JSON.stringify({event:'groq_chat_timing',ms:Date.now()-start}));
  return {text:reply,reply_markup:backMarkup()};
}

async function ingestEmail(request,env) {
  if (!env.INGEST_SECRET || !hasValidSecret(request.headers.get('authorization')?.replace(/^Bearer /i,'')||'',env.INGEST_SECRET)) return ok({error:'unauthorized'},401);
  if (env.MAIL_INGEST_ENABLED!=='true') return ok({error:'ingest_disabled'},503);
  let raw;
  try { const txt=await request.text(); if(txt.length>20000) return ok({error:'too_large'},413); raw=JSON.parse(txt); }
  catch { return ok({error:'bad_json'},400); }
  if (!isEmailObject(raw)) return ok({error:'invalid_email_record'},400);
  const email={id:raw.email_id,received_at:val(raw.received_at||new Date().toISOString(),40),from_name:val(raw.from_name,250),from_email:val(raw.from_email,250),subject:val(raw.subject,500),summary:val(raw.summary,1600),action:val(raw.action,900),category:val(raw.category||'ПИСЬМО',30),priority:normalizePriority(raw.priority),deadline_text:val(raw.deadline_text,100),deadline_iso:val(raw.deadline_iso,40),has_attachments:raw.has_attachments==='YES'||raw.has_attachments===true?1:0};
  const result=await env.DB.prepare('INSERT OR IGNORE INTO emails(email_id,received_at,from_name,from_email,subject,summary,action,category,priority,deadline_text,deadline_iso,has_attachments,notification_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(email.id,email.received_at,email.from_name,email.from_email,email.subject,email.summary,email.action,email.category,email.priority,email.deadline_text,email.deadline_iso,email.has_attachments,'disabled').run();
  if (result.meta.changes===0) return ok({ok:true,duplicate:true});
  const needsAction=email.action&&email.action!=='Действий не требуется';
  const classification=needsAction?'TASK':
    ['НОВОСТЬ','FYI','ВАЖНО'].includes(email.category)?'NEWS':'INFO';
  const source=await storeSourceEvent(env,{
    sourceType:'email_ingest',sourceId:email.id,threadKey:'email_ingest:'+email.id,
    author:email.from_name,sourceTitle:'Рабочее письмо: '+email.subject,
    originalText:email.summary,classification,
    title:needsAction?email.action:email.subject,
    description:email.summary,summary:email.summary,priority:email.priority,
    dueIso:email.deadline_iso,dueText:email.deadline_text,emailId:email.id,
    createdAt:email.received_at
  });
  const notify=env.WORKER_EMAIL_NOTIFICATIONS==='true'&&
    (source.created||email.category==='ВАЖНО');
  if (notify) {
    await env.DB.prepare(
      "UPDATE emails SET notification_status='queued' WHERE email_id=? AND notification_status='disabled'"
    ).bind(email.id).run();
    try { await env.JOBS.send({kind:'email',email_id:email.id}); }
    catch (e) { failLog('ingest_queue_failed',e); return ok({ok:true,stored:true,notification:'needs_review'},202); }
  }
  return ok({ok:true,stored:true,task:source.created,updated:source.updated});
}
async function ingestTask(request,env) {
  if (!env.INGEST_SECRET || !hasValidSecret(request.headers.get('authorization')?.replace(/^Bearer /i,'')||'',env.INGEST_SECRET)) return ok({error:'unauthorized'},401);
  if (env.MAIL_INGEST_ENABLED!=='true') return ok({error:'ingest_disabled'},503);
  let t;
  try {const raw=await request.text();if(raw.length>12000)return ok({error:'too_large'},413);t=JSON.parse(raw);}catch{return ok({error:'bad_json'},400);}
  if (!t||typeof t.task_id!=='string'||!t.task_id||typeof t.title!=='string'||!t.title) return ok({error:'invalid_task'},400);
  const now=new Date().toISOString();
  const result=await env.DB.prepare('INSERT OR IGNORE INTO tasks(task_id,email_id,title,description,status,priority,due_iso,due_text,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind(val(t.task_id,128),t.email_id?val(t.email_id,128):null,val(t.title,180),val(t.description,900),['NEW','IN_PROGRESS','DONE'].includes(t.status)?t.status:'NEW',normalizePriority(t.priority),val(t.due_iso,40),val(t.due_text,100),val(t.created_at||now,40),now).run();
  if(result.meta.changes===1){
    await env.DB.prepare(
      'INSERT OR IGNORE INTO task_metadata(task_id,source_type,source_id,source_title,original_text,suggested_priority,last_source_at) '+
      "VALUES(?,'api',?,'Внешняя интеграция',?,?,?)"
    ).bind(val(t.task_id,128),val(t.task_id,128),val(t.description,4000),normalizePriority(t.priority),now).run();
    await taskHistory(env,val(t.task_id,128),'CREATED','Внешняя интеграция');
  }
  return ok({ok:true,stored:result.meta.changes===1,duplicate:result.meta.changes===0});
}
async function processSLPNotice(job,env) {
  if(env.SLP_NOTICE_NOTIFICATIONS!=='true')return;
  const id=String(job.id||'');
  if(!/^[a-f0-9]{32}$/.test(id))return;
  const row=await env.DB.prepare(
    "SELECT source_title,body,source_link,task_id FROM inbound_events "+
    "WHERE source_type='slp' AND source_id=?"
  ).bind(id).first();
  if(!row)return;
  // Mark before attempting Telegram: an uncertain network outcome must not be resent.
  const key='slp-notice:'+id;
  if(!await claimNotification(env,key,'slp_notice',id))return;
  try {
    await send(env,env.TELEGRAM_CHAT_ID,{
      text:'📺 SLP 2.0: требуется внимание\n\n'+row.body+
        (row.source_link?'\n\nОткрыть SLP: '+row.source_link:'')
    });
    await finishNotification(env,key,'sent');
  } catch(error) {
    await finishNotification(env,key,'unknown');
    failLog('slp_notice_delivery_unknown',error);
  }
}
async function processEmail(job,env) {
  if(env.WORKER_EMAIL_NOTIFICATIONS!=='true') return;
  const e=await env.DB.prepare('SELECT * FROM emails WHERE email_id=?').bind(job.email_id).first();
  if(!e || e.notification_status!=='queued') return;
  // One atomic claim for this email ID. A second queued job sees zero changes.
  // Unknown network delivery is not automatically retried.
  const claim=await env.DB.prepare("UPDATE emails SET notification_status='unknown' WHERE email_id=? AND notification_status='queued'").bind(job.email_id).run();
  if(claim.meta.changes!==1) return;
  const source=await env.DB.prepare(
    "SELECT classification,task_id FROM inbound_events WHERE source_type IN ('gmail','email_ingest') AND source_id=?"
  ).bind(e.email_id).first();
  const heading=source?.classification==='UPDATE'?'🧩 Дополнение к задаче':
    source?.classification==='TASK'?'📥 Новая задача':
    source?.classification==='REVIEW'?'⚠️ Письмо на проверку':'🔥 Важная рабочая информация';
  const notice=heading+'\n\nТема: '+e.subject+'\nОт: '+e.from_name+'\n\n'+e.summary+
    (e.action&&e.action!=='Действий не требуется'?'\n\nЧто требуется: '+e.action:'')+
    (e.deadline_text&&e.deadline_text!=='Не указан'?'\nСрок: '+e.deadline_text:'')+
    (source?.source_link?'\n\nОткрыть письмо: '+source.source_link:'');
  await send(env,env.TELEGRAM_CHAT_ID,{
    text:notice,
    ...(env.WORKER_EMAIL_WORKER_CALLBACKS_ENABLED==='true'?
      {reply_markup:source?.task_id?taskMarkup(source.task_id):emailMarkup(e.email_id)}:{})
  });
  await env.DB.prepare("UPDATE emails SET notification_status='sent' WHERE email_id=?").bind(e.email_id).run();
}
export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if(path==='/admin/connections') return connectionStatus(request,env);
    if(path==='/admin/import/tasks') return importLegacyTasks(request,env);
    if(path==='/admin/telegram/status') return telegramCutoverReadiness(request,env);
    if(path==='/admin/telegram/cutover') return telegramCutover(request,env);
    if(path==='/app'||path.startsWith('/app/api/'))return miniApp(request,env);
    if(path==='/oauth/outlook/start')return startOutlookOAuth(request,env);
    if(path==='/oauth/outlook/callback')return completeOutlookOAuth(request,env);
    if(path==='/oauth/google/calendar/start')return startCalendarOAuth(request,env);
    if(path==='/oauth/google/start') return startGoogleOAuth(request,env);
    if(path==='/oauth/google/callback') return completeGoogleOAuth(request,env);
    if(request.method==='GET'&&path==='/health') return ok({ok:true,service:'personal-assistant',phase:'staging',version:'0.2.0'});
    if(request.method==='GET'&&path==='/health/db') {
      if (!env.DB) return ok({ok:false,phase:'staging',database:'unbound'},503);
      try {
        const tables=await env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('telegram_updates','emails','tasks','history','states') ORDER BY name"
        ).all();
        const present=(tables.results||[]).map(row=>row.name);
        const ready=present.length===5;
        return ok({ok:ready,phase:'staging',database:'rahal-mamut-staging',tables:present},ready?200:503);
      } catch(error) {
        failLog('staging_db_health_failed',error);
        return ok({ok:false,phase:'staging',database:'unavailable'},503);
      }
    }
    if(request.method==='GET'&&path==='/health/features') {
      if(!env.DB) return ok({ok:false,phase:'staging',reason:'database_unbound'},503);
      try {
        const names=await env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('reminder_deliveries','reply_drafts') ORDER BY name"
        ).all();
        const tables=(names.results||[]).map(row=>row.name);
        const flags={
          gmail_poll:env.GMAIL_POLL_ENABLED==='true',
          reminders:env.REMINDERS_ENABLED==='true',
          reply_previews:env.REPLY_PREVIEWS_ENABLED==='true',
          email_notifications:env.WORKER_EMAIL_NOTIFICATIONS==='true'
        };
        return ok({ok:true,phase:'staging',tables,flags});
      } catch(err) {
        failLog('feature_health_failed',err);
        return ok({ok:false,phase:'staging',reason:'database_unavailable'},503);
      }
    }
    if(request.method==='POST'&&path==='/internal/telegram/mention') {
      try{return await ingestTelegramMention(request,env);}
      catch(e){failLog('telegram_mention_ingest_failed',e);return ok({error:'temporary'},503);}
    }
    if(request.method==='POST'&&path==='/telegram/webhook') {
      try { return await webhook(request,env); }
      catch(e){ failLog('webhook_error',e);return ok({error:'temporary'},503); }
    }
    if(request.method==='POST'&&path==='/internal/slp/notice') {
      try{return await ingestSLPNotice(request,env);}
      catch(e){failLog('slp_ingest_failed',e);return ok({error:'temporary'},503);}
    }
    if(request.method==='POST'&&path==='/internal/ingest/email') {
      try { return await ingestEmail(request,env); }
      catch(e){failLog('email_ingest_error',e);return ok({error:'temporary'},503);}
    }
    if(request.method==='POST'&&path==='/internal/ingest/task') {
      try {return await ingestTask(request,env);}
      catch(e){failLog('task_ingest_error',e);return ok({error:'temporary'},503);}
    }
    return ok({error:'not_found'},404);
  },
  async queue(batch,env) {
    for (const msg of batch.messages) {
      try {
        if (msg.body?.kind==='telegram') {
          const outcome=await processTelegram(msg.body,env);
          if(outcome==='busy') {msg.retry({delaySeconds:5});continue;}
        } else if(msg.body?.kind==='telegram_mention') {
          const outcome=await processTelegramMention(env,msg.body.id);
          if(outcome==='busy'){msg.retry({delaySeconds:15});continue;}
        } else if(msg.body?.kind==='email') await processEmail(msg.body,env);
        else if(msg.body?.kind==='slp_notice') await processSLPNotice(msg.body,env);
        else if(msg.body?.kind==='gmail_ingest') {
          const outcome=await ingestGmailId(env,msg.body.id);
          if(outcome?.busy) { msg.retry({delaySeconds:30}); continue; }
        }
        else throw new Error('Unknown queue job');
        msg.ack();
      } catch(e){failLog('queue_job_failed',e);msg.retry({delaySeconds:5});}
    }
  },
  async scheduled(controller,env,ctx) {
    // Disabled by default. No Google account or bot token is needed for staging.
    if(env.GMAIL_POLL_ENABLED==='true') {
      try {
        const result=await pollGmail(env);
        await env.DB.prepare(
          "INSERT INTO states(chat_id,mode,data,updated_at) VALUES(?,?,?,?) "+
          "ON CONFLICT(chat_id) DO UPDATE SET mode=excluded.mode,data=excluded.data,updated_at=excluded.updated_at"
        ).bind('system:gmail-poll','OK',JSON.stringify(result),
          nowSeconds()).run();
        console.log(JSON.stringify({event:'gmail_poll',...result}));
      } catch(e) {
        failLog('gmail_poll_failed',e);
        try {
          await env.DB.prepare(
            "INSERT INTO states(chat_id,mode,data,updated_at) VALUES(?,?,?,?) "+
            "ON CONFLICT(chat_id) DO UPDATE SET mode=excluded.mode,data=excluded.data,updated_at=excluded.updated_at"
          ).bind('system:gmail-poll','ERROR','Gmail poll failed',nowSeconds()).run();
        } catch { /* A D1 outage is already captured by failLog. */ }
        throw e;
      }
    }
    if(env.REMINDERS_ENABLED==='true') {
      try { const result=await runReminders(env); console.log(JSON.stringify({event:'reminder_tick',...result})); }
      catch(e) { failLog('reminder_tick_failed',e); throw e; }
    }
    if(env.OUTLOOK_POLL_ENABLED==='true'){
      try { const result=await pollOutlook(env);
        console.log(JSON.stringify({event:'outlook_poll',...result}));
      }catch(e){failLog('outlook_poll_failed',e);}
    }
    if(env.DAILY_BRIEF_ENABLED==='true') {
      try { const result=await runDailyBrief(env); console.log(JSON.stringify({event:'daily_brief',...result})); }
      catch(e) { failLog('daily_brief_failed',e); }
    }
  }
};
