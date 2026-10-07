import test from 'node:test';
import assert from 'node:assert/strict';
import {aiProviders,aiConfigured,chatCompletion} from '../src/ai.js';
import {AiError} from '../src/ai-errors.js';

const schema={type:'object',properties:{intent:{type:'string',enum:['chat','tasks']},reply:{type:'string'}},
  required:['intent','reply'],additionalProperties:false};
const request=(extra={})=>({messages:[{role:'system',content:'SYS'},{role:'user',content:'Привет'}],...extra});
const ok=content=>Response.json({choices:[{message:{content}}]});
const fail=(status,code='')=>new Response(JSON.stringify({error:{code,message:'m'}}),{status});
// Routes each provider host to a handler and records what was sent.
function mock(handlers){
  const calls=[];
  global.fetch=async(url,init)=>{
    const host=new URL(String(url)).host,sent=JSON.parse(init.body);
    calls.push({host,url:String(url),sent,auth:init.headers.authorization});
    const handler=handlers[host];
    if(!handler)throw Error('unexpected host '+host);
    return handler(sent);
  };
  return calls;
}
const nativeFetch=global.fetch;
test.afterEach(()=>{global.fetch=nativeFetch;});

test('providers are listed in priority order and only when fully configured',()=>{
  assert.deepEqual(aiProviders({}),[]);
  assert.equal(aiConfigured({}),false);
  assert.deepEqual(aiProviders({GROQ_API_KEY:'g'}).map(p=>[p.name,p.model,p.strict]),[['groq','openai/gpt-oss-20b',true]]);
  assert.deepEqual(aiProviders({GROQ_API_KEY:'g',GROQ_MODEL:'qwen/qwen3.8-27b'}).map(p=>p.strict),[false]);
  const all=aiProviders({GROQ_API_KEY:'g',CEREBRAS_API_KEY:'c',AI_BASE_URL:'https://llm.example/v1/',AI_API_KEY:'k',AI_MODEL:'m'});
  assert.deepEqual(all.map(p=>p.name),['custom','cerebras','groq']);
  assert.equal(all[0].base,'https://llm.example/v1');
  assert.equal(all[1].model,'gpt-oss-120b');
  // An incomplete or non-HTTPS custom provider is ignored rather than half-used.
  assert.deepEqual(aiProviders({AI_BASE_URL:'https://llm.example/v1',AI_API_KEY:'k'}),[]);
  assert.deepEqual(aiProviders({AI_BASE_URL:'http://llm.example/v1',AI_API_KEY:'k',AI_MODEL:'m'}),[]);
  assert.deepEqual(aiProviders({AI_BASE_URL:'not a url',AI_API_KEY:'k',AI_MODEL:'m'}),[]);
  assert.deepEqual(aiProviders({CEREBRAS_API_KEY:'   '}),[]);
});

test('the first configured provider answers and later ones are not contacted',async()=>{
  const calls=mock({'api.cerebras.ai':()=>ok('Здравствуйте')});
  const result=await chatCompletion({CEREBRAS_API_KEY:'c-key',GROQ_API_KEY:'g-key'},request({maxTokens:300}));
  assert.deepEqual(result,{value:'Здравствуйте',provider:'cerebras'});
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://api.cerebras.ai/v1/chat/completions');
  assert.equal(calls[0].auth,'Bearer c-key');
  assert.equal(calls[0].sent.model,'gpt-oss-120b');
  assert.equal(calls[0].sent.max_completion_tokens,300);
  assert.equal('response_format' in calls[0].sent,false);
});

test('a rate-limited, failing or rejecting provider falls through to the next',async()=>{
  for(const first of [()=>fail(429,'rate_limit_exceeded'),()=>fail(503),()=>fail(401,'invalid_api_key'),
    ()=>fail(400,'model_not_found'),()=>{throw Object.assign(Error('t'),{name:'TimeoutError'});},()=>ok('')]){
    const calls=mock({'api.cerebras.ai':first,'api.groq.com':()=>ok('ответ')});
    const result=await chatCompletion({CEREBRAS_API_KEY:'c',GROQ_API_KEY:'g'},request());
    assert.deepEqual(result,{value:'ответ',provider:'groq'});
    assert.deepEqual(calls.map(c=>c.host),['api.cerebras.ai','api.groq.com']);
  }
});

test('when every provider fails the first failure is reported with all attempts',async()=>{
  mock({'api.cerebras.ai':()=>fail(429,'rate_limit_exceeded'),'api.groq.com':()=>fail(401,'invalid_api_key')});
  await assert.rejects(chatCompletion({CEREBRAS_API_KEY:'c',GROQ_API_KEY:'g'},request()),error=>{
    assert.ok(error instanceof AiError);
    assert.deepEqual([error.kind,error.status,error.provider],['rate_limit',429,'cerebras']);
    assert.deepEqual(error.attempts,[{provider:'cerebras',kind:'rate_limit',status:429,code:'rate_limit_exceeded'},
      {provider:'groq',kind:'auth',status:401,code:'invalid_api_key'}]);
    return true;
  });
  await assert.rejects(chatCompletion({},request()),error=>error.kind==='auth');
});

test('structured replies use a strict schema where supported and JSON mode elsewhere',async()=>{
  let calls=mock({'api.groq.com':()=>ok('{"intent":"tasks","reply":""}')});
  let result=await chatCompletion({GROQ_API_KEY:'g'},request({schema,schemaName:'assistant_intent'}));
  assert.deepEqual(result.value,{intent:'tasks',reply:''});
  assert.equal(calls[0].sent.response_format.type,'json_schema');
  assert.deepEqual(calls[0].sent.response_format.json_schema,{name:'assistant_intent',strict:true,schema});
  assert.equal(calls[0].sent.reasoning_effort,'low');
  assert.equal(calls[0].sent.messages[0].content,'SYS');

  calls=mock({'api.cerebras.ai':()=>ok('```json\n{"intent":"chat","reply":"Привет!"}\n```')});
  const original=request({schema});
  result=await chatCompletion({CEREBRAS_API_KEY:'c'},original);
  assert.deepEqual(result.value,{intent:'chat',reply:'Привет!'});
  assert.deepEqual(calls[0].sent.response_format,{type:'json_object'});
  assert.equal('reasoning_effort' in calls[0].sent,false);
  assert.match(calls[0].sent.messages[0].content,/^SYS\n.*intent: chat\|tasks; reply: string$/);
  // The caller's messages are not mutated between providers.
  assert.equal(original.messages[0].content,'SYS');
});

test('an unusable structured reply moves on to the next provider',async()=>{
  for(const bad of ['not json','[1,2]','{"intent":"launch_missiles","reply":""}']){
    const calls=mock({'api.cerebras.ai':()=>ok(bad),'api.groq.com':()=>ok('{"intent":"chat","reply":"ok"}')});
    const result=await chatCompletion({CEREBRAS_API_KEY:'c',GROQ_API_KEY:'g'},
      request({schema,accept:object=>['chat','tasks'].includes(object.intent)}));
    assert.equal(result.provider,'groq',bad);
    assert.equal(calls.length,2);
  }
});
