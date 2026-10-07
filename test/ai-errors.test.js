import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {AiError,throwForResponse,classifyAiError,aiFailureText,recordAiFailure} from '../src/ai-errors.js';
import {taskTalk} from '../src/task-dialog.js';

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
  async batch(statements){const out=[];for(const s of statements)out.push(await s.all());return out;}
  last(){
    const row=this.sqlite.prepare("SELECT mode,data FROM states WHERE chat_id='system:ai-last-error'").get();
    return row?{kind:row.mode,...JSON.parse(row.data)}:null;
  }
}
const failure=(status,body,headers={})=>new Response(JSON.stringify(body),{status,headers});
const caught=async promise=>{try{await promise;}catch(error){return error;}throw Error('expected a rejection');};
const nativeFetch=global.fetch;
test.afterEach(()=>{global.fetch=nativeFetch;});

test('provider responses are classified by status with code and retry delay',async()=>{
  const limited=await caught(throwForResponse(failure(429,
    {error:{message:'Rate limit reached for model on tokens per day',type:'tokens',code:'rate_limit_exceeded'}},
    {'retry-after':'740'})));
  assert.ok(limited instanceof AiError);
  assert.deepEqual([limited.kind,limited.status,limited.code,limited.retryAfter],['rate_limit',429,'rate_limit_exceeded',740]);
  assert.match(aiFailureText(limited),/Лимит бесплатной модели исчерпан\. Попробуй через 13 мин\./);
  assert.equal((await caught(throwForResponse(failure(401,{error:{message:'Invalid API Key',code:'invalid_api_key'}})))).kind,'auth');
  assert.equal((await caught(throwForResponse(failure(403,{})))).kind,'auth');
  assert.equal((await caught(throwForResponse(failure(503,{})))).kind,'provider');
  assert.equal((await caught(throwForResponse(failure(413,{})))).kind,'too_large');
  const rejected=await caught(throwForResponse(failure(400,{error:{message:'model decommissioned',code:'model_decommissioned'}})));
  assert.equal(rejected.kind,'request');
  assert.match(aiFailureText(rejected),/Модель отклонила запрос \(model_decommissioned\)/);
  // A body that is not JSON still yields the status.
  assert.equal((await caught(throwForResponse(new Response('<html>bad gateway',{status:502})))).status,502);
});

test('non-HTTP failures are classified too, and every reason says nothing changed',()=>{
  assert.equal(classifyAiError(Object.assign(Error('x'),{name:'TimeoutError'})).kind,'timeout');
  assert.equal(classifyAiError(new SyntaxError('Unexpected token')).kind,'bad_output');
  assert.equal(classifyAiError(Error('Groq intent absent')).kind,'unknown');
  for(const kind of ['rate_limit','auth','too_large','provider','request','timeout','bad_output','unknown']){
    const text=aiFailureText(new AiError(kind));
    assert.match(text,/^⚠️ .+ Ничего не изменено\.$/,kind);
  }
  assert.match(aiFailureText(new AiError('rate_limit',{retryAfter:20})),/через 20 сек\./);
});

test('the recorded failure never contains prompt text, model output or keys',async()=>{
  const DB=new D1();
  const error=await caught(throwForResponse(failure(400,{error:{message:'Failed to validate JSON',
    code:'json_validate_failed',failed_generation:'SECRET-MODEL-OUTPUT about the owner'}})));
  await recordAiFailure({DB},'intent',error);
  const saved=DB.last();
  assert.deepEqual(saved,{kind:'request',where:'intent',status:400,code:'json_validate_failed',
    detail:'Failed to validate JSON [generated 35 chars, cut off]'});
  assert.equal(JSON.stringify(saved).includes('SECRET-MODEL-OUTPUT'),false);
  // A broken database must not turn a readable failure into a crash.
  await recordAiFailure({DB:{prepare(){throw Error('down');}}},'intent',error);
});

test('the dialogue reports the real reason and records it',async()=>{
  const DB=new D1();
  const env={DB,GROQ_API_KEY:'fake-groq-key',TELEGRAM_CHAT_ID:'123'};
  global.fetch=async url=>{
    assert.match(String(url),/api\.groq\.com/);
    return failure(429,{error:{message:'Rate limit reached',code:'rate_limit_exceeded'}},{'retry-after':'30'});
  };
  const answer=await taskTalk(env,'123','Привет',1);
  assert.match(answer.text,/Лимит бесплатной модели исчерпан\. Попробуй через 30 сек\. Сервис: groq\. Ничего не изменено\./);
  assert.equal(answer.text.includes('fake-groq-key'),false);
  assert.deepEqual([DB.last().kind,DB.last().status,DB.last().code],['rate_limit',429,'rate_limit_exceeded']);
  assert.equal(DB.last().provider,'groq');
  assert.deepEqual(DB.last().attempts,[{provider:'groq',kind:'rate_limit',status:429,code:'rate_limit_exceeded'}]);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,0);
});
