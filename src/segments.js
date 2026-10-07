// Sorting of mail and the tasks made from it into six segments. Three are
// work topics, one is other work mail, one is work news, one is non-work mail.
// Non-work mail is never analysed: only its sender and subject are kept.
export const SEGMENTS={
  SPORT:{label:'Спорт',icon:'⚽',work:true,topic:true},
  CONTENT:{label:'Контент',icon:'🎬',work:true,topic:true},
  PROMO:{label:'Промокоды',icon:'🎟',work:true,topic:true},
  WORK:{label:'Рабочие письма',icon:'💼',work:true},
  NEWS:{label:'Новости',icon:'📰',work:true},
  NONWORK:{label:'Не рабочее',icon:'📭',work:false}
};
export const SEGMENT_ORDER=Object.keys(SEGMENTS);
export const TOPICS=['SPORT','CONTENT','PROMO','OTHER'];
export const isSegment=value=>Object.hasOwn(SEGMENTS,String(value));
export const segmentTitle=key=>isSegment(key)?SEGMENTS[key].icon+' '+SEGMENTS[key].label:'';

// Deterministic topic guess, used when no model is allowed or it gives no topic.
// Promo codes are checked first: such mail often also mentions content or sport.
const PROMO=/(?:промо[\s-]?код|промокод|promo[\s-]?code|\bpromo\b|купон|ваучер|voucher|скидк|подписк|тариф|триал|trial|пробн\S* период|биллинг|billing)/iu;
const SPORT=/(?:спорт|матч|футбол|хокке|теннис|баскетбол|волейбол|бокс|единоборств|турнир|чемпионат|первенств|кубок|лига\b|лиги\b|плей[\s-]?офф|трансляц|\b(?:uefa|fifa|fide|nba|nhl|ufc|mma|apl|epl|khl|sport|match|league|fixture)\b|уефа|фифа|кхл|нба|нхл)/iu;
const CONTENT=/(?:контент|сериал|фильм|кино\b|мульт|премьер|релиз|витрин|баннер|постер|трейлер|каталог|эпизод|сезон|серия\b|серии\b|подборк|локализац|субтитр|озвуч|метаданн|\b(?:content|vod|hbo|series|movie|trailer|release)\b)/iu;
export function topicOf(text){
  const value=String(text??'').slice(0,6000);
  if(PROMO.test(value))return 'PROMO';
  if(SPORT.test(value))return 'SPORT';
  if(CONTENT.test(value))return 'CONTENT';
  return 'OTHER';
}
// workMail: corporate provenance was verified. classification/category come
// from the mail analysis; topic is the model's suggestion, if any.
export function segmentFor({workMail,classification='',category='',topic='',text=''}){
  if(!workMail)return 'NONWORK';
  if(classification==='NEWS'||category==='НОВОСТЬ')return 'NEWS';
  const chosen=['SPORT','CONTENT','PROMO'].includes(topic)?topic:topicOf(text);
  return chosen==='OTHER'?'WORK':chosen;
}
export async function setSegment(env,kind,itemId,segment){
  if(!itemId||!isSegment(segment)||!['email','task'].includes(kind))return false;
  await env.DB.prepare(
    'INSERT INTO item_segments(kind,item_id,segment,updated_at) VALUES(?,?,?,?) '+
    'ON CONFLICT(kind,item_id) DO UPDATE SET segment=excluded.segment,updated_at=excluded.updated_at'
  ).bind(kind,String(itemId).slice(0,180),segment,new Date().toISOString()).run();
  return true;
}
// A task keeps the topic of the first source that created it, never NEWS/NONWORK.
export async function setTaskSegmentOnce(env,taskId,segment){
  if(!taskId||!SEGMENTS[segment]?.work||segment==='NEWS')return false;
  const result=await env.DB.prepare(
    'INSERT OR IGNORE INTO item_segments(kind,item_id,segment,updated_at) VALUES(?,?,?,?)'
  ).bind('task',String(taskId).slice(0,180),segment,new Date().toISOString()).run();
  return result.meta.changes===1;
}

const clip=(value,max)=>{const text=String(value??'').replace(/\s+/g,' ').trim();return text.length>max?text.slice(0,max-1)+'…':text;};
const MENU=[{text:'☰ Меню',callback_data:'menu'}];
const mark={высокий:'🔴',средний:'🟡',низкий:'⚪'};

