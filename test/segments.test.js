import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {topicOf,segmentFor,setSegment,setTaskSegmentOnce,segmentOverview,segmentView,SEGMENT_ORDER} from '../src/segments.js';
import {ingestGmailId,pollGmail} from '../src/gmail.js';
import {isQuickAction} from '../src/router.js';

class Db {
  constructor(){
    this.sqlite=new DatabaseSync(':memory:');
    for(const name of readdirSync(new URL('../migrations/',import.meta.url)).sort())
      this.sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  }
  prepare(sql){
    const st=this.sqlite.prepare(sql),kind=/^\s*SELECT\b/i.test(sql)?'select':'write';
    const wrap=params=>({_kind:kind,
      run:async()=>({meta:{changes:Number(st.run(...params).changes)}}),
      first:async()=>st.get(...params)??null,
      all:async()=>({results:st.all(...params)})});
    return {...wrap([]),bind:(...params)=>wrap(params)};
  }
  async batch(statements){
    this.sqlite.exec('BEGIN IMMEDIATE');
    try{const out=[];for(const s of statements)out.push(s._kind==='select'?await s.all():await s.run());
      this.sqlite.exec('COMMIT');return out;}
    catch(error){this.sqlite.exec('ROLLBACK');throw error;}
  }
  segment(kind,id){return this.sqlite.prepare('SELECT segment FROM item_segments WHERE kind=? AND item_id=?').get(kind,id)?.segment;}
  email(id){return this.sqlite.prepare('SELECT * FROM emails WHERE email_id=?').get(id);}
}
const AUTH='mx.google.com; dkim=pass header.i=@work.example; spf=pass smtp.mailfrom=worker@work.example';
function mail({id='a1b2c3d4',thread='thread-'+id,work=true,subject='Тема',inner='Текст письма',from='Shop <news@shop.example>'}={}){
  const body=work?'From: Colleague <colleague@work.example>\nTo: Alex <worker@work.example>\n\n'+inner:inner;
  return {id,threadId:thread,internalDate:'1770000000000',snippet:'',payload:{mimeType:'text/plain',headers:[
    {name:'From',value:work?'Alex <worker@work.example>':from},{name:'To',value:'owner@personal.example'},
    {name:'Subject',value:subject},...(work?[{name:'Authentication-Results',value:AUTH}]:[])],
    body:{data:Buffer.from(body,'utf8').toString('base64url')}}};
}
// Gmail returns the queued message; the model answers with the given analysis.
function world(messages,analysis){
  const db=new Db(),modelCalls=[];
  const env={DB:db,GMAIL_POLL_ENABLED:'true',WORK_EMAIL:'worker@work.example',WORK_DOMAIN:'work.example',
    GOOGLE_CLIENT_ID:'c',GOOGLE_CLIENT_SECRET:'s',GMAIL_REFRESH_TOKEN:'r',GROQ_API_KEY:'g',
    ASSISTANT_SCOPE:'work',OUTLOOK_AI_ENABLED:'true',GMAIL_NONWORK_INDEX_ENABLED:'true',
    JOBS:{send:async()=>{}}};
  global.fetch=async(url,init)=>{
    const u=String(url);
    if(u.includes('oauth2.googleapis.com/token'))return Response.json({access_token:'t'});
    if(u.includes('api.groq.com')){
      const sent=JSON.parse(init.body);modelCalls.push(sent);
      const reply=typeof analysis==='function'?analysis(sent):analysis;
      return Response.json({choices:[{message:{content:JSON.stringify(reply)}}]});
    }
    const id=u.match(/\/messages\/([^/?]+)/)?.[1];
    if(id&&messages[id])return Response.json(messages[id]);
    throw Error('Unexpected request '+u);
  };
  return {db,env,modelCalls};
}
const reply=(over={})=>({category:'ЗАДАЧА',priority:'средний',summary:'Кратко',action:'Сделать',
  deadline_text:'Не указан',deadline_iso:'',classification:'TASK',title:'Сделать',description:'Сделать',
  assignee:'',related_task_id:'',owner_action_required:true,topic:'OTHER',...over});
