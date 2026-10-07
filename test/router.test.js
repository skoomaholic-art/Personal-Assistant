import test from 'node:test';
import assert from 'node:assert/strict';
import {commandOf,getChatId,hasValidSecret,safeText,localDayBounds,isEmailObject,menuMarkup,moreMarkup} from '../src/router.js';
const message=text=>({message:{chat:{id:123},text}});
test('menu and cancel override arbitrary input',()=>{
 assert.equal(commandOf(message('/menu')),'menu');
 assert.equal(commandOf(message('МЕНЮ')),'menu');
 assert.equal(commandOf(message('/cancel')),'cancel');
 assert.equal(commandOf(message('Отмена')),'cancel');
 assert.equal(commandOf(message('/reset')),'reset');
 assert.equal(commandOf(message('/menu@MyBot')),'menu');
});
test('existing Russian intent and callbacks',()=>{
 assert.equal(commandOf(message('что важного?')),'important');
 assert.equal(commandOf({callback_query:{message:{chat:{id:123}},data:'task:done:abc'}}),'task:done:abc');
 assert.equal(getChatId({callback_query:{message:{chat:{id:123}},data:'menu'}}),'123');
});
test('token check rejects wrong and empty secret',()=>{
 assert.equal(hasValidSecret('valid_secret','valid_secret'),true);
 assert.equal(hasValidSecret('valid_secret','invalid_secret'),false);
 assert.equal(hasValidSecret('',''),false);
 assert.equal(hasValidSecret(null,'something'),false);
});
test('Telegram text is bounded',()=>{
 assert.ok(safeText('x'.repeat(9000)).length<=3900);
 assert.equal(safeText('OK'),'OK');
});
test('email ID is validated',()=>{
 assert.equal(isEmailObject({email_id:'18a4b9f21',subject:'Hi'}),true);
 assert.equal(isEmailObject({email_id:'a/b',subject:'Hi'}),false);
});
test('local day bounds honor UTC+5',()=>{
 const b=localDayBounds(new Date('2026-09-27T20:30:00Z'),300);
 assert.equal(b.start.toISOString(),'2026-09-27T19:00:00.000Z');
 assert.equal(b.end.toISOString(),'2026-09-28T19:00:00.000Z');
});
test('menu callback wiring',()=>{
 const main=menuMarkup().inline_keyboard.flat(),more=moreMarkup().inline_keyboard.flat();
 const actions=[...main,...more].map(x=>x.callback_data);
 // Task lifecycle sections and the way back are always reachable.
 for(const action of ['tasks','progress','done','news','report','newtask','mail','more'])
   assert.ok(main.some(x=>x.callback_data===action),action);
 for(const action of ['review','important','mail:refresh','menu'])
   assert.ok(more.some(x=>x.callback_data===action),action);
 assert.equal(new Set(actions).size,actions.length);
 assert.ok(actions.every(x=>typeof x==='string'&&x&&Buffer.byteLength(x)<64));
 // The Mini App button appears only for an https .../app URL; otherwise voice help.
 assert.ok(main.some(x=>x.callback_data==='voicehelp'));
 const withPanel=menuMarkup('https://assistant.example/app').inline_keyboard.flat();
 assert.equal(withPanel.find(x=>x.web_app)?.web_app.url,'https://assistant.example/app');
 assert.equal(menuMarkup('http://assistant.example/app').inline_keyboard.flat().some(x=>x.web_app),false);
 // The daily view stays available as a command even though it left the menu.
 assert.equal(commandOf(message('/today')),'today');
});
