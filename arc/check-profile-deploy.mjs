// Local Anvil only: deploys the whole stack with a chain profile that is not Arc — by default the synthetic
// ETH-like test profile (SingleSparkContract/arc/test/profiles/eth-like.json, chain 31337) — and runs a launch, a buy, a sell,
// fee collection with a keeper gas top-up, and a keeper burn through the executor, all in that profile's
// currency units. Then the two read-only deployment verifiers run against it. Public development keys and
// synthetic addresses; nothing touches a public network.
//
//   node SingleSparkContract/arc/check-profile-deploy.mjs [--profile SingleSparkContract/arc/test/profiles/eth-like.json] [--out report.json]
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, erc20Abi, formatEther, http,
  parseEventLogs, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deployArc, artifact } from './deploy.mjs';
import { loadProfileFile } from './chains/profile.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const profilePath = resolve(option('--profile') ?? resolve(root, 'test/profiles/eth-like.json'));
const outPath = option('--out');
const profile = loadProfileFile(profilePath);
const { halfSupplyCost, keeperGas } = profile.economics;
const unit = halfSupplyCost / 10_000n; // one dollar's worth, by the profile's own scale
const symbol = profile.nativeCurrency.symbol;

const reserve = createServer();
await new Promise(r => reserve.listen(0, '127.0.0.1', r));
const port = reserve.address().port;
await new Promise(r => reserve.close(r));
const url = `http://127.0.0.1:${port}`;
const anvil = spawn('anvil', ['--port', String(port), '--chain-id', String(profile.chainId), '--silent', '--gas-limit', '60000000'],
  { stdio: 'ignore' });

// Anvil's published development keys; they only ever hold Anvil's own balances.
const keys = ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'];
const [deployer, operator, trader] = keys.map(key => privateKeyToAccount(key));
const community = privateKeyToAccount(`0x${'2'.padStart(64, '0')}`).address;
const team = privateKeyToAccount(`0x${'4'.padStart(64, '0')}`).address;
const chain = defineChain({ id: profile.chainId, name: profile.name, nativeCurrency: profile.nativeCurrency,
  rpcUrls: { default: { http: [url] } } });
const client = createPublicClient({ chain, transport: http(url, { retryCount: 0 }), cacheTime: 0 });
const walletFor = account => createWalletClient({ account, chain, transport: http(url) });
const dir = mkdtempSync(resolve(tmpdir(), 'arc-profile-deploy-'));
const launchAbi = artifact('ArcLaunchV2').abi;
const strategyAbi = artifact('ArcLaunchStrategy').abi;
const executorAbi = artifact('ArcKeeperExecutor').abi;
const steps = [];
const record = (name, detail = {}) => { steps.push({ name, ...detail }); console.log(`ok  ${name}`); };
const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
const send = async (account, address, abi, functionName, args = [], value = 0n) => {
  const hash = await walletFor(account).writeContract({ address, abi, functionName, args, value });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', `${functionName} reverted`);
  return receipt;
};
const now = async () => (await client.getBlock()).timestamp;
const warp = async seconds => {
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [Number(await now()) + seconds] });
  await client.request({ method: 'evm_mine', params: [] });
};
const setBalance = (address, amount) => client.request({ method: 'anvil_setBalance', params: [address, `0x${amount.toString(16)}`] });