const nativeFetch=global.fetch;
test.afterEach(()=>{global.fetch=nativeFetch;});

test('topics are recognised from text, promo codes first',()=>{
  for(const [text,topic] of [
    ['Расписание матчей Лиги чемпионов на неделю','SPORT'],['Трансляция турнира UFC в субботу','SPORT'],
    ['Новый сериал: постер и трейлер для витрины','CONTENT'],['Баннер к премьере фильма','CONTENT'],
    ['Нужно завести промокод на 30 дней подписки','PROMO'],['Promo code для партнёра','PROMO'],
    ['Промокод на просмотр матча','PROMO'],['Отпуск в ноябре','OTHER'],['','OTHER'],[null,'OTHER']])
    assert.equal(topicOf(text),topic,String(text));
});

test('segment follows provenance first, then news, then topic',()=>{
  assert.equal(segmentFor({workMail:false,topic:'SPORT',text:'матч'}),'NONWORK');
  assert.equal(segmentFor({workMail:true,classification:'NEWS',topic:'SPORT'}),'NEWS');
  assert.equal(segmentFor({workMail:true,category:'НОВОСТЬ',text:'промокод'}),'NEWS');
  assert.equal(segmentFor({workMail:true,classification:'TASK',topic:'CONTENT'}),'CONTENT');
  assert.equal(segmentFor({workMail:true,classification:'TASK',topic:'OTHER',text:'турнир'}),'SPORT');
  assert.equal(segmentFor({workMail:true,classification:'INFO',topic:'nonsense',text:'договор'}),'WORK');
});

test('non-work mail keeps only sender and subject and never reaches the model',async()=>{
  const {db,env,modelCalls}=world({a1b2c3d4:mail({work:false,subject:'Скидки недели',inner:'ЛИЧНЫЙ ТЕКСТ ПИСЬМА'})});
  assert.deepEqual(await ingestGmailId(env,'a1b2c3d4'),{not_work:true,indexed:true});
  const row=db.email('a1b2c3d4');
  assert.deepEqual([row.status,row.from_name,row.from_email,row.subject],
    ['NONWORK','Shop <news@shop.example>','news@shop.example','Скидки недели']);
  assert.deepEqual([row.summary,row.action,row.deadline_text],['','','']);
  assert.equal(JSON.stringify(row).includes('ЛИЧНЫЙ ТЕКСТ'),false);
  assert.equal(db.segment('email','a1b2c3d4'),'NONWORK');
  assert.equal(modelCalls.length,0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,0);
  assert.deepEqual(await ingestGmailId(env,'a1b2c3d4'),{duplicate:true});
  // Without the owner's switch nothing about the message is retained.
  env.GMAIL_NONWORK_INDEX_ENABLED='false';
  global.fetch=(f=>async(url,init)=>String(url).includes('/messages/')?Response.json(mail({id:'b1b2c3d4',work:false,subject:'Секрет'})):f(url,init))(global.fetch);
  assert.deepEqual(await ingestGmailId(env,'b1b2c3d4'),{not_work:true});
  assert.deepEqual([db.email('b1b2c3d4').status,db.email('b1b2c3d4').subject],['IGNORED_NONWORK','']);
  assert.equal(db.segment('email','b1b2c3d4'),undefined);
});

test('work mail and its task land in the topic the model names',async()=>{
  const {db,env,modelCalls}=world({a1b2c3d4:mail({subject:'Запрос',inner:'Нужно подготовить расписание'})},
    reply({topic:'SPORT',priority:'высокий'}));
  const result=await ingestGmailId(env,'a1b2c3d4');
  assert.deepEqual([result.stored,result.task,result.needs_review],[true,true,false]);
  assert.equal(db.segment('email','a1b2c3d4'),'SPORT');
  const task=db.sqlite.prepare('SELECT task_id,priority FROM tasks').get();
  assert.equal(db.segment('task',task.task_id),'SPORT');
  assert.equal(task.priority,'высокий');
  // The model is asked for a topic and told to rate importance from the text.
  assert.match(modelCalls[0].messages[0].content,/topic - тема письма: SPORT/);
  assert.match(modelCalls[0].messages[0].content,/Важность определяй только по тексту письма/);
  assert.deepEqual(modelCalls[0].response_format.json_schema.schema.properties.topic.enum,['SPORT','CONTENT','PROMO','OTHER']);
});

