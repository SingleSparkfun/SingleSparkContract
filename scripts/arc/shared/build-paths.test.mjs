import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { root as arc, dir, v2dir, claimDir } from '../launchpads/argus/testnet/build.mjs';
import { root as ponsRoot, data } from '../../robinhood/launchpads/pons/testnet/build.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

test('moving tools preserves frozen artifacts and durable transaction recovery directories', () => {
  assert.equal(arc, resolve(repository, 'arc'));
  assert.equal(dir, resolve(repository, 'arc/data/argus-public-testnet'));
  assert.equal(v2dir, resolve(repository, 'arc/data/argus-public-testnet-v2'));
  assert.equal(claimDir, resolve(repository, 'arc/data/argus-public-testnet-claim'));
  assert.equal(ponsRoot, resolve(repository));
  assert.equal(data, resolve(repository, '.data/robinhood/pons'));
});
