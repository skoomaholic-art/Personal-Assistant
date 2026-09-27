import {calendarAgenda} from './calendar.js';
import {backMarkup,safeText} from './router.js';

const small=(x,n)=>String(x??'').trim().slice(0,n);
const seconds=()=>Math.floor(Date.now()/1000);
async function collect(env,now=Date.now()){
  const [tasks,messages]=await Promise.all([
    env.DB.prepare(
      "SELECT title,due_iso,due_text,status,priority FROM tasks "+
      "WHERE status NOT IN ('DONE','DELETED') "+
      "ORDER BY CASE WHEN due_iso='' THEN 1 ELSE 0 END,due_iso ASC,created_at DESC LIMIT 12"
    ).all(),
    env.DB.prepare(
      "SELECT subject,from_name,category,priority FROM emails "+
      "WHERE received_at>=? AND status NOT IN ('ANALYZING','IGNORED_NONWORK') "+
      "ORDER BY received_at DESC LIMIT 12"
    ).bind(new Date(now-24*3600000).toISOString()).all()
  ]);
  const taskLines=(tasks.results||[]).slice(0,8).map(x=>{
    const due=Date.parse(x.due_iso||'');
    const overdue=Number.isFinite(due)&&due<now;
    return (overdue?'⚠️ ':'• ')+small(x.title,110)+
      (x.due_text?' ('+small(x.due_text,70)+')':'');
  });
  const emails=(messages.results||[]).slice(0,8).map(e=>
    '• '+small(e.subject,105)+' | '+small(e.from_name,80)+
    ' ('+small(e.category,24)+')');
  return {
    taskCount:(tasks.results||[]).length,emailCount:(messages.results||[]).length,
    body:'☀️ Доброе утро! Краткая сводка.\n\n'+
      '📋 Активные задачи:\n'+(taskLines.join('\n')||'Пока нет.')+
      '\n\n📨 Новые письма за сутки:\n'+(emails.join('\n')||'Новых нет.')+
      '\n\nНапиши «Покажи задачи» или «Что важно?», чтобы разобрать подробнее.'
  };
}
export async function dailyBriefPreview(env){
  const data=await collect(env);
  let calendarText='';
  if(env.GOOGLE_CALENDAR_ENABLED==='true'){
    try{
      const agenda=await calendarAgenda(env,'today');
      calendarText='\n\n'+small(agenda.text,1100);
    }catch{/* Mail and tasks still work without calendar. */}
  }
  return {text:safeText(data.body+calendarText),reply_markup:backMarkup()};
}
export async function runDailyBrief(env,time=Date.now()){
  if(env.DAILY_BRIEF_ENABLED!=='true')return {disabled:true};
  if(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_CHAT_ID||!env.DB)
    throw Error('Owner notification delivery is not configured');
  const offset=Number(env.TZ_OFFSET_MINUTES??300);
  const localDate=new Date(time+offset*60000);
  const hour=localDate.getUTCHours();
  // Run only in the owner-requested 08:00-10:00 local morning window.
  if(hour<8||hour>=10)return {outside_window:true};
  const today=localDate.toISOString().slice(0,10);
  const name='system:brief:'+today;
  const claim=await env.DB.prepare(
    "INSERT OR IGNORE INTO states(chat_id,mode,data,updated_at) VALUES(?,'BRIEF_UNKNOWN','{}',?)"
  ).bind(name,seconds()).run();
  if(claim.meta.changes!==1)return {already_attempted:true};
  try{
    const preview=await dailyBriefPreview(env);
    const sent=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendMessage',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({chat_id:String(env.TELEGRAM_CHAT_ID),text:preview.text,
        disable_web_page_preview:true,reply_markup:preview.reply_markup}),
      signal:AbortSignal.timeout(10000)
    });
    if(!sent.ok)throw Error('Telegram brief HTTP '+sent.status);
    const result=await sent.json();
    if(!result.ok)throw Error('Telegram brief delivery rejected');
    await env.DB.prepare(
      "UPDATE states SET mode='BRIEF_SENT',updated_at=? "+
      "WHERE chat_id=? AND mode='BRIEF_UNKNOWN'"
    ).bind(seconds(),name).run();
    return {sent:true,date:today};
  }catch(error){
    console.error(JSON.stringify({event:'daily_brief_unknown',type:error?.name||'Error'}));
    // Do not blindly repeat a possibly-delivered daily message.
    return {unknown_delivery:true};
  }
}
