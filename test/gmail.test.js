import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {
  gmailAccessToken, gmailHeaders, isWorkGmailMessage, normalizeGmailMessage,
  analyzeGmailEmail, ingestGmailId, pollGmail
} from '../src/gmail.js';

const PASS_AUTH='mx.google.com; dkim=pass header.i=@work.example header.s=sel header.b=abc; '+
  'spf=pass (google.com: domain of worker@work.example designates 192.0.2.1 as permitted sender) '+
  'smtp.mailfrom=worker@work.example; dmarc=pass header.from=work.example';
function sampleMail({id='a1b2c3d4',from='Vendor <notice@vendor.example>',to='Alex <worker@work.example>',body='Please review by Friday',subject='Review',auth=''}={}) {
  return {id,threadId:'thread123',internalDate:'1770000000000',snippet:'short snippet',
    payload:{mimeType:'multipart/mixed',headers:[
      {name:'From',value:from},{name:'To',value:to},{name:'Subject',value:subject},
      ...(auth?[{name:'Authentication-Results',value:auth}]:[])],
      parts:[
        {mimeType:'text/plain',body:{data:Buffer.from(body,'utf8').toString('base64url')}},
        {mimeType:'application/pdf',filename:'specification.pdf',body:{attachmentId:'att1'}}]
    }
  };
}
// The only provenance the Worker accepts: the owner's own corporate address,
// authenticated by Gmail, forwarding a message whose original headers are kept.
function workForward(overrides={}) {
  return sampleMail({from:'Alex <worker@work.example>',to:'Alex <owner@personal.example>',auth:PASS_AUTH,
    body:'From: Vendor <notice@vendor.example>\nTo: Alex <worker@work.example>\n\nPlease review by Friday',
    ...overrides});
}
const TASK_REPLY={category:'ЗАДАЧА',priority:'высокий',summary:'Нужно проверить документ',
  action:'Проверить документ',deadline_text:'Не указан',deadline_iso:'',classification:'TASK',
  title:'Проверить документ',description:'Проверить документ',assignee:'',related_task_id:'',
  owner_action_required:true};
