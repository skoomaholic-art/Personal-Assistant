// Shared helpers for the feature-flag registry (config/flags.json).
import {readFileSync,readdirSync} from 'node:fs';

const at=path=>new URL('../'+path,import.meta.url);
export const registry=()=>JSON.parse(readFileSync(at('config/flags.json'),'utf8'));
// wrangler.jsonc is kept comment-free so it stays valid JSON.
export const wranglerVars=()=>JSON.parse(readFileSync(at('wrangler.jsonc'),'utf8')).vars||{};

// Every env.NAME compared with 'true' or 'false' anywhere in src is a switch.
export function flagsUsedInCode(){
  const found=new Set();
  for(const name of readdirSync(at('src')).filter(x=>x.endsWith('.js'))){
    const source=readFileSync(at('src/'+name),'utf8');
    for(const match of source.matchAll(/env\.([A-Z][A-Z0-9_]*)\s*[!=]==?\s*'(?:true|false)'/g))
      found.add(match[1]);
  }
  return [...found].sort();
}

const state=flag=>flag.staging===true?'включён':flag.staging===false?'выключен':'не задан (выключен)';
const cell=value=>String(value||'').replace(/\|/g,'\\|');
export function renderFlagsDoc(data=registry()){
  const lines=['# Переключатели функций','',
    '> Файл создан автоматически из `config/flags.json` командой `npm run flags:doc`. Не редактируйте его вручную.','',
    'Значения в столбце «Staging» совпадают с `vars` в `wrangler.jsonc`; совпадение и полноту списка проверяет `test/flags.test.js`. '+
    'В `wrangler.jsonc` задано `keep_vars: true`, поэтому значения, изменённые в панели Cloudflare, здесь не видны.',''];
  const open=data.flags.filter(flag=>flag.note);
  if(open.length){
    lines.push('## Требует решения','');
    for(const flag of open)lines.push('- `'+flag.name+'` ('+state(flag)+'): '+flag.note);
    lines.push('');
  }
  for(const [group,title] of Object.entries(data.groups)){
    lines.push('## '+title,'','| Флаг | Staging | Что включает | Что нужно для включения |','|---|---|---|---|');
    for(const flag of data.flags.filter(x=>x.group===group))
      lines.push('| `'+flag.name+'` | '+state(flag)+' | '+cell(flag.effect)+' | '+cell(flag.needs||'-')+' |');
    lines.push('');
  }
  return lines.join('\n');
}
