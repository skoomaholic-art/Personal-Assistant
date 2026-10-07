const clip=(value,max)=>String(value??'').trim().slice(0,max);
const nowIso=()=>new Date().toISOString();
const priorities=new Set(['высокий','средний','низкий']);
const priority=value=>priorities.has(value)?value:'средний';
const rank={низкий:1,средний:2,высокий:3};

export async function taskHistory(env,taskId,action,detail=''){
  if(!taskId)return;
  await env.DB.prepare(
    'INSERT INTO task_history(task_id,action,detail,created_at) VALUES(?,?,?,?)'
  ).bind(clip(taskId,160),clip(action,50),clip(detail,1000),nowIso()).run();
}

export async function findTaskForThread(env,threadKey){
  if(!threadKey)return null;
  return env.DB.prepare(
    "SELECT t.*,m.manual_priority,m.suggested_priority,m.source_author "+
    "FROM task_metadata m JOIN tasks t ON t.task_id=m.task_id "+
    "WHERE m.source_thread_key=? AND t.status!='DELETED' LIMIT 1"
  ).bind(clip(threadKey,220)).first();
}

async function relatedTask(env,id){
  if(!id)return null;
  return env.DB.prepare(
    "SELECT t.*,m.manual_priority,m.suggested_priority,m.source_author "+
    "FROM tasks t LEFT JOIN task_metadata m ON m.task_id=t.task_id "+
    "WHERE t.task_id=? AND t.status!='DELETED' LIMIT 1"
  ).bind(clip(id,160)).first();
}

function deterministicTaskId(sourceType,threadKey,sourceId){
  const raw=(threadKey||sourceId).replace(/[^A-Za-z0-9:_-]/g,'_').slice(0,105);
  return clip(sourceType,18)+':'+raw;
}

