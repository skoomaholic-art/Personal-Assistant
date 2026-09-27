import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {taskMenuAction,taskCallback,taskTalk,taskList,taskReport} from '../src/task-dialog.js';
import {menuMarkup,commandOf} from '../src/router.js';

class DB {
  constructor(){
    this.sqlite=new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8'));
  }
  prepare(sql){
    const stmt=this.sqlite.prepare(sql);
    const bound=args=>({
      first:async()=>stmt.get(...args)??null,
      all:async()=>({results:stmt.all(...args)}),
      run:async()=>{const r=stmt.run(...args);return {meta:{changes:Number(r.changes)}};}
    });
    return {...bound([]),bind:(...args)=>bound(args)};
  }
  async batch(statements){
    // D1 batch is transaction-scoped, including its SELECT statements.
    this.sqlite.exec('BEGIN IMMEDIATE');
    try{
      const result=[];
      for(const x of statements)result.push(x.first?await x.all():await x.run());
      this.sqlite.exec('COMMIT');
      return result;
    }catch(error){this.sqlite.exec('ROLLBACK');throw error;}
  }
  close(){this.sqlite.close();}
}
function mockIntent(data){
  return {
    intent:'chat',reply:'Я здесь.',title:'',description:'',due_text:'',due_iso:'',
    priority:'средний',target:'',needs_details:false,question:'',...data
  };
}
function setup() {
  const DBInstance=new DB();
  const env={DB:DBInstance,GROQ_API_KEY:'mock-key',GROQ_MODEL:'openai/gpt-oss-20b'};
  return {env,DB:DBInstance};
}
let originalFetch=global.fetch;
test.afterEach(()=>{global.fetch=originalFetch;});
function groq(data){
  const calls=[];
  global.fetch=async(url,request)=>{
    calls.push({url:String(url),request});
    assert.match(String(url),/^https:\/\/api\.groq\.com\/openai\/v1\/chat\/completions$/);
    const body=JSON.parse(request.body);
    assert.equal(body.response_format.type,'json_schema');
    return Response.json({choices:[{message:{content:JSON.stringify(mockIntent(data))}}]});
  };
  return calls;
}
test('menu uses balanced short rows and task-related actions',()=>{
  const rows=menuMarkup().inline_keyboard;
  assert.equal(rows.length,6);
  assert.ok(rows.every(r=>r.length===2));
  assert.deepEqual(new Set(rows.flat().map(x=>x.callback_data)).size,12);
  assert.ok(rows.flat().every(x=>Buffer.byteLength(x.callback_data)<64));
  for(const [text,action] of [
    ['/tasks','tasks'],['/report','report'],['/new','newtask'],
    ['мои задачи','tasks'],['проверить почту','mail']
  ])assert.equal(commandOf({message:{text}}),action);
});
test('owner gets proposal, confirms once, then sees task and report',async()=>{
  const {env,DB}=setup();
  try {
    groq({intent:'create_task',title:'Подготовить презентацию',description:'Для четверговой встречи',
      due_text:'в четверг к 15:00',due_iso:'2026-10-01T15:00:00+05:00',priority:'высокий'});
    assert.match((await taskMenuAction(env,'owner','newtask')).text,/Какую задачу/);
    const proposed=await taskTalk(env,'owner','В четверг к трём подготовить презентацию',10);
    assert.match(proposed.text,/Подготовить презентацию/);
    assert.ok(proposed.reply_markup.inline_keyboard.flat().some(x=>x.callback_data==='task:new:save'));
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM tasks').get().n,0);
    const confirmed=await taskCallback(env,'owner','task:new:save',11);
    assert.match(confirmed.text,/сохранена/);
    assert.equal(DB.sqlite.prepare('SELECT title FROM tasks').get().title,'Подготовить презентацию');
    const duplicate=await taskCallback(env,'owner','task:new:save',12);
    assert.match(duplicate.text,/Нет задачи/);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM tasks').get().n,1);
    assert.match((await taskList(env)).text,/Подготовить презентацию/);
    assert.match((await taskReport(env)).text,/Новые: 1/);
  } finally {DB.close();}
});
test('asking details does not create a task until missing detail and confirmation',async()=>{
  const {env,DB}=setup();
  try{
    const intents=[
      mockIntent({intent:'create_task',needs_details:true,question:'Что именно сделать?'}),
      mockIntent({intent:'create_task',title:'Купить лекарство',needs_details:false})
    ];
    global.fetch=async()=>Response.json({choices:[{message:{content:JSON.stringify(intents.shift())}}]});
    const a=await taskTalk(env,'owner','Добавь мне задачу',101);
    assert.match(a.text,/Что именно сделать/);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM tasks').get().n,0);
    const b=await taskTalk(env,'owner','Купить лекарство',102);
    assert.match(b.text,/Сохранить/);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM tasks').get().n,0);
    await taskCallback(env,'owner','task:new:cancel',103);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM tasks').get().n,0);
  }finally{DB.close();}
});
test('task deletion is a reversible soft-delete and requires explicit confirmation',async()=>{
  const {env,DB}=setup();
  try{
    DB.sqlite.prepare("INSERT INTO tasks(task_id,email_id,title,description,status,priority,due_iso,due_text,created_at,updated_at) VALUES('manual:1',NULL,'Сдать отчёт','','NEW','средний','','',?,?)")
      .run(new Date().toISOString(),new Date().toISOString());
    const a=await taskCallback(env,'owner','task:delete:ask:manual:1',1);
    assert.match(a.text,/Изменить задачу/);
    assert.equal(DB.sqlite.prepare("SELECT status FROM tasks WHERE task_id='manual:1'").get().status,'NEW');
    const cancelled=await taskCallback(env,'owner','task:action:no',2);
    assert.match(cancelled.text,/Отменено/);
    assert.equal(DB.sqlite.prepare("SELECT status FROM tasks WHERE task_id='manual:1'").get().status,'NEW');
    await taskCallback(env,'owner','task:delete:ask:manual:1',3);
    const saved=await taskCallback(env,'owner','task:action:yes',4);
    assert.match(saved.text,/удалена/);
    assert.equal(DB.sqlite.prepare("SELECT status FROM tasks WHERE task_id='manual:1'").get().status,'DELETED');
    assert.doesNotMatch((await taskList(env)).text,/Сдать отчёт/);
    assert.match((await taskReport(env)).text,/Всего без удалённых: 0/);
    assert.match((await taskCallback(env,'owner','task:action:yes',5)).text,/устарело/);
  }finally{DB.close();}
});
test('completed tasks can also be deleted, but only after a second click',async()=>{
  const {env,DB}=setup();
  try {
    const date=new Date().toISOString();
    DB.sqlite.prepare(
      "INSERT INTO tasks(task_id,email_id,title,description,status,priority,due_iso,due_text,created_at,updated_at) "+
      "VALUES('finished:1',NULL,'Завершённая задача','','DONE','средний','','',?,?)"
    ).run(date,date);
    const ask=await taskCallback(env,'owner','task:delete:ask:finished:1',1);
    assert.match(ask.text,/Статус после подтверждения/);
    assert.equal(DB.sqlite.prepare("SELECT status FROM tasks WHERE task_id='finished:1'").get().status,'DONE');
    await taskCallback(env,'owner','task:action:yes',2);
    assert.equal(DB.sqlite.prepare("SELECT status FROM tasks WHERE task_id='finished:1'").get().status,'DELETED');
  }finally{DB.close();}
});
test('natural-language completion asks first, changes only the matched task',async()=>{
  const {env,DB}=setup();
  try {
    const date=new Date().toISOString();
    for(const [id,title] of [['task:one','Подготовить баннер'],['task:two','Отправить письмо']]){
      DB.sqlite.prepare('INSERT INTO tasks(task_id,email_id,title,description,status,priority,due_iso,due_text,created_at,updated_at) VALUES(?,NULL,?,?,?,?,?,?,?,?)')
        .run(id,title,'','NEW','средний','','',date,date);
    }
    groq({intent:'task_done',target:'Подготовить баннер'});
    const proposed=await taskTalk(env,'owner','Баннер уже готов, закрой эту задачу',21);
    assert.match(proposed.text,/Подготовить баннер/);
    assert.equal(DB.sqlite.prepare("SELECT status FROM tasks WHERE task_id='task:one'").get().status,'NEW');
    await taskCallback(env,'owner','task:action:yes',22);
    assert.equal(DB.sqlite.prepare("SELECT status FROM tasks WHERE task_id='task:one'").get().status,'DONE');
    assert.equal(DB.sqlite.prepare("SELECT status FROM tasks WHERE task_id='task:two'").get().status,'NEW');
  }finally{DB.close();}
});
test('ambiguous natural-language deletion cannot select an arbitrary task',async()=>{
  const {env,DB}=setup();
  try{
    const date=new Date().toISOString();
    for(const [id,title] of [['one','Письмо Олегу'],['two','Письмо Вадиму']]){
      DB.sqlite.prepare('INSERT INTO tasks(task_id,email_id,title,description,status,priority,due_iso,due_text,created_at,updated_at) VALUES(?,NULL,?,?,?,?,?,?,?,?)')
        .run(id,title,'','NEW','средний','','',date,date);
    }
    groq({intent:'task_delete',target:'письмо'});
    const reply=await taskTalk(env,'owner','Удали задачу с письмом',31);
    assert.match(reply.text,/несколько задач/);
    assert.equal(DB.sqlite.prepare("SELECT COUNT(*) n FROM tasks WHERE status='DELETED'").get().n,0);
  }finally{DB.close();}
});
test('general chat is answered and stored without creating a task',async()=>{
  const {env,DB}=setup();
  try{
    groq({intent:'chat',reply:'Конечно, Александр. Что обсудим?'});
    const reply=await taskTalk(env,'owner','Привет, можем поговорить?',41);
    assert.match(reply.text,/Что обсудим/);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM tasks').get().n,0);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) n FROM history').get().n,2);
  }finally{DB.close();}
});
