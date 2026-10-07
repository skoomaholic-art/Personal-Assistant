import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../src/worker.js';
import {webhookTarget} from '../src/telegram-cutover.js';
import {upgradeLegacyCallback,isQuickAction} from '../src/router.js';

const ORIGIN='https://assistant.example';
const LEGACY='https://script.google.com/macros/s/AKfycbTESTDEPLOYMENT/exec?secret=legacy-secret-value';
const PASSWORD='owner-password-that-is-long-enough';
const AUTH='Basic '+Buffer.from('admin:'+PASSWORD).toString('base64');

class D1 {
  constructor(){
    this.sqlite=new DatabaseSync(':memory:');
    for(const name of readdirSync(new URL('../migrations/',import.meta.url)).sort())
      this.sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  }
  prepare(sql){
    const st=this.sqlite.prepare(sql);
    const bound=args=>({
      run:async()=>({meta:{changes:Number(st.run(...args).changes)}}),
      first:async()=>st.get(...args)??null,
      all:async()=>({results:st.all(...args)})
    });
    return {...bound([]),bind:(...args)=>bound(args)};
  }
  state(){
    const row=this.sqlite.prepare("SELECT mode,data FROM states WHERE chat_id='system:telegram-cutover'").get();
    return row?{mode:row.mode,...JSON.parse(row.data)}:null;
  }
}
// A stand-in for Telegram that remembers the webhook like the real API does.
function setup({url=LEGACY,vars={},rejectSet=false}={}){
  const DB=new D1(),calls=[];
  const telegramState={url};
  const env={DB,JOBS:{send:async()=>{}},SETUP_PASSWORD:PASSWORD,TELEGRAM_CUTOVER_ENABLED:'true',
    TELEGRAM_BOT_TOKEN:'fake-bot-token',TELEGRAM_CHAT_ID:'123',
    TELEGRAM_WEBHOOK_SECRET:'worker-webhook-secret',GROQ_API_KEY:'fake-groq',...vars};
  global.fetch=async(input,init={})=>{
    const uri=String(input);
    assert.ok(uri.startsWith('https://api.telegram.org/botfake-bot-token/'),'unexpected request '+uri);
    const method=uri.split('/').at(-1),payload=JSON.parse(init.body||'{}');
    calls.push({method,payload});
    if(method==='getWebhookInfo')
      return Response.json({ok:true,result:{url:telegramState.url,pending_update_count:2}});
    if(method==='setWebhook'){
      if(rejectSet)return Response.json({ok:false,description:'bad'},{status:400});
      telegramState.url=payload.url;
      return Response.json({ok:true,result:true});
    }
    throw Error('Unexpected Telegram method '+method);
  };
  const sets=()=>calls.filter(call=>call.method==='setWebhook');
  return {env,DB,telegramState,sets};
}
function get(headers={authorization:AUTH}){
  return new Request(ORIGIN+'/admin/telegram/cutover',{headers});
}
function post(fields,{origin=ORIGIN,authorization=AUTH}={}){
  const body=new FormData();
  for(const [key,value] of Object.entries(fields))body.set(key,value);
  return new Request(ORIGIN+'/admin/telegram/cutover',{method:'POST',body,
    headers:{origin,...(authorization?{authorization}:{})}});
}
const nativeFetch=global.fetch;
test.afterEach(()=>{global.fetch=nativeFetch;});

test('webhook target is classified by exact origin and path',()=>{
  assert.equal(webhookTarget(ORIGIN+'/telegram/webhook',ORIGIN),'cloudflare_worker');
  assert.equal(webhookTarget(LEGACY,ORIGIN),'legacy_apps_script');
  assert.equal(webhookTarget('',ORIGIN),'not_set');
  assert.equal(webhookTarget(ORIGIN+'/other',ORIGIN),'other');
  assert.equal(webhookTarget('https://assistant.example.evil/telegram/webhook',ORIGIN),'other');
  assert.equal(webhookTarget('https://script.google.com.evil/x',ORIGIN),'other');
});

