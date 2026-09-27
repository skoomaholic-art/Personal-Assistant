import test from 'node:test';
import assert from 'node:assert/strict';
import {commandOf,getChatId,hasValidSecret,safeText,localDayBounds,isEmailObject,menuMarkup} from '../src/router.js';
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
 assert.ok(menuMarkup().inline_keyboard.flat().some(x=>x.callback_data==='today'));
});
