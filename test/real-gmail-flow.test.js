import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {
  prepareGmailDraft,confirmGmailSend,gmailSendPreview
} from '../src/gmail-compose.js';

class FakeD1 {
  constructor() {
    this.sql=new DatabaseSync(':memory:');
    for(const n of ['0001_init.sql','0003_local_reply_previews.sql',
      '0004_gmail_draft_delivery.sql'])
      this.sql.exec(readFileSync(new URL('../migrations/'+n,import.meta.url),'utf8'));
    this.sql.prepare("INSERT INTO emails(email_id,received_at,from_email,subject,status) VALUES(?,?,?,?,?)")
      .run('a1b2c3d4',new Date().toISOString(),'colleague@vendor.example','Обзор','NEW');
    this.sql.prepare("INSERT INTO reply_drafts(draft_id,email_id,to_email,subject,body,body_sha256,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run('d'+'1'.repeat(32),'a1b2c3d4','colleague@vendor.example',
        'Re: Обзор','Спасибо за письмо!','digest','PREVIEW',
        new Date().toISOString(),new Date().toISOString());
  }
  prepare(sql) {
    const st=this.sql.prepare(sql);
    const kind=/^\s*SELECT\b/i.test(sql)?'read':'write';
    const bound=args=>({
      kind,
      run:async()=>({meta:{changes:Number(st.run(...args).changes)}}),
      first:async()=>st.get(...args)??null,
      all:async()=>({results:st.all(...args)})
    });
    return {...bound([]),bind:(...args)=>bound(args)};
  }
  async batch(queries) {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const out=[];
      for(const q of queries)out.push(q.kind==='read'?await q.all():await q.run());
      this.sql.exec('COMMIT');return out;
    }catch(e){this.sql.exec('ROLLBACK');throw e;}
  }
  get(statusField='status') {
    return this.sql.prepare('SELECT '+statusField+' FROM reply_drafts').get();
  }
  close(){this.sql.close();}
}
const draftId='d'+'1'.repeat(32);
const originalFetch=global.fetch;
test.afterEach(()=>{global.fetch=originalFetch;});
function setup({failSend=false,originalFrom='Alex <worker@work.example>'}={}) {
  const DB=new FakeD1();let create=0,send=0;
  const env={
    DB,WORK_EMAIL:'worker@work.example',WORK_DOMAIN:'work.example',
    OUTBOUND_FROM_ALIAS:'worker@work.example',
    GOOGLE_CLIENT_ID:'fake-id',GOOGLE_CLIENT_SECRET:'fake-secret',
    GMAIL_REFRESH_TOKEN:'fake-refresh',
    GMAIL_DRAFTS_ENABLED:'true',GMAIL_SEND_ENABLED:'true'
  };
  global.fetch=async (url,options={})=>{
    const u=String(url);
    if(u.includes('oauth2.googleapis.com/token'))
      return Response.json({access_token:'fake-access-token'});
    if(u.includes('/messages/a1b2c3d4'))
      return Response.json({id:'a1b2c3d4',threadId:'thread1111',
        internalDate:'1780000000000',payload:{mimeType:'text/plain',headers:[
          // Authenticated forward from the owner's corporate address; the
          // original author is read from the preserved header block.
          {name:'From',value:originalFrom},
          {name:'To',value:'owner@personal.example'},
          {name:'Subject',value:'Обзор'},
          {name:'Message-ID',value:'<mail@example.org>'},
          {name:'Authentication-Results',value:'mx.google.com; dkim=pass header.i=@work.example header.s=sel; '+
            'spf=pass smtp.mailfrom=worker@work.example'}
        ],body:{data:Buffer.from('From: Colleague <colleague@vendor.example>\nTo: worker@work.example\n\nНужно ответить').toString('base64url')}}});
    if(u.includes('/settings/sendAs'))
      return Response.json({sendAs:[{sendAsEmail:'worker@work.example',
        verificationStatus:'accepted',isDefault:false}]});
    if(u.endsWith('/drafts')&&options.method==='POST') {
      create++;
      const request=JSON.parse(options.body);
      assert.equal(request.message.threadId,'thread1111');
      const mime=Buffer.from(request.message.raw,'base64url').toString('utf8');
      assert.match(mime,/From: worker@work\.example/);
      assert.match(mime,/To: colleague@vendor\.example/);
      return Response.json({id:'r123456789',message:{id:'m123456789'}});
    }
    if(u.includes('/drafts/r123456789'))
      return Response.json({id:'r123456789',message:{id:'m123456789',
        payload:{mimeType:'text/plain',headers:[
          {name:'From',value:'worker@work.example'},
          {name:'To',value:'colleague@vendor.example'},
          {name:'Subject',value:'Re: Обзор'}
        ],body:{data:Buffer.from('Спасибо за письмо!').toString('base64url')}}}});
    if(u.endsWith('/drafts/send')) {
      send++;
      if(failSend)throw Error('connection lost after Gmail may have accepted');
      assert.equal(JSON.parse(options.body).id,'r123456789');
      return Response.json({id:'message1234'});
    }
    throw Error('Unexpected URL '+u);
  };
  return {DB,env,counts:()=>({create,send})};
}
test('remote Gmail draft can be previewed and sent exactly once after opt-in',async()=>{
  const {DB,env,counts}=setup();
  try {
    const ready=await prepareGmailDraft(env,draftId);
    assert.equal(ready.status,'GMAIL_PREVIEWED');
    assert.equal(ready.to_email,'colleague@vendor.example');
    assert.ok(ready.snapshot_hash);
    assert.equal(counts().create,1);
    assert.match(gmailSendPreview(ready,true).text,/ТЕКСТ ЦЕЛИКОМ/);
    assert.equal(gmailSendPreview(ready,false).reply_markup.inline_keyboard.some(
      row=>row.some(button=>button.callback_data.startsWith('senddraft:'))),false);
    const answer=await confirmGmailSend(env,draftId,ready.preview_token);
    assert.match(answer.text,/Gmail подтвердил/);
    assert.equal(DB.get().status,'SENT');
    assert.equal(counts().send,1);
    await confirmGmailSend(env,draftId,ready.preview_token);
    assert.equal(counts().send,1);
  } finally{DB.close();}
});
test('ambiguous Gmail send is never repeated',async()=>{
  const {DB,env,counts}=setup({failSend:true});
  try{
    const ready=await prepareGmailDraft(env,draftId);
    const answer=await confirmGmailSend(env,draftId,ready.preview_token);
    assert.match(answer.text,/Неясно/);
    assert.equal(DB.get().status,'SEND_UNKNOWN');
    await confirmGmailSend(env,draftId,ready.preview_token);
    assert.equal(counts().send,1);
  } finally{DB.close();}
});
test('mail send remains disabled without distinct switch',async()=>{
  const {DB,env,counts}=setup();
  try{
    const ready=await prepareGmailDraft(env,draftId);
    env.GMAIL_SEND_ENABLED='false';
    const answer=await confirmGmailSend(env,draftId,ready.preview_token);
    assert.match(answer.text,/выключена/);
    assert.equal(counts().send,0);
  } finally{DB.close();}
});
test('no Gmail draft is created for a source message without corporate provenance',async()=>{
  const {DB,env,counts}=setup({originalFrom:'Colleague <colleague@vendor.example>'});
  try{
    await assert.rejects(prepareGmailDraft(env,draftId),/не распознано как рабочее/);
    assert.equal(counts().create,0);
    assert.equal(counts().send,0);
  } finally{DB.close();}
});
