// Regenerates docs/FLAGS.md from config/flags.json.
import {writeFileSync} from 'node:fs';
import {renderFlagsDoc} from './flags.mjs';
writeFileSync(new URL('../docs/FLAGS.md',import.meta.url),renderFlagsDoc());
console.log('docs/FLAGS.md updated');
