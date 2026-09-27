import {
  commandOf, getChatId, QUICK_ACTIONS, hasValidSecret, safeText,
  menuMarkup, backMarkup, emailMarkup, taskMarkup, normalizePriority,
  isEmailObject, localDayBounds
} from './router.js';
import {pollGmail, ingestGmailId} from './gmail.js';
import {runReminders} from './reminders.js';

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
  const chatId = getChatId(update);
  if (!chatId || chatId !== String(env.TELEGRAM_CHAT_ID)) return ok({error:'forbidden'},403);
  if (!Number.isSafeInteger(update.update_id)) return ok({error:'missing_update_id'},400);
  const insert = await env.DB.prepare(
    "INSERT OR IGNORE INTO telegram_updates(update_id,status,created_at) VALUES(?,'queued',?)"
  ).bind(update.update_id,nowSeconds()).run();
  if (insert.meta.changes === 0) return ok({ok:true,duplicate:true});

  // Fast, AI-free commands do not wait for a Queue consumer.
  if (QUICK_ACTIONS.has(commandOf(update))) {
    try {
      await callbackAck(env, update);
      const answer = await prepareAnswer(update,env);
      await send(env,chatId,answer);
      await env.DB.prepare("UPDATE telegram_updates SET status='done' WHERE update_id=?")
        .bind(update.update_id).run();
      return ok({ok:true,fast:true});
    } catch (e) {
      failLog('fast_action_failed',e);
      await env.DB.prepare("DELETE FROM telegram_updates WHERE update_id=? AND status='queued'")
        .bind(update.update_id).run();
      return ok({error:'temporary'},503);
    }
  }
  try {
    await env.JOBS.send({kind:'telegram', update});
    return ok({ok:true,queued:true});
  } catch (e) {
    failLog('queue_enqueue_failed',e);
    await env.DB.prepare("DELETE FROM telegram_updates WHERE update_id=? AND status='queued'")
      .bind(update.update_id).run();
    return ok({error:'temporary'},503);
  }
}