test('keywords decide when the model gives no usable topic; news is filed as news',async()=>{
  let w=world({a1b2c3d4:mail({subject:'Промокод для партнёра',inner:'Заведи код'})},reply({topic:'OTHER'}));
  await ingestGmailId(w.env,'a1b2c3d4');
  assert.equal(w.db.segment('email','a1b2c3d4'),'PROMO');
  assert.equal(w.db.segment('task',w.db.sqlite.prepare('SELECT task_id FROM tasks').get().task_id),'PROMO');

  w=world({a1b2c3d4:mail({subject:'Итоги тура',inner:'Обзор матчей'})},
    reply({classification:'NEWS',category:'НОВОСТЬ',action:'Действий не требуется',owner_action_required:false,topic:'SPORT'}));
  await ingestGmailId(w.env,'a1b2c3d4');
  assert.equal(w.db.segment('email','a1b2c3d4'),'NEWS');
  assert.equal(w.db.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,0);

  w=world({a1b2c3d4:mail({subject:'Договор аренды',inner:'Посмотри правки'})},reply({topic:'OTHER'}));
  await ingestGmailId(w.env,'a1b2c3d4');
  assert.equal(w.db.segment('email','a1b2c3d4'),'WORK');
});

test('without approved external AI the topic still comes from the subject',async()=>{
  const {db,env,modelCalls}=world({a1b2c3d4:mail({subject:'Баннер к премьере сериала'})});
  env.OUTLOOK_AI_ENABLED='false';
  const result=await ingestGmailId(env,'a1b2c3d4');
  assert.equal(result.needs_review,true);
  assert.equal(db.segment('email','a1b2c3d4'),'CONTENT');
  assert.equal(modelCalls.length,0);
});

test('a task keeps its first topic and is never filed under news or non-work',async()=>{
  const db=new Db(),env={DB:db};
  assert.equal(await setTaskSegmentOnce(env,'t1','SPORT'),true);
  assert.equal(await setTaskSegmentOnce(env,'t1','PROMO'),false);
  assert.equal(db.segment('task','t1'),'SPORT');
  assert.equal(await setTaskSegmentOnce(env,'t2','NEWS'),false);
  assert.equal(await setTaskSegmentOnce(env,'t2','NONWORK'),false);
  assert.equal(await setSegment(env,'email','e1','BOGUS'),false);
  assert.equal(await setSegment(env,'memo','e1','SPORT'),false);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM item_segments').get().n,1);
});

test('the poll lists the whole inbox only when the non-work section is on',async()=>{
  const queries=[];
  const env={DB:new Db(),JOBS:{send:async()=>{}},GMAIL_POLL_ENABLED:'true',ASSISTANT_SCOPE:'work',
    WORK_EMAIL:'worker@work.example',WORK_DOMAIN:'work.example',
    GOOGLE_CLIENT_ID:'c',GOOGLE_CLIENT_SECRET:'s',GMAIL_REFRESH_TOKEN:'r'};
  global.fetch=async url=>{
    const u=new URL(String(url));
    if(u.host==='oauth2.googleapis.com')return Response.json({access_token:'t'});
    queries.push(u.searchParams.get('q'));
    return Response.json({messages:[]});
  };
  await pollGmail(env);
  env.GMAIL_NONWORK_INDEX_ENABLED='true';
  await pollGmail(env);
  assert.match(queries[0],/from:\(@work\.example\)/);
  assert.doesNotMatch(queries[1],/work\.example/);
  for(const q of queries)assert.match(q,/-in:spam -in:trash/);
});

