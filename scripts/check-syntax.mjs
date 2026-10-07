// Syntax-checks every JavaScript module so a new file cannot be missed.
import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root=fileURLToPath(new URL('..',import.meta.url));
const files=['src','scripts','test'].flatMap(dir=>
  readdirSync(join(root,dir)).filter(name=>/\.m?js$/.test(name)).sort().map(name=>join(dir,name)));
let failed=0;
for(const file of files){
  const result=spawnSync(process.execPath,['--check',join(root,file)],{encoding:'utf8'});
  if(result.status!==0){failed++;console.error('FAIL '+file+'\n'+result.stderr);}
}
if(failed){console.error(failed+' of '+files.length+' files failed the syntax check');process.exit(1);}
console.log('syntax ok: '+files.length+' files');