export async function segmentOverview(env,note=''){
  const [mail,tasks]=await Promise.all([
    env.DB.prepare("SELECT segment,COUNT(*) AS n FROM item_segments WHERE kind='email' GROUP BY segment").all(),
    env.DB.prepare(
      "SELECT s.segment,COUNT(*) AS n FROM item_segments s JOIN tasks t ON t.task_id=s.item_id "+
      "WHERE s.kind='task' AND t.status IN ('NEW','IN_PROGRESS') GROUP BY s.segment").all()
  ]);
  const letters=Object.fromEntries((mail.results||[]).map(row=>[row.segment,Number(row.n)]));
  const open=Object.fromEntries((tasks.results||[]).map(row=>[row.segment,Number(row.n)]));
  const lines=SEGMENT_ORDER.map(key=>segmentTitle(key)+': писем '+(letters[key]||0)+
    (SEGMENTS[key].topic||key==='WORK'?', открытых задач '+(open[key]||0):''));
  const buttons=[];
  for(let i=0;i<SEGMENT_ORDER.length;i+=2)
    buttons.push(SEGMENT_ORDER.slice(i,i+2).map(key=>({text:segmentTitle(key),callback_data:'seg:'+key})));
  buttons.push([{text:'🔄 Проверить почту',callback_data:'mail:refresh'},{text:'⚠️ На разбор',callback_data:'review'}],MENU);
  return {text:(note?note+'\n\n':'')+'📨 Почта по разделам\n\n'+lines.join('\n'),
    reply_markup:{inline_keyboard:buttons}};
}
export async function segmentView(env,key){
  if(!isSegment(key))return segmentOverview(env);
  const back=[{text:'📨 Разделы',callback_data:'mail'},...MENU];
  if(key==='NONWORK'){
    const rows=await env.DB.prepare(
      "SELECT e.from_name,e.from_email,e.subject FROM item_segments s JOIN emails e ON e.email_id=s.item_id "+
      "WHERE s.kind='email' AND s.segment='NONWORK' ORDER BY e.received_at DESC LIMIT 12").all();
    const list=(rows.results||[]).map((row,i)=>(i+1)+'. '+clip(row.from_name||row.from_email||'Без отправителя',45)+
      ' - '+clip(row.subject||'Без темы',90));
    return {text:segmentTitle(key)+'\n\nХраню только отправителя и тему; текст не читаю и не анализирую.\n\n'+
      (list.join('\n')||'Пока ничего нет.'),reply_markup:{inline_keyboard:[back]}};
  }
  const [tasks,mail]=await Promise.all([
    env.DB.prepare(
      "SELECT t.task_id,t.title,t.status,t.priority,t.due_text FROM item_segments s JOIN tasks t ON t.task_id=s.item_id "+
      "WHERE s.kind='task' AND s.segment=? AND t.status IN ('NEW','IN_PROGRESS') "+
      "ORDER BY CASE t.priority WHEN 'высокий' THEN 0 WHEN 'средний' THEN 1 ELSE 2 END,t.updated_at DESC LIMIT 6"
    ).bind(key).all(),
    env.DB.prepare(
      "SELECT e.email_id,e.from_name,e.subject,e.priority,e.status,"+
      "(SELECT COUNT(*) FROM tasks t WHERE t.email_id=e.email_id AND t.status!='DELETED') AS has_task "+
      "FROM item_segments s JOIN emails e ON e.email_id=s.item_id "+
      "WHERE s.kind='email' AND s.segment=? AND e.status IN ('NEW','WORK_REVIEW','WORK_OUTLOOK') "+
      "ORDER BY e.received_at DESC LIMIT 6"
    ).bind(key).all()
  ]);
  const lines=[segmentTitle(key)],buttons=[];
  if(key!=='NEWS'){
    lines.push('','Задачи:');
    if(!(tasks.results||[]).length)lines.push('Открытых задач нет.');
    (tasks.results||[]).forEach((task,i)=>{
      lines.push((mark[task.priority]||'🟡')+' '+(i+1)+'. '+clip(task.title,110)+
        (task.status==='IN_PROGRESS'?' (в работе)':'')+(task.due_text?' | '+clip(task.due_text,40):''));
      buttons.push([{text:'Задача '+(i+1)+': '+clip(task.title,30),callback_data:'task:view:'+task.task_id}]);
    });
  }
  lines.push('','Письма:');
  if(!(mail.results||[]).length)lines.push('Писем нет.');
  (mail.results||[]).forEach((row,i)=>{
    lines.push((mark[row.priority]||'🟡')+' '+(i+1)+'. '+clip(row.subject,100)+' - '+clip(row.from_name,40)+
      (Number(row.has_task)?' ✅ задача':'')+(row.status==='WORK_REVIEW'?' ⚠️ на разбор':''));
    buttons.push([{text:'Письмо '+(i+1)+': '+clip(row.subject,30),callback_data:'email:view:'+row.email_id}]);
  });
  buttons.push(back);
  return {text:lines.join('\n').slice(0,3900),reply_markup:{inline_keyboard:buttons}};
}
