// Telegram audio is downloaded only after the webhook has authenticated the
// owner's private chat. Raw audio is kept in memory and never stored in D1.
const MAX_AUDIO_BYTES=10*1024*1024;
const MAX_VOICE_SECONDS=600;
export async function transcribeTelegramVoice(env,voice) {
  if(env.ASSISTANT_SCOPE==='work'&&env.OUTLOOK_AI_ENABLED!=='true')
    return {ok:false,message:'Голосовые рабочие сообщения не передаю внешней AI-модели без разрешения. Пришли текстом.'};
  if(env.TASK_VOICE_ENABLED!=='true')
    return {ok:false,message:'Голосовые пока не включены. Пришли, пожалуйста, сообщение текстом.'};
  if(!env.TELEGRAM_BOT_TOKEN||!env.GROQ_API_KEY)
    return {ok:false,message:'Распознавание голоса не настроено. Пришли текст.'};
  const fileId=String(voice?.file_id||'');
  if(!/^[a-zA-Z0-9_-]{10,300}$/.test(fileId))
    return {ok:false,message:'Не удалось прочитать голосовое сообщение.'};
  if(Number(voice?.file_size||0)>MAX_AUDIO_BYTES)
    return {ok:false,message:'Голосовое слишком большое. Запиши сообщение короче 10 МБ.'};
  if(Number(voice?.duration||0)>MAX_VOICE_SECONDS)
    return {ok:false,message:'Голосовое слишком длинное. Поддерживаются записи до 10 минут.'};
  try {
    const token=env.TELEGRAM_BOT_TOKEN;
    const info=await fetch('https://api.telegram.org/bot'+token+'/getFile',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({file_id:fileId}),signal:AbortSignal.timeout(10000)
    });
    if(!info.ok)throw Error('Telegram getFile HTTP '+info.status);
    const payload=await info.json();
    const path=String(payload?.result?.file_path||'');
    if(!payload?.ok||!path||path.startsWith('/')||path.includes('..')||
      !/^[a-zA-Z0-9_./-]{1,300}$/.test(path))
      throw Error('Invalid Telegram file path');
    if(Number(payload.result?.file_size||0)>MAX_AUDIO_BYTES)
      return {ok:false,message:'Голосовое превышает ограничение 10 МБ.'};
    const audio=await fetch('https://api.telegram.org/file/bot'+token+'/'+path,{
      method:'GET',signal:AbortSignal.timeout(18000)
    });
    if(!audio.ok)throw Error('Telegram audio HTTP '+audio.status);
    const bytes=await audio.arrayBuffer();
    if(!bytes.byteLength||bytes.byteLength>MAX_AUDIO_BYTES)
      return {ok:false,message:'Голосовое пустое или слишком большое.'};
    const ext=path.toLowerCase().split('.').pop();
    const mime=ext==='mp3'?'audio/mpeg':ext==='mp4'?'audio/mp4':
      ext==='m4a'?'audio/mp4':ext==='webm'?'audio/webm':'audio/ogg';
    const filename=ext==='mp3'?'voice.mp3':ext==='mp4'?'voice.mp4':
      ext==='m4a'?'voice.m4a':ext==='webm'?'voice.webm':'voice.ogg';
    const form=new FormData();
    form.set('model','whisper-large-v3-turbo');
    form.set('response_format','json');
    form.set('file',new Blob([bytes],{type:mime}),filename);
    // Do not expose the Telegram download URL to Groq; upload only audio.
    const result=await fetch('https://api.groq.com/openai/v1/audio/transcriptions',{
      method:'POST',headers:{authorization:'Bearer '+env.GROQ_API_KEY},
      body:form,signal:AbortSignal.timeout(24000)
    });
    if(!result.ok)throw Error('Groq transcription HTTP '+result.status);
    const data=await result.json();
    const text=String(data?.text||'').trim().slice(0,2500);
    if(!text)return {ok:false,message:'Не удалось разобрать речь. Запиши ещё раз или напиши текстом.'};
    return {ok:true,text};
  } catch(error) {
    console.error(JSON.stringify({event:'voice_transcription_failed',error_type:error?.name||'Error'}));
    return {ok:false,message:'Не удалось распознать голосовое. Попробуй ещё раз или напиши текстом.'};
  }
}
