import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

// Ship the contract ABI with the standalone backend image; never resolve sibling source at runtime.
const source = new URL('./client.mjs', import.meta.url);
const target = new URL('../../SingleSparkBackend/native-launch/chains/solana/program/client.mjs', import.meta.url);
if (process.argv.includes('--check')) assert.equal(readFileSync(target, 'utf8'), readFileSync(source, 'utf8'), 'Run npm run export:backend in the Solana contract package');
else { mkdirSync(dirname(fileURLToPath(target)), { recursive: true }); copyFileSync(source, target); }
