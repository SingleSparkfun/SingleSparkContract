import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeDeployData, encodeFunctionData, keccak256, parseAbi, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { root, readJson, json } from './build.mjs';
import { gameplayPaths } from './build-gameplay.mjs';
import { context } from './transactions.mjs';
import { maskImmutables, preflight } from './deploy.mjs';

export function revenueFixPins(previous, report) {
  assert.equal(previous.chainId, 46630);
  assert.equal(report.status, 'revenue_registry_verified');
  assert.equal(report.finalityComplete, true);
  assert([undefined, 'transaction', 'timestamp'].includes(report.policyActivation), 'Unverified policy activation mode');
  const contracts = { ...previous.contracts };
  const freshHooks = report.addresses.buybackPlugin !== undefined || report.addresses.distributionPlugin !== undefined;
  const names = ['vaultFactory', 'vaultImplementation', 'swapAdapter'];
  if (freshHooks) {
    for (const name of ['buybackPlugin', 'distributionPlugin'])
      assert(report.addresses[name] && report.codeHashes[name] && previous.contracts[name], 'Both new Hook implementations must be verified');
    names.push('buybackPlugin', 'distributionPlugin');
  }
  for (const name of names) {
    const old = previous.contracts[name];
    contracts[`historical_${old.address.slice(2).toLowerCase()}`] = old;
    contracts[name] = { address: report.addresses[name].toLowerCase(), codeHash: report.codeHashes[name] };
  }
  const historical = [{ factory: previous.vaultFactory, implementation: previous.vaultImplementation, block: previous.deploymentBlock }, ...previous.legacyFactories];
  const legacyFactories = [...new Map(historical.map(pin => [pin.factory.toLowerCase(), pin])).values()];
  return { ...previous, policyActivation: report.policyActivation ?? 'transaction', payoutPolicy: 'repeat', contracts, legacyFactories,
    vaultFactory: contracts.vaultFactory.address, vaultImplementation: contracts.vaultImplementation.address,
    swapAdapter: contracts.swapAdapter.address,
    ...(freshHooks ? { buybackPlugin: contracts.buybackPlugin.address, distributionPlugin: contracts.distributionPlugin.address } : {}),
    deploymentBlock: Number(report.transactions['deploy-revenue-factory'].blockNumber), policyDelaySeconds: 600 };
}

