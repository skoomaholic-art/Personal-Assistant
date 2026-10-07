// Turns a failed model call into a reason the owner can act on, and keeps the
// last failure in D1 for diagnosis. Only the provider's status, error code and
// short error message are kept: never the prompt, the reply or any key.
const STATE_KEY='system:ai-last-error';
const clip=(value,max)=>String(value??'').replace(/\s+/g,' ').trim().slice(0,max);

export class AiError extends Error {
  constructor(kind,{status=0,code='',detail='',retryAfter=0}={}){
    super('AI '+kind+(status?' HTTP '+status:''));
    this.name='AiError';this.kind=kind;this.status=status;
    this.code=clip(code,80);this.detail=clip(detail,300);this.retryAfter=retryAfter;
  }
}
function kindOf(status){
  if(status===429)return 'rate_limit';
  if(status===401||status===403)return 'auth';
  if(status===413)return 'too_large';
  if(status>=500)return 'provider';
  return 'request';
}
// Call with a non-OK provider response; always throws.
export async function throwForResponse(response){
  let code='',detail='';
  try{
    const body=JSON.parse((await response.text()).slice(0,4000));
    code=body?.error?.code||body?.error?.type||'';
    detail=body?.error?.message||'';
  }catch{/* keep the status only */}
  const retryAfter=Number(response.headers.get('retry-after'))||0;
  throw new AiError(kindOf(response.status),{status:response.status,code,detail,retryAfter});
}
export function classifyAiError(error){
  if(error instanceof AiError)return error;
  if(error?.name==='TimeoutError'||error?.name==='AbortError')return new AiError('timeout');
  if(error instanceof SyntaxError)return new AiError('bad_output',{detail:'model reply was not valid JSON'});
  return new AiError('unknown',{detail:error?.name||'Error'});
}
export function aiFailureText(error){
  const e=classifyAiError(error);
  const wait=e.retryAfter>0?' Попробуй через '+(e.retryAfter<90?Math.ceil(e.retryAfter)+' сек.':Math.ceil(e.retryAfter/60)+' мин.'):' Попробуй позже.';
  const reason={
    rate_limit:'Лимит бесплатной модели Groq исчерпан.'+wait,
    auth:'Groq не принял ключ доступа. Нужно обновить GROQ_API_KEY в Cloudflare.',
    too_large:'Сообщение вместе с контекстом слишком большое для модели. Очисти чат командой /reset и повтори.',
    provider:'Сервис модели Groq сейчас недоступен. Попробуй через пару минут.',
    request:'Модель отклонила запрос'+(e.code?' ('+e.code+')':'')+'. Это ошибка настройки, а не твоего сообщения.',
    timeout:'Модель не ответила вовремя. Повтори сообщение.',
    bad_output:'Модель вернула ответ, который не удалось разобрать. Повтори сообщение.',
    unknown:'Не получилось обработать сообщение. Повтори, пожалуйста.'
  }[e.kind];
  return '⚠️ '+reason+' Ничего не изменено.';
}
export async function recordAiFailure(env,where,error){
  const e=classifyAiError(error);
  console.error(JSON.stringify({event:'ai_call_failed',where,kind:e.kind,status:e.status,code:e.code}));
  try{
    await env.DB.prepare(
      'INSERT INTO states(chat_id,mode,data,updated_at) VALUES(?,?,?,?) '+
      'ON CONFLICT(chat_id) DO UPDATE SET mode=excluded.mode,data=excluded.data,updated_at=excluded.updated_at'
    ).bind(STATE_KEY,e.kind,JSON.stringify({where:clip(where,40),status:e.status,code:e.code,detail:e.detail}),
      Math.floor(Date.now()/1000)).run();
  }catch{/* diagnosis must never break the reply */}
  return e;
}
