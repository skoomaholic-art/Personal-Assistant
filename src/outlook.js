import {ownerAuthorized} from './google-oauth.js';
import {backMarkup,safeText} from './router.js';

const responseHeaders={'cache-control':'no-store','referrer-policy':'no-referrer',
  'x-content-type-options':'nosniff'};
const STATE='__Host-pa_ms_state',PKCE='__Host-pa_ms_pkce';
const types='application/x-www-form-urlencoded';
const permissions=['openid','email','offline_access','User.Read',
  'Mail.Read','Mail.Send','Calendars.ReadWrite'];
const tenant=env=>/^(?:organizations|[a-f0-9-]{36})$/i.test(String(env.MS_TENANT_ID||'organizations'))?
  String(env.MS_TENANT_ID||'organizations'):'organizations';
const authority=env=>'https://login.microsoftonline.com/'+tenant(env);
const base64url=bytes=>{
  let text='';for(const item of bytes)text+=String.fromCharCode(item);
  return btoa(text).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
};
const decode=text=>Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const short=(v,n)=>String(v??'').trim().slice(0,n);
const reply=(text,status=200,headers={})=>new Response(text,{
  status,headers:{...responseHeaders,'content-type':'text/plain; charset=utf-8',...headers}
});
function uri(request,env){
  const value=new URL(String(env.MS_REDIRECT_URI||''));
  if(value.origin!==new URL(request.url).origin||value.protocol!=='https:'||
    value.pathname!=='/oauth/outlook/callback'||value.search||value.hash)
    throw Error('Microsoft OAuth redirect URI invalid');
  return value.href;
}
function cookie(request,name){
  const match=(request.headers.get('cookie')||'').split(';')
    .map(x=>x.trim()).find(x=>x.startsWith(name+'='));
  return match?.slice(name.length+1)||'';
}
const clearCookies=[
  STATE+'=; Max-Age=0; Secure; HttpOnly; SameSite=Lax; Path=/',
  PKCE+'=; Max-Age=0; Secure; HttpOnly; SameSite=Lax; Path=/'
];
async function secretKey(env){
  if(!env.MS_CLIENT_SECRET||!env.SETUP_PASSWORD||env.SETUP_PASSWORD.length<24)
    throw Error('Microsoft token encryption unavailable');
  const bytes=new TextEncoder().encode(
    'personal-assistant-outlook-v1\0'+env.SETUP_PASSWORD+'\0'+env.MS_CLIENT_SECRET
  );
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
async function encrypt(env,token){
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const bytes=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},
    await secretKey(env),new TextEncoder().encode(token));
  return 'v1.'+base64url(nonce)+'.'+base64url(new Uint8Array(bytes));
}
async function decrypt(env,cipher){
  const parts=String(cipher||'').split('.');
  if(parts.length!==3||parts[0]!=='v1')throw Error('Outlook credential unavailable');
  const value=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(parts[1])},
    await secretKey(env),decode(parts[2]));
  return new TextDecoder().decode(value);
}
export async function startOutlookOAuth(request,env){
  if(request.method!=='GET')return reply('Method not allowed',405);
  if(env.OUTLOOK_SETUP_ENABLED!=='true'||!env.MS_CLIENT_ID||
    !env.MS_CLIENT_SECRET||!env.DB)return reply('Outlook integration not authorized',503);
  if(!ownerAuthorized(request,env))
    return reply('Owner login required',401,{
      'www-authenticate':'Basic realm="Personal Assistant", charset="UTF-8"'});
  try{
    const state=base64url(crypto.getRandomValues(new Uint8Array(32)));
    const verifier=base64url(crypto.getRandomValues(new Uint8Array(32)));
    const digest=new Uint8Array(await crypto.subtle.digest(
      'SHA-256',new TextEncoder().encode(verifier)
    ));
    const query=new URLSearchParams({
      client_id:env.MS_CLIENT_ID,response_type:'code',redirect_uri:uri(request,env),
      response_mode:'query',scope:permissions.join(' '),
      code_challenge:base64url(digest),code_challenge_method:'S256',state
    });
    const headers=new Headers(responseHeaders);
    headers.set('location',authority(env)+'/oauth2/v2.0/authorize?'+query.toString());
    headers.append('set-cookie',STATE+'='+state+'; Max-Age=600; Secure; HttpOnly; SameSite=Lax; Path=/');
    headers.append('set-cookie',PKCE+'='+verifier+'; Max-Age=600; Secure; HttpOnly; SameSite=Lax; Path=/');
    return new Response(null,{status:302,headers});
  }catch{return reply('Outlook OAuth configuration unavailable',503);}
}
export async function completeOutlookOAuth(request,env){
  if(request.method!=='GET'||env.OUTLOOK_SETUP_ENABLED!=='true')
    return reply('Outlook pairing is disabled',503);
  const url=new URL(request.url);
  const state=url.searchParams.get('state')||'';
  const saved=cookie(request,STATE);
  const verifier=cookie(request,PKCE);
  const expiredHeaders=new Headers(responseHeaders);
  for(const item of clearCookies)expiredHeaders.append('set-cookie',item);
  expiredHeaders.set('content-type','text/plain; charset=utf-8');
  if(!state||!saved||state!==saved||!verifier||
    !/^[A-Za-z0-9_-]{40,100}$/.test(verifier))
    return new Response('Invalid or expired OAuth state',{status:400,headers:expiredHeaders});
  const code=url.searchParams.get('code')||'';
  if(!code||code.length>3000)
    return new Response('No valid authorization code',{status:400,headers:expiredHeaders});
  try{
    const params=new URLSearchParams({
      client_id:env.MS_CLIENT_ID,client_secret:env.MS_CLIENT_SECRET,
      code_verifier:verifier,code,redirect_uri:uri(request,env),
      grant_type:'authorization_code',scope:permissions.join(' ')
    });
    const res=await fetch(authority(env)+'/oauth2/v2.0/token',{
      method:'POST',headers:{'content-type':types},body:params,
      signal:AbortSignal.timeout(12000)
    });
    if(!res.ok)throw Error('Microsoft OAuth exchange failed');
    const tokens=await res.json();
    if(!tokens.access_token||!tokens.refresh_token)
      throw Error('Microsoft offline access not granted');
    const profile=await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName',{
      headers:{authorization:'Bearer '+tokens.access_token},signal:AbortSignal.timeout(12000)
    });
    if(!profile.ok)throw Error('Microsoft account not accessible');
    const user=await profile.json();
    const account=short(user.mail||user.userPrincipalName,254).toLowerCase();
    if(!account||account!==String(env.WORK_EMAIL||'').toLowerCase())
      throw Error('This is not the explicitly configured work account');
    const encrypted=await encrypt(env,tokens.refresh_token);
    await env.DB.prepare(
      "INSERT INTO oauth_credentials(provider,encrypted_refresh_token,account_email,granted_scopes,updated_at) "+
      "VALUES('outlook',?,?,?,?) ON CONFLICT(provider) DO UPDATE SET "+
      "encrypted_refresh_token=excluded.encrypted_refresh_token,"+
      "account_email=excluded.account_email,granted_scopes=excluded.granted_scopes,"+
      "updated_at=excluded.updated_at"
    ).bind(encrypted,account,String(tokens.scope||''),new Date().toISOString()).run();
    return new Response('Work Outlook connected with owner consent. Mail polling and external AI sharing remain separately disabled.',{
      status:200,headers:expiredHeaders
    });
  }catch{
    return new Response('Outlook pairing failed or company policy denied access. Nothing was sent.',{
      status:503,headers:expiredHeaders
    });
  }
}
export async function outlookAccessToken(env){
  if(!env.DB||!env.MS_CLIENT_ID||!env.MS_CLIENT_SECRET)
    throw Error('Work Outlook is not configured');
  const row=await env.DB.prepare(
    "SELECT encrypted_refresh_token FROM oauth_credentials WHERE provider='outlook'"
  ).first();
  if(!row?.encrypted_refresh_token)throw Error('Work Outlook has not been authorized');
  const refresh=await decrypt(env,row.encrypted_refresh_token);
  const result=await fetch(authority(env)+'/oauth2/v2.0/token',{
    method:'POST',headers:{'content-type':types},
    body:new URLSearchParams({
      client_id:env.MS_CLIENT_ID,client_secret:env.MS_CLIENT_SECRET,
      refresh_token:refresh,grant_type:'refresh_token',scope:permissions.join(' ')
    }),signal:AbortSignal.timeout(12000)
  });
  if(!result.ok)throw Error('Microsoft refresh token refused');
  const token=await result.json();
  if(!token.access_token)throw Error('Microsoft access token missing');
  // Microsoft rotates refresh tokens. Save the newest encrypted token.
  // Never expose tokens in logs, errors or chat.
  if(token.refresh_token){
    const encrypted=await encrypt(env,token.refresh_token);
    await env.DB.prepare(
      "UPDATE oauth_credentials SET encrypted_refresh_token=?,updated_at=? "+
      "WHERE provider='outlook'"
    ).bind(encrypted,new Date().toISOString()).run();
  }
  return token.access_token;
}
export async function graph(env,resource,{method='GET',body=null,params={}}={}){
  const url=new URL('https://graph.microsoft.com/v1.0'+resource);
  for(const [key,value] of Object.entries(params))url.searchParams.set(key,String(value));
  const response=await fetch(url.toString(),{
    method,headers:{authorization:'Bearer '+await outlookAccessToken(env),
      accept:'application/json',...(body===null?{}:{'content-type':'application/json'})},
    body:body===null?undefined:JSON.stringify(body),signal:AbortSignal.timeout(16000)
  });
  if(!response.ok)throw Error('Microsoft Graph '+method+' HTTP '+response.status);
  // Graph sendMail/reply return HTTP 202 Accepted with no JSON body.
  // A successful 202 means Graph accepted the request, not that the
  // recipient has received or read the mail.
  if(response.status===202||response.status===204)return {accepted:true};
  return response.json();
}
async function hashedId(id){
  const sha=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(id));
  return 'outlook_'+Array.from(new Uint8Array(sha).slice(0,16),
    x=>x.toString(16).padStart(2,'0')).join('');
}
export async function pollOutlook(env){
  if(env.OUTLOOK_POLL_ENABLED!=='true')return {disabled:true};
  if(!env.DB)throw Error('Outlook D1 unavailable');
  const oauth=await env.DB.prepare(
    "SELECT updated_at FROM oauth_credentials WHERE provider='outlook'"
  ).first();
  if(!oauth)throw Error('Work Outlook authorization missing');
  const checkpoint=await env.DB.prepare(
    "SELECT data FROM states WHERE chat_id='system:outlook-floor'"
  ).first();
  const floor=checkpoint?.data||oauth.updated_at;
  if(!checkpoint)await env.DB.prepare(
    "INSERT OR IGNORE INTO states(chat_id,mode,data,updated_at) VALUES('system:outlook-floor','CHECKPOINT',?,?)"
  ).bind(floor,Math.floor(Date.now()/1000)).run();
  const result=await graph(env,'/me/mailFolders/inbox/messages',{params:{
    '$select':'id,subject,bodyPreview,from,receivedDateTime,hasAttachments',
    '$filter':'receivedDateTime ge '+new Date(floor).toISOString(),
    '$orderby':'receivedDateTime desc','$top':'40'
  }});
  let inserted=0;
  for(const entry of Array.isArray(result.value)?result.value:[]){
    const id=await hashedId(String(entry.id||''));
    const person=entry.from?.emailAddress||{};
    const sender=short(person.address,250);
    const summary=short(entry.bodyPreview,1100);
    const record=await env.DB.prepare(
      "INSERT OR IGNORE INTO emails(email_id,received_at,from_name,from_email,"+
      "subject,summary,action,category,priority,deadline_text,deadline_iso,"+
      "has_attachments,status,notification_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(id,String(entry.receivedDateTime||new Date().toISOString()),
      short(person.name||sender,250),sender,short(entry.subject||'Без темы',450),
      summary,'Действия не определены','ПИСЬМО','средний','','',
      entry.hasAttachments?1:0,'WORK_OUTLOOK','disabled').run();
    if(record.meta.changes!==1)continue;
    await env.DB.prepare(
      "INSERT OR IGNORE INTO states(chat_id,mode,data,updated_at) VALUES(?,'OUTLOOK_REF',?,?)"
    ).bind('outlook:source:'+id,JSON.stringify({id:entry.id}),Math.floor(Date.now()/1000)).run();
    inserted++;
  }
  return {scanned:(result.value||[]).length,inserted};
}
export async function outlookAgenda(env,days=1){
  if(env.OUTLOOK_CALENDAR_READ_ENABLED!=='true')
    return {text:'Рабочий календарь не подключён с разрешения компании.',
      reply_markup:backMarkup()};
  const start=new Date(),end=new Date(start.getTime()+days*86400000);
  try{
    const result=await graph(env,'/me/calendarView',{params:{
      startDateTime:start.toISOString(),endDateTime:end.toISOString(),
      '$select':'subject,start,end,isCancelled','$top':'40',
      '$orderby':'start/dateTime'
    }});
    const lines=(result.value||[]).filter(x=>!x.isCancelled)
      .map(x=>'• '+short(x.subject||'Без темы',130)+
        ' | '+short(x.start?.dateTime,38));
    return {text:safeText('📅 Рабочий Outlook:\n'+(lines.join('\n')||'Событий нет.')),
      reply_markup:backMarkup()};
  }catch{return {text:'Не получилось загрузить рабочий календарь.',
    reply_markup:backMarkup()};}
}

export async function outlookCreateEvent(env,draft,transactionId){
  if(env.OUTLOOK_CALENDAR_WRITE_ENABLED!=='true')
    throw Error('Corporate calendar write access has not been authorized');
  const start=new Date(String(draft.start_iso)),end=new Date(String(draft.end_iso));
  if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||
    end<=start||!draft.title)throw Error('Invalid work calendar event');
  // UTC is explicit to avoid Microsoft's regional timezone aliases and
  // Kazakhstan UTC offset changes.
  const event=await graph(env,'/me/events',{method:'POST',body:{
    transactionId,subject:short(draft.title,180),
    body:{contentType:'text',content:short(draft.description,900)},
    start:{dateTime:start.toISOString().replace(/Z$/,''),timeZone:'UTC'},
    end:{dateTime:end.toISOString().replace(/Z$/,''),timeZone:'UTC'},
    location:{displayName:short(draft.location,180)},showAs:'busy'
  }});
  if(!event.id)throw Error('Outlook event ID missing');
  return event;
}
