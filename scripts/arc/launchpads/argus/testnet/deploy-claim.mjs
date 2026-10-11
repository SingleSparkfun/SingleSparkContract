// New Claim deployment; original public-testnet contracts and signed journals remain untouched.
import assert from 'node:assert/strict';
import { readFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, formatEther } from 'viem';
import { context } from './deploy.mjs';
import { root, json } from './build.mjs';

export async function deployClaim(c) {
  const original = JSON.parse(readFileSync(resolve(root, 'deployments/testnet/argus/argus-public-testnet.json')));
  assert.equal(original.status, 'passed');
  assert.equal(keccak256(await c.client.getCode({ address: c.build.portal })), original.codeHashes.portal, 'Verified Portal dependency');
  if (!process.argv.includes('--broadcast')) {
    console.log(json({ status:'reviewable_plan', chainId:5042002, portal:c.build.portal,
      contracts:['router','implementation','factory'], bootstrapPlatformToken:original.addresses.platformToken,
      platformFeeBps:1000, claimFeeBps:50, pluginWeights:[1,1,1], policyDelaySeconds:600,
      maximumBudgetUSDC:'10', balanceUSDC:formatEther(await c.client.getBalance({address:c.accounts.deployer.address})),
      report:c.reportPath, oldDeploymentsPreserved:true }));
    return;
  }
  const lockPath = resolve(c.storageDir, 'run.lock'), lock = openSync(lockPath, 'wx', 0o600);
  try {
    const nonce = async label => c.journal.steps[label]?.nonce ?? await c.client.getTransactionCount({address:c.accounts.deployer.address,blockTag:'pending'});
    const router = await c.deploy('router', [c.accounts.executor.address, original.addresses.platformToken, c.accounts.admin.address, false], await nonce('router'));
    const implementation = await c.deploy('implementation', [], await nonce('implementation'));
    const factory = await c.deploy('factory', [router, c.accounts.admin.address, c.accounts.executor.address, implementation], await nonce('factory'));
    assert.equal(await c.read(implementation,c.a.implementation.abi,'claimVersion'),1n);
    assert.equal(await c.read(factory,c.a.factory.abi,'DELAY'),600n);
    assert.equal(await c.read(implementation,c.a.implementation.abi,'allocationVersion'),1n);
    assert.equal((await c.read(factory,c.a.factory.abi,'router')).toLowerCase(),router.toLowerCase());
    c.report.addresses.platformToken = original.addresses.platformToken;
    c.report.bootstrapPlatformToken = original.addresses.platformToken;
    c.report.allocation = {platformFeeBps:1000,claimFeeBps:50,pluginWeights:[1,1,1],policyDelaySeconds:600};
    c.report.pluginContracts = [];
    for (let kind=0;kind<3;kind++) {
      const address = await c.read(factory,c.a.factory.abi,'revenuePlugin',[BigInt(kind)]);
      const codeHash = await c.read(factory,c.a.factory.abi,'pluginCodeHash',[BigInt(kind)]);
      assert.equal(keccak256(await c.client.getCode({address})),codeHash);
      c.report.pluginContracts.push({kind,address,codeHash});
    }
    c.report.status = c.report.status === 'passed' ? 'passed' : 'deployed_pending_acceptance';
    c.save();
    console.log(json({status:c.report.status,addresses:c.report.addresses,report:c.reportPath}));
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await deployClaim(await context({version:3})).catch(error => { console.error(error.shortMessage ?? error.message);process.exitCode=1; });
}
