import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gmailAccessToken, gmailHeaders, isWorkGmailMessage, normalizeGmailMessage,
  analyzeGmailEmail, ingestGmailId, pollGmail
} from '../src/gmail.js';

function sampleMail({id='a1b2c3d4',from='Vendor <notice@vendor.example>',to='Alex <worker@work.example>',body='Please review by Friday',subject='Review'}={}) {
  return {id,threadId:'thread123',internalDate:'1770000000000',snippet:'short snippet',
    payload:{mimeType:'multipart/mixed',headers:[
      {name:'From',value:from},{name:'To',value:to},{name:'Subject',value:subject}],
      parts:[
        {mimeType:'text/plain',body:{data:Buffer.from(body,'utf8').toString('base64url')}},
        {mimeType:'application/pdf',filename:'specification.pdf',body:{attachmentId:'att1'}}]
    }
  };
}
class Db {
  constructor(){this.mail=new Map();this.tasks=new Map();}
  prepare(sql) {
    const bound={args:[]};
    const statement={
      bind:(...args)=>{bound.args=args;return statement;},
      first:async()=>{
        if(sql.includes('FROM emails WHERE email_id=?'))return this.mail.get(bound.args[0])||null;
        return null;
      },
      all:async()=>{
        if(sql.includes('SELECT email_id FROM emails WHERE email_id IN')) {
          const result=bound.args.filter(id=>this.mail.has(id)).map(email_id=>({email_id}));
          return {results:result};
        }
        return {results:[]};
      },
      run:async()=>{
        if(sql.startsWith('INSERT OR IGNORE INTO emails')) {
          const id=bound.args[0];
          if(this.mail.has(id))return {meta:{changes:0}};
          this.mail.set(id,{email_id:id});return {meta:{changes:1}};
        }
        if(sql.startsWith('INSERT OR IGNORE INTO tasks')){
          const id=bound.args[0];
          if(this.tasks.has(id))return {meta:{changes:0}};
          this.tasks.set(id,bound.args);return {meta:{changes:1}};
        }
        throw new Error('Unexpected SQL in fixture: '+sql.slice(0,40));
      }
    };
    return statement;
  }
}
const realFetch=global.fetch;
test.afterEach(()=>{global.fetch=realFetch;});
test('work message filtering matches exact corporate recipient and sender domain',()=>{
  const env={WORK_EMAIL:'worker@work.example',WORK_DOMAIN:'work.example'};
  assert.equal(isWorkGmailMessage(sampleMail(),env),true);
  assert.equal(isWorkGmailMessage(sampleMail({from:'team@work.example',to:'other@personal.example'}),env),true);
  assert.equal(isWorkGmailMessage(sampleMail({from:'team@fakework.example',to:'other@personal.example'}),env),false);
  assert.equal(isWorkGmailMessage(sampleMail({from:'notify@vendor.example',to:'other@personal.example'}),env),false);
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
test('AI analysis without Groq returns review flag and cannot create a task',async()=>{
  const a=await analyzeGmailEmail({},normalizeGmailMessage(sampleMail()));
  assert.equal(a.needs_review,true);
  assert.equal(a.action,'AI-анализ не выполнен');
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
    if(String(url).includes('/messages/a1b2c3d4'))return Response.json(sampleMail());
    if(String(url).includes('api.groq.com'))return Response.json({choices:[{message:{content:JSON.stringify({
      category:'ЗАДАЧА',priority:'высокий',summary:'Нужно проверить документ',
      action:'Проверить документ',deadline_text:'Не указан',deadline_iso:''
    })}}]});
    throw new Error('Unexpected request');
  };
  assert.deepEqual(await ingestGmailId(env,'a1b2c3d4'),{stored:true,task:true,needs_review:false});
  assert.deepEqual(await ingestGmailId(env,'a1b2c3d4'),{duplicate:true});
  assert.equal(db.mail.size,1);
  assert.equal(db.tasks.size,1);
  assert.ok(db.tasks.has('gmail:a1b2c3d4'));
  assert.equal(calls.filter(x=>x.includes('oauth2.googleapis.com')).length,1);
});
test('unrelated personal email is never stored or sent to Groq',async()=>{
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
  assert.equal(db.mail.size,0);
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
  assert.deepEqual(stats,{scanned:3,queued:2});
  assert.deepEqual(sent,[{kind:'gmail_ingest',id:'c1b2c3d4'},{kind:'gmail_ingest',id:'b1b2c3d4'}]);
});
test('malformed and forged Gmail message IDs are rejected',async()=>{
  await assert.rejects(gmailMessageTokenless('bad/path'),/Invalid/);
});
async function gmailMessageTokenless(id) {
  const {gmailMessage}=await import('../src/gmail.js');
  return gmailMessage('token',id);
}