async function main() {
  const argument = name => { const index = process.argv.indexOf(name); assert(index >= 0 && process.argv[index + 1], `Pass ${name}`); return process.argv[index + 1]; };
  const walletPath = resolve(argument('--wallet'));
  const deploymentId = argument('--deployment-id');
  const freshHooks = process.argv.includes('--deploy-hooks');
  const build = readJson(gameplayPaths(deploymentId).output);
  const roleDirectory = resolve(root, 'chains/robinhood/deployments/testnet/pons');
  const deploymentRoles = resolve(roleDirectory, `${deploymentId}-roles.json`);
  const roles = readJson(existsSync(deploymentRoles) ? deploymentRoles : resolve(roleDirectory, 'vault-config.json'));
  assert.equal(roles.chainId, 46630);
  assert.equal(build.chainId, 46630); assert.equal(build.policyDelaySeconds, 600); assert.equal(build.payoutPolicy, 'repeat');
  assert.equal(statSync(walletPath).mode & 0o077, 0, 'Wallet file must be owner-only');
  const wallets = readJson(walletPath);
  assert.equal(privateKeyToAccount(wallets.admin.privateKey).address.toLowerCase(), roles.admin.toLowerCase(), 'Admin does not match the reviewed testnet role');
  const c = await context({ walletPath, broadcast: process.argv.includes('--broadcast'), deploymentName: 'gameplay', deploymentId, artifacts: { ...build, roles, ...(freshHooks ? { freshHooks: true } : {}) } });
  const previous = c.report.previousPins ?? readJson(resolve(root, '../SingleSparkBackend/api/src/chains/robinhood/launchpads/pons/deployment.json'));
  assert.equal(previous.chainId, 46630);
  await preflight(c);
  for (const pin of Object.values(previous.contracts))
    assert.equal(keccak256(await c.client.getCode({ address: pin.address })), pin.codeHash, 'Pinned Pons executable changed');
  const upstreamAbi = parseAbi(['function feeEscrow() view returns(address)', 'function memeHook() view returns(address)',
    'function poolManager() view returns(address)', 'function canLaunch(address launcher) view returns(bool)']);
  for (const [field, expected] of [['feeEscrow', previous.escrow], ['memeHook', previous.contracts.hook.address], ['poolManager', previous.poolManager]])
    assert.equal((await c.read(previous.ponsFactory, upstreamAbi, field)).toLowerCase(), expected.toLowerCase(), `Upstream ${field} changed`);
  assert(await c.read(previous.ponsFactory, upstreamAbi, 'canLaunch', [c.account.address]), 'Test wallet cannot launch');
  const a = build.artifacts;
  for (const [name, address] of [['buyback', previous.buybackPlugin], ['distribution', previous.distributionPlugin]])
    assert.equal(maskImmutables(await c.client.getCode({ address }), {}), maskImmutables(a[name].runtime.object, {}), 'Existing plugin differs from reviewed code');
  if (!c.broadcast) {
    console.log(json({ status: 'prepared', chainId: 46630, deploymentId, deployer: c.account.address, roles,
      platformToken: previous.platformToken, journal: c.journalPath, policyDelaySeconds: 600,
      maximumTotalCostWei: c.config.maximumTotalCostWei, policyActivation: build.policyActivation ?? 'transaction', contracts: [build.policyActivation === 'timestamp' ? 'PonsDelayedVaultFactory' : 'PonsVaultFactory', build.policyActivation === 'timestamp' ? 'PonsDelayedVault' : 'PonsHookVault', 'PonsSwapAdapter', ...(freshHooks ? ['BuybackHook', 'DistributionHook'] : [])] }));
    return;
  }
  mkdirSync(c.storageDir, { recursive: true, mode: 0o700 });
  const lockPath = resolve(c.storageDir, 'run.lock');
  const lock = openSync(lockPath, 'wx', 0o600);
  try {
    c.report.previousPins = previous; c.save();
    if (c.journal.steps['fund-revenue-admin'] || await c.client.getBalance({ address: roles.admin }) < 5_000_000_000_000n)
      await c.send('fund-revenue-admin', { to: roles.admin, value: 20_000_000_000_000n });
    const call = (label, address, abi, functionName, args = [], role = 'deployer') => c.send(label, { to: address, data: encodeFunctionData({ abi, functionName, args }) }, role);
    async function create(label, artifact, args) {
      const receipt = await c.send(label, { data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args }) });
      const code = await c.client.getCode({ address: receipt.contractAddress });
      assert.equal(maskImmutables(code, artifact.runtime.immutableReferences), maskImmutables(artifact.runtime.object, artifact.runtime.immutableReferences));
      return { address: receipt.contractAddress.toLowerCase(), codeHash: keccak256(code) };
    }
    const f = await create('deploy-revenue-factory', a.factory, [roles.admin, roles.authorizer, roles.treasury, previous.ponsFactory]);
    const implementation = await c.read(f.address, a.factory.abi, 'implementation');
    const implementationCode = await c.client.getCode({ address: implementation });
    assert.equal(maskImmutables(implementationCode, a.vault.runtime.immutableReferences), maskImmutables(a.vault.runtime.object, a.vault.runtime.immutableReferences));
    for (const [field, expected] of [['admin', roles.admin], ['authorizer', roles.authorizer], ['treasury', roles.treasury], ['pons', previous.ponsFactory], ['escrow', previous.escrow], ['hook', previous.contracts.hook.address]])
      assert.equal((await c.read(f.address, a.factory.abi, field)).toLowerCase(), expected.toLowerCase());
    assert.equal(await c.read(f.address, a.factory.abi, 'DELAY'), 600n);
    if (build.policyActivation === 'timestamp') assert.equal(await c.read(f.address, a.factory.abi, 'automaticPolicyActivation'), true);
    c.report.policyActivation = build.policyActivation ?? 'transaction';
    assert.equal((await c.read(implementation, a.vault.abi, 'factory')).toLowerCase(), f.address);
    assert.equal(await c.read(implementation, a.vault.abi, 'permanentPayoutDeduplication'), false);
    await c.read(f.address, a.factory.abi, 'checkPons');
    const adapter = await create('deploy-revenue-adapter', a.adapter, [f.address, previous.ponsFactory]);
    assert.equal((await c.read(adapter.address, a.adapter.abi, 'factory')).toLowerCase(), f.address);
    for (const [field, expected] of [['pons', previous.ponsFactory], ['hook', previous.contracts.hook.address], ['poolManager', previous.poolManager]])
      assert.equal((await c.read(adapter.address, a.adapter.abi, field)).toLowerCase(), expected.toLowerCase());
    Object.assign(c.report.addresses, { vaultFactory: f.address, vaultImplementation: implementation.toLowerCase(), swapAdapter: adapter.address });
    Object.assign(c.report.codeHashes, { vaultFactory: f.codeHash, vaultImplementation: keccak256(implementationCode), swapAdapter: adapter.codeHash });
    const hooks = { buybackPlugin: previous.buybackPlugin, distributionPlugin: previous.distributionPlugin };
    if (freshHooks) {
      for (const [name, artifact] of [['buybackPlugin', a.buyback], ['distributionPlugin', a.distribution]]) {
        const deployed = await create(`deploy-revenue-${name === 'buybackPlugin' ? 'buyback' : 'distribution'}`, artifact, []);
        hooks[name] = deployed.address;
        c.report.addresses[name] = deployed.address; c.report.codeHashes[name] = deployed.codeHash;
      }
    }
    c.report.platformToken = previous.platformToken; c.save();
    const plugins = ['buyback-burn@1', 'platform-buyback@1', 'distribution@1'].map((name, index) => [keccak256(toHex(name)), index === 2 ? hooks.distributionPlugin : hooks.buybackPlugin]);
    for (const [index, [id, address]] of plugins.entries()) await call(`schedule-revenue-plugin-${index}`, f.address, a.factory.abi, 'schedulePlugin', [id, address], 'admin');
    await call('schedule-revenue-adapter', f.address, a.factory.abi, 'scheduleAdapter', [adapter.address], 'admin');
    const scheduled = Object.entries(c.report.transactions).filter(([label]) => label.startsWith('schedule-revenue-'));
    const ready = (await Promise.all(scheduled.map(async ([, tx]) => (await c.client.getBlock({ blockNumber: BigInt(tx.blockNumber) })).timestamp + 600n))).reduce((maximum, value) => value > maximum ? value : maximum, 0n);
    if ((await c.client.getBlock()).timestamp < ready) {
      c.report.status = 'revenue_registry_timelock_pending'; c.report.readyAt = String(ready); c.save();
      console.log(json({ status: c.report.status, readyAt: String(ready), addresses: c.report.addresses })); return;
    }
    for (const [index, [id, address]] of plugins.entries()) {
      await call(`activate-revenue-plugin-${index}`, f.address, a.factory.abi, 'executePlugin', [id, address]);
      assert.equal((await c.read(f.address, a.factory.abi, 'plugin', [id])).toLowerCase(), address.toLowerCase());
    }
    await call('activate-revenue-adapter', f.address, a.factory.abi, 'executeAdapter', [adapter.address]);
    await c.read(f.address, a.factory.abi, 'checkAdapter', [adapter.address]);
    const finalized = await c.client.getBlock({ blockTag: 'finalized' });
    c.report.finalizedThroughBlock = String(finalized.number);
    c.report.finalityComplete = Object.values(c.report.transactions).every(tx => BigInt(tx.blockNumber) <= finalized.number);
    c.report.status = c.report.finalityComplete ? 'revenue_registry_verified' : 'revenue_registry_verified_pending_finality';
    c.report.verification = { checks: ['reviewed executable bytecode', 'pinned Pons Hook and escrow bindings', 'separate admin and authorizer', '10-minute testnet registry delay', 'three registered plugins', 'factory-bound swap adapter', 'existing platform token preserved'], production: false };
    c.save(); console.log(json({ status: c.report.status, addresses: c.report.addresses, finalityComplete: c.report.finalityComplete }));
  } finally { closeSync(lock); unlinkSync(lockPath); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error instanceof assert.AssertionError ? error.message : (error.shortMessage ?? 'Pons revenue deployment stopped; preserve its journal.'));
  if (!(error instanceof assert.AssertionError)) console.error(json({ error: error.name, code: error.code, cause: error.cause?.name, causeCode: error.cause?.code }));
  process.exitCode = 1;
});
