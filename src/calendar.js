import {loadEncryptedGoogleRefreshToken} from './google-oauth.js';
import {backMarkup,safeText,localDayBounds} from './router.js';
import {outlookCreateEvent} from './outlook.js';

const origin='https://www.googleapis.com/calendar/v3';
const SHORT=(value,max)=>String(value??'').trim().slice(0,max);
const tz='Asia/Almaty';
const stateKey=chatId=>String(chatId);
const ready=env=>env.GOOGLE_CALENDAR_ENABLED==='true'&&Boolean(env.DB&&env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET);
async function calendarConnected(env){
  if(!ready(env))return false;
  const result=await env.DB.prepare(
    "SELECT provider FROM oauth_credentials WHERE provider='calendar'"
  ).first();
  return Boolean(result);
}
const promptKeyboard={inline_keyboard:[
  [{text:'✅ Добавить в Google Calendar',callback_data:'cal:confirm'},
   {text:'✏️ Изменить',callback_data:'cal:edit'}],
  [{text:'❌ Отмена',callback_data:'cal:cancel'},{text:'☰ Меню',callback_data:'menu'}]
]};

async function token(env){
  const refresh=await loadEncryptedGoogleRefreshToken(env,'calendar');
  const body=new URLSearchParams({
    client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,
    refresh_token:refresh,grant_type:'refresh_token'
  });
  const result=await fetch('https://oauth2.googleapis.com/token',{
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body,signal:AbortSignal.timeout(10000)
  });
  if(!result.ok)throw Error('Google Calendar OAuth unavailable');
  const data=await result.json();
  if(!data.access_token)throw Error('Google Calendar access token absent');
  return data.access_token;
}
async function api(env,path,{method='GET',body=null,params={}}={}){
  const url=new URL(origin+path);
  for(const [key,value] of Object.entries(params))url.searchParams.set(key,String(value));
  const result=await fetch(url.toString(),{
    method,headers:{authorization:'Bearer '+await token(env),accept:'application/json',
      ...(body===null?{}:{'content-type':'application/json'})},
    body:body===null?undefined:JSON.stringify(body),
    signal:AbortSignal.timeout(12000)
  });
  if(!result.ok)throw Error('Google Calendar '+method+' HTTP '+result.status);
  return result.json();
}
export function calendarDraft(value){
  const d=value&&typeof value==='object'?value:{};
  const start=SHORT(d.start_iso,50),end=SHORT(d.end_iso,50);
  const valid=value=>/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d)$/.test(value)&&
    Number.isFinite(Date.parse(value));
  const startMs=valid(start)?Date.parse(start):NaN;
  let endMs=valid(end)?Date.parse(end):NaN;
  if(Number.isFinite(startMs)&&!Number.isFinite(endMs))endMs=startMs+60*60000;
  const endIso=Number.isFinite(endMs)?
    (valid(end)?end:new Date(endMs).toISOString()):'';
  return {
    title:SHORT(d.title,180),description:SHORT(d.description,900),
    start_iso:Number.isFinite(startMs)?start:'',
    end_iso:Number.isFinite(endMs)&&endMs>startMs?endIso:'',
    location:SHORT(d.location,180),
    calendar_target:d.calendar_target==='work'?'work':'personal'
  };
}
export function calendarPreview(input){
  const d=calendarDraft(input);
  const show=iso=>{
    try{return new Intl.DateTimeFormat('ru-RU',{
      timeZone:tz,dateStyle:'full',timeStyle:'short'
    }).format(new Date(iso));}catch{return iso;}
  };
  return {text:safeText(
    '📅 Предлагаю добавить в '+(d.calendar_target==='work'?'рабочий Outlook':'личный Google Calendar')+':\n\n'+
    'Событие: '+d.title+'\nНачало: '+show(d.start_iso)+'\nКонец: '+show(d.end_iso)+
    (d.location?'\nМесто: '+d.location:'')+
    (d.description?'\nОписание: '+d.description:'')+
    '\n\nДо нажатия «Добавить» ничего в календаре не изменится.'
  ),reply_markup:promptKeyboard};
}
async function saveState(env,chatId,mode,data){
  await env.DB.prepare(
    'INSERT INTO states(chat_id,mode,data,updated_at) VALUES(?,?,?,?) '+
    'ON CONFLICT(chat_id) DO UPDATE SET mode=excluded.mode,data=excluded.data,updated_at=excluded.updated_at'
  ).bind(stateKey(chatId),mode,JSON.stringify(data),Math.floor(Date.now()/1000)).run();
}
export async function proposeCalendar(env,chatId,input){
  const draft=calendarDraft(input);
  if(!draft.title||!draft.start_iso||!draft.end_iso)
    return {text:'Уточни название, дату и время начала встречи. Например: «Встреча с Олегом завтра в 15:00 на час».',
      reply_markup:backMarkup(),needs_clarification:true};
  await saveState(env,chatId,'CALENDAR_DRAFT',draft);
  return calendarPreview(draft);
}
export async function calendarFollowup(env,chatId,text,model){
  const state=await env.DB.prepare('SELECT mode,data FROM states WHERE chat_id=?')
    .bind(stateKey(chatId)).first();
  if(!state||!['CALENDAR_DRAFT','CALENDAR_EDIT'].includes(state.mode))return null;
  if(/^(нет|отмена|не надо|отмени)$/i.test(SHORT(text,60))){
    await env.DB.prepare('DELETE FROM states WHERE chat_id=?')
      .bind(stateKey(chatId)).run();
    return {text:'Отменено. Календарь не изменён.',reply_markup:backMarkup()};
  }
  if(/^(да|подтверждаю|добавь|сохрани|ок|окей)$/i.test(SHORT(text,60)))
    return confirmCalendar(env,chatId);
  if(model?.intent==='create_event'){
    let old={};try{old=JSON.parse(state.data||'{}');}catch{}
    return proposeCalendar(env,chatId,{
      ...old,...Object.fromEntries(
        ['title','description','start_iso','end_iso','location','calendar_target']
          .filter(key=>model[key]).map(key=>[key,model[key]])
      )
    });
  }
  return {text:'Уточни детали встречи или нажми «Добавить» / «Отмена».',
    reply_markup:promptKeyboard};
}
export async function calendarCallback(env,chatId,action){
  if(action==='cal:cancel'){
    const row=await env.DB.prepare('SELECT mode FROM states WHERE chat_id=?')
      .bind(stateKey(chatId)).first();
    if(row&&['CALENDAR_DRAFT','CALENDAR_EDIT'].includes(row.mode)){
      await env.DB.prepare('DELETE FROM states WHERE chat_id=?').bind(stateKey(chatId)).run();
      return {text:'Отменено. В календарь ничего не добавлено.',reply_markup:backMarkup()};
    }
    return {text:'Нет ожидающего события.',reply_markup:backMarkup()};
  }
  if(action==='cal:edit'){
    const row=await env.DB.prepare('SELECT mode FROM states WHERE chat_id=?')
      .bind(stateKey(chatId)).first();
    if(row?.mode!=='CALENDAR_DRAFT')
      return {text:'Нет события для редактирования.',reply_markup:backMarkup()};
    await env.DB.prepare("UPDATE states SET mode='CALENDAR_EDIT' WHERE chat_id=? AND mode='CALENDAR_DRAFT'")
      .bind(stateKey(chatId)).run();
    return {text:'Что изменить? Напиши дату, время или название.',reply_markup:backMarkup()};
  }
  if(action==='cal:confirm')return confirmCalendar(env,chatId);
  return null;
}
export async function confirmCalendar(env,chatId){
  const existing=await env.DB.prepare('SELECT mode,data FROM states WHERE chat_id=?')
    .bind(stateKey(chatId)).first();
  let target='personal';
  try {target=JSON.parse(existing?.data||'{}')?.calendar_target==='work'?'work':'personal';}catch{}
  if(target==='work'){
    if(env.OUTLOOK_CALENDAR_WRITE_ENABLED!=='true')
      return {text:'Рабочий Outlook Calendar пока не подключён с разрешения компании. Событие не создано.',reply_markup:backMarkup()};
  }else if(!await calendarConnected(env))
    return {text:'Google Calendar ещё не подключён. Событие не создано. Открой защищённую ссылку подключения календаря.',
      reply_markup:backMarkup()};
  const row=await env.DB.prepare('SELECT mode,data FROM states WHERE chat_id=?')
    .bind(stateKey(chatId)).first();
  if(row?.mode!=='CALENDAR_DRAFT'&&row?.mode!=='CALENDAR_EDIT')
    return {text:'Подтверждение устарело. Новых событий не создано.',reply_markup:backMarkup()};
  let d;try{d=calendarDraft(JSON.parse(row.data||'{}'));}catch{return {text:'Ошибка черновика.',reply_markup:backMarkup()};}
  if(!d.title||!d.start_iso||!d.end_iso)return {text:'В событии отсутствуют обязательные данные.',reply_markup:backMarkup()};
  const eventId='pa'+crypto.randomUUID().replace(/-/g,'');
  const claimed=await env.DB.prepare(
    "UPDATE states SET mode='CALENDAR_SENDING',data=?,updated_at=? "+
    "WHERE chat_id=? AND mode IN ('CALENDAR_DRAFT','CALENDAR_EDIT')"
  ).bind(JSON.stringify({...d,event_id:eventId}),Math.floor(Date.now()/1000),stateKey(chatId)).run();
  if(claimed.meta.changes!==1)
    return {text:'Событие уже обрабатывается. Не отправляй его повторно.',reply_markup:backMarkup()};
  try {
    // Setting the calendar event ID guards against duplicate creation if a
    // worker terminates and the operator later checks the outcome manually.
    const event=target==='work'?
      await outlookCreateEvent(env,d,eventId):
      await api(env,'/calendars/primary/events',{
        method:'POST',params:{sendUpdates:'none'},
        body:{
          id:eventId,summary:d.title,description:d.description,location:d.location,
          start:{dateTime:d.start_iso,timeZone:tz},
          end:{dateTime:d.end_iso,timeZone:tz}
        }
      });
    await saveState(env,chatId,'CALENDAR_CREATED',{
      event_id:eventId,summary:d.title,start:d.start_iso,google_event_id:event.id||eventId
    });
    return {text:'✅ Событие добавлено в '+(target==='work'?'рабочий':'личный')+' календарь:\n'+
      d.title+'\n'+new Intl.DateTimeFormat('ru-RU',{timeZone:tz,dateStyle:'medium',timeStyle:'short'})
        .format(new Date(d.start_iso)),reply_markup:backMarkup()};
  }catch(error){
    // A timeout is ambiguous: Google may have accepted the event. No retry.
    await env.DB.prepare(
      "UPDATE states SET mode='CALENDAR_UNKNOWN',updated_at=? "+
      "WHERE chat_id=? AND mode='CALENDAR_SENDING'"
    ).bind(Math.floor(Date.now()/1000),stateKey(chatId)).run();
    console.error(JSON.stringify({event:'calendar_delivery_unknown',kind:error?.name||'Error'}));
    return {text:'Не удалось подтвердить создание события. Проверь личный календарь перед повтором: запрос мог успеть выполниться.',
      reply_markup:backMarkup()};
  }
}
export async function calendarAgenda(env,period='today'){
  if(!await calendarConnected(env))return {text:'Личный календарь ещё не подключён. Подключение требует твоего согласия Google.',
    reply_markup:backMarkup()};
  const bounds=localDayBounds(new Date(),Number(env.TZ_OFFSET_MINUTES??300));
  const stop=period==='week'?
    new Date(bounds.end.getTime()+6*86400000):bounds.end;
  try{
    const result=await api(env,'/calendars/primary/events',{params:{
      timeMin:bounds.start.toISOString(),timeMax:stop.toISOString(),
      singleEvents:'true',orderBy:'startTime',maxResults:'40'
    }});
    const items=Array.isArray(result.items)?result.items:[];
    const resultText=items.slice(0,20).map(item=>{
      const start=item.start?.dateTime||item.start?.date||'';
      let when;
      try{when=start.length===10?start:
        new Intl.DateTimeFormat('ru-RU',{timeZone:tz,dateStyle:'short',timeStyle:'short'})
          .format(new Date(start));}catch{when=start;}
      return '• '+when+' | '+SHORT(item.summary||'Без названия',140);
    }).join('\n');
    return {text:safeText('📅 '+(period==='week'?'Ближайшая неделя':'Сегодня')+
      ' в личном календаре:\n\n'+(resultText||'Событий нет.')),reply_markup:backMarkup()};
  }catch{return {text:'Не удалось получить события Google Calendar. Повторим позже.',
    reply_markup:backMarkup()};}
}