class Db {
  constructor(){
    this.sqlite=new DatabaseSync(':memory:');
    for(const name of readdirSync(new URL('../migrations/',import.meta.url)).sort())
      this.sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
    const db=this.sqlite;
    this.mail={
      get size(){return db.prepare('SELECT COUNT(*) AS n FROM emails').get().n;},
      set(id,obj){db.prepare("INSERT INTO emails(email_id,received_at,status) VALUES(?,?,'NEW')").run(id,new Date().toISOString());},
      has(id){return Boolean(db.prepare('SELECT 1 FROM emails WHERE email_id=?').get(id));}
    };
    this.tasks={
      get size(){return db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;},
      has(id){return Boolean(db.prepare('SELECT 1 FROM tasks WHERE task_id=?').get(id));}
    };
  }
  prepare(sql) {
    const st=this.sqlite.prepare(sql);
    const kind=/^\s*SELECT\b/i.test(sql)?'select':'write';
    const wrap=(params)=>({
      _kind:kind,
      run:async()=>({meta:{changes:Number(st.run(...params).changes)}}),
      first:async()=>st.get(...params)??null,
      all:async()=>({results:st.all(...params)})
    });
    return {...wrap([]),bind:(...params)=>wrap(params)};
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results=[];
      for(const stmt of statements) results.push(stmt._kind==='select'?await stmt.all():await stmt.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch(error){this.sqlite.exec('ROLLBACK');throw error;}
  }
}

const realFetch=global.fetch;
test.afterEach(()=>{global.fetch=realFetch;});
test('work message filtering requires the exact corporate sender and an aligned authentication result',()=>{
  const env={WORK_EMAIL:'worker@work.example',WORK_DOMAIN:'work.example'};
  assert.equal(isWorkGmailMessage(workForward(),env),true);
  // Each accepted identity form on its own.
  for(const auth of ['mx.google.com; dkim=pass header.i=@work.example header.s=sel',
    'mx.example; dkim=pass header.d=work.example',
    'mx.google.com; spf=pass (sender ok) smtp.mailfrom=worker@work.example',
    'mx.google.com; spf=pass smtp.mailfrom=work.example'])
    assert.equal(isWorkGmailMessage(workForward({auth}),env),true,auth);
  // A recipient header alone never proves corporate origin.
  assert.equal(isWorkGmailMessage(sampleMail(),env),false);
  assert.equal(isWorkGmailMessage(sampleMail({auth:PASS_AUTH}),env),false);
  // The corporate sender without, or with a failed or foreign, authentication result.
  assert.equal(isWorkGmailMessage(workForward({auth:''}),env),false);
  for(const auth of ['mx.google.com; dkim=fail header.i=@work.example; spf=fail smtp.mailfrom=worker@work.example',
    'mx.google.com; dkim=pass header.i=@work.example.evil; spf=pass smtp.mailfrom=worker@work.example.evil',
    'mx.google.com; dkim=pass header.i=@fakework.example; spf=pass smtp.mailfrom=a@fakework.example',
    'mx.google.com; dkim=pass header.i=@evilwork.example header.d=notwork.example',
    'mx.google.com; dmarc=pass header.from=work.example'])
    assert.equal(isWorkGmailMessage(workForward({auth}),env),false,auth);
  // Another colleague's address, or a lookalike domain, is not the configured sender.
  assert.equal(isWorkGmailMessage(workForward({from:'team@work.example'}),env),false);
  assert.equal(isWorkGmailMessage(workForward({from:'worker@fakework.example'}),env),false);
  assert.equal(isWorkGmailMessage(workForward(),{WORK_EMAIL:'worker@work.example'}),false);
});
test('MIME body and attachment metadata are extracted without attachment contents',()=>{
  const p=normalizeGmailMessage(sampleMail({body:'Добрый день!',subject:'Тест'}));
  assert.equal(p.body,'Добрый день!');
  assert.equal(p.has_attachments,true);
  assert.deepEqual(p.attachment_names,['specification.pdf']);
  assert.equal(p.subject,'Тест');
});
test('OAuth secrets are required before contacting Google',async()=>{
  global.fetch=()=>{throw Error('No external network expected')};
  await assert.rejects(gmailAccessToken({}),/not configured/);
});
test('mail ingest is disabled by default even if called directly',async()=>{
  global.fetch=()=>{throw Error('No external network expected')};
  assert.deepEqual(await ingestGmailId({GMAIL_POLL_ENABLED:'false'},'a1b2c3d4'),{disabled:true});
});
test('AI analysis without Groq falls back to subject triage and cannot create a task',async()=>{
  global.fetch=()=>{throw Error('No external network expected')};
  const a=await analyzeGmailEmail({},normalizeGmailMessage(sampleMail()));
  assert.equal(a.needs_review,true);
  assert.equal(a.classification,'REVIEW');
  assert.equal(a.action,'Просмотреть рабочее письмо');
  const news=await analyzeGmailEmail({},normalizeGmailMessage(sampleMail({subject:'Дайджест недели'})));
  assert.equal(news.needs_review,false);
  assert.equal(news.classification,'NEWS');
});
test('work scope keeps corporate mail away from Groq until external AI is approved',async()=>{
  global.fetch=()=>{throw Error('No external network expected')};
  const a=await analyzeGmailEmail({GROQ_API_KEY:'groq',ASSISTANT_SCOPE:'work',OUTLOOK_AI_ENABLED:'false'},
    normalizeGmailMessage(workForward()));
  assert.equal(a.needs_review,true);
  assert.equal(a.classification,'REVIEW');
});
test('work mail is stored once and its task ID is stable across retries',async()=>{
  const db=new Db();
  const calls=[];
  const env={GMAIL_POLL_ENABLED:'true',WORK_EMAIL:'worker@work.example',WORK_DOMAIN:'work.example',
    GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',GMAIL_REFRESH_TOKEN:'refresh',
    GROQ_API_KEY:'groq',DB:db};
  global.fetch=async (url)=>{
    calls.push(String(url));
    if(String(url).includes('oauth2.googleapis.com/token'))return Response.json({access_token:'fake-access-token'});
    if(String(url).includes('/messages/a1b2c3d4'))return Response.json(workForward());
    if(String(url).includes('api.groq.com'))return Response.json({choices:[{message:{content:JSON.stringify(TASK_REPLY)}}]});
    throw new Error('Unexpected request');
  };
  assert.deepEqual(await ingestGmailId(env,'a1b2c3d4'),{stored:true,task:true,updated:false,needs_review:false});
  assert.deepEqual(await ingestGmailId(env,'a1b2c3d4'),{duplicate:true});
  assert.equal(db.mail.size,1);
  assert.equal(db.tasks.size,1);
  assert.ok(db.tasks.has('gmail:gmail:thread123'));
  assert.equal(calls.filter(x=>x.includes('oauth2.googleapis.com')).length,1);
});
test('unrelated personal email stores only an ID marker and never goes to Groq',async()=>{
  const db=new Db(),calls=[];
  const env={GMAIL_POLL_ENABLED:'true',WORK_EMAIL:'worker@work.example',WORK_DOMAIN:'work.example',
    GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',GMAIL_REFRESH_TOKEN:'refresh',
    GROQ_API_KEY:'groq',DB:db};
  global.fetch=async url=>{
    calls.push(String(url));
    if(String(url).includes('oauth2.googleapis.com/token'))return Response.json({access_token:'fake'});
    return Response.json(sampleMail({from:'person@personal.example',to:'friend@personal.example'}));
  };
  assert.deepEqual(await ingestGmailId(env,'a1b2c3d4'),{not_work:true});
  assert.equal(db.mail.size,1);
  const ignored=db.sqlite.prepare('SELECT status,from_email,subject,summary FROM emails WHERE email_id=?').get('a1b2c3d4');
  assert.equal(ignored.status,'IGNORED_NONWORK');
  assert.equal(ignored.from_email,'');
  assert.equal(ignored.subject,'');
  assert.equal(ignored.summary,'');
  assert.deepEqual(await ingestGmailId(env,'a1b2c3d4'),{duplicate:true});
  assert.equal(calls.some(x=>x.includes('groq.com')),false);
});
test('poll queues only unseen IDs and never reads full message bodies in cron',async()=>{
  const DB=new Db();
  DB.mail.set('a1b2c3d4',{email_id:'a1b2c3d4'});
  const sent=[];
  const env={GMAIL_POLL_ENABLED:'true',GOOGLE_CLIENT_ID:'client',
    GOOGLE_CLIENT_SECRET:'secret',GMAIL_REFRESH_TOKEN:'refresh',DB,JOBS:{send:async msg=>sent.push(msg)}};
  global.fetch=async url=>{
    if(String(url).includes('oauth2.googleapis.com/token'))return Response.json({access_token:'fake'});
    if(String(url).includes('/messages?'))return Response.json({messages:[
      {id:'a1b2c3d4'},{id:'b1b2c3d4'},{id:'c1b2c3d4'}]});
    throw new Error('Unexpected fetch');
  };
  const stats=await pollGmail(env);
  assert.deepEqual(stats,{scanned:3,queued:2,pending:0});
  assert.deepEqual(sent,[{kind:'gmail_ingest',id:'c1b2c3d4'},{kind:'gmail_ingest',id:'b1b2c3d4'}]);
});
test('malformed and forged Gmail message IDs are rejected',async()=>{
  await assert.rejects(gmailMessageTokenless('bad/path'),/Invalid/);
});
async function gmailMessageTokenless(id) {
  const {gmailMessage}=await import('../src/gmail.js');
  return gmailMessage('token',id);
}

test('parallel Gmail workers start only one OAuth/Groq analysis for the same id',async()=>{
 const db=new Db();
 const env={GMAIL_POLL_ENABLED:'true',WORK_EMAIL:'worker@work.example',WORK_DOMAIN:'work.example',
   GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',GMAIL_REFRESH_TOKEN:'refresh',
   GROQ_API_KEY:'groq',DB:db};
 let releaseToken,announceToken,oauthCalls=0,groqCalls=0;
 const waiting=new Promise(resolve=>{releaseToken=resolve;});
 const entered=new Promise(resolve=>{announceToken=resolve;});
 global.fetch=async url=>{
   const u=String(url);
   if(u.includes('oauth2.googleapis.com/token')){
     oauthCalls++;
     announceToken();
     await waiting;
     return Response.json({access_token:'fake-token'});
   }
   if(u.includes('/messages/a1b2c3d4'))return Response.json(workForward());
   if(u.includes('api.groq.com')){
     groqCalls++;
     return Response.json({choices:[{message:{content:JSON.stringify(TASK_REPLY)}}]});
   }
   throw Error('Unexpected URL');
 };
 const first=ingestGmailId(env,'a1b2c3d4');
 await entered;
 const parallel=await ingestGmailId(env,'a1b2c3d4');
 assert.deepEqual(parallel,{busy:true});
 assert.equal(oauthCalls,1);
 assert.equal(groqCalls,0);
 releaseToken();
 assert.deepEqual(await first,{stored:true,task:true,updated:false,needs_review:false});
 assert.equal(groqCalls,1);
 assert.deepEqual(await ingestGmailId(env,'a1b2c3d4'),{duplicate:true});
 assert.equal(db.mail.size,1);
 assert.equal(db.tasks.size,1);
});

test('failed task insert rolls back email; retry can persist both together',async()=>{
 const db=new Db();
 const env={GMAIL_POLL_ENABLED:'true',WORK_EMAIL:'worker@work.example',WORK_DOMAIN:'work.example',
   GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',GMAIL_REFRESH_TOKEN:'refresh',
   GROQ_API_KEY:'groq',DB:db};
 global.fetch=async url=>{
   if(String(url).includes('oauth2.googleapis.com/token'))return Response.json({access_token:'fake-token'});
   if(String(url).includes('/messages/a1b2c3d4'))return Response.json(workForward());
   if(String(url).includes('api.groq.com'))return Response.json({
     choices:[{message:{content:JSON.stringify(TASK_REPLY)}}]
   });
   throw Error('Unexpected URL');
 };
 const original=db.batch.bind(db);
 db.batch=async statements=>original([...statements,db.prepare('INSERT INTO missing_table VALUES(1)')]);
 await assert.rejects(ingestGmailId(env,'a1b2c3d4'),/no such table/);
 assert.equal(db.mail.size,0);
 assert.equal(db.tasks.size,0);
 db.batch=original;
 assert.deepEqual(await ingestGmailId(env,'a1b2c3d4'),{stored:true,task:true,updated:false,needs_review:false});
 assert.equal(db.mail.size,1);
 assert.equal(db.tasks.size,1);
});
