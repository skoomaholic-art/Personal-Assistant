// One place for chat-model calls. Providers are OpenAI-compatible endpoints,
// tried in order; a provider is used only when its key is configured. If one
// is rate-limited, down or rejects the request, the next one answers instead.
import {AiError,throwForResponse,classifyAiError} from './ai-errors.js';

// Models on Groq that accept a strict JSON schema.
const GROQ_STRICT=new Set(['openai/gpt-oss-20b','openai/gpt-oss-120b']);
const clean=value=>String(value??'').trim();

function validBase(url){
  try{const parsed=new URL(url);return parsed.protocol==='https:'?url.replace(/\/+$/,''):'';}
  catch{return '';}
}
export function aiProviders(env){
  const list=[];
  // Any other OpenAI-compatible service, without a code change.
  const base=validBase(clean(env.AI_BASE_URL));
  if(base&&clean(env.AI_API_KEY)&&clean(env.AI_MODEL))
    list.push({name:'custom',base,key:clean(env.AI_API_KEY),model:clean(env.AI_MODEL),strict:false});
  if(clean(env.CEREBRAS_API_KEY))
    list.push({name:'cerebras',base:'https://api.cerebras.ai/v1',key:clean(env.CEREBRAS_API_KEY),
      model:clean(env.CEREBRAS_MODEL)||'gpt-oss-120b',strict:false});
  if(clean(env.GROQ_API_KEY)){
    const model=clean(env.GROQ_MODEL)||'openai/gpt-oss-20b';
    list.push({name:'groq',base:'https://api.groq.com/openai/v1',key:clean(env.GROQ_API_KEY),
      model,strict:GROQ_STRICT.has(model),reasoning:GROQ_STRICT.has(model)});
  }
  return list;
}
export const aiConfigured=env=>aiProviders(env).length>0;

// A compact description of the expected JSON for providers without schema support.
function describe(schema){
  return Object.entries(schema.properties).map(([name,spec])=>
    name+': '+(spec.enum?spec.enum.join('|'):spec.type)).join('; ');
}
function body(provider,request){
  const messages=request.messages.map(message=>({...message}));
  const out={model:provider.model,temperature:request.temperature??0.3,
    max_completion_tokens:request.maxTokens??600,messages};
  if(provider.reasoning)out.reasoning_effort='low';
  if(request.schema){
    if(provider.strict)out.response_format={type:'json_schema',json_schema:{
      name:request.schemaName||'reply',strict:true,schema:request.schema}};
    else{
      out.response_format={type:'json_object'};
      messages[0]={...messages[0],content:messages[0].content+
        '\nВерни один JSON-объект со всеми полями (пустая строка, если поле не нужно): '+describe(request.schema)};
    }
  }
  return out;
}
async function callOne(provider,request){
  try{return await send(provider,request);}
  catch(error){
    // A strict schema can reject the model's own output. Ask once more in
    // plain JSON mode and validate the reply here instead.
    if(provider.strict&&request.schema&&error instanceof AiError&&
       error.kind==='request'&&error.code==='json_validate_failed'){
      console.log(JSON.stringify({event:'ai_strict_schema_retry',provider:provider.name}));
      return send({...provider,strict:false},request);
    }
    throw error;
  }
}
async function send(provider,request){
  const response=await fetch(provider.base+'/chat/completions',{
    method:'POST',
    headers:{authorization:'Bearer '+provider.key,'content-type':'application/json'},
    body:JSON.stringify(body(provider,request)),
    signal:AbortSignal.timeout(request.timeoutMs??20000)
  });
  if(!response.ok)await throwForResponse(response);
  const content=clean((await response.json())?.choices?.[0]?.message?.content);
  if(!content)throw new AiError('bad_output',{detail:'empty reply'});
  if(!request.schema)return content;
  // Some models wrap JSON in a code fence despite JSON mode.
  const object=JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g,''));
  if(!object||typeof object!=='object'||Array.isArray(object))
    throw new AiError('bad_output',{detail:'reply is not a JSON object'});
  if(request.accept&&!request.accept(object))
    throw new AiError('bad_output',{detail:'reply failed validation'});
  return object;
}
// Returns {value, provider}. Throws the first provider's failure when every
// provider fails, with all attempts attached as error.attempts.
export async function chatCompletion(env,request){
  const providers=aiProviders(env);
  if(!providers.length)throw new AiError('auth',{detail:'no AI provider configured'});
  const attempts=[];
  for(const provider of providers){
    try{
      const value=await callOne(provider,request);
      if(attempts.length)console.log(JSON.stringify({event:'ai_fallback_used',
        provider:provider.name,failed:attempts.map(a=>a.provider+':'+a.kind)}));
      return {value,provider:provider.name};
    }catch(error){
      const failure=classifyAiError(error);
      failure.provider=provider.name;
      attempts.push({provider:provider.name,kind:failure.kind,status:failure.status,code:failure.code,error:failure});
    }
  }
  const first=attempts[0].error;
  first.attempts=attempts.map(({provider,kind,status,code})=>({provider,kind,status,code}));
  throw first;
}