test('cutover page requires the owner password and the explicit switch',async()=>{
  const {env,sets}=setup();
  assert.equal((await worker.fetch(get({}),env)).status,401);
  assert.equal((await worker.fetch(get({authorization:'Basic '+Buffer.from('admin:wrong-password-wrong-password').toString('base64')}),env)).status,401);
  assert.equal((await worker.fetch(post({action:'switch',confirm:'yes'},{authorization:''}),env)).status,401);
  env.TELEGRAM_CUTOVER_ENABLED='false';
  assert.equal((await worker.fetch(get(),env)).status,503);
  assert.equal((await worker.fetch(post({action:'switch',confirm:'yes'}),env)).status,503);
  assert.equal(sets().length,0);
});

test('status page shows the current target without leaking secrets',async()=>{
  const {env,sets}=setup();
  const response=await worker.fetch(get(),env);
  assert.equal(response.status,200);
  const html=await response.text();
  assert.match(html,/старый бот \(Google Apps Script\)/);
  assert.match(html,/Переключить бота/);
  for(const secret of ['legacy-secret-value','AKfycbTESTDEPLOYMENT','fake-bot-token','worker-webhook-secret',PASSWORD])
    assert.equal(html.includes(secret),false,'page leaks '+secret);
  assert.equal(sets().length,0);
});

test('switch needs confirmation, same-origin form and complete configuration',async()=>{
  const {env,sets,telegramState}=setup();
  assert.equal((await worker.fetch(post({action:'switch'}),env)).status,403);
  assert.equal((await worker.fetch(post({action:'switch',confirm:'yes'},{origin:'https://evil.example'}),env)).status,403);
  delete env.TELEGRAM_WEBHOOK_SECRET;
  assert.equal((await worker.fetch(post({action:'switch',confirm:'yes'}),env)).status,409);
  assert.equal(sets().length,0);
  assert.equal(telegramState.url,LEGACY);
});

test('switch points the existing bot at the Worker and remembers the way back',async()=>{
  const {env,DB,sets,telegramState}=setup();
  const response=await worker.fetch(post({action:'switch',confirm:'yes'}),env);
  assert.equal(response.status,200);
  const html=await response.text();
  assert.match(html,/переключён на новую версию/);
  assert.equal(html.includes('legacy-secret-value'),false);
  assert.deepEqual(sets().map(call=>call.payload),[{url:ORIGIN+'/telegram/webhook',
    secret_token:'worker-webhook-secret',allowed_updates:['message','callback_query'],
    drop_pending_updates:false}]);
  assert.equal(telegramState.url,ORIGIN+'/telegram/webhook');
  assert.deepEqual(DB.state(),{mode:'SWITCHED',previous_url:LEGACY});
  // A second click is a no-op.
  assert.equal((await worker.fetch(post({action:'switch',confirm:'yes'}),env)).status,200);
  assert.equal(sets().length,1);
  assert.match(await (await worker.fetch(get(),env)).text(),/Откатить на старого бота/);
});

test('a rejected switch leaves Telegram on the legacy bot and reports failure',async()=>{
  const {env,DB,telegramState}=setup({rejectSet:true});
  const response=await worker.fetch(post({action:'switch',confirm:'yes'}),env);
  assert.equal(response.status,502);
  assert.equal(telegramState.url,LEGACY);
  assert.equal(DB.state().mode,'SWITCHING');
});

test('rollback restores the saved Apps Script address only',async()=>{
  const {env,DB,sets,telegramState}=setup();
  await worker.fetch(post({action:'switch',confirm:'yes'}),env);
  assert.equal((await worker.fetch(post({action:'rollback'}),env)).status,403);
  const response=await worker.fetch(post({action:'rollback',confirm:'yes'}),env);
  assert.equal(response.status,200);
  assert.equal(telegramState.url,LEGACY);
  assert.deepEqual(sets().at(-1).payload,{url:LEGACY,drop_pending_updates:false});
  assert.equal(DB.state().mode,'ROLLED_BACK');
  assert.equal((await response.text()).includes('legacy-secret-value'),false);
});

