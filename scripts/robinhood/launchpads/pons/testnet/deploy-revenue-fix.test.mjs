import assert from 'node:assert/strict';
import { test } from 'node:test';
import { revenueFixPins } from './deploy-revenue-fix.mjs';

test('revenue rollout preserves platform-token, old custody and recovery pins until finalized registry activation', () => {
  const previous = { chainId: 46630, platformToken: 'platform', vaultFactory: '0x11', vaultImplementation: '0x22', swapAdapter: '0x33',
    deploymentBlock: 100, payoutPolicy: 'permanent', legacyFactories: [{ factory: '0x44', implementation: '0x55', block: 50 }],
    contracts: Object.fromEntries(['vaultFactory', 'vaultImplementation', 'swapAdapter'].map((name, index) => [name, { address: ['0x11', '0x22', '0x33'][index], codeHash: `old${index}` }])) };
  const report = { status: 'revenue_registry_verified', finalityComplete: true,
    addresses: { vaultFactory: '0x66', vaultImplementation: '0x77', swapAdapter: '0x88' },
    codeHashes: { vaultFactory: 'new0', vaultImplementation: 'new1', swapAdapter: 'new2' },
    transactions: { 'deploy-revenue-factory': { blockNumber: '200' } } };
  const pins = revenueFixPins(previous, report);
  assert.equal(pins.platformToken, previous.platformToken); assert.equal(pins.payoutPolicy, 'repeat');
  assert.deepEqual(pins.legacyFactories, [{ factory: '0x11', implementation: '0x22', block: 100 }, ...previous.legacyFactories]);
  assert.deepEqual(pins.contracts.historical_11, previous.contracts.vaultFactory);
  assert.deepEqual(pins.contracts.historical_22, previous.contracts.vaultImplementation);
  assert.deepEqual(pins.contracts.historical_33, previous.contracts.swapAdapter);
  assert.equal(pins.vaultFactory, '0x66'); assert.equal(pins.deploymentBlock, 200);
  assert.equal(previous.vaultFactory, '0x11');
  assert.throws(() => revenueFixPins(previous, { ...report, finalityComplete: false }));
  assert.throws(() => revenueFixPins(previous, { ...report, status: 'revenue_registry_timelock_pending' }));
  assert.throws(() => revenueFixPins({ ...previous, chainId: 4663 }, report));
  const beforeHooks = { ...previous, buybackPlugin:'0x99', distributionPlugin:'0xaa', contracts:{...previous.contracts,
    buybackPlugin:{address:'0x99',codeHash:'old-buyback'},distributionPlugin:{address:'0xaa',codeHash:'old-distribution'}} };
  const allHooks = { ...report, addresses:{...report.addresses,buybackPlugin:'0xbb',distributionPlugin:'0xcc'},
    codeHashes:{...report.codeHashes,buybackPlugin:'new-buyback',distributionPlugin:'new-distribution'} };
  const updated = revenueFixPins(beforeHooks, allHooks);
  assert.equal(updated.buybackPlugin,'0xbb');assert.equal(updated.distributionPlugin,'0xcc');
  assert.deepEqual(updated.contracts.historical_99,beforeHooks.contracts.buybackPlugin);
  assert.deepEqual(updated.contracts.historical_aa,beforeHooks.contracts.distributionPlugin);
  assert.equal(beforeHooks.buybackPlugin,'0x99');
  assert.throws(()=>revenueFixPins(beforeHooks,{...allHooks,addresses:{...report.addresses,buybackPlugin:'0xbb'}}));
  assert.throws(()=>revenueFixPins(beforeHooks,{...allHooks,codeHashes:{...report.codeHashes,buybackPlugin:'new-buyback'}}));
});
