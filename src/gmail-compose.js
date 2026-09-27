// Optional Gmail draft creation/send flow for Rahal Mamut.
// All real mail writes are blocked unless separate explicit feature switches
// and Gmail OAuth scopes are configured. No automatic send or retry.
import {
  gmailAccessToken, gmailMessage, gmailHeaders, isWorkGmailMessage,
  normalizeGmailMessage, gmailAttachmentManifest
} from './gmail.js';

const API='https://gmail.googleapis.com/gmail/v1/users/me';
const ADDRESS=/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const ID=/^[a-zA-Z0-9_-]{5,160}$/;
const draftIdValid=id=>/^d[0-9a-f]{32}$/.test(String(id||''));
const safe=(x,n=500)=>String(x??'').trim().slice(0,n);
function assertHeader(value,label,max=300) {
  const v=safe(value,max+1);
  if(!v || v.length>max || /[\r\n\x00-\x1f\x7f]/.test(v))
    throw new Error('Invalid '+label+' header');
  return v;
}
function oneAddress(value) {
  const v=safe(value,350);
  if(/[\r\n]/.test(v))return '';
  // Reply to exactly ONE unambiguous mailbox. Reject lists and groups.
  if(/[,;]/.test(v))return '';
  const match=v.match(/<([^<>]+)>$/);
  const email=(match?match[1]:v).trim().toLowerCase();
  return ADDRESS.test(email)?email:'';
}
function b64url(bytes) {
  let binary='';
  for(let i=0;i<bytes.length;i+=8192)
    binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function read64(data,max=18000) {
  if(typeof data!=='string'||!data.length||data.length>max*1.5)
    throw new Error('Gmail draft body is empty or exceeds preview limit');
  try {
    const normalized=data.replace(/-/g,'+').replace(/_/g,'/');
    const binary=atob(normalized);
    if(binary.length>max)throw new Error('Gmail draft body exceeds preview limit');
    const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  } catch(error) {
    if(error.message.includes('limit')) throw error;
    throw new Error('Gmail draft body cannot be decoded');
  }
}
async function request(token,method,path,body=null,params=null) {
  const url=new URL(API+path);
  if(params) for(const [key,value] of Object.entries(params))url.searchParams.set(key,value);
  const response=await fetch(url.toString(),{
    method,headers:{Authorization:'Bearer '+token,Accept:'application/json',
      ...(body===null?{}:{'content-type':'application/json'})},
    body:body===null?undefined:JSON.stringify(body),
    signal:AbortSignal.timeout(12000)
  });
  // Do not copy raw Google response bodies into logs or exceptions.
  if(!response.ok)throw new Error('Gmail '+method+' '+path.split('/')[1]+' HTTP '+response.status);
  return response.json();
}
async function digest(value) {
  const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf),n=>n.toString(16).padStart(2,'0')).join('');
}
const encodeSubject=text=>{
  const raw=assertHeader(text,'subject');
  if(/^[\x20-\x7e]*$/.test(raw))return raw;
  const bytes=new TextEncoder().encode(raw);
  let bin='';for(const n of bytes)bin+=String.fromCharCode(n);
  return '=?UTF-8?B?'+btoa(bin)+'?=';
};
export function buildReplyMime({from,to,subject,body,originalMessageId,references}) {
  from=oneAddress(from);to=oneAddress(to);
  if(!from||!to)throw new Error('Invalid from/to address');
  if(typeof body!=='string'||!body.trim()||body.length>12000)
    throw new Error('Reply is empty or too long');
  const headers=[
    'MIME-Version: 1.0',
    'From: '+assertHeader(from,'from'),
    'To: '+assertHeader(to,'to'),
    'Subject: '+encodeSubject(subject),
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64'
  ];
  const msgId=safe(originalMessageId,300);
  const refs=safe(references,750);
  if(msgId && /^<[^<>\r\n]+>$/.test(msgId)) {
    headers.splice(4,0,'In-Reply-To: '+msgId);
    const chain=refs && !/[\r\n]/.test(refs)?refs+' '+msgId:msgId;
    headers.splice(5,0,'References: '+chain.slice(0,900));
  }
  const plain=new TextEncoder().encode(body.replace(/\r\n?/g,'\n').replace(/\n/g,'\r\n'));
  let encoded='';for(const n of plain) encoded+=String.fromCharCode(n);
  const payload=btoa(encoded).match(/.{1,76}/g)?.join('\r\n')||'';
  const raw=headers.join('\r\n')+'\r\n\r\n'+payload+'\r\n';
  return b64url(new TextEncoder().encode(raw));
}
export async function approvedAlias(token,env) {
  const expected=oneAddress(env.OUTBOUND_FROM_ALIAS);
  const work=oneAddress(env.WORK_EMAIL);
  if(!expected||expected!==work)throw new Error('Verified corporate alias not configured');
  const aliases=await request(token,'GET','/settings/sendAs');
  const found=(aliases.sendAs||[]).find(item=>
    String(item.sendAsEmail||'').toLowerCase()===expected &&
    (item.isDefault===true || item.verificationStatus==='accepted'));
  if(!found)throw new Error('Corporate Gmail send-as alias is not verified');
  return expected;
}
function canonicalEmail(value) {
  const v=safe(value,350);
  if(!v)return '';
  if(/[,;\r\n]/.test(v))return '';
  return oneAddress(v);
}
function fullDraftBody(message) {
  let plain=null,html=false;
  const files=gmailAttachmentManifest(message);
  const walk=p=>{
    if(!p)return;
    if(p.mimeType==='text/html' && p.body?.data) html=true;
    if(p.mimeType==='text/plain'&&p.body?.data){
      if(plain!==null)throw new Error('Gmail draft has multiple plain text parts');
      plain=read64(p.body.data);
    }
    for(const child of p.parts||[])walk(child);
  };
  walk(message.payload);
  if(html)throw new Error('HTML Gmail draft requires manual review in Gmail');
  if(files.length)throw new Error('Gmail draft attachments require manual review in Gmail');
  if(plain===null)throw new Error('Full text/plain Gmail draft unavailable');
  return plain.replace(/\r\n?/g,'\n').trim();
}
export async function gmailDraftSnapshot(env,token,gmailDraftId) {
  if(!ID.test(String(gmailDraftId)))throw new Error('Invalid Gmail draft id');
  const obj=await request(token,'GET','/drafts/'+encodeURIComponent(gmailDraftId),null,{format:'full'});
  const m=obj?.message;
  if(!m?.payload)throw new Error('Gmail draft has no full message payload');
  const h=gmailHeaders(m);
  const from=canonicalEmail(h.from),to=canonicalEmail(h.to);
  if(!from||!to||h.cc||h.bcc)throw new Error('Gmail draft recipients are not one-to-one');
  const body=fullDraftBody(m);
  const snapshot={
    from_email:from,to_email:to,cc_line:'',bcc_line:'',
    subject:safe(h.subject,300),body,
    attachment_manifest:'[]'
  };
  if(!snapshot.subject||!snapshot.body)throw new Error('Incomplete Gmail draft');
  return {...snapshot,snapshot_hash:await digest(JSON.stringify(snapshot))};
}
async function setDraft(env,id,status,values={},oldStatus) {
  const items=Object.entries(values);
  const sql="UPDATE reply_drafts SET status=?,updated_at=?"+
    items.map(([name])=>','+name+'=?').join('')+
    " WHERE draft_id=? AND status=?";
  const bind=[status,new Date().toISOString(),...items.map(([,value])=>value),id,oldStatus];
  return env.DB.prepare(sql).bind(...bind).run();
}
export async function prepareGmailDraft(env,draftId) {
  if(env.GMAIL_DRAFTS_ENABLED!=='true')throw new Error('Создание Gmail-черновиков отключено');
  if(!draftIdValid(draftId))throw new Error('Invalid draft ID');
  const draft=await env.DB.prepare('SELECT * FROM reply_drafts WHERE draft_id=?').bind(draftId).first();
  if(!draft || draft.status!=='PREVIEW'||draft.gmail_draft_id)
    throw new Error('Черновик уже обрабатывается или не найден');
  const claimed=await setDraft(env,draftId,'GMAIL_CREATING',{},'PREVIEW');
  if(claimed.meta.changes!==1)throw new Error('Черновик уже обрабатывается');
  let outboundStarted=false;
  try {
    const token=await gmailAccessToken(env);
    const original=await gmailMessage(token,draft.email_id);
    if(!isWorkGmailMessage(original,env))
      throw new Error('Исходное письмо не распознано как рабочее');
    const originalMail=normalizeGmailMessage(original);
    const recipient=oneAddress(originalMail.from_email);
    if(!recipient||recipient!==oneAddress(draft.to_email))
      throw new Error('Адресат исходного письма изменился');
    if(!ID.test(String(original.threadId||'')))
      throw new Error('Не найден Gmail thread');
    const alias=await approvedAlias(token,env);
    const headers=gmailHeaders(original);
    const raw=buildReplyMime({
      from:alias,to:recipient,subject:draft.subject,body:draft.body,
      originalMessageId:headers['message-id']||'',
      references:headers.references||''
    });
    outboundStarted=true;
    const created=await request(token,'POST','/drafts',{
      message:{raw,threadId:original.threadId}
    });
    const gmailDraftId=String(created?.id||'');
    if(!ID.test(gmailDraftId))throw new Error('Gmail returned no draft ID');
    const snap=await gmailDraftSnapshot(env,token,gmailDraftId);
    if(snap.from_email!==alias||snap.to_email!==recipient||
       snap.subject!==draft.subject||snap.body!==draft.body.trim())
      throw new Error('Gmail draft preview differs from requested email');
    const preview_token=crypto.randomUUID().replace(/-/g,'').slice(0,12);
    const saved=await setDraft(env,draftId,'GMAIL_PREVIEWED',{
      gmail_draft_id:gmailDraftId,from_email:alias,
      to_email:snap.to_email,subject:snap.subject,body:snap.body,
      cc_line:snap.cc_line,bcc_line:snap.bcc_line,
      attachment_manifest:snap.attachment_manifest,snapshot_hash:snap.snapshot_hash,
      preview_token
    },'GMAIL_CREATING');
    if(saved.meta.changes!==1)throw new Error('Gmail draft state changed during creation');
    return env.DB.prepare('SELECT * FROM reply_drafts WHERE draft_id=?').bind(draftId).first();
  } catch(error) {
    try {
      await setDraft(env,draftId,outboundStarted?'GMAIL_CREATE_UNKNOWN':'PREVIEW',
        {last_error:'Проверить черновики Gmail, не повторять автоматически'},
        'GMAIL_CREATING');
    } catch{ /* Keep the existing one-way status if D1 is unavailable. */ }
    throw error;
  }
}
export function gmailSendPreview(draft) {
  if(!draft||draft.status!=='GMAIL_PREVIEWED')throw new Error('No approved draft preview');
  const header='✉️ Gmail-черновик готов. Письмо НЕ отправлено.\n\n'+
    'От: '+draft.from_email+'\nКому: '+draft.to_email+
    '\nКопия: '+(draft.cc_line||'Нет')+
    '\nСкрытая копия: '+(draft.bcc_line||'Нет')+
    '\nТема: '+draft.subject+
    '\nВложения: Нет\n\nТЕКСТ ЦЕЛИКОМ:\n\n';
  const footer='\n\nПроверь текст, адресата и тему. Нажатие «Отправить» отправит письмо через Gmail.';
  const text=header+draft.body+footer;
  if(text.length>3850)throw new Error('Полный предпросмотр не помещается в Telegram, отправка заблокирована');
  return {text,reply_markup:{inline_keyboard:[
    [{text:'✅ Отправить письмо',callback_data:'senddraft:'+draft.draft_id+':'+draft.preview_token}],
    [{text:'❌ Отмена',callback_data:'canceldraft:'+draft.draft_id}]
  ]}};
}
export async function confirmGmailSend(env,draftId,previewToken) {
  if(env.GMAIL_SEND_ENABLED!=='true')
    return {text:'Отправка Gmail пока выключена. Письмо не отправлено.'};
  if(!draftIdValid(draftId)||!/^[0-9a-f]{12}$/.test(String(previewToken||'')))
    return {text:'Некорректное подтверждение. Письмо не отправлено.'};
  const draft=await env.DB.prepare('SELECT * FROM reply_drafts WHERE draft_id=?').bind(draftId).first();
  if(!draft)return {text:'Черновик не найден. Письмо не отправлено.'};
  if(draft.status==='SENT')return {text:'✅ Письмо уже отправлено. Повторно не отправляю.'};
  if(['SENDING','SEND_UNKNOWN','GMAIL_CREATING','GMAIL_CREATE_UNKNOWN'].includes(draft.status))
    return {text:'⚠️ Статус Gmail неясен. Повторно не отправляю. Проверь черновики и «Отправленные».'};
  if(draft.status!=='GMAIL_PREVIEWED'||draft.preview_token!==previewToken||!draft.snapshot_hash)
    return {text:'Подтверждение устарело. Письмо не отправлено.'};
  const token=await gmailAccessToken(env);
  const alias=await approvedAlias(token,env);
  let current;
  try {current=await gmailDraftSnapshot(env,token,draft.gmail_draft_id);}
  catch(error){
    await setDraft(env,draftId,'CHANGED',{preview_token:''},'GMAIL_PREVIEWED');
    return {text:'Gmail-черновик исчез или изменён. Отправка заблокирована, открой его в Gmail.'};
  }
  if(current.snapshot_hash!==draft.snapshot_hash||
     current.from_email!==alias||current.to_email!==oneAddress(draft.to_email)||
     current.body!==draft.body.trim()){
    await setDraft(env,draftId,'CHANGED',{preview_token:''},'GMAIL_PREVIEWED');
    return {text:'Gmail-черновик изменён. Отправка заблокирована. Открой его в Gmail.'};
  }
  // Commit the irreversible claim BEFORE any drafts.send HTTP request.
  const claim=await env.DB.prepare(
    "UPDATE reply_drafts SET status='SENDING',preview_token='',updated_at=? "+
    "WHERE draft_id=? AND status='GMAIL_PREVIEWED' AND preview_token=? AND snapshot_hash=?"
  ).bind(new Date().toISOString(),draftId,previewToken,draft.snapshot_hash).run();
  if(claim.meta.changes!==1)
    return {text:'Черновик уже обрабатывается. Повторно не отправляю.'};
  let response;
  try {
    response=await request(token,'POST','/drafts/send',{id:draft.gmail_draft_id});
  } catch(error) {
    try {await setDraft(env,draftId,'SEND_UNKNOWN',{last_error:'Проверить папку Отправленные'},'SENDING');}
    catch{/* SENDING itself prevents a repeat. */}
    return {text:'⚠️ Неясно, отправил ли Gmail письмо. Повторно не отправляю. Проверь папку «Отправленные».'};
  }
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE reply_drafts SET status='SENT',sent_at=?,sent_message_id=?,updated_at=? WHERE draft_id=? AND status='SENDING'")
        .bind(new Date().toISOString(),safe(response?.id,160),new Date().toISOString(),draftId),
      env.DB.prepare("UPDATE emails SET status='REPLIED' WHERE email_id=?").bind(draft.email_id)
    ]);
  } catch {
    return {text:'⚠️ Gmail подтвердил отправку, но запись статуса не удалась. НЕ отправляй повторно.'};
  }
  return {text:'✅ Gmail подтвердил отправку письма. Повторная отправка заблокирована.'};
}