test('rollback refuses when no legacy address was saved or it is not Apps Script',async()=>{
  const {env,DB,sets}=setup({url:ORIGIN+'/telegram/webhook'});
  assert.equal((await worker.fetch(post({action:'rollback',confirm:'yes'}),env)).status,409);
  DB.sqlite.prepare("INSERT INTO states(chat_id,mode,data,updated_at) VALUES('system:telegram-cutover','SWITCHED',?,0)")
    .run(JSON.stringify({previous_url:'https://evil.example/hook'}));
  assert.equal((await worker.fetch(post({action:'rollback',confirm:'yes'}),env)).status,409);
  assert.equal(sets().length,0);
});

test('buttons under old Apps Script messages map to current actions',()=>{
  for(const [legacy,current] of [['open_menu','menu'],['menu_today','today'],['menu_important','important'],
    ['menu_week','week'],['menu_news','news'],['menu_colleagues','colleagues'],['menu_search','search'],
    ['menu_mail','mail:refresh'],['menu_reset','reset'],['confirm_reset','reset:yes'],['cancel_reset','reset:no'],
    ['task_done:abc123','task:done:abc123'],['task_progress:abc123','task:progress:abc123'],
    ['task_view:abc123','task:view:abc123'],['email_view:18a4b9f21','email:view:18a4b9f21'],
    ['email_task:18a4b9f21','email:task:18a4b9f21'],['email_reply:18a4b9f21','email:reply:18a4b9f21'],
    ['attget:18a4b9f21:0','legacy:stale'],['email_atts:18a4b9f21','legacy:stale']])
    assert.equal(upgradeLegacyCallback(legacy),current,legacy);
  // Current identifiers, including draft buttons shared with the old bot, pass through untouched.
  for(const current of ['menu','tasks','task:done:abc','email:view:x1','mail:refresh','reset:yes',
    'editdraft:d1','canceldraft:d1','senddraft:d1:token','task:new:save',''])
    assert.equal(upgradeLegacyCallback(current),current);
  assert.equal(isQuickAction('legacy:stale'),true);
});

test('a legacy button pressed after cutover is answered by the Worker without the Queue',async()=>{
  const DB=new D1(),sent=[],queued=[];
  const env={DB,JOBS:{send:async job=>queued.push(job)},TELEGRAM_BOT_TOKEN:'fake-bot-token',
    TELEGRAM_CHAT_ID:'123',TELEGRAM_WEBHOOK_SECRET:'worker-webhook-secret'};
  global.fetch=async(input,init={})=>{
    const method=String(input).split('/').at(-1);
    if(method==='sendMessage')sent.push(JSON.parse(init.body));
    return Response.json({ok:true,result:{message_id:1}});
  };
  const press=(id,data)=>worker.fetch(new Request(ORIGIN+'/telegram/webhook',{method:'POST',
    headers:{'X-Telegram-Bot-Api-Secret-Token':'worker-webhook-secret'},
    body:JSON.stringify({update_id:id,callback_query:{id:'cb'+id,message:{chat:{id:123}},data}})}),env);
  assert.equal((await (await press(1,'open_menu')).json()).fast,true);
  assert.equal(sent.at(-1).text,'Что делаем?');
  assert.ok(sent.at(-1).reply_markup.inline_keyboard.flat().some(button=>button.callback_data==='tasks'));
  assert.equal((await (await press(2,'attget:18a4b9f21:0')).json()).fast,true);
  assert.match(sent.at(-1).text,/старой версии бота/);
  assert.equal((await (await press(3,'menu_reset')).json()).fast,true);
  assert.match(sent.at(-1).text,/Очистить историю/);
  assert.equal(queued.length,0);
});

test('admin form pages keep the Origin header usable for their own posts',async()=>{
  const {env}=setup();
  for(const path of ['/admin/telegram/cutover','/admin/import/tasks']){
    const response=await worker.fetch(new Request(ORIGIN+path,{headers:{authorization:AUTH}}),env);
    assert.equal(response.status,200,path);
    // "no-referrer" makes browsers send "Origin: null" on same-origin form posts.
    assert.equal(response.headers.get('referrer-policy'),'same-origin',path);
  }
  assert.equal((await worker.fetch(post({action:'switch',confirm:'yes'},{origin:'null'}),env)).status,403);
});