async function processTelegram(job,env) {
  const update = job.update;
  const updateId = update.update_id;
  const claimed = await env.DB.prepare(
    "UPDATE telegram_updates SET status='processing', attempts=attempts+1, claimed_at=? " +
    "WHERE update_id=? AND (status='queued' OR (status='processing' AND claimed_at<?))"
  ).bind(nowSeconds(),updateId,nowSeconds()-90).run();
  if (claimed.meta.changes !== 1) {
    const prior = await env.DB.prepare('SELECT status FROM telegram_updates WHERE update_id=?').bind(updateId).first();
    if (!prior || prior.status === 'done') return 'done';
    return 'busy';
  }
  try {
    await callbackAck(env,update);
    const saved = await env.DB.prepare('SELECT response_json FROM telegram_updates WHERE update_id=?')
      .bind(updateId).first();
    // Persist prepared answer so a failed Telegram delivery does not re-run Groq or state mutations.
    let answer = saved?.response_json ? JSON.parse(saved.response_json) : null;
    if (!answer) {
      answer = await prepareAnswer(update,env);
      await env.DB.prepare('UPDATE telegram_updates SET response_json=? WHERE update_id=?')
        .bind(JSON.stringify(answer),updateId).run();
    }
    await send(env,getChatId(update),answer);
    await env.DB.prepare("UPDATE telegram_updates SET status='done' WHERE update_id=?")
      .bind(updateId).run();
    return 'done';
  } catch (e) {
    failLog('telegram_processing_failed',e);
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
      lines.push('Статус: '+r.status+' | Дедлайн: '+(r.due_text || 'Не указан'));
      buttons.push([{text:(index+1)+'. '+safeText(value,35),callback_data:'task:view:'+r.task_id}]);
    } else {
      lines.push(safeText(r.summary,170));
      buttons.push([{text:(index+1)+'. '+safeText(value,35),callback_data:'email:view:'+r.email_id}]);
    }
  });
  buttons.push([{text:'☰ Меню',callback_data:'menu'}]);
  return {text:safeText(lines.join('\n')),reply_markup:{inline_keyboard:buttons}};
}
const emailFields = 'email_id,from_name,from_email,subject,summary,action,category,priority,deadline_text,has_attachments,received_at';
async function listEmails(env,where,bind=[]) {
  const query='SELECT '+emailFields+' FROM emails WHERE '+where+' ORDER BY received_at DESC LIMIT 8';
  const res=await env.DB.prepare(query).bind(...bind).all();
  return res.results;
}
async function getTasks(env) {
  const res=await env.DB.prepare("SELECT task_id,email_id,title,description,status,priority,due_iso,due_text,created_at FROM tasks WHERE status!='DONE' ORDER BY due_iso='' DESC,due_iso ASC LIMIT 80").all();
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
    return {text:action==='cancel'?'Ввод отменён. Что делаем?':'Что делаем?',reply_markup:menuMarkup()};
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
      env.DB.prepare('DELETE FROM history WHERE chat_id=?').bind(chatId),
      env.DB.prepare('DELETE FROM states WHERE chat_id=?').bind(chatId)
    ]);
    return {text:'✅ Контекст очищен.',reply_markup:backMarkup()};
  }
  if (action==='important') return fromRows('🔥 Важное',await listEmails(env,"priority='высокий' OR category='ВАЖНО'"),'email');
  if (action==='news') return fromRows('📰 Новости / FYI',await listEmails(env,"category IN ('НОВОСТЬ','FYI')"),'email');
  if (action==='colleagues') {
    const domain=String(env.WORK_DOMAIN || 'fmedia.kz').toLowerCase();
    return fromRows('👥 Коллеги',await listEmails(env,'lower(from_email) LIKE ?',['%@'+domain]),'email');
  }
  if (action==='today' || action==='week') {
    const tasks=await getTasks(env);
    const bounds=localDayBounds(new Date(),env.TZ_OFFSET_MINUTES ?? 300);
    const end=action==='today' ? bounds.end : new Date(bounds.end.getTime()+6*86400000);
    const filtered=tasks.filter(t=>{
      if (!t.due_iso) {
        if (action==='week') return true;
        const created=Date.parse(t.created_at||'');
        return Number.isFinite(created) && created>=bounds.start.getTime() && created<bounds.end.getTime();
      }
      const due=Date.parse(t.due_iso);
      return Number.isFinite(due) && due<end.getTime();
    });
    return fromRows(action==='today'?'✅ Сегодня':'📅 Неделя',filtered,'task');
  }
  if (action==='search') {
    await setState(env,chatId,'SEARCH');
    return {text:'Что ищем в сохранённых письмах? /cancel - отмена.',reply_markup:backMarkup()};
  }
  if (callback?.startsWith('email:view:')) {
    const id=callback.slice('email:view:'.length);
    const e=await env.DB.prepare('SELECT '+emailFields+' FROM emails WHERE email_id=?').bind(id).first();
    if (!e) return {text:'Письмо не найдено.',reply_markup:backMarkup()};
    return {text:safeText('📨 Письмо\n\nОт: '+e.from_name+'\nТема: '+e.subject+'\n\n'+e.summary+'\n\nЧто требуется: '+e.action+'\nДедлайн: '+(e.deadline_text||'Не указан')),reply_markup:emailMarkup(e.email_id)};
  }
  if (callback?.startsWith('email:task:')) {
    const id=callback.slice('email:task:'.length);
    const e=await env.DB.prepare('SELECT '+emailFields+' FROM emails WHERE email_id=?').bind(id).first();
    if (!e) return {text:'Письмо не найдено.',reply_markup:backMarkup()};
    const existing=await env.DB.prepare('SELECT task_id,title FROM tasks WHERE email_id=?').bind(id).first();
    if (existing) return {text:'Задача уже сохранена:\n'+existing.title,reply_markup:taskMarkup(existing.task_id)};
    const taskId=crypto.randomUUID();
    await env.DB.prepare('INSERT OR IGNORE INTO tasks(task_id,email_id,title,description,status,priority,due_iso,due_text,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .bind(taskId,id,val(e.action||e.subject,180),val(e.summary,1000),'NEW',e.priority,'',e.deadline_text||'',new Date().toISOString(),new Date().toISOString()).run();
    const t=await env.DB.prepare('SELECT task_id,title FROM tasks WHERE email_id=?').bind(id).first();
    return {text:'✅ Задача сохранена:\n'+t.title,reply_markup:taskMarkup(t.task_id)};
  }
  if (callback?.startsWith('task:view:')) {
    const t=await env.DB.prepare('SELECT task_id,title,description,status,priority,due_text FROM tasks WHERE task_id=?').bind(callback.slice(10)).first();
    return t?{text:safeText('✅ Задача\n\n'+t.title+'\n\n'+t.description+'\nСтатус: '+t.status+'\nПриоритет: '+t.priority+'\nДедлайн: '+t.due_text),reply_markup:taskMarkup(t.task_id)}:{text:'Задача не найдена.',reply_markup:backMarkup()};
  }
  if (callback?.startsWith('task:done:') || callback?.startsWith('task:progress:')) {
    const done=callback.startsWith('task:done:');
    const id=callback.slice(done?10:14);
    await env.DB.prepare('UPDATE tasks SET status=?,updated_at=? WHERE task_id=?').bind(done?'DONE':'IN_PROGRESS',new Date().toISOString(),id).run();
    return {text:done?'✅ Отмечено выполненным.':'🟡 Отмечено «В работе».',reply_markup:backMarkup()};
  }
  if (callback?.startsWith('email:reply:') || callback?.startsWith('senddraft:')) {
    return {text:'Отправка почты с нового сервера пока не включена. До переноса Gmail и проверки адресатов используй прежний Apps Script. Я не отправляю письма без подтверждения.',reply_markup:backMarkup()};
  }
  if (callback) return {text:'Эта кнопка пока недоступна в тестовой версии.',reply_markup:backMarkup()};
  const text=String(update?.message?.text||'').trim();
  if (!text) return {text:'Пришли текстовое сообщение.',reply_markup:backMarkup()};
  const state=await env.DB.prepare('SELECT mode FROM states WHERE chat_id=?').bind(chatId).first();
  if (state?.mode==='SEARCH') {
    await clearState(env,chatId);
    const term='%'+text.slice(0,80).toLowerCase()+'%';
    return fromRows('🔎 '+safeText(text,80),await listEmails(env,'lower(subject) LIKE ? OR lower(summary) LIKE ? OR lower(from_name) LIKE ?',[term,term,term]),'email');
  }
  return await groqChat(env,chatId,text,update.update_id);
}

