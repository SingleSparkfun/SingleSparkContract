// Reuse the verified testnet Portal/router; new projects (including SPARK) receive fees in vaults.
import assert from 'node:assert/strict';
import { readFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { keccak256 } from 'viem';
import { context } from './deploy.mjs';
import { root, json } from './build.mjs';

const c = await context({ version: 2 });
const old = JSON.parse(readFileSync(resolve(root, '../deployments/testnet/arc/argus/argus-public-testnet.json')));
assert.equal(old.status, 'passed');
for (const name of ['portal', 'router']) {
  const address = name === 'portal' ? c.build.portal : old.addresses.router;
  assert.equal(keccak256(await c.client.getCode({ address })), old.codeHashes[name], `${name}: pinned testnet dependency`);
}
if (c.report.status === 'passed') {
  console.log(json({status:'already_deployed_and_verified', report:c.reportPath}));
} else if (!process.argv.includes('--broadcast')) {
  console.log(json({ status: 'reviewable_plan', chainId: 5042002, portal: c.build.portal, router: old.addresses.router,
    creatorAndRecipient: 'independent contract vault for all three new projects', platformTargetDelay: 172800,
    maximumBudgetUSDC: '10', originalJournalPreserved: true }));
} else {
  const lockPath = resolve(c.storageDir, 'run.lock'), lock = openSync(lockPath, 'wx', 0o600);
  try {
    const nonce = async label => c.journal.steps[label]?.nonce ?? await c.client.getTransactionCount({ address: c.accounts.deployer.address, blockTag: 'pending' });
    const implementation = await c.deploy('implementation', [], await nonce('implementation'));
    const factory = await c.deploy('factory', [old.addresses.router, c.accounts.admin.address, c.accounts.executor.address, implementation], await nonce('factory'));
    assert.equal(await c.read(implementation, c.a.implementation.abi, 'layoutVersion'), 2n);
    assert.equal(await c.read(factory, c.a.factory.abi, 'DELAY'), 172800n);
    c.report.addresses.router = old.addresses.router;
    c.report.codeHashes.router = old.codeHashes.router;
    c.report.addresses.platformToken = old.addresses.platformToken;
    c.report.bootstrapPlatformToken = old.addresses.platformToken;
    c.report.status = 'deployed_pending_acceptance'; c.save();
    console.log(json({ status: c.report.status, addresses: c.report.addresses, report: c.reportPath }));
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
