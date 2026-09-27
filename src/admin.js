import {ownerAuthorized} from './google-oauth.js';
import {gmailAccessToken} from './gmail.js';

// Password-gated, read-only service diagnostics. No Gmail message body is
// requested. Never return access tokens, API credentials or Google responses.
const noCache={
  'content-type':'application/json; charset=utf-8',
  'cache-control':'private, no-store, max-age=0',
  'referrer-policy':'no-referrer',
  'x-content-type-options':'nosniff'
};
const response=(data,status=200,extra={})=>
  Response.json(data,{status,headers:{...noCache,...extra}});
const challenge={'www-authenticate':'Basic realm="Personal Assistant", charset="UTF-8"'};

async function verifyGmail(env) {
  const token=await gmailAccessToken(env);
  const result=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile',{
    method:'GET',
    headers:{authorization:'Bearer '+token,'accept':'application/json'},
    signal:AbortSignal.timeout(10000)
  });
  if(!result.ok)throw new Error('Gmail API HTTP '+result.status);
  const data=await result.json();
  const account=String(data?.emailAddress||'').toLowerCase();
  if(!account||!account.includes('@'))throw new Error('Google account missing');
  const expected=String(env.GMAIL_ALLOWED_ACCOUNT||'').toLowerCase().trim();
  if(expected && account!==expected)throw new Error('Wrong authorized Google account');
  return {ok:true,account};
}
async function verifyGroq(env) {
  if(!env.GROQ_API_KEY)throw new Error('Groq key not installed');
  // GET /models checks the real key without consuming chat completion tokens.
  const result=await fetch('https://api.groq.com/openai/v1/models',{
    method:'GET',
    headers:{authorization:'Bearer '+env.GROQ_API_KEY,accept:'application/json'},
    signal:AbortSignal.timeout(10000)
  });
  if(!result.ok)throw new Error('Groq models HTTP '+result.status);
  const data=await result.json();
  const configured=String(env.GROQ_MODEL||'openai/gpt-oss-20b');
  const available=Array.isArray(data?.data)?data.data.some(x=>x.id===configured):false;
  return {ok:available,model:configured};
}
export async function connectionStatus(request,env) {
  if(request.method!=='GET')return response({error:'method_not_allowed'},405);
  if(!ownerAuthorized(request,env))
    return response({error:'owner_auth_required'},401,challenge);
  const checks=await Promise.allSettled([verifyGmail(env),verifyGroq(env)]);
  let mailbox={work_emails:0,ignored_personal:0,tasks:0,last_poll:null};
  try {
    const [counts,tasks,poll]=await Promise.all([
      env.DB.prepare(
        "SELECT COUNT(CASE WHEN status NOT IN ('ANALYZING','IGNORED_NONWORK') THEN 1 END) AS work_emails, "+
        "COUNT(CASE WHEN status='IGNORED_NONWORK' THEN 1 END) AS ignored_personal FROM emails"
      ).first(),
      env.DB.prepare("SELECT COUNT(*) AS tasks FROM tasks").first(),
      env.DB.prepare("SELECT mode,data,updated_at FROM states WHERE chat_id=?")
        .bind('system:gmail-poll').first()
    ]);
    let lastPoll=null;
    if(poll) {
      let stats={};
      try{stats=JSON.parse(poll.data||'{}');}catch{stats={};}
      lastPoll={
        status:poll.mode,
        at:new Date(Number(poll.updated_at)*1000).toISOString(),
        scanned:Number(stats.scanned||0),
        queued:Number(stats.queued||0)
      };
    }
    mailbox={
      work_emails:Number(counts?.work_emails||0),
      ignored_personal:Number(counts?.ignored_personal||0),
      tasks:Number(tasks?.tasks||0),
      last_poll:lastPoll
    };
  } catch { mailbox={status:'database_unavailable'}; }
  // Do not reveal internal error details or sensitive Google account data
  // in failure responses. The owner only needs per-provider health.
  const google=checks[0].status==='fulfilled'
    ? checks[0].value : {ok:false,reason:'google_connection_unavailable'};
  const groq=checks[1].status==='fulfilled'
    ? checks[1].value : {ok:false,reason:'groq_connection_unavailable'};
  return response({
    ok:Boolean(google.ok&&groq.ok),
    service:'Персональный помощник',phase:'staging',
    google,groq,mailbox,
    mail_poll_enabled:env.GMAIL_POLL_ENABLED==='true',
    mail_notifications_enabled:env.WORKER_EMAIL_NOTIFICATIONS==='true',
    email_send_enabled:env.GMAIL_SEND_ENABLED==='true'
  },google.ok&&groq.ok?200:503);
}
