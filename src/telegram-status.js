import {ownerAuthorized} from './google-oauth.js';

// Read-only owner diagnosis. No token, chat ID, original webhook URL or message
// is ever returned. Telegram's getWebhookInfo is one inexpensive API call.
const headers={
  'content-type':'application/json; charset=utf-8',
  'cache-control':'private, no-store',
  'referrer-policy':'no-referrer',
  'x-content-type-options':'nosniff'
};
const json=(result,status=200,challenge=false)=>Response.json(result,{
  status,headers:{...headers,...(challenge?{'www-authenticate':
    'Basic realm="Rahal Mamut status", charset="UTF-8"'}:{})}});
export async function telegramCutoverReadiness(request,env){
  if(!ownerAuthorized(request,env))return json({error:'owner_auth_required'},401,true);
  if(request.method!=='GET')return json({error:'method_not_allowed'},405);
  const ready=Boolean(env.TELEGRAM_BOT_TOKEN&&env.TELEGRAM_CHAT_ID&&
    env.TELEGRAM_WEBHOOK_SECRET&&env.DB&&env.JOBS);
  let webhook={status:'unavailable'};
  if(env.TELEGRAM_BOT_TOKEN){
    try{
      const res=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+
        '/getWebhookInfo',{signal:AbortSignal.timeout(10000)});
      if(!res.ok)throw Error('Telegram HTTP '+res.status);
      const body=await res.json();
      if(!body.ok)throw Error('Telegram rejected getWebhookInfo');
      const data=body.result||{};
      let target='not_set';
      if(data.url){
        const url=new URL(data.url);
        const own=new URL(request.url);
        target=url.origin===own.origin&&url.pathname==='/telegram/webhook'
          ?'cloudflare_worker':
          url.hostname==='script.google.com'||url.hostname==='script.googleusercontent.com'
            ?'legacy_apps_script':'other';
      }
      webhook={status:'ok',target,pending_updates:Number(data.pending_update_count||0)};
    }catch{webhook={status:'unavailable'};}
  }
  let db={status:'unavailable'};
  if(env.DB){
    try{
      const row=await env.DB.prepare(
        'SELECT (SELECT COUNT(*) FROM tasks) AS tasks, '+
        '(SELECT COUNT(*) FROM telegram_mentions) AS mentions, '+
        "(SELECT COUNT(*) FROM emails WHERE status='WORK_REVIEW') AS mail_review"
      ).first();
      db={status:'ok',tasks:Number(row?.tasks||0),
        received_telegram_mentions:Number(row?.mentions||0),
        mail_needing_review:Number(row?.mail_review||0)};
    }catch{}
  }
  let legacyImport={completed:false};
  if(env.DB){
    try{
      const row=await env.DB.prepare(
        "SELECT mode,data FROM states WHERE chat_id='system:legacy-task-import'"
      ).first();
      if(row?.mode==='IMPORTED'){
        let data={};try{data=JSON.parse(row.data||'{}');}catch{}
        legacyImport={completed:Boolean(data.confirmed_work_only),
          source_rows:Number(data.source_rows||0)};
      }
    }catch{}
  }
  return json({
    service:'rahal-mamut',scope:env.ASSISTANT_SCOPE||'unspecified',
    worker_ready_for_webhook:ready,webhook,
    database:db,
    listener:{
      secret_configured:Boolean(env.TELEGRAM_MENTION_INGEST_SECRET),
      group_allowlist_configured:Boolean(String(env.TELEGRAM_MENTION_CHAT_IDS||'').trim()),
      private_allowlist_configured:Boolean(String(env.TELEGRAM_MENTION_PRIVATE_CHAT_IDS||'').trim()),
      // A configured secret is not proof of a live Windows MTProto connection.
      process_running:'unverified'
    },
    legacy_tasks_imported:legacyImport,
    notifications_from_worker:env.WORKER_EMAIL_NOTIFICATIONS==='true'
  });
}
