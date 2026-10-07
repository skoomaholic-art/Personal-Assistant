import {ownerAuthorized} from './google-oauth.js';
import {BRAND_HEAD,BRAND_LOGO} from './brand.js';

// Owner-only switch of the ONE existing Telegram bot from the legacy Apps
// Script webhook to this Worker, and back. Nothing here creates a second bot.
// The bot token, the webhook secret and the previous webhook URL are never
// shown: the previous URL is kept in D1 only so that rollback is one click.
const HEADERS={
  'content-type':'text/html; charset=utf-8',
  'cache-control':'private, no-store',
  'x-content-type-options':'nosniff',
  // same-origin keeps the Origin header on our own form posts; no-referrer would null it.
  'referrer-policy':'same-origin',
  'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'"
};
const CHALLENGE={'www-authenticate':'Basic realm="Rahal Mamut cutover", charset="UTF-8"'};
const STATE_KEY='system:telegram-cutover';
const LEGACY_HOSTS=new Set(['script.google.com','script.googleusercontent.com']);
const ALLOWED_UPDATES=['message','callback_query'];
const title='Переключение Telegram-бота';

function page(body,status=200,challenge=false){
  return new Response('<!doctype html><html lang="ru"><meta charset="utf-8">'+
    '<meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<title>'+title+'</title>'+BRAND_HEAD+'<style>'+
    'body{background:#101a14;color:#e9f5ed;font:16px/1.55 system-ui;padding:24px;max-width:740px;margin:auto}'+
    'section{background:#1b2b20;border:1px solid #42634d;border-radius:16px;padding:20px;margin:0 0 16px}'+
    'label{display:block;margin:14px 0}li{margin:6px 0}'+
    'button{padding:12px 18px;background:#88df9c;color:#102016;border:0;border-radius:9px;font-weight:700}'+
    'button.back{background:#e6c36a}a{color:#88df9c}</style><main>'+BRAND_LOGO+'<h1>'+title+'</h1>'+body+'</main></html>',
    {status,headers:{...HEADERS,...(challenge?CHALLENGE:{})}});
}
const box=html=>'<section>'+html+'</section>';
const home='<p><a href="/admin/telegram/cutover">Вернуться</a></p>';

async function telegram(env,method,payload){
  const res=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/'+method,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(payload||{}),signal:AbortSignal.timeout(10000)
  });
  if(!res.ok)throw Error('Telegram HTTP '+res.status);
  const body=await res.json();
  if(!body.ok)throw Error('Telegram rejected '+method);
  return body.result;
}
export function webhookTarget(url,ownOrigin){
  if(!url)return 'not_set';
  let parsed;
  try{parsed=new URL(url);}catch{return 'other';}
  if(parsed.origin===ownOrigin&&parsed.pathname==='/telegram/webhook')return 'cloudflare_worker';
  return LEGACY_HOSTS.has(parsed.hostname)?'legacy_apps_script':'other';
}
const TARGET_TEXT={
  cloudflare_worker:'новая версия (Cloudflare Worker)',
  legacy_apps_script:'старый бот (Google Apps Script)',
  not_set:'webhook не задан',other:'другой адрес'
};
async function savedPrevious(env){
  const row=await env.DB.prepare('SELECT data FROM states WHERE chat_id=?').bind(STATE_KEY).first();
  try{return JSON.parse(row?.data||'{}');}catch{return {};}
}
async function saveState(env,mode,data){
  await env.DB.prepare(
    'INSERT INTO states(chat_id,mode,data,updated_at) VALUES(?,?,?,?) '+
    'ON CONFLICT(chat_id) DO UPDATE SET mode=excluded.mode,data=excluded.data,updated_at=excluded.updated_at'
  ).bind(STATE_KEY,mode,JSON.stringify(data),Math.floor(Date.now()/1000)).run();
}
function missing(env){
  return ['TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','TELEGRAM_WEBHOOK_SECRET','GROQ_API_KEY']
    .filter(name=>!env[name]).concat(env.DB?[]:['DB'],env.JOBS?[]:['JOBS']);
}

