// Narrow, metadata-only bridge for SLP's editorial review queue.
// A notice is NOT a confirmed schedule, and never contains email bodies or XLSX bytes.
import {hasValidSecret} from './router.js';
import {storeSourceEvent} from './task-store.js';

const reply=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
const clip=(value,max)=>String(value??'').trim().slice(0,max);
const validId=/^[a-f0-9]{32}$/;

export async function ingestSLPNotice(request,env){
  if(env.SLP_NOTICE_INGEST_ENABLED!=='true') return reply({error:'disabled'},503);
  const provided=request.headers.get('authorization')?.replace(/^Bearer /i,'')||'';
  if(!env.SLP_NOTICE_SECRET||!hasValidSecret(provided,env.SLP_NOTICE_SECRET))
    return reply({error:'unauthorized'},401);
  let data;
  try {
    const body=await request.text();
    if(body.length>2000)return reply({error:'too_large'},413);
    data=JSON.parse(body);
  } catch{return reply({error:'bad_json'},400);}
  if(!data||!validId.test(data.id)||!['pending','review'].includes(data.status)||
     typeof data.channel!=='string'||data.channel.length>120)
    return reply({error:'invalid_notice'},400);

  const id=data.id,channel=clip(data.channel,120)||'Канал не определён';
  const status=data.status==='review'?'требуется проверка':'ожидает подтверждения';
  // The target URL is configured by the owner, never accepted from the sender.
  const configuredUrl=clip(env.SLP_WEB_URL,500);
  const link=/^https:\/\/[a-z0-9.-]+(?:\/.*)?$/i.test(configuredUrl)?configuredUrl:'';
  const title='Проверить расписание: '+channel;
  const description='SLP 2.0. Получено обновление по каналу '+channel+
    '. Статус: '+status+'. Открой «Почта и обновления» в SLP и проверь документ перед применением.';
  const result=await storeSourceEvent(env,{
    sourceType:'slp',sourceId:id,threadKey:'slp:'+id,
    author:'SLP 2.0',sourceTitle:title,sourceLink:link,
    originalText:description,classification:'TASK',
    title,description,summary:description,priority:'средний',
    createdAt:new Date().toISOString()
  });
  if(env.SLP_NOTICE_NOTIFICATIONS!=='true')
    return reply({ok:true,stored:true,duplicate:result.duplicate,notification:'disabled'});
  // Retrying the POST is safe: a separate durable claim prevents duplicate delivery.
  try { await env.JOBS.send({kind:'slp_notice',id}); }
  catch{return reply({error:'queue_unavailable',stored:true},503);}
  return reply({ok:true,stored:true,duplicate:result.duplicate,notification:'queued'});
}