let status = 'failed', failure, deployment;
try {
  for (let i = 0; ; i++) {
    try { await client.getChainId(); break; } catch (error) { if (i > 50) throw error; await new Promise(r => setTimeout(r, 100)); }
  }
  // A local chain has no V4 of its own: deploy one, the way the other Anvil checks do.
  const deployContract = async (name, args) => {
    const compiled = artifact(name);
    const hash = await walletFor(deployer).deployContract({ abi: compiled.abi, bytecode: compiled.bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    return receipt.contractAddress;
  };
  const poolManager = await deployContract('PoolManager', [deployer.address]);
  const positionManager = await deployContract('PositionManager', [poolManager, zeroAddress, 100000, zeroAddress, zeroAddress]);

  const options = { profile, positionManager, community, platformName: 'SingleSpark', platformSymbol: 'SPARK',
    satisfaction: { team, roundDuration: 1800, votingDuration: 600, quorum: 1000 },
    executor: { owner: deployer.address, operator: operator.address }, journalPath: resolve(dir, 'deployment-journal.json') };
  deployment = await deployArc(client, walletFor(deployer), options);
  assert.deepEqual(await deployArc(client, walletFor(deployer), options), deployment, 'a rerun must resume, not redeploy');
  const { launch, strategy, keeperExecutor: executor } = deployment;
  assert.equal(deployment.feeCurrency, symbol);
  assert.equal(await read(strategy, strategyAbi, 'HALF_SUPPLY_COST'), halfSupplyCost);
  assert.equal(await read(strategy, strategyAbi, 'MIN_LAUNCH_TICK'), profile.economics.minLaunchTick);
  assert.equal(await read(launch, launchAbi, 'KEEPER_GAS_TRIGGER'), keeperGas.trigger);
  assert.equal(await read(executor, executorAbi, 'OPERATOR_GAS_TARGET'), keeperGas.trigger);
  record('stack deployed from the profile', { chainId: profile.chainId, profile: profile.name, launch, strategy, executor,
    minBuyback: deployment.minBuyback });

  // Both read-only verifiers accept it against the same profile file.
  const recordPath = resolve(dir, 'deployment.json');
  writeFileSync(recordPath, JSON.stringify(deployment));
  const verifierEnv = { ...process.env, ARC_RPC_URL: url, ARC_CHAIN_PROFILE: profilePath };
  execFileSync(process.execPath, [resolve(root, 'verify-v2-testnet.mjs'), recordPath, resolve(dir, 'v2.json')], { env: verifierEnv, stdio: 'pipe' });
  execFileSync(process.execPath, [resolve(root, 'verify-satisfaction-deployment.mjs'), recordPath, resolve(dir, 'satisfaction.json')], { env: verifierEnv, stdio: 'pipe' });
  record('verify-v2-testnet.mjs and verify-satisfaction-deployment.mjs pass with ARC_CHAIN_PROFILE');

  // A meme, bought and partly sold back once the opening ladder has passed.
  await setBalance(trader.address, 100_000n * unit);
  const launched = await send(trader, launch, launchAbi, 'launch', ['Profile Meme', 'PMEME', '', 10_000, 50_000, community]);
  const token = parseEventLogs({ abi: launchAbi, eventName: 'Launched', logs: launched.logs })[0].args.token;
  await warp(4);
  await send(trader, launch, launchAbi, 'trade', [token, true, 2_000n * unit, 1n, await now() + 600n], 2_000n * unit);
  const bought = await read(token, erc20Abi, 'balanceOf', [trader.address]);
  assert(bought > 0n);
  await send(trader, token, erc20Abi, 'approve', [launch, bought / 2n]);
  await send(trader, launch, launchAbi, 'trade', [token, false, bought / 2n, 1n, await now() + 600n]);
  record('launch, buy and sell', { token, spent: `${formatEther(2_000n * unit)} ${symbol}`, bought: formatEther(bought) });

  // Collection splits the tax and pays the (empty) keeper executor from the platform share.
  await setBalance(executor, 0n);
  await setBalance(operator.address, 0n);
  const collected = await send(deployer, launch, launchAbi, 'collectFees', [token]);
  const [fees] = parseEventLogs({ abi: launchAbi, eventName: 'FeesCollected', logs: collected.logs });
  const [paid] = parseEventLogs({ abi: launchAbi, eventName: 'KeeperGasPaid', logs: collected.logs });
  assert(fees && fees.args.nativeAmount > 0n, 'no tax collected');
  assert(paid, 'the keeper was not topped up');
  assert(paid.args.amount >= keeperGas.minTopup && paid.args.amount <= keeperGas.maxTopup);
  assert.equal(await client.getBalance({ address: launch }), await read(launch, launchAbi, 'nativeAccounted'));
  record('fees collected and keeper topped up', { collected: `${formatEther(fees.args.nativeAmount)} ${symbol}`,
    keeperTopUp: `${formatEther(paid.args.amount)} ${symbol}`, maxTopup: formatEther(keeperGas.maxTopup) });

  // The keeper burn, through the executor, within the guarded per-call ceiling.
  await setBalance(operator.address, 100n * unit);
  await warp(181);
  const [, pending] = await read(launch, launchAbi, 'tokens', [token]);
  const [, limit] = await read(strategy, strategyAbi, 'keeperSwapState', [token, true]);
  const amount = pending < limit ? pending : limit;
  assert(amount >= profile.economics.minBuyback, `burn budget ${formatEther(amount)} is below the minimum buyback`);
  const supply = await read(token, erc20Abi, 'totalSupply');
  const burn = await send(operator, executor, executorAbi, 'execute',
    [launch, encodeFunctionData({ abi: launchAbi, functionName: 'executeBurn', args: [token, amount, 1n, await now() + 60n] })]);
  const [burned] = parseEventLogs({ abi: launchAbi, eventName: 'Burned', logs: burn.logs });
  assert(burned && burned.args.bought > 0n);
  assert.equal(await read(token, erc20Abi, 'totalSupply'), supply - burned.args.bought);
  record('keeper burn through the executor', { spent: `${formatEther(amount)} ${symbol}`, burned: formatEther(burned.args.bought) });
  status = 'passed';
} catch (error) {
  failure = error.stack || String(error);
  console.error(failure);
} finally {
  anvil.kill();
}
const report = { status, checkedAt: new Date().toISOString(), profile: profilePath, chainId: profile.chainId, steps,
  ...(failure ? { failure } : {}),
  note: 'Local Anvil with a synthetic profile and development keys: proves the scripts and contracts are chain-agnostic, '
    + 'not that any real chain is configured or deployed.' };
if (outPath) writeFileSync(resolve(outPath), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status, steps: steps.length }));
if (status !== 'passed') process.exit(1);