export async function telegramCutover(request,env){
  if(!ownerAuthorized(request,env))return page(box('<p>Требуется вход владельца.</p>'),401,true);
  if(env.TELEGRAM_CUTOVER_ENABLED!=='true')
    return page(box('<p>Переключение выключено (<code>TELEGRAM_CUTOVER_ENABLED</code>). Webhook не менялся.</p>'),503);
  const absent=missing(env);
  if(absent.includes('DB')||absent.includes('TELEGRAM_BOT_TOKEN'))
    return page(box('<p>Worker не настроен: '+absent.join(', ')+'. Webhook не менялся.</p>'),503);
  const own=new URL(request.url).origin;

  if(request.method==='GET'){
    let info,previous,tasks;
    try{
      info=await telegram(env,'getWebhookInfo');
      previous=await savedPrevious(env);
      tasks=Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status!='DELETED'").first())?.n||0);
    }catch{return page(box('<p>Не удалось получить состояние. Webhook не менялся.</p>'),502);}
    const target=webhookTarget(info.url,own);
    const status=box('<p>Сейчас бот подключён к: <b>'+TARGET_TEXT[target]+'</b>.</p>'+
      '<p>Сообщений в очереди Telegram: '+Number(info.pending_update_count||0)+
      '. Задач в новой базе: '+tasks+'.</p>'+
      (absent.length?'<p>Не хватает настроек: '+absent.join(', ')+'.</p>':''));
    if(target==='cloudflare_worker')return page(status+box(
      '<p>Бот уже работает на новой версии.</p>'+(previous.previous_url?
        '<form method="post" action="/admin/telegram/cutover">'+
        '<input type="hidden" name="action" value="rollback">'+
        '<label><input type="checkbox" name="confirm" value="yes" required> '+
        'Вернуть бота на старый Apps Script.</label>'+
        '<button class="back" type="submit">Откатить на старого бота</button></form>':
        '<p>Прежний адрес не сохранён. Для отката запусти в редакторе Apps Script функцию '+
        '<code>configureTelegramWebhook</code>.</p>')));
    if(absent.length)return page(status);
    return page(status+box(
      '<p>Перед переключением:</p><ol>'+
      '<li>Перенеси задачи из старой таблицы: <a href="/admin/import/tasks">импорт задач</a>.</li>'+
      '<li>После переключения удали в Apps Script триггеры <code>checkNewMail</code> и '+
      '<code>runReminders</code>, иначе уведомления будут приходить дважды.</li></ol>'+
      '<form method="post" action="/admin/telegram/cutover">'+
      '<input type="hidden" name="action" value="switch">'+
      '<label><input type="checkbox" name="confirm" value="yes" required> '+
      'Переключить существующего бота на новую версию. Старый адрес будет сохранён для отката.</label>'+
      '<button type="submit">Переключить бота</button></form>'));
  }

  if(request.method!=='POST')return page(box('<p>Метод не поддерживается.</p>'),405);
  if(request.headers.get('origin')!==own)
    return page(box('<p>Недопустимый источник запроса. Открой страницу непосредственно на сайте.</p>'+home),403);
  let form;
  try{form=await request.formData();}catch{return page(box('<p>Не удалось прочитать форму.</p>'+home),400);}
  if(form.get('confirm')!=='yes')return page(box('<p>Требуется подтверждение. Webhook не менялся.</p>'+home),403);
  const action=form.get('action');
  let info;
  try{info=await telegram(env,'getWebhookInfo');}
  catch{return page(box('<p>Telegram недоступен. Webhook не менялся.</p>'+home),502);}
  const target=webhookTarget(info.url,own);

  if(action==='switch'){
    if(absent.length)return page(box('<p>Не хватает настроек: '+absent.join(', ')+'. Webhook не менялся.</p>'+home),409);
    if(target==='cloudflare_worker')return page(box('<p>Бот уже работает на новой версии.</p>'+home));
    // Remember where to go back to BEFORE touching Telegram.
    if(target==='legacy_apps_script')
      await saveState(env,'SWITCHING',{previous_url:info.url});
    try{
      await telegram(env,'setWebhook',{url:own+'/telegram/webhook',
        secret_token:env.TELEGRAM_WEBHOOK_SECRET,allowed_updates:ALLOWED_UPDATES,
        drop_pending_updates:false});
      const after=await telegram(env,'getWebhookInfo');
      if(webhookTarget(after.url,own)!=='cloudflare_worker')throw Error('Webhook not confirmed');
    }catch{
      return page(box('<p>Telegram не подтвердил переключение. Проверь состояние на этой странице; '+
        'при необходимости запусти <code>configureTelegramWebhook</code> в Apps Script.</p>'+home),502);
    }
    if(target==='legacy_apps_script')await saveState(env,'SWITCHED',{previous_url:info.url});
    return page(box('<p>✅ Бот переключён на новую версию. Напиши ему в Telegram, чтобы проверить.</p>'+
      '<p>Теперь удали в Apps Script триггеры <code>checkNewMail</code> и <code>runReminders</code>.</p>'+home));
  }

  if(action==='rollback'){
    const previous=await savedPrevious(env);
    let host='';
    try{host=new URL(previous.previous_url).hostname;}catch{}
    if(!LEGACY_HOSTS.has(host))
      return page(box('<p>Прежний адрес не сохранён. Запусти <code>configureTelegramWebhook</code> в Apps Script. '+
        'Webhook не менялся.</p>'+home),409);
    try{
      await telegram(env,'setWebhook',{url:previous.previous_url,drop_pending_updates:false});
      const after=await telegram(env,'getWebhookInfo');
      if(webhookTarget(after.url,own)!=='legacy_apps_script')throw Error('Rollback not confirmed');
    }catch{
      return page(box('<p>Telegram не подтвердил откат. Запусти <code>configureTelegramWebhook</code> в Apps Script.</p>'+home),502);
    }
    await saveState(env,'ROLLED_BACK',{previous_url:previous.previous_url});
    return page(box('<p>↩️ Бот возвращён на старый Apps Script.</p>'+home));
  }
  return page(box('<p>Неизвестное действие. Webhook не менялся.</p>'+home),400);
}
