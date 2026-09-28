import {dailyBriefPreview} from './brief.js';
import {calendarAgenda} from './calendar.js';
import {outlookAgenda} from './outlook.js';
import {personalMemory} from './memory.js';
import {workOnly,WORK_EMAIL_STATUSES} from './work-mode.js';
import {latestTelegramMentions,reviewTelegramMention} from './telegram-mentions.js';
import {createTaskFromWorkEmail,categorizeReviewedWorkEmail} from './work-inbox.js';

const json=(data,status=200)=>Response.json(data,{status,headers:{
  'content-type':'application/json; charset=utf-8','cache-control':'private, no-store',
  'x-content-type-options':'nosniff'}});
const cut=(x,n)=>String(x??'').trim().slice(0,n);
async function authorized(request,env){
  if(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_CHAT_ID)return false;
  const value=request.headers.get('authorization')||'';
  if(!value.startsWith('tma ')||value.length>6000)return false;
  const params=new URLSearchParams(value.slice(4));
  const hash=params.get('hash')||'';
  const timestamp=Number(params.get('auth_date'));
  if(!/^[0-9a-f]{64}$/i.test(hash)||!Number.isSafeInteger(timestamp)||
    Date.now()/1000-timestamp>86400||timestamp>Date.now()/1000+60)return false;
  const check=[...params].filter(([key])=>key!=='hash')
    .map(([key,val])=>key+'='+val).sort().join('\n');
  const first=await crypto.subtle.importKey('raw',new TextEncoder().encode('WebAppData'),
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  const secret=await crypto.subtle.sign('HMAC',first,
    new TextEncoder().encode(env.TELEGRAM_BOT_TOKEN));
  const key=await crypto.subtle.importKey('raw',secret,
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signed=new Uint8Array(await crypto.subtle.sign('HMAC',key,
    new TextEncoder().encode(check)));
  const expected=Array.from(signed,v=>v.toString(16).padStart(2,'0')).join('');
  let diff=0;for(let i=0;i<64;i++)diff|=expected.charCodeAt(i)^hash.toLowerCase().charCodeAt(i);
  if(diff!==0)return false;
  try{return String(JSON.parse(params.get('user')||'{}').id)===
    String(env.TELEGRAM_CHAT_ID);}catch{return false;}
}
const html=String.raw`<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Персональный помощник</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{color-scheme:dark;--bg:#0b1510;--card:#18251d;--line:#30503b;--text:#e7f4eb;--sub:#a5bfb0;--accent:#75e5a5}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,sans-serif;padding:14px 14px 86px}
main{max-width:760px;margin:auto}h1{font-size:24px;margin:7px 0}h2{font-size:19px;margin:6px 0 11px}
p,.muted{color:var(--sub)}article,form{border:1px solid var(--line);background:var(--card);border-radius:15px;padding:13px;margin:10px 0}
small{display:block;color:var(--sub);margin:5px 0}
input,textarea{display:block;width:100%;background:#101d15;color:var(--text);border:1px solid #40644d;border-radius:9px;padding:10px;margin:8px 0;font:inherit}
textarea{min-height:65px}button{font:inherit;color:var(--text);background:#254632;border:1px solid #476b50;border-radius:9px;padding:8px 10px;margin:4px}
button.save{background:var(--accent);color:#07190e;font-weight:700;border:0}
nav{position:fixed;left:0;right:0;bottom:0;background:#13241a;border-top:1px solid var(--line);display:flex;justify-content:space-around;flex-wrap:wrap;padding:8px 2px max(8px,env(safe-area-inset-bottom))}
nav button{border:0;background:transparent;font-size:12px;padding:7px 2px}nav button[aria-current=true]{color:var(--accent)}
.hidden{display:none}.body{white-space:pre-wrap;overflow-wrap:anywhere}.actions{display:flex;flex-wrap:wrap}
</style></head><body><main><h1>Персональный помощник</h1>
<p>Рабочие задачи, Outlook, встречи и информация в одном месте.</p><div id="notice"></div>
<section id="home"></section><section id="tasks" class="hidden"></section><section id="progress" class="hidden"></section><section id="done" class="hidden"></section>
<section id="mail" class="hidden"></section><section id="news" class="hidden"></section><section id="review" class="hidden"></section>
<section id="calendar" class="hidden"></section>
<section id="memory" class="hidden"></section></main>
<nav><button data-tab="home" aria-current="true">Главная</button>
<button data-tab="tasks">Новые</button><button data-tab="progress">В работе</button><button data-tab="done">Готово</button><button data-tab="mail">Почта</button>
<button data-tab="news">Новости</button><button data-tab="review">Разбор</button><button data-tab="calendar">Календарь</button>
<button data-tab="memory">Память</button></nav>
<script>
(function(){
const tg=window.Telegram&&window.Telegram.WebApp,notice=document.getElementById('notice');
if(!tg||!tg.initData){notice.textContent='Открой эту панель из Telegram.';return;}
tg.ready();tg.expand();
const auth='tma '+tg.initData;
async function api(path,method,body){
 const r=await fetch('/app/api/'+path,{method:method||'GET',
  headers:{authorization:auth,'content-type':'application/json'},
  body:body?JSON.stringify(body):undefined});
 if(!r.ok)throw Error(r.status===401?'Снова открой панель из Telegram.':'Сервис временно недоступен.');
 return r.json();
}
function el(tag,text,cls){const x=document.createElement(tag);if(text!==undefined)x.textContent=text;if(cls)x.className=cls;return x;}
function card(title,body){const x=el('article');x.append(el('h2',title),el('div',body||'Пока пусто.','body'));return x;}
async function show(tab){
 for(const e of document.querySelectorAll('main section'))e.classList.toggle('hidden',e.id!==tab);
 for(const b of document.querySelectorAll('nav button'))b.setAttribute('aria-current',b.dataset.tab===tab);
 const box=document.getElementById(tab);box.replaceChildren(el('p','Загрузка...'));
 try{
  if(tab==='home'){const d=await api('brief');box.replaceChildren(card('Сегодня',d.text));}
  if(tab==='mail'){
   const d=await api('mail');box.replaceChildren(el('h2','Письма'));
   for(const item of d){const c=card(item.subject,item.summary);
    c.append(el('small',item.from_name+' · '+item.category));box.append(c);}
   if(!d.length)box.append(card('Почта','Нет новых писем.'));
  }
  if(tab==='news'||tab==='review'){
   const data=await api('news');box.replaceChildren(el('h2',tab==='review'?'На разбор':'Рабочие новости'));
   if(tab==='news'){
   for(const item of data.telegram){
    const c=card(item.summary,'Из Telegram · '+(item.chat_title||'Чат'));
    c.append(el('small','От: '+(item.sender_name||'Участник')));
    if(item.source_link&&item.source_link.startsWith('https://t.me/')){
     const a=el('button','💬 Открыть исходное');
     a.addEventListener('click',()=>tg.openTelegramLink(item.source_link));
     c.append(a);
    }box.append(c);
   }
   for(const item of data.mail){
    const c=card(item.subject,item.summary);
    c.append(el('small','📨 Рабочая почта · '+item.from_name));box.append(c);
   }
   if(!data.telegram.length&&!data.mail.length)
    box.append(card('Новостей нет','Здесь появятся рабочие сообщения и рассылки.'));
   }
   if(tab==='review'){
    box.append(el('h2','⚠️ На разбор'));
   const decide=async(url,question)=>{
    if(!window.confirm(question))return;
    try{const response=await api(url,'POST');notice.textContent=response.text;
      await show('news');notice.textContent=response.text;}
    catch(error){notice.textContent=error.message;}
   };
   for(const item of data.telegram_review){
    const c=card(item.summary,'Из Telegram · '+(item.chat_title||'Чат'));
    c.append(el('small','От: '+(item.sender_name||'Участник')));
    const actions=el('div',undefined,'actions');
    for(const [action,label] of [
      ['task','✅ В задачи'],['news','📰 В новости'],['ignore','🗑 Не рабочее']
    ]){
     const b=el('button',label);
     b.addEventListener('click',()=>decide('telegram/'+encodeURIComponent(item.id)+'/'+action,
       'Подтвердить: '+label+'?'));actions.append(b);
    }c.append(actions);box.append(c);
   }
   for(const item of data.mail_review){
    const c=card(item.subject,item.summary);
    c.append(el('small','📨 Письмо · нужен разбор происхождения'));
    const actions=el('div',undefined,'actions');
    for(const [action,label] of [
      ['task','✅ В задачи'],['news','📰 В новости'],['ignore','🗑 Не рабочее']
    ]){
     const b=el('button',label);
     b.addEventListener('click',()=>decide('mail/'+encodeURIComponent(item.email_id)+'/'+action,
       'Подтвердить: '+label+'?'));actions.append(b);
    }c.append(actions);box.append(c);
   }
   if(!data.telegram_review.length&&!data.mail_review.length)
    box.append(card('Всё разобрано','Неопределённых рабочих сообщений нет.'));
   }
  }
  if(tab==='calendar'){const d=await api('calendar');
   box.replaceChildren(...(d.work_only?[card('Рабочий Outlook',d.work)]:
     [card('Личный календарь',d.personal),card('Рабочий',d.work)]));}
  if(tab==='memory'){const d=await api('memory');
   box.replaceChildren(card('Подтверждённая память',
    d.map((v,i)=>(i+1)+'. '+v).join('\n')||'Скажи боту «Запомни ...».'));}
  if(['tasks','progress','done'].includes(tab)){
   const wanted={tasks:'NEW',progress:'IN_PROGRESS',done:'DONE'}[tab];
   const d=(await api('tasks')).filter(task=>task.status===wanted);
   box.replaceChildren(el('h2',{tasks:'Задачи (не в работе)',progress:'Задачи (в работе)',done:'Выполненные'}[tab]));
   if(tab==='tasks'){
    const form=el('form'),title=el('input'),description=el('textarea'),due=el('input');
    title.placeholder='Новая задача';title.required=true;title.maxLength=180;
    description.placeholder='Описание';description.maxLength=900;due.type='datetime-local';
    const save=el('button','➕ Добавить','save');save.type='submit';
    form.append(title,description,due,save);
    form.addEventListener('submit',async e=>{e.preventDefault();
     try{await api('tasks','POST',{title:title.value,description:description.value,
       due_iso:due.value?new Date(due.value).toISOString():'',
       due_text:due.value||''});await show('tasks');}
     catch(err){notice.textContent=err.message;}});
    box.append(form);
   }
   for(const task of d){
    const c=card(task.title,task.description);
    const origin=task.email_id?'📨 Из рабочей почты':
      task.task_id.startsWith('tgm:')?'💬 Из Telegram':'➕ Добавлена вручную';
    c.append(el('small',origin+' · '+(task.due_text||'Без срока')+' · Важность: '+task.priority));
    const actions=el('div',undefined,'actions');
    const action=async(name,body)=>{
     try{
      const result=await api('tasks/'+encodeURIComponent(task.task_id)+'/'+name,'POST',body);
      if(!result.changed){notice.textContent='Задача уже была изменена. Обнови список.';return;}
      await show(tab);
     }catch(error){notice.textContent=error.message;}
    };
    if(task.status==='NEW'){
     const importance=el('select');
     for(const label of ['Выбери важность','высокий','средний','низкий']){
      const option=el('option',label);option.value=label==='Выбери важность'?'':label;
      if(!option.value){option.disabled=true;option.selected=true;}
      importance.append(option);
     }
     const start=el('button','🟡 Взять в работу','save');
     start.addEventListener('click',()=>importance.value?
       action('progress',{priority:importance.value}):
       (notice.textContent='Выбери важность задачи.'));
     actions.append(importance,start);
    }
    if(task.status==='IN_PROGRESS'){
     const importance=el('select');
     for(const label of ['высокий','средний','низкий']){
      const option=el('option',label);option.value=label;
      option.selected=label===task.priority;importance.append(option);
     }
     const save=el('button','Сохранить важность');
     save.addEventListener('click',()=>action('priority',{priority:importance.value}));
     const finish=el('button','✅ Выполнено','save');
     finish.addEventListener('click',()=>{
      if(window.confirm('Завершить задачу «'+task.title+'»?'))action('done');
     });
     actions.append(importance,save,finish);
    }
    const remove=el('button','🗑 Удалить');
    remove.addEventListener('click',()=>{
     if(window.confirm('Удалить задачу «'+task.title+'»?'))action('delete');
    });
    actions.append(remove);c.append(actions);box.append(c);
   }
   if(!d.length)box.append(card('Пока пусто','Задач в этом разделе нет.'));
  }
  notice.textContent='';
 }catch(err){notice.textContent=err.message||'Ошибка загрузки';}
}
for(const b of document.querySelectorAll('nav button'))
 b.addEventListener('click',()=>show(b.dataset.tab));
show('home');
})();
</script></body></html>`;
export async function miniApp(request,env){
  const path=new URL(request.url).pathname;
  if(request.method==='GET'&&path==='/app')return new Response(html,{
    headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
      'x-content-type-options':'nosniff','content-security-policy':
      "default-src 'none'; script-src 'unsafe-inline' https://telegram.org; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org"}
  });
  if(!path.startsWith('/app/api/'))return json({error:'not_found'},404);
  if(!await authorized(request,env))return json({error:'owner_auth_required'},401);
  const section=path.slice('/app/api/'.length);
  if(request.method==='GET'&&section==='tasks'){
    const rows=await env.DB.prepare(
      "SELECT task_id,title,description,status,priority,due_iso,due_text "+
      "FROM tasks WHERE status!='DELETED' "+
      "ORDER BY CASE WHEN status='DONE' THEN 1 ELSE 0 END,due_iso='' ASC,due_iso ASC,created_at DESC LIMIT 100"
    ).all();return json(rows.results||[]);
  }
  if(request.method==='GET'&&section==='mail'){
    const rows=await env.DB.prepare(
      "SELECT subject,summary,from_name,category FROM emails "+
      "WHERE "+(workOnly(env)?'status IN '+WORK_EMAIL_STATUSES:
        "status NOT IN ('ANALYZING','IGNORED_NONWORK')")+" "+
      "ORDER BY received_at DESC LIMIT 35"
    ).all();return json(rows.results||[]);
  }
  if(request.method==='GET'&&section==='news'){
    const [telegram,telegram_review,mail,mail_review]=await Promise.all([
      latestTelegramMentions(env,30,'NEWS'),
      latestTelegramMentions(env,30,'REVIEW'),
      env.DB.prepare(
        "SELECT email_id,subject,summary,from_name,received_at FROM emails "+
        "WHERE status IN ('NEW','WORK_OUTLOOK') AND "+
        "category IN ('НОВОСТЬ','FYI') AND action='Действий не требуется' "+
        "ORDER BY received_at DESC LIMIT 30"
      ).all(),
      env.DB.prepare(
        "SELECT email_id,subject,summary,received_at FROM emails "+
        "WHERE status='WORK_REVIEW' ORDER BY received_at DESC LIMIT 30"
      ).all()
    ]);
    return json({telegram,telegram_review,mail:mail.results||[],
      mail_review:mail_review.results||[]});
  }
  const parts=section.split('/');
  if(request.method==='POST'&&parts.length===3&&
    parts[0]==='telegram'&&['task','news','ignore'].includes(parts[2])){
    let id;try{id=decodeURIComponent(parts[1]);}catch{return json({error:'invalid_id'},400);}
    if(!/^-?\d{1,20}:\d{1,16}$/.test(id))return json({error:'invalid_id'},400);
    const result=await reviewTelegramMention(env,'mention:'+parts[2]+':'+id);
    return json({text:result.text});
  }
  if(request.method==='POST'&&parts.length===3&&parts[0]==='mail'&&
    ['task','news','ignore'].includes(parts[2])){
    let id;try{id=decodeURIComponent(parts[1]);}catch{return json({error:'invalid_id'},400);}
    if(!/^[A-Za-z0-9_-]{4,160}$/.test(id))return json({error:'invalid_id'},400);
    const result=parts[2]==='task'?
      await createTaskFromWorkEmail(env,id):
      await categorizeReviewedWorkEmail(env,id,parts[2]);
    return json({text:result.text});
  }
  if(request.method==='GET'&&section==='brief')return json(await dailyBriefPreview(env));
  if(request.method==='GET'&&section==='memory')
    return json(await personalMemory(env,env.TELEGRAM_CHAT_ID));
  if(request.method==='GET'&&section==='calendar'){
    const [personal,work]=await Promise.all([
      calendarAgenda(env,'today'),outlookAgenda(env,1)
    ]);return json({personal:personal.text,work:work.text,work_only:workOnly(env)});
  }
  if(request.method==='POST'&&section==='tasks'){
    const rawBody=await request.text();
    if(rawBody.length>5000)return json({error:'too_large'},413);
    let data;try{data=JSON.parse(rawBody);}catch{return json({error:'invalid_body'},400);}
    const title=cut(data.title,180),description=cut(data.description,900);
    const dueIso=cut(data.due_iso,40),dueText=cut(data.due_text,100);
    if(!title)return json({error:'title_required'},400);
    if(dueIso&&(!Number.isFinite(Date.parse(dueIso))||
      !/^\d{4}-\d\d-\d\dT/.test(dueIso)))
      return json({error:'invalid_due_time'},400);
    const id='app:'+crypto.randomUUID(),now=new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO tasks(task_id,email_id,title,description,status,priority,due_iso,due_text,created_at,updated_at) '+
      'VALUES(?,NULL,?,?,?,?,?,?,?,?)'
    ).bind(id,title,description,'NEW','средний',dueIso,dueText,now,now).run();
    return json({created:true,task_id:id},201);
  }
  const match=section.match(/^tasks\/([a-zA-Z0-9_:-]{3,80})\/(done|progress|priority|delete)$/);
  if(request.method==='POST'&&match){
    const [,id,action]=match,instant=new Date().toISOString();
    if(action==='progress'||action==='priority'){
      const raw=await request.text();
      if(raw.length>200)return json({error:'too_large'},413);
      let data;try{data=JSON.parse(raw);}catch{return json({error:'invalid_body'},400);}
      if(!['высокий','средний','низкий'].includes(data?.priority))
        return json({error:'priority_required'},400);
      const result=await env.DB.prepare(
        action==='progress'?
          "UPDATE tasks SET status='IN_PROGRESS',priority=?,updated_at=? WHERE task_id=? AND status='NEW'":
          "UPDATE tasks SET priority=?,updated_at=? WHERE task_id=? AND status='IN_PROGRESS'"
      ).bind(data.priority,instant,id).run();
      return json({changed:result.meta.changes===1});
    }
    const sql=action==='delete'?
      "UPDATE tasks SET status='DELETED',updated_at=? WHERE task_id=? AND status!='DELETED'":
      "UPDATE tasks SET status='DONE',updated_at=? WHERE task_id=? AND status='IN_PROGRESS'";
    const result=await env.DB.prepare(sql).bind(instant,id).run();
    return json({changed:result.meta.changes===1});
  }
  return json({error:'not_found'},404);
}
