import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker from '../src/worker.js';
import {STAGING_SCHEMA_STATEMENTS} from '../src/staging-schema.js';

const url='https://rahal-mamut-staging.alexandr-petrossov.workers.dev/health/db';
const required=['emails','history','states','tasks','telegram_updates'];
class FakeStagingDB {
  constructor() {this.tables=new Set();this.batchCalls=0;}
  prepare(sql) {
    return {sql,all:async()=>({results:[...this.tables].sort().map(name=>({name}))})};
  }
  async batch(statements) {
    this.batchCalls++;
    for(const statement of statements) {
      const match=statement.sql.match(/^CREATE TABLE IF NOT EXISTS\\s+(\\w+)/i);
      if(match)this.tables.add(match[1]);
    }
    return statements.map(()=>({success:true}));
  }
}
test('staging bootstrap exactly matches the migration SQL',()=>{
  const migration=readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8');
  const expected=migration.replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean);
  assert.deepEqual(STAGING_SCHEMA_STATEMENTS,expected);
  assert.equal(STAGING_SCHEMA_STATEMENTS.length,10);
  assert.ok(STAGING_SCHEMA_STATEMENTS.every(sql=>/^CREATE (TABLE|INDEX) IF NOT EXISTS /i.test(sql)));
});
test('schema health never initializes D1 without explicit flag',async()=>{
  const db=new FakeStagingDB();
  const res=await worker.fetch(new Request(url),{DB:db,STAGING_SCHEMA_BOOTSTRAP:'false'});
  assert.equal(res.status,503);
  assert.equal(db.batchCalls,0);
});
test('temporary staging bootstrap creates only required tables, and is idempotent',async()=>{
  const db=new FakeStagingDB();
  const env={DB:db,STAGING_SCHEMA_BOOTSTRAP:'true',MAIL_INGEST_ENABLED:'false',WORKER_EMAIL_NOTIFICATIONS:'false'};
  let res=await worker.fetch(new Request(url),env);
  assert.equal(res.status,200);
  assert.deepEqual((await res.json()).tables,required);
  assert.equal(db.batchCalls,1);
  res=await worker.fetch(new Request(url),env);
  assert.equal(res.status,200);
  assert.deepEqual((await res.json()).tables,required);
  env.STAGING_SCHEMA_BOOTSTRAP='false';
  res=await worker.fetch(new Request(url),env);
  assert.equal(res.status,200);
  assert.equal(db.batchCalls,2);
});
test('bootstrap refuses other host even if flag is set',async()=>{
  const db=new FakeStagingDB();
  const res=await worker.fetch(new Request('https://example.org/health/db'),{DB:db,STAGING_SCHEMA_BOOTSTRAP:'true'});
  assert.equal(res.status,503);
  assert.equal(db.batchCalls,0);
});
test('bootstrap refuses enabled email notifications or ingestion',async()=>{
  for(const toggle of ['MAIL_INGEST_ENABLED','WORKER_EMAIL_NOTIFICATIONS']){
    const db=new FakeStagingDB();
    const res=await worker.fetch(new Request(url),{DB:db,STAGING_SCHEMA_BOOTSTRAP:'true',[toggle]:'true'});
    assert.equal(res.status,503);
    assert.equal(db.batchCalls,0);
  }
});