test('overview counts every section and each section lists its tasks and letters',async()=>{
  const w=world({s1s1s1s1:mail({id:'s1s1s1s1',subject:'Расписание тура',inner:'Подготовь расписание'}),
    n1n1n1n1:mail({id:'n1n1n1n1',work:false,subject:'Ваш заказ доставлен'})},reply({topic:'SPORT',priority:'высокий'}));
  await ingestGmailId(w.env,'s1s1s1s1');
  await ingestGmailId(w.env,'n1n1n1n1');
  const overview=await segmentOverview(w.env,'Проверка запущена.');
  assert.match(overview.text,/^Проверка запущена\.\n\n📨 Почта по разделам/);
  assert.match(overview.text,/⚽ Спорт: писем 1, открытых задач 1/);
  assert.match(overview.text,/🎟 Промокоды: писем 0, открытых задач 0/);
  assert.match(overview.text,/📭 Не рабочее: писем 1$/m);
  const buttons=overview.reply_markup.inline_keyboard.flat().map(b=>b.callback_data);
  for(const key of SEGMENT_ORDER)assert.ok(buttons.includes('seg:'+key),key);
  assert.ok(buttons.every(data=>Buffer.byteLength(data)<64));

  const sport=await segmentView(w.env,'SPORT');
  assert.match(sport.text,/^⚽ Спорт\n\nЗадачи:\n🔴 1\. Сделать/);
  assert.match(sport.text,/Письма:\n🔴 1\. Расписание тура - .*✅ задача/);
  const sportButtons=sport.reply_markup.inline_keyboard.flat().map(b=>b.callback_data);
  assert.ok(sportButtons.some(d=>d.startsWith('task:view:'))&&sportButtons.includes('email:view:s1s1s1s1'));

  const other=await segmentView(w.env,'NONWORK');
  assert.match(other.text,/1\. Shop <news@shop\.example> - Ваш заказ доставлен/);
  assert.equal(other.reply_markup.inline_keyboard.flat().some(b=>b.callback_data.startsWith('email:view:')),false);
  assert.match((await segmentView(w.env,'PROMO')).text,/Открытых задач нет\.\n\nПисьма:\nПисем нет\./);
  assert.match((await segmentView(w.env,'bogus')).text,/Почта по разделам/);
  assert.equal(isQuickAction('seg:SPORT'),true);
});

// Encrypts a refresh token exactly as the OAuth callback stores it.
async function storedToken(password,secret,token){
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('rahal-oauth-aes-256-v1\0'+password+'\0'+secret));
  const key=await crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(token)));
  return 'v1.'+Buffer.from(iv).toString('base64url')+'.'+Buffer.from(cipher).toString('base64url');
}
test('whole-inbox sorting starts when it is switched on, not at the old checkpoint',async()=>{
  const password='owner-password-that-is-long-enough',secret='client-secret';
  const run=async flag=>{
    const db=new Db(),queries=[];
    db.sqlite.prepare("INSERT INTO oauth_credentials(provider,encrypted_refresh_token,account_email,granted_scopes,updated_at) VALUES('gmail',?,?,?,?)")
      .run(await storedToken(password,secret,'refresh-token'),'owner@personal.example','gmail.readonly','2026-09-28T10:00:00.000Z');
    const env={DB:db,JOBS:{send:async()=>{}},GMAIL_POLL_ENABLED:'true',ASSISTANT_SCOPE:'work',
      WORK_EMAIL:'worker@work.example',WORK_DOMAIN:'work.example',GOOGLE_CLIENT_ID:'client',
      GOOGLE_CLIENT_SECRET:secret,SETUP_PASSWORD:password,GMAIL_NONWORK_INDEX_ENABLED:flag};
    global.fetch=async url=>{
      const u=new URL(String(url));
      if(u.host==='oauth2.googleapis.com')return Response.json({access_token:'t'});
      queries.push(u.searchParams.get('q'));
      return Response.json({messages:[]});
    };
    await pollGmail(env);
    await pollGmail(env);
    return queries.map(q=>Number(q.match(/after:(\d+)/)[1]));
  };
  const old=Math.floor(Date.parse('2026-09-28T10:00:00.000Z')/1000),before=Math.floor(Date.now()/1000);
  assert.deepEqual(await run('false'),[old,old]);
  const [first,second]=await run('true');
  assert.ok(first>=before,'listing must not start at the 28 September checkpoint');
  assert.equal(second,first,'the starting point is fixed once');
});
