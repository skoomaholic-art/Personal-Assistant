import {backMarkup} from './router.js';

const key=(env,chatId)=>env.ASSISTANT_SCOPE==='work'?
  'assistant:work-memory:'+String(chatId):
  'assistant:memory:'+String(chatId);
const cut=(s,n)=>String(s??'').trim().slice(0,n);
const yes={inline_keyboard:[
  [{text:'✅ Запомнить',callback_data:'memory:yes'},{text:'❌ Не сохранять',callback_data:'memory:no'}],
  [{text:'☰ Меню',callback_data:'menu'}]
]};
export async function personalMemory(env,chatId){
  const record=await env.DB.prepare("SELECT data FROM states WHERE chat_id=? AND mode='MEMORY'")
    .bind(key(env,chatId)).first();
  try {
    const items=JSON.parse(record?.data||'[]');
    return Array.isArray(items)?items.filter(x=>typeof x==='string').slice(0,30):[];
  }catch{return [];}
}
export async function showMemory(env,chatId){
  const list=await personalMemory(env,chatId);
  return {text:'🧠 Сохранённые договорённости:\n\n'+
    (list.length?list.map((x,i)=>(i+1)+'. '+x).join('\n'):
      'Пока нет. Скажи «Запомни: ...», и я предложу сохранить это после подтверждения.'),
    reply_markup:backMarkup()};
}
export async function proposeMemory(env,chatId,information){
  const note=cut(information,500);
  if(!note)return {text:'Что именно запомнить? Напиши: «Запомни: ...».',
    reply_markup:backMarkup()};
  // Avoid accidental persistence of tokens; no extraction or background
  // auto-memory from personal conversations or third-party mail.
  if(/(?:sk-(?:proj|or)-|api[_ -]?key|парол[ья]|секретный ключ|bearer\s+)/i.test(note))
    return {text:'Ключи и пароли не сохраняю в памяти бота.',reply_markup:backMarkup()};
  await env.DB.prepare(
    "INSERT INTO states(chat_id,mode,data,updated_at) VALUES(?,'MEMORY_PENDING',?,?) "+
    "ON CONFLICT(chat_id) DO UPDATE SET mode='MEMORY_PENDING',data=excluded.data,updated_at=excluded.updated_at"
  ).bind(String(chatId),JSON.stringify({note,at:Date.now()}),Math.floor(Date.now()/1000)).run();
  return {text:'🧠 Запомнить на будущее?\n\n'+note+
    '\n\nСохраню только после подтверждения.',reply_markup:yes};
}
export async function memoryCallback(env,chatId,action){
  const rec=await env.DB.prepare('SELECT mode,data FROM states WHERE chat_id=?')
    .bind(String(chatId)).first();
  if(action==='memory:no'){
    if(rec?.mode==='MEMORY_PENDING')
      await env.DB.prepare('DELETE FROM states WHERE chat_id=?').bind(String(chatId)).run();
    return {text:'Не сохраняю.',reply_markup:backMarkup()};
  }
  if(action!=='memory:yes')return null;
  if(rec?.mode!=='MEMORY_PENDING')return {text:'Подтверждение устарело.',
    reply_markup:backMarkup()};
  let data;try{data=JSON.parse(rec.data);}catch{data={};}
  if(!data.note||Date.now()-Number(data.at)>30*60*1000)
    return {text:'Предложение устарело. Ничего не запомнил.',reply_markup:backMarkup()};
  const current=await personalMemory(env,chatId);
  const list=[...current.filter(x=>x!==data.note),data.note].slice(-30);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO states(chat_id,mode,data,updated_at) VALUES(?,'MEMORY',?,?) "+
      "ON CONFLICT(chat_id) DO UPDATE SET mode='MEMORY',data=excluded.data,updated_at=excluded.updated_at"
    ).bind(key(env,chatId),JSON.stringify(list),Math.floor(Date.now()/1000)),
    env.DB.prepare("DELETE FROM states WHERE chat_id=? AND mode='MEMORY_PENDING'")
      .bind(String(chatId))
  ]);
  return {text:'✅ Запомнил. Можешь посмотреть через «Что ты помнишь обо мне?»',
    reply_markup:backMarkup()};
}
export async function forgetMemory(env,chatId,position){
  const items=await personalMemory(env,chatId);
  const index=Number(position)-1;
  if(!Number.isSafeInteger(index)||index<0||index>=items.length)
    return {text:'Укажи номер записи из списка памяти.',
      reply_markup:backMarkup()};
  const removed=items.splice(index,1)[0];
  await env.DB.prepare(
    "UPDATE states SET data=?,updated_at=? WHERE chat_id=? AND mode='MEMORY'"
  ).bind(JSON.stringify(items),Math.floor(Date.now()/1000),key(env,chatId)).run();
  return {text:'Удалено из памяти: '+cut(removed,170),reply_markup:backMarkup()};
}
