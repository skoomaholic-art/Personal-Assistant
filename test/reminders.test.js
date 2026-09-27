import test from 'node:test';
import assert from 'node:assert/strict';
import {dueReminderTasks,reminderText,runReminders} from '../src/reminders.js';

const realFetch=global.fetch;
test.afterEach(()=>{global.fetch=realFetch;});
class FakeDB {
  constructor(tasks){this.tasks=tasks;this.attempts=new Map();}
  prepare(sql){
    let args=[];
    const stmt={
      bind:(...x)=>{args=x;return stmt;},
      all:async()=>{
        if(!sql.startsWith('SELECT task_id,title'))throw Error('Unexpected select');
        return {results:this.tasks};
      },
      run:async()=>{
        if(sql.startsWith('INSERT INTO reminder_deliveries')){
          const [id,now,cutoff]=args;
          const old=this.attempts.get(id);
          if(old && old.attempted_at>cutoff)return {meta:{changes:0}};
          this.attempts.set(id,{attempted_at:now,status:'unknown'});
          return {meta:{changes:1}};
        }
        if(sql.startsWith('UPDATE reminder_deliveries SET status')){
          const [id,stamp]=args;
          if(this.attempts.get(id)?.attempted_at===stamp)this.attempts.get(id).status='sent';
          return {meta:{changes:1}};
        }
        throw Error('Unexpected SQL: '+sql);
      }
    };
    return stmt;
  }
}
const now=Date.parse('2026-09-27T12:00:00Z');
const task={task_id:'task123',title:'Review draft',status:'NEW',due_iso:'2026-09-27T13:00:00Z',due_text:'Today 13:00'};
test('due reminders include upcoming and overdue, not done or distant tasks',()=>{
  const tasks=[task,{...task,task_id:'past',due_iso:'2026-09-26T00:00:00Z'},
    {...task,task_id:'done',status:'DONE'},{...task,task_id:'far',due_iso:'2026-09-28T08:00:00Z'},
    {...task,task_id:'unscheduled',due_iso:''}];
  assert.deepEqual(dueReminderTasks(tasks,now).map(t=>t.task_id),['past','task123']);
  assert.match(reminderText(tasks[1],now),/просрочена/);
});
test('reminders are disabled by default without database or Telegram token',async()=>{
  global.fetch=()=>{throw Error('No external network expected')};
  assert.deepEqual(await runReminders({},now),{disabled:true});
});
test('one reminder sends once within cooldown and marks sent',async()=>{
  const DB=new FakeDB([task]),messages=[];
  const env={REMINDERS_ENABLED:'true',DB,TELEGRAM_BOT_TOKEN:'test-token',TELEGRAM_CHAT_ID:'123'};
  global.fetch=async (url,options)=>{
    assert.match(String(url),/api.telegram.org/);
    messages.push(JSON.parse(options.body));
    return Response.json({ok:true,result:{message_id:1}});
  };
  const one=await runReminders(env,now);
  assert.equal(one.sent,1);
  const two=await runReminders(env,now+5*60*1000);
  assert.equal(two.sent,0);
  assert.equal(two.skipped,1);
  assert.equal(messages.length,1);
  assert.equal(DB.attempts.get('task123').status,'sent');
});
test('ambiguous Telegram failure is not retried immediately',async()=>{
  const DB=new FakeDB([task]);
  const env={REMINDERS_ENABLED:'true',DB,TELEGRAM_BOT_TOKEN:'test-token',TELEGRAM_CHAT_ID:'123'};
  let calls=0;
  global.fetch=async()=>{calls++;throw Error('connection lost')};
  assert.equal((await runReminders(env,now)).unknown,1);
  assert.equal((await runReminders(env,now+10000)).skipped,1);
  assert.equal(calls,1);
  assert.equal(DB.attempts.get('task123').status,'unknown');
});
