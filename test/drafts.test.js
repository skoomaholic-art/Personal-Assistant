import test from 'node:test';
import assert from 'node:assert/strict';
import {
  replySubject,safeReplyAddress,hashDraft,createDraftPreview,
  loadDraft,editDraftPreview,cancelDraftPreview,draftPreview
} from '../src/drafts.js';
class FakeDB {
  constructor(){this.drafts=new Map();}
  prepare(sql){
    let args=[];
    const stmt={
      bind:(...x)=>{args=x;return stmt;},
      first:async()=>{
        if(sql.includes('FROM emails')) return {
          email_id:args[0],from_name:'Work sender',from_email:'colleague@example.org',
          subject:'Project review',summary:'Draft was requested',action:'Please reply'
        };
        if(sql.includes('FROM reply_drafts'))return this.drafts.get(args[0])||null;
        throw Error('Unexpected select');
      },
      run:async()=>{
        if(sql.startsWith('INSERT INTO reply_drafts')){
          const [draft_id,email_id,to_email,subject,body,body_sha256,created_at,updated_at]=args;
          this.drafts.set(draft_id,{
            draft_id,email_id,to_email,subject,body,body_sha256,created_at,updated_at,
            revision:1,status:'PREVIEW'
          });return {meta:{changes:1}};
        }
        if(sql.startsWith('UPDATE reply_drafts SET body')){
          const d=this.drafts.get(args[3]);
          if(!d||d.status!=='PREVIEW')return {meta:{changes:0}};
          d.body=args[0];d.body_sha256=args[1];d.revision++;d.updated_at=args[2];
          return {meta:{changes:1}};
        }
        if(sql.startsWith('UPDATE reply_drafts SET status')){
          const d=this.drafts.get(args[1]);
          if(!d||d.status!=='PREVIEW')return {meta:{changes:0}};
          d.status='CANCELLED';d.updated_at=args[0];return {meta:{changes:1}};
        }
        throw Error('Unexpected D1 statement '+sql);
      }
    };
    return stmt;
  }
}
test('reply subject follows original script and does not add repeated Re',()=>{
  assert.equal(replySubject('Проект'),'Re: Проект');
  assert.equal(replySubject('Re: Проект'),'Re: Проект');
});
test('invalid, multi-recipient or injected recipient is rejected',()=>{
  assert.equal(safeReplyAddress('colleague@example.org'),'colleague@example.org');
  assert.equal(safeReplyAddress('bad@@example.org'),'');
  assert.equal(safeReplyAddress('good@example.org,bad@example.org'),'');
  assert.equal(safeReplyAddress('good@example.org\r\nBcc:evil@example.org'),'');
});
test('local preview saves complete bounded body and does not contact Gmail or Telegram',async()=>{
  const DB=new FakeDB();
  const native=global.fetch;
  global.fetch=()=>{throw Error('Forbidden network request')};
  try {
    const draft=await createDraftPreview({DB},'a1b2c3d4','Спасибо, подтверждаю получение.');
    assert.ok(draft.draft_id.startsWith('d'));
    assert.equal(draft.to_email,'colleague@example.org');
    assert.equal(draft.subject,'Re: Project review');
    assert.equal(draft.status,'PREVIEW');
    assert.equal(draft.body_sha256,await hashDraft(draft.body));
    const preview=draftPreview(draft);
    assert.match(preview.text,/НЕ отправлен/);
    assert.match(preview.text,/Отправка с этого сервера отключена/);
    assert.equal(preview.reply_markup.inline_keyboard.some(row=>row.some(button=>/senddraft/.test(button.callback_data))),false);
    assert.deepEqual(await loadDraft({DB},draft.draft_id),draft);
    const edited=await editDraftPreview({DB},draft.draft_id,'Исправленный текст');
    assert.equal(edited.body,'Исправленный текст');
    assert.equal(edited.revision,2);
    assert.equal(await cancelDraftPreview({DB},draft.draft_id),true);
    assert.equal(await cancelDraftPreview({DB},draft.draft_id),false);
    await assert.rejects(editDraftPreview({DB},draft.draft_id,'Нельзя менять'),/отменён/);
  } finally {global.fetch=native;}
});