export async function storeSourceEvent(env,input){
  const sourceType=clip(input.sourceType,30);
  const sourceId=clip(input.sourceId,180);
  const eventId=clip(sourceType+':'+sourceId,220);
  const threadKey=clip(input.threadKey,220);
  const classification=['TASK','UPDATE','NEWS','INFO','NONE','REVIEW']
    .includes(input.classification)?input.classification:'REVIEW';
  const createdAt=clip(input.createdAt,40)||nowIso();
  const author=clip(input.author,180);
  const sourceTitle=clip(input.sourceTitle,300);
  const sourceLink=clip(input.sourceLink,500);
  const original=clip(input.originalText,6000);
  const suggested=priority(input.priority);
  const dueIso=Number.isFinite(Date.parse(String(input.dueIso||'')))?
    clip(input.dueIso,40):'';
  const dueText=dueIso?clip(input.dueText,100):'';
  let task=await relatedTask(env,input.relatedTaskId);
  if(!task)task=await findTaskForThread(env,threadKey);

  if(classification!=='TASK'&&classification!=='UPDATE'){
    const saved=await env.DB.prepare(
      'INSERT OR IGNORE INTO inbound_events(event_id,source_type,source_id,thread_key,author,source_title,body,source_link,classification,task_id,created_at) '+
      "VALUES(?,?,?,?,?,?,?,?,?,'',?)"
    ).bind(eventId,sourceType,sourceId,threadKey,author,sourceTitle,original,
      sourceLink,classification,createdAt).run();
    if(saved.meta.changes===0){
      await env.DB.prepare(
        "UPDATE inbound_events SET classification=? WHERE event_id=? AND classification='PENDING'"
      ).bind(classification,eventId).run();
    }
    return {classification,taskId:'',created:false,updated:false,
      duplicate:saved.meta.changes===0};
  }

  if(task){
    const inserted=await env.DB.prepare(
      'INSERT OR IGNORE INTO inbound_events(event_id,source_type,source_id,thread_key,author,source_title,body,source_link,classification,task_id,created_at) '+
      'VALUES(?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(eventId,sourceType,sourceId,threadKey,author,sourceTitle,original,
      sourceLink,'UPDATE',task.task_id,createdAt).run();
    if(inserted.meta.changes===0){
      const existing=await env.DB.prepare(
        'SELECT task_id,classification FROM inbound_events WHERE event_id=?'
      ).bind(eventId).first();
      if(['PENDING','REVIEW'].includes(existing?.classification)){
        await env.DB.prepare(
          "UPDATE inbound_events SET classification='UPDATE',task_id=? WHERE event_id=?"
        ).bind(task.task_id,eventId).run();
      }else return {classification:'UPDATE',taskId:existing?.task_id||task.task_id,
        created:false,updated:false,duplicate:true};
    }
    await env.DB.prepare(
      'INSERT OR IGNORE INTO task_updates(task_id,source_event_id,source_type,author,body,source_link,created_at) '+
      'VALUES(?,?,?,?,?,?,?)'
    ).bind(task.task_id,eventId,sourceType,author,
      clip(input.description||input.summary||original,4000),sourceLink,createdAt).run();
    await env.DB.prepare(
      'INSERT OR IGNORE INTO task_metadata(task_id,source_type,source_id,source_thread_key,source_author,source_title,source_link,original_text,suggested_priority,last_source_at) '+
      'VALUES(?,?,?,?,?,?,?,?,?,?)'
    ).bind(task.task_id,sourceType,sourceId,threadKey,author,sourceTitle,sourceLink,
      original,suggested,createdAt).run();
    await env.DB.prepare(
      "UPDATE OR IGNORE task_metadata SET source_thread_key=CASE WHEN source_thread_key='' THEN ? ELSE source_thread_key END,"+
      "source_author=CASE WHEN source_author='' THEN ? ELSE source_author END,"+
      "source_link=CASE WHEN source_link='' THEN ? ELSE source_link END,"+
      'suggested_priority=?,last_source_at=? WHERE task_id=?'
    ).bind(threadKey,author,sourceLink,suggested,createdAt,task.task_id).run();
    const manual=String(task.manual_priority||'');
    const nextPriority=manual?task.priority:
      (rank[suggested]>rank[priority(task.priority)]?suggested:priority(task.priority));
    const nextDescription=clip(input.description,1800);
    await env.DB.prepare(
      "UPDATE tasks SET status=CASE WHEN status='DONE' THEN 'NEW' ELSE status END,"+
      'description=CASE WHEN ?!=\'\' THEN ? ELSE description END,'+
      'priority=?,due_iso=CASE WHEN ?!=\'\' THEN ? ELSE due_iso END,'+
      'due_text=CASE WHEN ?!=\'\' THEN ? ELSE due_text END,updated_at=? WHERE task_id=?'
    ).bind(nextDescription,nextDescription,nextPriority,dueIso,dueIso,dueText,dueText,
      nowIso(),task.task_id).run();
    if(task.status==='DONE')await env.DB.prepare(
      "UPDATE task_metadata SET completed_at='' WHERE task_id=?"
    ).bind(task.task_id).run();
    await env.DB.prepare(
      'UPDATE task_metadata SET suggested_priority=?,last_source_at=? WHERE task_id=?'
    ).bind(suggested,createdAt,task.task_id).run();
    await taskHistory(env,task.task_id,'SOURCE_UPDATE',sourceType+': '+clip(input.summary||original,700));
    if(task.status==='DONE')await taskHistory(env,task.task_id,'STATUS','NEW_FROM_SOURCE_UPDATE');
    return {classification:'UPDATE',taskId:task.task_id,created:false,updated:true,
      duplicate:false,priority:nextPriority};
  }

  const taskId=deterministicTaskId(sourceType,threadKey,sourceId);
  const title=clip(input.title||input.summary||sourceTitle||'Новое поручение',180);
  const description=clip(input.description||input.summary||original,1800);
  const timestamp=nowIso();
  const batch=await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO tasks(task_id,email_id,title,description,status,priority,due_iso,due_text,created_at,updated_at) '+
      "VALUES(?,?,?,?, 'NEW',?,?,?,?,?)"
    ).bind(taskId,input.emailId?clip(input.emailId,160):null,title,description,
      suggested,dueIso,dueText,timestamp,timestamp),
    env.DB.prepare(
      'INSERT OR IGNORE INTO task_metadata(task_id,source_type,source_id,source_thread_key,source_author,source_title,source_link,original_text,suggested_priority,last_source_at) '+
      'VALUES(?,?,?,?,?,?,?,?,?,?)'
    ).bind(taskId,sourceType,sourceId,threadKey,author,sourceTitle,sourceLink,
      original,suggested,createdAt),
    env.DB.prepare(
      'INSERT OR IGNORE INTO inbound_events(event_id,source_type,source_id,thread_key,author,source_title,body,source_link,classification,task_id,created_at) '+
      "VALUES(?,?,?,?,?,?,?,?, 'TASK',?,?)"
    ).bind(eventId,sourceType,sourceId,threadKey,author,sourceTitle,original,
      sourceLink,taskId,createdAt),
    env.DB.prepare(
      'INSERT OR IGNORE INTO task_updates(task_id,source_event_id,source_type,author,body,source_link,created_at) '+
      'VALUES(?,?,?,?,?,?,?)'
    ).bind(taskId,eventId,sourceType,author,description,sourceLink,createdAt),
    env.DB.prepare(
      "INSERT INTO task_history(task_id,action,detail,created_at) SELECT ?,'CREATED',?,? "+
      'WHERE NOT EXISTS(SELECT 1 FROM task_history WHERE task_id=? AND action=\'CREATED\')'
    ).bind(taskId,sourceType+': '+author,timestamp,taskId)
  ]);
  const created=batch[0]?.meta?.changes===1;
  await env.DB.prepare(
    "UPDATE inbound_events SET classification='TASK',task_id=? WHERE event_id=? AND classification IN ('PENDING','REVIEW')"
  ).bind(taskId,eventId).run();
  const actual=await findTaskForThread(env,threadKey)||await relatedTask(env,taskId);
  return {classification:created?'TASK':'UPDATE',taskId:actual?.task_id||taskId,
    created,updated:!created,duplicate:false,priority:suggested};
}

export async function setManualPriority(env,taskId,value){
  const selected=priority(value),stamp=nowIso();
  const result=await env.DB.batch([
    env.DB.prepare(
      "UPDATE tasks SET priority=?,updated_at=? WHERE task_id=? AND status!='DELETED'"
    ).bind(selected,stamp,taskId),
    env.DB.prepare(
      'INSERT INTO task_metadata(task_id,manual_priority,suggested_priority,last_source_at) '+
      "VALUES(?,?,?,'') ON CONFLICT(task_id) DO UPDATE SET manual_priority=excluded.manual_priority"
    ).bind(taskId,selected,selected)
  ]);
  if(result[0]?.meta?.changes===1)await taskHistory(env,taskId,'PRIORITY',selected);
  return result[0]?.meta?.changes===1;
}

export async function claimNotification(env,key,kind,entityId){
  const result=await env.DB.prepare(
    "INSERT OR IGNORE INTO notification_events(dedupe_key,event_kind,entity_id,status,created_at) VALUES(?,?,?,'claimed',?)"
  ).bind(clip(key,220),clip(kind,50),clip(entityId,180),nowIso()).run();
  return result.meta.changes===1;
}

export async function finishNotification(env,key,status='sent'){
  await env.DB.prepare(
    'UPDATE notification_events SET status=?,delivered_at=? WHERE dedupe_key=?'
  ).bind(clip(status,30),nowIso(),clip(key,220)).run();
}
