import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registry,wranglerVars,flagsUsedInCode,renderFlagsDoc} from '../scripts/flags.mjs';

const data=registry();
const names=data.flags.map(flag=>flag.name);

test('flag registry is well formed',()=>{
  assert.equal(new Set(names).size,names.length,'duplicate flag name');
  for(const flag of data.flags){
    assert.match(flag.name,/^[A-Z][A-Z0-9_]*$/);
    assert.ok([true,false,null].includes(flag.staging),flag.name+': staging must be true, false or null');
    assert.ok(Object.hasOwn(data.groups,flag.group),flag.name+': unknown group '+flag.group);
    assert.ok(String(flag.effect||'').trim().length>10,flag.name+': effect is required');
  }
});

test('every switch read by the code is registered, and nothing stale remains',()=>{
  const used=flagsUsedInCode();
  assert.ok(used.length>=20,'flag scan found suspiciously few switches: '+used.length);
  assert.deepEqual(used.filter(name=>!names.includes(name)),[],'used in src but missing from config/flags.json');
  assert.deepEqual(names.filter(name=>!used.includes(name)),[],'registered but no longer read in src');
});

test('wrangler.jsonc matches the registry for every flag',()=>{
  const vars=wranglerVars();
  const drift=[];
  for(const flag of data.flags){
    const raw=vars[flag.name];
    if(raw!==undefined&&raw!=='true'&&raw!=='false')drift.push(flag.name+': wrangler value must be "true" or "false"');
    const actual=raw===undefined?null:raw==='true';
    if(actual!==flag.staging)drift.push(flag.name+': registry '+flag.staging+', wrangler '+actual);
  }
  assert.deepEqual(drift,[]);
  // A *_ENABLED variable in wrangler.jsonc that no code reads is a dead switch.
  const dead=Object.keys(vars).filter(name=>/_(?:ENABLED|NOTIFICATIONS)$/.test(name)&&!names.includes(name));
  assert.deepEqual(dead,[],'switches in wrangler.jsonc unknown to the registry');
});

test('docs/FLAGS.md is generated from the registry and up to date',()=>{
  const current=readFileSync(new URL('../docs/FLAGS.md',import.meta.url),'utf8');
  assert.equal(current,renderFlagsDoc(),'run: npm run flags:doc');
});