async function groqChat(env,chatId,userText,updateId) {
  if (!env.GROQ_API_KEY) return {text:'AI пока не настроен. Меню и сохранённые задачи доступны.',reply_markup:backMarkup()};
  const start=Date.now();
  const [hist,tasks]=await env.DB.batch([
    env.DB.prepare('SELECT role,content FROM history WHERE chat_id=? ORDER BY id DESC LIMIT 10').bind(chatId),
    env.DB.prepare("SELECT title,due_text FROM tasks WHERE status!='DONE' ORDER BY due_iso='' DESC,due_iso ASC LIMIT 3")
  ]);
  const system='Ты Рахал Мамут, рабочий помощник Александра. Отвечай по-русски, кратко и по существу. Не придумывай факты и не утверждай, что совершил действие, если оно не выполнено. Не цитируй секреты. Текущие задачи: '+tasks.results.map(t=>t.title+' ('+(t.due_text||'без срока')+')').join('; ');
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
    .bind(email.id,email.received_at,email.from_name,email.from_email,email.subject,email.summary,email.action,email.category,email.priority,email.deadline_text,email.deadline_iso,email.has_attachments,env.WORKER_EMAIL_NOTIFICATIONS==='true'?'queued':'disabled').run();
  if (result.meta.changes===0) return ok({ok:true,duplicate:true});
  // No automatic user-facing alert by default: Apps Script still owns mail notifications.
  if (env.WORKER_EMAIL_NOTIFICATIONS==='true') {
    try { await env.JOBS.send({kind:'email',email_id:email.id}); }
    catch (e) { failLog('ingest_queue_failed',e); return ok({ok:true,stored:true,notification:'needs_review'},202); }
  }
  return ok({ok:true,stored:true});
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
  return ok({ok:true,stored:result.meta.changes===1,duplicate:result.meta.changes===0});
}
async function processEmail(job,env) {
  if(env.WORKER_EMAIL_NOTIFICATIONS!=='true') return;
  const e=await env.DB.prepare('SELECT * FROM emails WHERE email_id=?').bind(job.email_id).first();
  if(!e||e.notification_status==='sent'||e.notification_status==='unknown') return;
  // Ambiguous outbound delivery must be reconciled, not resent automatically.
  await env.DB.prepare("UPDATE emails SET notification_status='unknown' WHERE email_id=? AND notification_status='queued'").bind(job.email_id).run();
  const notice='📨 '+e.category+'\n\nТема: '+e.subject+'\nОт: '+e.from_name+'\n\n'+e.summary+'\n\nДействие: '+e.action;
  await send(env,env.TELEGRAM_CHAT_ID,{text:notice,reply_markup:emailMarkup(e.email_id)});
  await env.DB.prepare("UPDATE emails SET notification_status='sent' WHERE email_id=?").bind(e.email_id).run();
}
export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if(request.method==='GET'&&path==='/health') return ok({ok:true,service:'rahal-mamut',phase:'staging',version:'0.1.0'});
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
    if(request.method==='POST'&&path==='/telegram/webhook') {
      try { return await webhook(request,env); }
      catch(e){ failLog('webhook_error',e);return ok({error:'temporary'},503); }
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
        } else if(msg.body?.kind==='email') await processEmail(msg.body,env);
        else if(msg.body?.kind==='gmail_ingest') await ingestGmailId(env,msg.body.id);
        else throw new Error('Unknown queue job');
        msg.ack();
      } catch(e){failLog('queue_job_failed',e);msg.retry({delaySeconds:5});}
    }
  },
  async scheduled(controller,env,ctx) {
    // Disabled by default. No Google account or bot token is needed for staging.
    if(env.GMAIL_POLL_ENABLED==='true') {
      try { const result=await pollGmail(env); console.log(JSON.stringify({event:'gmail_poll',...result})); }
      catch(e) { failLog('gmail_poll_failed',e); throw e; }
    }
    if(env.REMINDERS_ENABLED==='true') {
      try { const result=await runReminders(env); console.log(JSON.stringify({event:'reminder_tick',...result})); }
      catch(e) { failLog('reminder_tick_failed',e); throw e; }
    }
  }
};
