import {backMarkup,safeText} from './router.js';
const cut=(x,n)=>String(x??'').trim().slice(0,n);
const contactPrefix='tg:contact:';
const invitePrefix='tg:invite:';
const owner=(env)=>String(env.TELEGRAM_CHAT_ID||'');
const at=()=>Math.floor(Date.now()/1000);
const textOut=(text,reply_markup)=>({text:safeText(text),reply_markup:reply_markup||backMarkup()});
const selection={inline_keyboard:[
  [{text:'✅ Отправить сообщение',callback_data:'relay:send'},
   {text:'✏️ Изменить',callback_data:'relay:edit'}],
  [{text:'❌ Отменить',callback_data:'relay:cancel'},{text:'☰ Меню',callback_data:'menu'}]
]};
const nameKey=name=>cut(name,120).toLowerCase().replace(/ё/g,'е')
  .replace(/[^\p{L}\p{N}]+/gu,' ').trim();
async function botUsername(env){
  if(env.TELEGRAM_BOT_USERNAME)return cut(env.TELEGRAM_BOT_USERNAME,40).replace(/^@/,'');
  if(!env.TELEGRAM_BOT_TOKEN)return '';
  const response=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/getMe',{
    method:'POST',signal:AbortSignal.timeout(10000)
  });
  if(!response.ok)return '';
  const data=await response.json();
  return data?.ok?cut(data.result?.username,40):'';
}
async function state(env,chatId){
  return env.DB.prepare('SELECT mode,data FROM states WHERE chat_id=?')
    .bind(String(chatId)).first();
}
async function put(env,chatId,mode,data){
  await env.DB.prepare(
    'INSERT INTO states(chat_id,mode,data,updated_at) VALUES(?,?,?,?) '+
    'ON CONFLICT(chat_id) DO UPDATE SET mode=excluded.mode,data=excluded.data,updated_at=excluded.updated_at'
  ).bind(String(chatId),mode,JSON.stringify(data),at()).run();
}
const parse=row=>{try{return JSON.parse(row?.data||'{}');}catch{return {};}};
export async function listRelayContacts(env){
  const rows=await env.DB.prepare(
    "SELECT data FROM states WHERE chat_id LIKE 'tg:contact:%' AND mode='CONTACT' LIMIT 80"
  ).all();
  const contacts=(rows.results||[]).map(x=>parse(x))
    .filter(x=>x.chat_id&&x.name);
  if(!contacts.length)return textOut(
    '👥 Пока никто не подключился к боту для сообщений. Чтобы написать человеку от имени помощника, сначала нужно его согласие: человек должен открыть бота по личной ссылке.'
  );
  return textOut('👥 Подключённые получатели:\n'+contacts
    .map(x=>'• '+cut(x.name,100)).join('\n')+
    '\n\nСкажи: «Напиши [имя] ...»');
}
export async function inviteRelayContact(env,chatId,name){
  if(String(chatId)!==owner(env))return textOut('Нет доступа.');
  const alias=cut(name,100);
  if(!alias)return textOut('Кого пригласить? Укажи имя для списка контактов.');
  const user=await botUsername(env);
  if(!user)return textOut('Ещё не подключён существующий Telegram-бот. Приглашение пока не создать.');
  const token=crypto.randomUUID().replace(/-/g,'');
  await put(env,invitePrefix+token,'INVITE',{
    name:alias,created_at:at(),expires_at:at()+7*86400
  });
  return textOut('Чтобы я мог писать «'+alias+'» от своего имени, этому человеку нужно добровольно открыть бот:\n\n'+
    'https://t.me/'+user+'?start=p'+token+
    '\n\nОтправь человеку эту ссылку. После подключения смогу подготовить сообщение и отправить только после твоего подтверждения.');
}
export async function handleRelayJoin(env,update){
  const chat=update?.message?.chat;
  const id=String(chat?.id||'');
  if(!id||id===owner(env)||chat?.type!=='private')return false;
  const input=cut(update?.message?.text,250);
  if(input==='/stop'||input==='/unsubscribe'){
    await env.DB.prepare('DELETE FROM states WHERE chat_id=?')
      .bind(contactPrefix+id).run();
    return {handled:true,chat_id:id,
      text:'Вы отключили сообщения от персонального помощника. Чтобы подключиться снова, потребуется новое приглашение.'};
  }
  const match=input.match(/^\/start(?:@[a-zA-Z0-9_]+)?\s+p([a-f0-9]{32})$/i);
  if(!match)return {handled:true,chat_id:id,text:'Этот бот представляет персонального помощника Александра. Для получения сообщений требуется приглашение. Команда /stop отключает связь.'};
  const already=await state(env,contactPrefix+id);
  if(already?.mode==='CONTACT')
    return {handled:true,chat_id:id,text:'Вы уже подключены. Команда /stop отключает сообщения.'};
  const invite=await state(env,invitePrefix+match[1]);
  const data=parse(invite);
  if(invite?.mode!=='INVITE'||!data.expires_at||data.expires_at<at())
    return {handled:true,chat_id:id,text:'Ссылка устарела. Попросите новое приглашение.'};
  const claimed=await env.DB.prepare(
    "UPDATE states SET mode='CLAIMED',updated_at=? WHERE chat_id=? AND mode='INVITE'"
  ).bind(at(),invitePrefix+match[1]).run();
  if(claimed.meta.changes!==1)
    return {handled:true,chat_id:id,text:'Приглашение уже использовано. Попросите новую ссылку.'};
  await put(env,contactPrefix+id,'CONTACT',{
    chat_id:id,name:cut(data.name,100),
    display_name:cut([update.message?.from?.first_name,update.message?.from?.last_name]
      .filter(Boolean).join(' '),100),
    registered_at:at()
  });
  return {handled:true,chat_id:id,text:
    'Вы подключились к персональному помощнику Александра. Он сможет передавать вам сообщения от своего имени по подтверждённой просьбе Александра. Чтобы отключиться, отправьте /stop.'};
}
async function matchingContacts(env,name){
  const res=await env.DB.prepare(
    "SELECT data FROM states WHERE chat_id LIKE 'tg:contact:%' AND mode='CONTACT' LIMIT 80"
  ).all();
  const key=nameKey(name);
  return (res.results||[]).map(r=>parse(r))
    .filter(x=>key&&nameKey(x.name)===key);
}
export async function proposeRelay(env,chatId,{recipient,message}){
  const to=cut(recipient,100),body=cut(message,2200);
  if(!to||!body)return textOut(
    'Уточни имя получателя и текст сообщения. Например: «Напиши Олегу, что нужны материалы к пятнице».'
  );
  const matches=await matchingContacts(env,to);
  if(matches.length!==1)return textOut(
    matches.length>1?'Несколько контактов с таким именем. Уточни адресата.':
    'Контакт «'+to+'» ещё не подключён. Сначала пригласи его командой: «Пригласи '+to+'».'
  );
  const draft={recipient_name:matches[0].name,recipient_chat_id:matches[0].chat_id,
    body,created_at:at()};
  await put(env,chatId,'RELAY_DRAFT',draft);
  return textOut('💬 Сообщение от имени помощника (ещё НЕ отправлено)\n\n'+
    'Получатель: '+draft.recipient_name+'\n\n'+
    'Здравствуйте! Я персональный помощник Александра. По его просьбе передаю сообщение:\n\n'+
    draft.body+'\n\nОтправить?',selection);
}
export async function relayCallback(env,chatId,action){
  const row=await state(env,chatId);
  if(action==='relay:cancel'){
    if(['RELAY_DRAFT','RELAY_EDIT'].includes(row?.mode)){
      await env.DB.prepare('DELETE FROM states WHERE chat_id=?').bind(String(chatId)).run();
      return textOut('Сообщение отменено. Никому ничего не отправлено.');
    }
    return textOut('Нет ожидающего сообщения.');
  }
  if(action==='relay:edit'){
    if(row?.mode!=='RELAY_DRAFT')return textOut('Нет черновика для изменения.');
    await env.DB.prepare(
      "UPDATE states SET mode='RELAY_EDIT' WHERE chat_id=? AND mode='RELAY_DRAFT'"
    ).bind(String(chatId)).run();
    return textOut('Пришли новый текст сообщения. После этого ещё раз покажу черновик.');
  }
  if(action==='relay:send')return confirmRelay(env,chatId);
  return null;
}
export async function relayFollowup(env,chatId,text){
  const row=await state(env,chatId);
  if(!['RELAY_DRAFT','RELAY_EDIT'].includes(row?.mode))return null;
  const input=cut(text,2400);
  if(/^(отмена|нет|не отправляй|отмени)$/i.test(input))
    return relayCallback(env,chatId,'relay:cancel');
  if(/^(да, отправь|отправь|подтверждаю отправку)$/i.test(input))
    return confirmRelay(env,chatId);
  if(row.mode==='RELAY_EDIT'){
    const d=parse(row);
    return proposeRelay(env,chatId,{recipient:d.recipient_name,message:input});
  }
  return textOut('Сообщение ждёт подтверждения. Нажми «Отправить» или «Изменить».',selection);
}
export async function confirmRelay(env,chatId){
  if(env.TELEGRAM_RELAY_ENABLED!=='true'||!env.TELEGRAM_BOT_TOKEN)
    return textOut('Передача сообщений пока не включена. Никому ничего не отправлено.');
  const row=await state(env,chatId);
  if(row?.mode!=='RELAY_DRAFT')return textOut('Подтверждение устарело. Сообщение не отправлено.');
  const d=parse(row);
  if(!d.recipient_chat_id||!d.body||at()-Number(d.created_at)>1800)
    return textOut('Черновик устарел. Сообщение не отправлено.');
  const contact=await state(env,contactPrefix+d.recipient_chat_id);
  if(contact?.mode!=='CONTACT')return textOut('Получатель отключился. Сообщение не отправлено.');
  const claimed=await env.DB.prepare(
    "UPDATE states SET mode='RELAY_SENDING',updated_at=? WHERE chat_id=? AND mode='RELAY_DRAFT'"
  ).bind(at(),String(chatId)).run();
  if(claimed.meta.changes!==1)return textOut('Сообщение уже обрабатывается.');
  try{
    const response=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+
      '/sendMessage',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({chat_id:d.recipient_chat_id,
        text:'Здравствуйте! Я персональный помощник Александра. По его просьбе передаю сообщение:\n\n'+d.body}),
      signal:AbortSignal.timeout(10000)
    });
    if(!response.ok)throw Error('Telegram send HTTP '+response.status);
    const sent=await response.json();
    if(!sent.ok)throw Error('Telegram send was rejected');
    await put(env,chatId,'RELAY_SENT',{
      recipient:d.recipient_name,chat_id:d.recipient_chat_id,message_id:sent.result?.message_id||0,
      sent_at:at()
    });
    return textOut('✅ Сообщение отправлено «'+d.recipient_name+'» от имени помощника.');
  }catch(err){
    console.error(JSON.stringify({event:'telegram_relay_unknown',type:err?.name||'Error'}));
    await env.DB.prepare(
      "UPDATE states SET mode='RELAY_UNKNOWN',updated_at=? "+
      "WHERE chat_id=? AND mode='RELAY_SENDING'"
    ).bind(at(),String(chatId)).run();
    return textOut('Не могу подтвердить доставку. Сообщение могло уйти, поэтому автоматически не повторяю.');
  }
}
