import test from 'node:test';
import assert from 'node:assert/strict';
import {transcribeTelegramVoice} from '../src/voice.js';

const nativeFetch=global.fetch;
test.afterEach(()=>{global.fetch=nativeFetch;});
test('voice transcription is disabled unless explicitly enabled',async()=>{
  global.fetch=async()=>{throw Error('Voice should never be downloaded');};
  assert.match((await transcribeTelegramVoice({},{
    file_id:'abcd0123456789',file_size:250,duration:10
  })).message,/выключены/);
});
test('oversized voice is refused before requesting or uploading it',async()=>{
  global.fetch=async()=>{throw Error('Oversized voice must not be downloaded');};
  assert.match((await transcribeTelegramVoice({
    TASK_VOICE_ENABLED:'true',TELEGRAM_BOT_TOKEN:'token',GROQ_API_KEY:'key'
  },{file_id:'abcd0123456789',file_size:11*1024*1024})).message,/большое/);
});
test('authorized Telegram voice is fetched and transcribed once without persisting audio',async()=>{
  const calls=[];
  global.fetch=async(url,options)=>{
    calls.push(String(url));
    if(String(url).endsWith('/getFile')){
      const args=JSON.parse(options.body);
      assert.equal(args.file_id,'abcd0123456789');
      return Response.json({ok:true,result:{file_path:'voice/audio123.oga',file_size:1500}});
    }
    if(String(url).includes('api.telegram.org/file/'))
      return new Response(new Uint8Array([79,103,103,83,0,1,2,3]),{status:200});
    if(String(url).includes('/audio/transcriptions')){
      assert.equal(options.headers.authorization,'Bearer groq-key');
      assert.equal(options.body.get('model'),'whisper-large-v3-turbo');
      assert.equal(options.body.get('file').name,'voice.ogg');
      return Response.json({text:'Напомни подготовить презентацию'});
    }
    throw Error('Unexpected URL: '+url);
  };
  const result=await transcribeTelegramVoice({
    TASK_VOICE_ENABLED:'true',TELEGRAM_BOT_TOKEN:'tg-token',GROQ_API_KEY:'groq-key'
  },{file_id:'abcd0123456789',file_size:1500,duration:8});
  assert.deepEqual(result,{ok:true,text:'Напомни подготовить презентацию'});
  assert.equal(calls.length,3);
  assert.ok(calls.some(x=>x.includes('/getFile')));
  assert.ok(calls.some(x=>x.includes('/audio/transcriptions')));
});
test('bad Telegram file path is rejected before fetching audio',async()=>{
  const calls=[];
  global.fetch=async(url)=>{
    calls.push(String(url));
    return Response.json({ok:true,result:{file_path:'../not-allowed.ogg'}});
  };
  const result=await transcribeTelegramVoice({
    TASK_VOICE_ENABLED:'true',TELEGRAM_BOT_TOKEN:'tg',GROQ_API_KEY:'groq'
  },{file_id:'abcd0123456789'});
  assert.equal(result.ok,false);
  assert.equal(calls.length,1);
});
