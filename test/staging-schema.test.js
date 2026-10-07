import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker from '../src/worker.js';

const url='https://rahal-mamut-staging.alexandr-petrossov.workers.dev/health/db';
const expected=['emails','history','states','tasks','telegram_updates'];
function fakeDatabase(tables) {
  return {
    prepare(sql) {
      assert.match(sql,/^SELECT name FROM sqlite_master/);
      return {all:async()=>({results:tables.map(name=>({name}))})};
    },
    async batch(){throw new Error('Read-only DB health route must never execute SQL writes');}
  };
}
test('canonical D1 migration only creates idempotent tables and indexes',()=>{
  const migration=readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8');
  const statements=migration.replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean);
  assert.equal(statements.length,10);
  assert.ok(statements.every(sql=>/^CREATE (TABLE|INDEX) IF NOT EXISTS /i.test(sql)));
});
test('DB health reports unavailable without binding',async()=>{
  const res=await worker.fetch(new Request(url),{});
  assert.equal(res.status,503);
  assert.equal((await res.json()).database,'unbound');
});
test('DB health reports incomplete schema without mutating it',async()=>{
  const res=await worker.fetch(new Request(url),{DB:fakeDatabase([])});
  assert.equal(res.status,503);
  assert.deepEqual((await res.json()).tables,[]);
});
test('DB health verifies five table names without running migrations',async()=>{
  const res=await worker.fetch(new Request(url),{
    DB:fakeDatabase(expected),STAGING_SCHEMA_BOOTSTRAP:'true'
  });
  assert.equal(res.status,200);
  const result=await res.json();
  assert.equal(result.ok,true);
  assert.equal(result.phase,'staging');
  assert.deepEqual(result.tables,expected);
});
