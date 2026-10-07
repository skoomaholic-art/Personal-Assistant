// Durable reminder delivery adapted from legacy Storage.gs/runReminders.
// All delivery is opt-in, and no real message is sent in staging by default.
const MAX_REMINDERS_PER_TICK=6;
const MIN_REPEAT_SECONDS=12*60*60;
function dueMillis(value) {
  const ms=Date.parse(String(value||''));
  return Number.isFinite(ms)?ms:null;
}
export function dueReminderTasks(tasks, now=Date.now()) {
  return tasks.filter(t=>{
    if (String(t.status)==='DONE'||String(t.status)==='DELETED') return false;
    const due=dueMillis(t.due_iso);
    return due!==null && due<=now+2*60*60*1000;
  }).sort((a,b)=>dueMillis(a.due_iso)-dueMillis(b.due_iso))
    .slice(0,MAX_REMINDERS_PER_TICK);
}
export function reminderText(task,now=Date.now()) {
  const due=dueMillis(task.due_iso);
  const overdue=due!==null && due<now;
  return (overdue?'🚨 Срок прошёл. Как продвигается задача?':'⏰ Скоро дедлайн. Успеваешь?')+
    '\n\n'+String(task.title||'Без названия').slice(0,180)+
    '\n\nДедлайн: '+String(task.due_text||task.due_iso||'Не указан').slice(0,100);
}
async function sendReminder(env,task,now) {
  const chat=String(env.TELEGRAM_CHAT_ID);
  const id=String(task.task_id||'');
  const buttons=id.length<48
    ? {inline_keyboard:[
       [{text:'✅ Выполнено',callback_data:'task:done:'+id},
        {text:'🟡 В работе',callback_data:'task:progress:'+id}],
       [{text:'📅 Перенести',callback_data:'task:postpone:'+id},
        {text:'☰ Меню',callback_data:'menu'}]
      ]}
    : {inline_keyboard:[[{text:'☰ Меню',callback_data:'menu'}]]};
  const response=await fetch('https://api.telegram.org/bot'+env.TELEGRAM_BOT_TOKEN+'/sendMessage',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({chat_id:chat,text:reminderText(task,now),reply_markup:buttons}),
    signal:AbortSignal.timeout(10000)
  });
  if(!response.ok) throw new Error('Reminder Telegram HTTP '+response.status);
  const body=await response.json();
  if(!body.ok) throw new Error('Reminder Telegram rejected request');
}

export async function runReminders(env,now=Date.now()) {
  if(env.REMINDERS_ENABLED!=='true') return {disabled:true};
  if(!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !env.DB)
    throw new Error('Reminders not configured');
  // The query is bounded; due ISO variations are normalized in dueReminderTasks.
  const res=await env.DB.prepare(
    "SELECT task_id,title,description,status,due_iso,due_text FROM tasks WHERE status NOT IN ('DONE','DELETED') AND due_iso!='' ORDER BY due_iso ASC LIMIT 100"
  ).all();
  const tasks=dueReminderTasks(res.results||[],now);
  let sent=0,unknown=0,skipped=0;
  for (const task of tasks) {
    // Claim *before* contacting Telegram. Ambiguous network outcomes are
    // never automatically retried immediately; cooldown matches legacy policy.
    const claim=await env.DB.prepare(
      "INSERT INTO reminder_deliveries(task_id,attempted_at,status) VALUES(?,?,'unknown') "+
      "ON CONFLICT(task_id) DO UPDATE SET attempted_at=excluded.attempted_at,status='unknown' "+
      "WHERE reminder_deliveries.attempted_at <= ?"
    ).bind(task.task_id,Math.floor(now/1000),Math.floor(now/1000)-MIN_REPEAT_SECONDS).run();
    if(claim.meta.changes!==1){skipped++;continue;}
    try {
      await sendReminder(env,task,now);
      await env.DB.prepare("UPDATE reminder_deliveries SET status='sent' WHERE task_id=? AND attempted_at=?")
        .bind(task.task_id,Math.floor(now/1000)).run();
      sent++;
    } catch(err) {
      // Deliberately do not log recipients, task text, bot token, or response body.
      console.error(JSON.stringify({event:'reminder_delivery_unknown',error_type:err?.name||'Error'}));
      unknown++;
    }
  }
  return {considered:tasks.length,sent,unknown,skipped};
}
