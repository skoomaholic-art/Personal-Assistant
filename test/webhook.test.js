import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

class FakeDB {
 constructor(){this.ids=new Map();this.sent=[];this.states=[];this.history=[];this.tasks=[];}
 prepare(sql){return {bind:(...args)=>({
  run:async()=>this.run(sql,args),first:async()=>this.first(sql,args),all:async()=>this.all(sql,args)
 })};}
 async batch(stmts){return Promise.all(stmts.map(s=>s.run()));}
 async run(sql,args){
  if(sql.startsWith('INSERT OR IGNORE INTO telegram_updates')){
   if(this.ids.has(args[0]))return {meta:{changes:0}};
   this.ids.set(args[0],{status:'queued',response_json:''});return {meta:{changes:1}};
  }
  if(sql.startsWith('DELETE FROM states')){this.states=[];return {meta:{changes:1}};}
  if(sql.startsWith('UPDATE telegram_updates SET status=')){
   if(sql.includes("status='done'"))this.ids.get(args[0]).status='done';
   if(sql.includes("status='processing'"))this.ids.get(args[1]).status='processing';
   if(sql.includes("status='queued'"))this.ids.get(args[0]).status='queued';
   return {meta:{changes:1}};
  }
  if(sql.startsWith('DELETE FROM telegram_updates')){this.ids.delete(args[0]);return {meta:{changes:1}};}
  if(sql.startsWith('DELETE FROM history')){this.history=[];return {meta:{changes:1}};}
  if(sql.startsWith('INSERT INTO states')){this.states.push(args);return {meta:{changes:1}};}
  if(sql.startsWith('INSERT OR IGNORE INTO emails')){return {meta:{changes:1}};}
  if(sql.startsWith('INSERT OR IGNORE INTO tasks')){return {meta:{changes:1}};}
  if(sql.startsWith('UPDATE emails')){return {meta:{changes:1}};}
  return {meta:{changes:1}};
 }
 async first(sql,args){if(sql.includes('FROM telegram_updates'))return this.ids.get(args[0]);if(sql.includes('FROM states'))return this.states.length?{mode:this.states.at(-1)[1]}:null;return null;}
 async all(sql,args){return {results:[]};}
}
function env(){const DB=new FakeDB();const sent=[];return {
 DB, TELEGRAM_BOT_TOKEN:'test-no-real-token',TELEGRAM_CHAT_ID:'123',TELEGRAM_WEBHOOK_SECRET:'secret',
 JOBS:{send:async x=>{sent.push(x)}},queued:sent
};}
function req(id,text,secret='secret',chat=123){return new Request('https://test.example/telegram/webhook',{
 method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify({update_id:id,message:{chat:{id:chat},text}})
});}
const nativeFetch=global.fetch;
let messages;
function installTelegramMock(){messages=[];global.fetch=async (url,init)=>{assert.ok(url.includes('test-no-real-token'));messages.push(JSON.parse(init.body));return Response.json({ok:true,result:{message_id:1}});};}
test.afterEach(()=>{global.fetch=nativeFetch;});
test('health reports staging, not production-ready',async()=>{
 const r=await worker.fetch(new Request('https://test.example/health'),env());assert.equal(r.status,200);
 assert.equal((await r.json()).phase,'staging');
});
test('unauthorized webhook is rejected without database access',async()=>{
 const e=env();const r=await worker.fetch(req(1,'/menu','bad'),e);
 assert.equal(r.status,401);assert.equal(e.DB.ids.size,0);
});
test('wrong Telegram chat cannot enqueue work',async()=>{
 const e=env();const r=await worker.fetch(req(1,'hello','secret',999),e);
 assert.equal(r.status,403);assert.equal(e.queued.length,0);
});
test('lightweight /menu bypasses queue and Groq',async()=>{
 installTelegramMock();const e=env();const r=await worker.fetch(req(1,'/menu'),e);
 assert.equal(r.status,200);assert.equal((await r.json()).fast,true);
 assert.equal(e.queued.length,0);assert.equal(messages.length,1);
 assert.equal(messages[0].text,'Что делаем?');
});
test('duplicate webhook update does not trigger second reply',async()=>{
 installTelegramMock();const e=env();await worker.fetch(req(3,'/menu'),e);const r=await worker.fetch(req(3,'/menu'),e);
 assert.equal((await r.json()).duplicate,true);assert.equal(messages.length,1);
});
test('text AI request is enqueued and acknowledged without Groq',async()=>{
 const e=env();const r=await worker.fetch(req(2,'Привет'),e);
 assert.equal(r.status,200);assert.equal(e.queued.length,1);
 assert.equal(e.queued[0].kind,'telegram');
});
test('queue enqueue failure responds 503 and releases claim',async()=>{
 const e=env();e.JOBS.send=async()=>{throw new Error('queue down')};
 const r=await worker.fetch(req(7,'Привет'),e);
 assert.equal(r.status,503);assert.equal(e.DB.ids.size,0);
});
test('ingestion is disabled until migration explicitly starts',async()=>{
 const e=env();const r=await worker.fetch(new Request('https://test.example/internal/ingest/email',{method:'POST',headers:{authorization:'Bearer x'},body:'{}'}),e);
 assert.equal(r.status,401);
});
test('no public endpoint sends email',async()=>{
 const e=env();for(const path of ['/gmail/send','/senddraft','/email/reply']){
  const r=await worker.fetch(new Request('https://test.example'+path,{method:'POST'}),e);
  assert.equal(r.status,404);
 }
});

test('feature health is read-only and reveals no secrets',async()=>{
 const e=env();e.GMAIL_POLL_ENABLED='false';e.REMINDERS_ENABLED='false';
 e.REPLY_PREVIEWS_ENABLED='false';e.WORKER_EMAIL_NOTIFICATIONS='false';
 const before=e.DB.ids.size;
 const r=await worker.fetch(new Request('https://test.example/health/features'),e);
 assert.equal(r.status,200);
 const data=await r.json();
 assert.equal(data.phase,'staging');
 assert.deepEqual(data.tables,[]);
 assert.deepEqual(data.flags,{gmail_poll:false,reminders:false,reply_previews:false,email_notifications:false});
 assert.equal(e.DB.ids.size,before);
 assert.equal(JSON.stringify(data).includes('TELEGRAM_BOT_TOKEN'),false);
});
