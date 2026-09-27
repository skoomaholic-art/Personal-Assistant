import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../src/worker.js';

// Use the real SQLite schema, not a permissive fake SQL string parser.
// This emulates D1's prepared-statement methods and atomic batch execution.
class SqliteD1 {
  constructor() {
    this.sqlite=new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8'));
  }
  prepare(sql) {
    const statement=this.sqlite.prepare(sql);
    const bound=(args)=>({
      run:async()=>{
        const r=statement.run(...args);
        return {meta:{changes:Number(r.changes)}};
      },
      first:async()=>statement.get(...args)??null,
      all:async()=>({results:statement.all(...args)})
    });
    return {...bound([]),bind:(...args)=>bound(args)};
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results=[];
      for(const statement of statements) {
        // D1 batch is used here for both SELECT statements and writes.
        if(statement._kind==='select') results.push(await statement.all());
        else results.push(await statement.run());
      }
      this.sqlite.exec('COMMIT');
      return results;
    } catch(error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  close(){this.sqlite.close();}
}
// Detect SELECT statements for D1's batch method.
const original=SqliteD1.prototype.prepare;
SqliteD1.prototype.prepare=function(sql) {
  const p=original.call(this,sql);
  const kind=/^\s*SELECT\b/i.test(sql)?'select':'write';
  const bind=p.bind;
  p._kind=kind;
  p.bind=(...args)=>({...bind(...args),_kind:kind});
  return p;
};
function envelope(id,text) {
  return {update_id:id,message:{chat:{id:123},text}};
}
function request(update) {
  return new Request('https://test.example/telegram/webhook',{
    method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'test-webhook-secret'},
    body:JSON.stringify(update)
  });
}
function runtime() {
  const DB=new SqliteD1(),queued=[];
  const env={DB,JOBS:{send:async job=>queued.push(job)},
    TELEGRAM_BOT_TOKEN:'fake-bot-token',TELEGRAM_WEBHOOK_SECRET:'test-webhook-secret',
    TELEGRAM_CHAT_ID:'123',GROQ_API_KEY:'fake-groq-api'};
  return {env,DB,queued};
}
function makeMessage(job,ack,retry) {
  return {body:job,ack:()=>{ack.count++},retry:()=>{retry.count++}};
}
const nativeFetch=global.fetch;
test.afterEach(()=>{global.fetch=nativeFetch;});

test('Fast reply: uncertain Telegram delivery is never sent a second time',async()=>{
  const {env,DB}=runtime();let networkCalls=0;
  global.fetch=async url=>{
    assert.match(String(url),/api.telegram.org/);
    networkCalls++;
    throw Error('reply lost after possible Telegram acceptance');
  };
  try {
    const first=await worker.fetch(request(envelope(101,'/menu')),env);
    assert.equal(first.status,202);
    assert.equal(DB.sqlite.prepare('SELECT status FROM telegram_updates WHERE update_id=101').get().status,'delivery_unknown');
    const duplicate=await worker.fetch(request(envelope(101,'/menu')),env);
    assert.equal((await duplicate.json()).duplicate,true);
    assert.equal(networkCalls,1);
  } finally {DB.close();}
});
test('Queued reply: a network failure after send-attempt is ACKed, not retried',async()=>{
  const {env,DB,queued}=runtime(),ack={count:0},retry={count:0};
  const sent=[];
  global.fetch=async(url,options)=>{
    if(String(url).includes('api.groq.com')) return Response.json({
      choices:[{message:{content:'Здравствуйте!'}}]
    });
    if(String(url).includes('api.telegram.org')) {
      sent.push(options.body);
      throw Error('ambiguous Telegram network failure');
    }
    throw Error('Unexpected outbound endpoint');
  };
  try {
    const accept=await worker.fetch(request(envelope(102,'Привет')),env);
    assert.equal(accept.status,200);
    assert.equal(queued.length,1);
    const msg=makeMessage(queued[0],ack,retry);
    await worker.queue({messages:[msg]},env);
    await worker.queue({messages:[msg]},env);
    assert.equal(sent.length,1);
    assert.equal(ack.count,2);
    assert.equal(retry.count,0);
    assert.equal(DB.sqlite.prepare('SELECT status FROM telegram_updates WHERE update_id=102').get().status,'delivery_unknown');
    assert.equal(DB.sqlite.prepare("SELECT count(*) AS n FROM history").get().n,2);
  } finally {DB.close();}
});
test('Webhook queue failure retains work, duplicate re-enqueues it',async()=>{
  const {env,DB,queued}=runtime();
  let call=0;
  env.JOBS.send=async job=>{
    call++;
    if(call===1)throw Error('Queue unavailable');
    queued.push(job);
  };
  try {
    const first=await worker.fetch(request(envelope(103,'Запомни это')),env);
    assert.equal(first.status,503);
    assert.equal(DB.sqlite.prepare('SELECT status FROM telegram_updates WHERE update_id=103').get().status,'queued');
    const retry=await worker.fetch(request(envelope(103,'Запомни это')),env);
    assert.equal(retry.status,200);
    assert.equal((await retry.json()).requeued,true);
    assert.equal(queued.length,1);
  } finally {DB.close();}
});
test('Concurrent consumers cannot both send one Telegram update',async()=>{
  const {env,DB,queued}=runtime();
  let botCalls=0,groqCalls=0;
  global.fetch=async url=>{
    if(String(url).includes('groq.com')) {
      groqCalls++;
      return Response.json({choices:[{message:{content:'Один ответ'}}]});
    }
    if(String(url).includes('telegram.org')){
      botCalls++;
      return Response.json({ok:true,result:{message_id:1}});
    }
    throw Error('Unexpected network call');
  };
  try {
    await worker.fetch(request(envelope(104,'Как дела?')),env);
    const ack={count:0},retry={count:0};
    const msg=makeMessage(queued[0],ack,retry);
    await Promise.all([worker.queue({messages:[msg]},env),worker.queue({messages:[msg]},env)]);
    assert.equal(botCalls,1);
    assert.equal(groqCalls,1);
    assert.equal(DB.sqlite.prepare('SELECT status FROM telegram_updates WHERE update_id=104').get().status,'done');
  } finally {DB.close();}
});

