import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { root as arc, dir, v2dir, claimDir, sourcePath as arcSource } from '../launchpads/argus/testnet/build.mjs';
import { root as ponsRoot, data } from '../../robinhood/launchpads/pons/testnet/build.mjs';
import { sourcePath as ponsSource } from '../../robinhood/launchpads/pons/testnet/build-gameplay.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

test('chain build roots keep separate frozen deployment and recovery directories', () => {
  assert.equal(arc, resolve(repository, 'chains/arc'));
  assert.equal(dir, resolve(repository, 'chains/arc/data/argus-public-testnet'));
  assert.equal(v2dir, resolve(repository, 'chains/arc/data/argus-public-testnet-v2'));
  assert.equal(claimDir, resolve(repository, 'chains/arc/data/argus-public-testnet-claim'));
  assert.equal(ponsRoot, resolve(repository));
  assert.equal(data, resolve(repository, 'chains/robinhood/data/pons'));
});

test('frozen compiler source keys resolve to relocated sources without escaping chains', () => {
  assert.equal(arcSource('../chains/arc/launchpads/argus/ArgusRevenueVault.sol'), resolve(repository, 'chains/arc/launchpads/argus/ArgusRevenueVault.sol'));
  assert.equal(arcSource('../chains/evm/hooks/RevenueHooks.sol'), resolve(repository, 'chains/evm/hooks/RevenueHooks.sol'));
  assert.equal(arcSource('lib/v4-core/src/PoolManager.sol'), resolve(repository, 'chains/arc/lib/v4-core/src/PoolManager.sol'));
  assert.equal(ponsSource('arc/lib/v4-core/src/PoolManager.sol'), arcSource('lib/v4-core/src/PoolManager.sol'));
  assert.equal(ponsSource('chains/robinhood/launchpads/pons/PonsHookVault.sol'), resolve(repository, 'chains/robinhood/launchpads/pons/PonsHookVault.sol'));
  for (const path of [arcSource('../chains/arc/launchpads/argus/ArgusRevenueVault.sol'), arcSource('lib/v4-core/src/PoolManager.sol'), ponsSource('chains/robinhood/launchpads/pons/PonsHookVault.sol')]) assert(existsSync(path), path);
  for (const bad of ['/etc/passwd', '../../.env', 'lib/../../../.env', 'arc/lib/../../../.env']) {
    assert.throws(() => arcSource(bad));
    assert.throws(() => ponsSource(bad));
  }
});
