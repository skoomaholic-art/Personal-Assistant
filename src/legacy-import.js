import {ownerAuthorized} from './google-oauth.js';
import {BRAND_HEAD,BRAND_LOGO} from './brand.js';

// Owner-only, non-destructive import of the existing Apps Script Tasks worksheet.
// No source rows are logged, sent to external AI, overwritten, or deleted.
const HEADERS={
  'content-type':'text/html; charset=utf-8',
  'cache-control':'private, no-store',
  'x-content-type-options':'nosniff',
  // same-origin keeps the Origin header on our own form posts; no-referrer would null it.
  'referrer-policy':'same-origin',
  'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'"
};
const CHALLENGE={'www-authenticate':'Basic realm="Rahal Mamut data import", charset="UTF-8"'};
const REQUIRED=['task_id','title','status','priority','email_id','description',
  'due_iso','due_text','created_at','updated_at'];
const STATUSES=new Set(['NEW','IN_PROGRESS','DONE','DELETED']);
const PRIORITIES=new Set(['высокий','средний','низкий']);
const LIMIT=2_000_000;
const MAX_ROWS=5000;
const title='Перенос задач из старого Рахал Мамута';
function page(body,status=200,challenge=false){
  return new Response('<!doctype html><html lang="ru"><meta charset="utf-8">'+
    '<meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<title>'+title+'</title>'+BRAND_HEAD+'<style>'+
    'body{background:#101a14;color:#e9f5ed;font:16px/1.55 system-ui;padding:24px;max-width:740px;margin:auto}'+
    'section{background:#1b2b20;border:1px solid #42634d;border-radius:16px;padding:20px}'+
    'label{display:block;margin:18px 0}input[type=file]{display:block;margin:8px 0;max-width:100%}'+
    'button{padding:12px 18px;background:#88df9c;color:#102016;border:0;border-radius:9px;font-weight:700}'+
    'a{color:#88df9c}</style><main>'+BRAND_LOGO+'<h1>'+title+'</h1><section>'+body+'</section></main></html>',
    {status,headers:{...HEADERS,...(challenge?CHALLENGE:{})}});
}
function invalid(message,status=422){
  return page('<p>'+message+'</p><p><a href="/admin/import/tasks">Вернуться</a></p>',status);
}
function parseCsv(text){
  const rows=[];let row=[],field='',quoted=false;
  text=text.replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(quoted){
      if(ch==='"'&&text[i+1]==='"'){field+='"';i++;}
      else if(ch==='"')quoted=false;
      else field+=ch;
    }else if(ch==='"'){
      if(field!=='')throw Error('Некорректные кавычки в CSV');
      quoted=true;
    }else if(ch===','){row.push(field);field='';}
    else if(ch==='\r'||ch==='\n'){
      row.push(field);
      if(row.some(value=>value.trim()))rows.push(row);
      row=[];field='';
      if(ch==='\r'&&text[i+1]==='\n')i++;
      if(rows.length>MAX_ROWS+1)throw Error('Слишком много строк в CSV');
    }else field+=ch;
  }
  if(quoted)throw Error('Незакрытая кавычка в CSV');
  row.push(field);
  if(row.some(value=>value.trim()))rows.push(row);
  return rows;
}
function normalized(text){
  const rows=parseCsv(text);
  if(rows.length<2)throw Error('CSV не содержит задач');
  const headers=rows.shift().map(value=>value.trim().toLowerCase());
  if(new Set(headers).size!==headers.length)throw Error('Повторяются заголовки столбцов');
  if(REQUIRED.some(name=>!headers.includes(name)))
    throw Error('Это не экспорт вкладки Tasks старого бота: отсутствуют нужные столбцы');
  const tasks=[],seen=new Set();
  for(let i=0;i<rows.length;i++){
    const values=rows[i];
    if(values.length!==headers.length)throw Error('Ошибка числа столбцов в строке '+(i+2));
    const row=Object.fromEntries(headers.map((key,k)=>[key,values[k]]));
    const id=String(row.task_id||'').trim();
    const status=String(row.status||'').trim().toUpperCase();
    const priority=String(row.priority||'').trim().toLowerCase();
    const emailId=String(row.email_id||'').trim();
    if(!/^[a-zA-Z0-9_:-]{3,80}$/.test(id)||!row.title?.trim()||
      !STATUSES.has(status)||!PRIORITIES.has(priority)||
      (emailId&&!/^[a-zA-Z0-9_-]{4,160}$/.test(emailId))||
      String(row.title).length>2000||String(row.description).length>30000){
      throw Error('Недопустимый ID, статус, важность или длина данных в строке '+(i+2));
    }
    if(seen.has(id))continue;
    seen.add(id);
    tasks.push({
      id,emailId:emailId||null,title:row.title,description:row.description,
      status,priority,dueIso:row.due_iso,dueText:row.due_text,
      createdAt:row.created_at||new Date().toISOString(),
      updatedAt:row.updated_at||row.created_at||new Date().toISOString()
    });
  }
  return tasks;
}
export async function importLegacyTasks(request,env){
  if(!ownerAuthorized(request,env))
    return page('<p>Требуется вход владельца.</p>',401,true);
  if(request.method==='GET')return page(
    '<p>Сначала скачай вкладку <b>Tasks</b> старой Google-таблицы «Mamut Rahal Data» как CSV. '+
    'Исходную таблицу этот импорт не изменяет.</p>'+
    '<p>Задачи импортируются в существующую Cloudflare D1 с сохранением ID, статуса, важности и сроков. '+
    'Повторная загрузка не создаёт дубли и не перезаписывает задачи, уже изменённые в D1.</p>'+
    '<form method="post" enctype="multipart/form-data" action="/admin/import/tasks">'+
    '<label>Файл Google Sheets CSV <input type="file" name="tasks_csv" accept=".csv,text/csv" required></label>'+
    '<label><input type="checkbox" name="work_data_confirm" value="yes" required> '+
    'Подтверждаю, что экспорт содержит только задачи, которые разрешено перенести в рабочего помощника.</label>'+
    '<button type="submit">Импортировать без удаления старых задач</button></form>'+
    '<p>Ограничение: до 2 МБ и 5000 строк. Данные не отправляются в Groq.</p>');
  if(request.method!=='POST')return invalid('Метод не поддерживается.',405);
  const url=new URL(request.url);
  if(request.headers.get('origin')!==url.origin||
    !String(request.headers.get('content-type')||'').toLowerCase().startsWith('multipart/form-data'))
    return invalid('Недопустимый источник загрузки. Открой форму непосредственно на сайте.',403);
  const length=Number(request.headers.get('content-length')||0);
  if(length>LIMIT+8192)return invalid('Файл превышает лимит.',413);
  let form;
  try{form=await request.formData();}
  catch{return invalid('Не удалось прочитать файл.');}
  if(form.get('work_data_confirm')!=='yes')return invalid('Требуется подтверждение рабочего содержимого.',403);
  const file=form.get('tasks_csv');
  if(!file||typeof file.text!=='function'||file.size>LIMIT)
    return invalid('Выбери CSV файл размером до 2 МБ.',413);
  let tasks;
  try{tasks=normalized(await file.text());}
  catch(error){
    const message=String(error.message||'Некорректный CSV');
    // The parser only emits fixed validation text plus the row number.
    return invalid(message);
  }
  if(!env.DB)return invalid('База временно недоступна.',503);
  let imported=0;
  try{
    for(let i=0;i<tasks.length;i+=80){
      const statements=tasks.slice(i,i+80).map(item=>env.DB.prepare(
        'INSERT OR IGNORE INTO tasks'+
        '(task_id,email_id,title,description,status,priority,due_iso,due_text,created_at,updated_at) '+
        'VALUES(?,?,?,?,?,?,?,?,?,?)'
      ).bind(item.id,item.emailId,item.title,item.description,item.status,item.priority,
        item.dueIso,item.dueText,item.createdAt,item.updatedAt));
      const result=await env.DB.batch(statements);
      imported+=result.reduce((count,one)=>count+Number(one.meta?.changes||0),0);
    }
  }catch{
    return invalid('Импорт прервался. Ранее сохранённые записи остаются в D1. '+
      'Повторная загрузка того же файла безопасна: существующие задачи не перезаписываются.',503);
  }
  // Record an owner-confirmed migration checkpoint without exposing source data.
  try{
    await env.DB.prepare(
      'INSERT INTO states(chat_id,mode,data,updated_at) VALUES(?,?,?,?) '+
      'ON CONFLICT(chat_id) DO UPDATE SET mode=excluded.mode,data=excluded.data,updated_at=excluded.updated_at'
    ).bind('system:legacy-task-import','IMPORTED',JSON.stringify({
      source_rows:tasks.length,imported_rows:imported,confirmed_work_only:true
    }),Math.floor(Date.now()/1000)).run();
  }catch{return invalid('Задачи перенесены, но отметку о завершении записать не удалось. '+
    'Повтори загрузку: уже импортированные задачи не будут перезаписаны.',503);}
  return page('<h2>Импорт завершён</h2><p>Строк задач в CSV: <b>'+
    tasks.length+'</b>. Новых задач в D1: <b>'+imported+
    '</b>. Уже существующие и повторяющиеся записи пропущены: <b>'+
    (tasks.length-imported)+'</b>.</p>'+
    '<p>Старые Google Sheets не изменены. Не удаляй экспорт до проверки новой версии.</p>'+
    '<p><a href="/admin/telegram/status">Проверить готовность Telegram</a></p>'+ 
    '<p><a href="/admin/import/tasks">Загрузить другой CSV</a></p>');
}
