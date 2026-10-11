import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

// Ship the contract ABI with the standalone backend image; never resolve sibling source at runtime.
const source = new URL('./client.mjs', import.meta.url);
const target = new URL('../../../SingleSparkBackend/native-launch/chains/solana/program/client.mjs', import.meta.url);
const files = [[source,target],...['package.json','index.cjs','index.d.ts'].map(name => [
  new URL(`./shared/bigint-buffer/${name}`,import.meta.url),
  new URL(`../../../SingleSparkBackend/native-launch/shared/bigint-buffer/${name}`,import.meta.url),
])];
for (const [from,to] of files) {
  if (process.argv.includes('--check')) assert.equal(readFileSync(to, 'utf8'), readFileSync(from, 'utf8'), 'Run npm run export:backend in the Solana contract package');
  else { mkdirSync(dirname(fileURLToPath(to)), { recursive: true }); copyFileSync(from, to); }
}
