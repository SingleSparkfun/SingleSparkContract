import assert from 'node:assert/strict';
import { openSync, closeSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeDeployData, encodeFunctionData, parseEventLogs, zeroAddress, toHex, keccak256 } from 'viem';
import { root, data, readJson, json } from './build.mjs';
import { context } from './transactions.mjs';
import { deploy, maskImmutables } from './deploy.mjs';

const walletIndex = process.argv.indexOf('--wallet');
assert(walletIndex >= 0, 'Pass --wallet with an owner-only testnet wallet');
const walletPath = resolve(process.argv[walletIndex + 1]);
const foundation = await context({ walletPath });
await deploy(foundation);
const names = ['PonsVaultFactory', 'PonsGameplayVault'];
const artifacts = Object.fromEntries(names.map(name => {
  const a = readJson(resolve(root, `chains/robinhood/out/${name}.sol/${name}.json`));
  return [name, { abi: a.abi, bytecode: a.bytecode, deployedBytecode: a.deployedBytecode }];
}));
const roles = readJson(resolve(root, 'chains/robinhood/deployments/testnet/pons/vault-config.json'));
assert.equal(roles.chainId, 46630);
artifacts.roles = roles;
const deploymentIndex = process.argv.indexOf('--deployment-id');
const deploymentId = deploymentIndex < 0 ? '' : process.argv[deploymentIndex + 1];
assert(deploymentIndex < 0 || typeof deploymentId === 'string' && deploymentId.length > 0, 'Pass a testnet deployment ID');
const c = await context({ walletPath, broadcast: process.argv.includes('--broadcast'), deploymentName: 'vault-launch', artifacts, deploymentId });
const source = foundation.report.addresses.factory;
if (!c.broadcast) {
  console.log(json({ chainId: 46630, roles, source, journal: c.journalPath, status: 'prepared', maximumCostWei: c.config.maximumTotalCostWei }));
  process.exit(0);
}
mkdirSync(c.storageDir, { recursive: true, mode: 0o700 });
const lockPath = resolve(c.storageDir, 'run.lock'), lock = openSync(lockPath, 'wx', 0o600);
try {
  const f = artifacts.PonsVaultFactory, v = artifacts.PonsGameplayVault;
  const pons = readJson(resolve(data, 'build.json')).artifacts;
  const call = (label, address, abi, functionName, args = [], value = 0n) => c.send(label, { to: address, data: encodeFunctionData({ abi, functionName, args }), value });
  const deployment = await c.send('vault-factory', { data: encodeDeployData({ abi: f.abi, bytecode: f.bytecode.object, args: [roles.admin, roles.authorizer, roles.treasury, source] }) });
  const factory = deployment.contractAddress;
  const implementation = await c.read(factory, f.abi, 'implementation');
  for (const [name, address, artifact] of [['vaultFactory', factory, f], ['vaultImplementation', implementation, v]]) {
    const code = await c.client.getCode({ address });
    assert.equal(maskImmutables(code, artifact.deployedBytecode.immutableReferences), maskImmutables(artifact.deployedBytecode.object, artifact.deployedBytecode.immutableReferences));
    c.report.addresses[name] = address; c.report.codeHashes[name] = keccak256(code);
  }
  for (const [field, expected] of Object.entries({ ...roles, pons: source, escrow: foundation.report.addresses.escrow }).filter(([field]) => !['chainId', 'description'].includes(field)))
    assert.equal((await c.read(factory, f.abi, field)).toLowerCase(), expected.toLowerCase());
  assert.equal(await c.read(factory, f.abi, 'DELAY'), 172800n);
  c.report.sourcePons = { addresses: foundation.report.addresses, codeHashes: foundation.report.codeHashes };
  c.save();
  const economics = await c.read(source, pons.factory.abi, 'previewLaunchEconomics', [0n, zeroAddress]);
  const salt = toHex(1, { size: 32 });
  const params = { name: 'SingleSpark Vault Test', symbol: 'SSVTEST', logo: '', description: 'Project Vault acceptance on Robinhood Testnet; no real value',
    socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' }, creatorFeeRecipient: zeroAddress,
    creatorTaxBps: 200, buybackEnabled: false, expectedEconomics: economics, salt };
  const launched = await call('vault-launch', factory, f.abi, 'launch', [params], BigInt(c.config.launchFeeWei));
  const events = parseEventLogs({ abi: f.abi, eventName: 'ProjectLaunched', logs: launched.logs }).filter(log => log.address.toLowerCase() === factory.toLowerCase());
  assert.equal(events.length, 1);
  const { owner, token, curve, vault } = events[0].args;
  assert.equal(owner.toLowerCase(), c.account.address.toLowerCase());
  assert.equal((await c.read(factory, f.abi, 'predictLaunchVault', [owner, salt])).toLowerCase(), vault.toLowerCase());
  assert.equal((await c.read(factory, f.abi, 'vaultOf', [owner, token])).toLowerCase(), vault.toLowerCase());
  assert.equal((await c.read(vault, v.abi, 'owner')).toLowerCase(), owner.toLowerCase());
  assert.equal((await c.read(vault, v.abi, 'projectToken')).toLowerCase(), token.toLowerCase());
  assert.equal((await c.read(source, pons.factory.abi, 'getLaunchedToken', [token])).creatorFeeRecipient.toLowerCase(), vault.toLowerCase());
  Object.assign(c.report.addresses, { testToken: token, testCurve: curve, testVault: vault }); c.save();
  const amount = BigInt(c.config.launchConfig.graduationThreshold) / 10n;
  await call('vault-curve-buy', curve, pons.PonsV2BondingCurve.abi, 'buy', [amount, 1n, owner], amount);
  const collected = await call('vault-collect-revenue', vault, v.abi, 'collectRevenue');
  const at = (functionName, blockNumber) => c.client.readContract({ address: vault, abi: v.abi, functionName, blockNumber });
  const received = await at('received', collected.blockNumber);
  assert(received > 0n, 'Creator income did not reach the full gameplay Vault');
  assert.equal(await at('platformBudget', collected.blockNumber), received * 1000n / 10000n);
  assert.equal(await at('claimBudget', collected.blockNumber), received * 50n / 10000n);
  assert.equal(await at('unallocated', collected.blockNumber), received - received * 1000n / 10000n - received * 50n / 10000n);
  const deposit = await call('vault-native-deposit', vault, v.abi, 'deposit', [1_000_000_000_000n], 1_000_000_000_000n);
  assert.equal(await at('received', deposit.blockNumber), received + 1_000_000_000_000n);
  const finalized = await c.client.getBlock({ blockTag: 'finalized' });
  c.report.finalizedThroughBlock = String(finalized.number);
  c.report.status = Object.values(c.report.transactions).every(tx => BigInt(tx.blockNumber) <= finalized.number) ? 'vault_launch_verified' : 'vault_launch_verified_pending_finality';
  c.report.verification = { checks: ['atomic launch and deterministic Vault', 'wallet owner preserved', 'Pons creator fee recipient is project Vault', 'curve income swept and claimed by Vault', '10% / 0.5% / 89.5% budgets', 'native ETH deposit without wrapping', '48-hour production controller'], creatorIncomeWei: String(received), pluginsEnabled: false, platformToken: null };
  c.save(); console.log(json({ status: c.report.status, addresses: c.report.addresses, verification: c.report.verification }));
} finally { closeSync(lock); unlinkSync(lockPath); }
