import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const deploy = fileURLToPath(new URL('./deploy.mjs', import.meta.url));
const result = spawnSync(process.execPath, [deploy, '--broadcast'], {
  encoding: 'utf8',
  env: {
    ARC_CHAIN_ID: '5042002',
    ARC_RPC_URL: 'http://127.0.0.1:1',
    ARC_DEPLOYER_PRIVATE_KEY: `0x${'0'.repeat(63)}1`,
    ARC_KEEPER_OWNER: '0x0000000000000000000000000000000000000002',
    ARC_KEEPER_OPERATOR_ADDRESS: '0x0000000000000000000000000000000000000003',
  },
});
assert.notEqual(result.status, 0);
assert.match(result.stderr, /ARC_DEPLOYER_PRIVATE_KEY must belong to the keeper operator wallet/);
console.log('deploy signer guard passed');
