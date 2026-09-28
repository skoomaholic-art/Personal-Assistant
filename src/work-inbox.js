import {backMarkup,normalizePriority,taskMarkup} from './router.js';
import {storeSourceEvent} from './task-store.js';

const cut=(value,max)=>String(value??'').trim().slice(0,max);
const ID=/^[A-Za-z0-9_-]{4,160}$/;
const allowed="'NEW','WORK_REVIEW','WORK_OUTLOOK'";

// Shared by the Telegram dialogue and the Telegram Mini App. One email can
// have at most one task because tasks.email_id has a UNIQUE constraint.
export async function createTaskFromWorkEmail(env,id){
  if(!ID.test(String(id||'')))return {
    text:'Некорректное письмо.',reply_markup:backMarkup()};
  const email=await env.DB.prepare(
    "SELECT email_id,subject,summary,action,priority,deadline_text,deadline_iso,status,from_name "+
    "FROM emails WHERE email_id=? AND status IN ("+allowed+")"
  ).bind(id).first();
  if(!email)return {text:'Рабочее письмо недоступно.',reply_markup:backMarkup()};
  const existing=await env.DB.prepare(
    'SELECT task_id,title,status FROM tasks WHERE email_id=?'
  ).bind(id).first();
  if(existing)return {text:'Задача по этому письму уже есть:\n'+existing.title,
    reply_markup:taskMarkup(existing.task_id,existing.status)};
  const review=email.status==='WORK_REVIEW';
  const title=cut(review?'Проверить письмо: '+email.subject:
    email.action&&email.action!=='Действий не требуется'?
      email.action:email.subject,180);
  const description=cut('Источник: рабочее письмо.\nОт: '+
    (review?'Отправитель требует уточнения':email.from_name)+
    '\nТема: '+email.subject+'\n\n'+email.summary,900);
  const deadline=!review&&Number.isFinite(Date.parse(email.deadline_iso))?
    cut(email.deadline_iso,40):'';
  const stored=await storeSourceEvent(env,{
    sourceType:'gmail',sourceId:id,threadKey:'gmail-message:'+id,
    author:email.from_name,sourceTitle:'Рабочее письмо: '+email.subject,
    sourceLink:'https://mail.google.com/mail/u/0/#all/'+id,
    originalText:email.summary,classification:'TASK',title,description,
    priority:normalizePriority(email.priority),dueIso:deadline,
    dueText:review?'':cut(email.deadline_text,100),emailId:id,
    createdAt:new Date().toISOString()
  });
  const task=await env.DB.prepare(
    'SELECT task_id,title,status FROM tasks WHERE task_id=?'
  ).bind(stored.taskId).first();
  return task?{text:'✅ Задача сохранена:\n'+task.title,
    reply_markup:taskMarkup(task.task_id,task.status)}:
    {text:'Не удалось сохранить задачу. Повтори позже.',
      reply_markup:backMarkup()};
}
export async function categorizeReviewedWorkEmail(env,id,decision){
  if(!ID.test(String(id||''))||!['news','ignore'].includes(decision))
    return {text:'Некорректное действие.',reply_markup:backMarkup()};
  if(decision==='news'){
    const result=await env.DB.prepare(
      "UPDATE emails SET status='NEW',category='НОВОСТЬ',"+
      "action='Действий не требуется',priority='низкий' "+
      "WHERE email_id=? AND status='WORK_REVIEW'"
    ).bind(id).run();
    return {text:result.meta.changes===1?'📰 Письмо добавлено в рабочие новости.':
      'Письмо уже разобрано или недоступно.',reply_markup:backMarkup()};
  }
  // Keep only the opaque ID as a deduplication marker; do not display
  // untrusted or non-work personal text after the owner's decision.
  const result=await env.DB.prepare(
    "UPDATE emails SET status='IGNORED_NONWORK',from_name='',from_email='',"+
    "subject='',summary='',action='',category='МУСОР',deadline_text='',"+
    "deadline_iso='',notification_status='disabled' "+
    "WHERE email_id=? AND status='WORK_REVIEW' "+
    "AND NOT EXISTS(SELECT 1 FROM tasks WHERE email_id=?)"
  ).bind(id,id).run();
  return {text:result.meta.changes===1?
    '🗑 Исключено из рабочего списка. Сохранён только технический ID.':
    'Письмо уже обработано или по нему создана задача.',
    reply_markup:backMarkup()};
}