test('Successful Telegram send followed by D1 outage is not sent twice',async()=>{
  const {env,DB,queued}=runtime();
  let sent=0;
  global.fetch=async url=>{
    if(String(url).includes('api.groq.com'))return Response.json({
      choices:[{message:{content:'Доставленный ответ'}}]
    });
    if(String(url).includes('api.telegram.org')) {
      sent++;
      return Response.json({ok:true,result:{message_id:77}});
    }
    throw Error('Unexpected outbound endpoint');
  };
  try {
    await worker.fetch(request(envelope(105,'Новое сообщение')),env);
    const originalPrepare=DB.prepare.bind(DB);
    DB.prepare=sql=>{
      const statement=originalPrepare(sql);
      if(!sql.includes("UPDATE telegram_updates SET status='done'"))return statement;
      const bind=statement.bind;
      statement.bind=(...args)=>{
        const bound=bind(...args);
        return {...bound,run:async()=>{throw Error('D1 connection lost after Telegram delivery');}};
      };
      return statement;
    };
    const ack={count:0},retry={count:0};
    const msg=makeMessage(queued[0],ack,retry);
    await worker.queue({messages:[msg]},env);
    await worker.queue({messages:[msg]},env);
    assert.equal(sent,1);
    assert.equal(ack.count,2);
    assert.equal(retry.count,0);
    assert.equal(DB.sqlite.prepare('SELECT status FROM telegram_updates WHERE update_id=105').get().status,'delivery_unknown');
  } finally {DB.close();}
});

test('voice -> transcription -> task preview -> owner confirmation -> D1 -> report',async()=>{
  const {env,DB,queued}=runtime();
  env.TASK_CONVERSATION_ENABLED='true';
  env.TASK_VOICE_ENABLED='true';
  const sent=[],called=[];
  global.fetch=async(url,options={})=>{
    const uri=String(url);
    called.push(uri);
    if(uri.endsWith('/getFile'))
      return Response.json({ok:true,result:{file_path:'voice/test123.oga',file_size:600}});
    if(uri.includes('api.telegram.org/file/bot'))
      return new Response(new Uint8Array([79,103,103,83,1,2,3,4]),{status:200});
    if(uri.includes('api.groq.com/openai/v1/audio/transcriptions'))
      return Response.json({text:'Создай задачу подготовить спортивную презентацию в четверг'});
    if(uri.includes('api.groq.com/openai/v1/chat/completions'))
      return Response.json({choices:[{message:{content:JSON.stringify({
        intent:'create_task',reply:'',title:'Подготовить спортивную презентацию',
        description:'',due_text:'в четверг',due_iso:'',priority:'средний',
        target:'',needs_details:false,question:''
      })}}]});
    if(uri.includes('api.telegram.org/bot')){
      const action=uri.split('/').at(-1);
      if(action==='sendMessage')sent.push(JSON.parse(options.body));
      return Response.json({ok:true,result:{message_id:1}});
    }
    throw Error('Unexpected URL '+uri);
  };
  async function deliver(update) {
    const accepted=await worker.fetch(request(update),env);
    assert.equal(accepted.status,200);
    const job=queued.shift();
    assert.ok(job);
    const ack={count:0},retry={count:0};
    await worker.queue({messages:[makeMessage(job,ack,retry)]},env);
    assert.equal(ack.count,1);
    assert.equal(retry.count,0);
  }
  try {
    await deliver({update_id:210,message:{chat:{id:123},
      voice:{file_id:'voice-file-12345678',duration:8,file_size:600}}});
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,0);
    assert.match(sent.at(-1).text,/🎙 Распознал/);
    assert.match(sent.at(-1).text,/Сохранить/);
    await deliver({update_id:211,callback_query:{id:'callback211',
      message:{chat:{id:123}},data:'task:new:save'}});
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,1);
    assert.equal(DB.sqlite.prepare('SELECT title FROM tasks').get().title,
      'Подготовить спортивную презентацию');
    await deliver({update_id:212,message:{chat:{id:123},text:'/report'}});
    assert.match(sent.at(-1).text,/Новые: 1/);
    assert.equal(called.filter(x=>x.includes('audio/transcriptions')).length,1);
    assert.equal(called.filter(x=>x.includes('chat/completions')).length,1);
  }finally{DB.close();}
});
