import { testDatabase, testSql, localApiLimits } from './test-database.mjs';
// Local Anvil integration only. Public development keys and synthetic addresses; no public-chain transactions.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, parseEther, erc20Abi, parseEventLogs, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deployArc, artifact } from './deploy.mjs';
import { arcAbi } from '../../SingleSparkFront/front/web3/arcAbi.ts';

const reserve = createServer();
await new Promise(r => reserve.listen(0, '127.0.0.1', r));
const port = reserve.address().port;
await new Promise(r => reserve.close(r));
const url = `http://127.0.0.1:${port}`;
const checkUI = process.argv.includes('--ui');
const site = 'http://127.0.0.1:5180';
const publication = 1727521075 + (20672105 - 1) * 3;
// Leave room for the opening windows before the keeper's 630-second history requirement.
const anvil = spawn('anvil', ['--port', String(port), '--chain-id', '5042002', '--timestamp', String(publication - 720), '--silent']);
let api, vite, browser;
const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const account = privateKeyToAccount(key);
const community = privateKeyToAccount(`0x${'2'.padStart(64, '0')}`).address;
const treasury = privateKeyToAccount(`0x${'3'.padStart(64, '0')}`).address;
const chain = defineChain({ id: 5042002, name: 'Arc Local', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
const client = createPublicClient({ chain, transport: http(url, { retryCount: 0 }), cacheTime: 0 });
const wallet = createWalletClient({ account, chain, transport: http(url) });
const dir = mkdtempSync(resolve(tmpdir(), 'arc-economics-v2-'));
const readReward = (address, functionName) => client.readContract({ address, abi: artifact('ArcRewards').abi, functionName });
const call = async (address, abi, functionName, args = [], value = 0n) => {
  const hash = await wallet.writeContract({ address, abi, functionName, args, value });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', functionName); return receipt;
};
try {
  for (let i = 0; ; i++) {
    try { await client.getChainId(); break; } catch (error) { if (i > 30) throw error; await new Promise(r => setTimeout(r, 100)); }
  }
  await client.request({ method: 'anvil_setBlockTimestampInterval', params: [0] });
  const deploy = async (name, args) => {
    const a = artifact(name);
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, 'success'); return receipt.contractAddress;
  };
  const pool = await deploy('PoolManager', [account.address]);
  const pm = await deploy('PositionManager', [pool, zeroAddress, 100000, zeroAddress, zeroAddress]);
  const options = { positionManager: pm, keeper: account.address, operations: treasury, community,
    platformName: 'SingleSpark', platformSymbol: 'SPARK', minBuyback: '0.001', journalPath: resolve(dir, 'deployment.json') };
  const deployment = await deployArc(client, wallet, options);
  assert.deepEqual(await deployArc(client, wallet, options), deployment);
  const verificationInput = resolve(dir, 'verification-deployment.json');
  writeFileSync(verificationInput, JSON.stringify(deployment));
  execFileSync(process.execPath, [resolve('SingleSparkContract/arc/verify-v2-testnet.mjs'), verificationInput, resolve(dir, 'verification.json')],
    { env: { ...process.env, ARC_RPC_URL: url }, stdio: 'pipe' });
  assert.equal(deployment.platformName, options.platformName);
  assert.equal(deployment.platformSymbol, options.platformSymbol);
  for (const [functionName, expected] of [['name', options.platformName], ['symbol', options.platformSymbol]]) {
    assert.equal(await client.readContract({ address: deployment.platformToken, abi: erc20Abi, functionName }), expected);
  }
  const projects = [];
  for (const [symbol, buyFee, sellFee] of [['ONE', 10000, 50000], ['FIVE', 50000, 10000]]) {
    const recipient = symbol === 'ONE' ? community : privateKeyToAccount(`0x${'4'.padStart(64, '0')}`).address;
    if (symbol === 'FIVE') await client.request({ method: 'anvil_setCode', params: [recipient, '0x60006000fd'] });
    const receipt = await call(deployment.launch, arcAbi, 'launch', [symbol, symbol, '', buyFee, sellFee, recipient]);
    const token = parseEventLogs({ abi: arcAbi, eventName: 'Launched', logs: receipt.logs })[0].args.token;
    const [, , rewards] = await client.readContract({ address: deployment.launch, abi: arcAbi, functionName: 'terms', args: [token] });
    projects.push({ token, symbol, buyFee, sellFee, rewards });
    await call(deployment.launch, arcAbi, 'trade', [token, true, parseEther('1'), 1n, (await client.getBlock()).timestamp + 120n], parseEther('1'));
    assert.equal(await client.readContract({ address: deployment.strategy, abi: artifact('ArcLaunchStrategy').abi,
      functionName: 'accruedNative', args: [token] }), parseEther('0.99'));
    assert.equal(await client.readContract({ address: deployment.strategy, abi: artifact('ArcLaunchStrategy').abi,
      functionName: 'accruedOpeningNative', args: [token] }), parseEther('0.99') - parseEther('1') * BigInt(buyFee) / 1000000n);
    await client.request({ method: 'evm_setNextBlockTimestamp', params: [Number((await client.getBlock()).timestamp + 3n)] });
    await client.request({ method: 'evm_mine', params: [] });
    const [, , effectiveFee] = await client.readContract({ address: deployment.strategy, abi: artifact('ArcLaunchStrategy').abi,
      functionName: 'launchProtection', args: [token] });
    assert.equal(effectiveFee, buyFee);
    await call(deployment.launch, arcAbi, 'trade', [token, true, parseEther('1000'), 1n, (await client.getBlock()).timestamp + 120n], parseEther('1000'));
    assert.equal(await client.readContract({ address: deployment.strategy, abi: artifact('ArcLaunchStrategy').abi,
      functionName: 'accruedNative', args: [token] }), parseEther('0.99') + parseEther('1000') * BigInt(buyFee) / 1000000n);
    const balance = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
    await call(token, erc20Abi, 'approve', [deployment.launch, balance / 10n]);
    await call(deployment.launch, arcAbi, 'trade', [token, false, balance / 10n, 1n, (await client.getBlock()).timestamp + 120n]);
  }
  console.log('Deployed V3: 99% opening buys, then independent 1%/5% and 5%/1% buy/sell fees exercised.');
  // A single mined block contains 128 independently signed transaction senders for candidate discovery.
  await client.request({ method: 'anvil_setAutomine', params: [false] });
  for (let i = 100; i < 228; i++) {
    const sender = privateKeyToAccount(`0x${i.toString(16).padStart(64, '0')}`);
    await client.request({ method: 'anvil_setBalance', params: [sender.address, `0x${parseEther('1').toString(16)}`] });
    const w = createWalletClient({ account: sender, chain, transport: http(url) });
    await w.sendTransaction({ to: account.address, value: 1n, gas: 21000n, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 0n });
  }
  await client.request({ method: 'evm_mine', params: [] });
  await client.request({ method: 'anvil_setAutomine', params: [true] });
  await client.request({ method: 'anvil_mine', params: ['0x40', '0x0'] });
  const env = { ...process.env, ...testDatabase(dir), ...localApiLimits, ARC_CHAIN_ID: '5042002', ARC_RPC_URL: url, ARC_PUBLIC_RPC_URL: url,
    ARC_EXPLORER_URL: 'https://testnet.arcscan.app', ARC_WEB_ORIGIN: checkUI ? site : 'http://127.0.0.1:5176', ARC_HOST: '127.0.0.1', ARC_PORT: '0',
    ARC_DATA_DIR: dir, ARC_LAUNCH_ADDRESS: deployment.launch, ARC_QUOTER_ADDRESS: deployment.quoter,
    ARC_FROM_BLOCK: deployment.fromBlock, ARC_KEEPER_PRIVATE_KEY: key, ARC_CONFIG_SIGNING_KEY: key,
    ARC_TREASURY_ENCRYPTION_KEY: '07'.repeat(32), ARC_CONFIG_KEY_ID: 'arc-local', ARC_GAS_RESERVE_USDC: '1', ARC_SLIPPAGE_BPS: '300',
    ARC_KEEPER_ADMIN_TOKEN: '', ARC_KEEPER_BATCH_SIZE: '20', ARC_MAX_GAS_PER_TX: '1500000', ARC_REWARDS_ADDRESS: '', ARC_REWARDS_FROM_BLOCK: '' };
  const run = (args, data = dir, gas = "5000000") => {
    const child = spawn(resolve('SingleSparkBackend/api/target/debug/jet-arc-backend'), args, { env: { ...env, ...testDatabase(data), ARC_DATA_DIR: data, ARC_MAX_GAS_PER_TX: gas } });
    let out = '', error = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => error += b);
    return new Promise((ok, fail) => { child.once('error', fail); child.once('exit', code => code === 0 ? ok(JSON.parse(out)) : fail(Error(error))); });
  };
  let snapshot;
  // Reuse the real indexer: both swap directions, restart, direct funding, collection and reorg.
  const feeData = resolve(dir, 'fee-index');
  const indexedFees = () => JSON.parse(testSql(feeData, "SELECT value::jsonb->'fees' FROM kv WHERE key='index'"));
  await run(['--resume-only'], feeData);
  const feesBefore = indexedFees();
  for (const project of projects) {
    const estimated = feesBefore[project.token.toLowerCase()];
    const { result: [native, tokens] } = await client.simulateContract({ address: deployment.launch,
      abi: arcAbi, functionName: 'collectFees', args: [project.token], account });
    assert(BigInt(estimated.native) >= native && BigInt(estimated.native) - native < 2048n);
    assert(BigInt(estimated.token) >= tokens && BigInt(estimated.token) - tokens < 2048n);
  }
  await run(['--resume-only'], feeData);
  assert.deepEqual(indexedFees(), feesBefore, 'Restart must not count swaps twice');
  const feeFork = await client.request({ method: 'evm_snapshot', params: [] });
  const feeToken = projects[0].token;
  await call(deployment.launch, artifact('ArcLaunchV2').abi, 'fundFees', [feeToken], parseEther('1'));
  await run(['--resume-only'], feeData);
  assert.equal(indexedFees()[feeToken.toLowerCase()].native, feesBefore[feeToken.toLowerCase()].native,
    'FeesAllocated from direct funding must not erase uncollected LP fees');
  const [tax, extra] = await Promise.all(['accruedNative', 'accruedOpeningNative'].map(functionName =>
    client.readContract({ address: deployment.strategy, abi: artifact('ArcLaunchStrategy').abi, functionName, args: [feeToken] })));
  const collected = await call(deployment.launch, arcAbi, 'collectFees', [feeToken]);
  const allocation = parseEventLogs({ abi: artifact('ArcLaunchV2').abi, eventName: 'FeesAllocated', logs: collected.logs })[0].args;
  assert.equal(allocation.nativeAmount, tax);
  assert.equal(allocation.ownBuyback, (tax - extra) * 83n / 100n);
  assert.equal(allocation.jetBuyback, (tax - extra) * 7n / 100n + extra);
  assert.equal(allocation.distributions, (tax - extra) * 5n / 100n);
  assert.equal(allocation.community, (tax - extra) * 4n / 100n);
  assert.equal(allocation.platform, tax - allocation.ownBuyback - allocation.jetBuyback - allocation.distributions - allocation.community);
  assert.equal(await client.readContract({ address: deployment.strategy, abi: artifact('ArcLaunchStrategy').abi,
    functionName: 'accruedOpeningNative', args: [feeToken] }), 0n);
  await run(['--resume-only'], feeData);
  assert.equal(BigInt(indexedFees()[feeToken.toLowerCase()].native), 0n);
  assert.equal(BigInt(indexedFees()[feeToken.toLowerCase()].token), 0n);
  await call(deployment.launch, arcAbi, 'trade', [feeToken, true, parseEther('1'), 1n,
    (await client.getBlock()).timestamp + 120n], parseEther('1'));
  await run(['--resume-only'], feeData);
  assert(BigInt(indexedFees()[feeToken.toLowerCase()].native) > 0n, 'Post-collection fees must accrue again');
  assert.equal(await client.request({ method: 'evm_revert', params: [feeFork] }), true);
  await run(['--resume-only'], feeData);
  assert.deepEqual(indexedFees(), feesBefore, 'Reorg must rebuild fee estimates from the canonical logs');
  console.log('PASS: fee estimates match real V4 collection; funding, collection, restart and reorg reconciled.');
  // Exercise the production Rust guard on real V4 state, then restore the economics fixture.
  const saved = await client.request({ method: 'evm_snapshot', params: [] });
  const guardData = resolve(dir, 'guard');
  const platform = deployment.platformToken;
  const launchAbi = artifact('ArcLaunchV2').abi;
  const tokenState = () => client.readContract({ address: deployment.launch, abi: launchAbi, functionName: 'tokens', args: [platform] });
  const [, , reward] = await client.readContract({ address: deployment.launch, abi: launchAbi, functionName: 'terms', args: [platform] });
  await call(deployment.launch, launchAbi, 'fundFees', [platform], parseEther('2000'));
  await assert.rejects(run(['--once'], resolve(guardData, 'warmup')), /history warming up/);
  assert((await tokenState())[1] >= parseEther('1800'), 'Historical budget and collected project fees stay queued');
  assert.equal((await tokenState())[4], 0n);
  assert.equal(await readReward(reward, 'pendingNative'), parseEther('100'));
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [publication - 60] });
  await call(deployment.launch, arcAbi, 'trade', [platform, true, parseEther('5000'), 1n, BigInt(publication + 60)], parseEther('5000'));
  await assert.rejects(run(['--once'], guardData), /spot deviates from historical price/);
  assert.equal((await tokenState())[4], 0n, 'Manipulated pool must not execute a buyback');
  assert.equal(await client.readContract({ address: platform, abi: erc20Abi, functionName: 'balanceOf', args: [reward] }), 0n);
  // Once real history stabilizes, the worker resumes with a partial amount and retains the rest.
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [publication + 570] });
  await client.request({ method: 'evm_mine', params: [] });
  const beforeBudget = (await tokenState())[1];
  snapshot = await run(['--once'], guardData);
  assert.equal(snapshot.keeperPriceGuard, true);
  assert((await tokenState())[1] > 0n && (await tokenState())[1] < beforeBudget);
  assert((await tokenState())[4] > 0n && (await tokenState())[4] < parseEther('100'));
  console.log('PASS: Rust keeper blocks missing history and the 5,000-USDC price attack; bounded swaps resume after stable history.');
  assert.equal(await client.request({ method: 'evm_revert', params: [saved] }), true);
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [publication - 60] });
  await client.request({ method: 'evm_mine', params: [] });
  // The normal sender must recover below its protected 1-USDC reserve before doing any work.
  await call(deployment.launch, artifact('ArcLaunchV2').abi, 'fundKeeperGas', [], parseEther('2'));
  await client.request({ method: 'anvil_setBalance', params: [account.address, `0x${parseEther('0.9').toString(16)}`] });
  // Small gas budget cannot pay the minimum 100; no partial payment is allowed.
  let gasBlocked = false;
  for (let i = 0; i < 20; i++) {
    snapshot = await run(['--once'], dir, '1500000');
    if (Number(testSql(dir, "SELECT count(*) FROM kv WHERE key LIKE 'rewards:%:worker' AND value::jsonb->>'status'='waiting_gas'")) > 0) { gasBlocked = true; break; }
  }
  assert(gasBlocked);
  for (const project of projects) assert.equal(await readReward(project.rewards, 'totalPaid'), 0n);
  const initialQueue = JSON.parse(testSql(dir, `SELECT value FROM kv WHERE key='rewards:5042002:${projects[0].rewards.toLowerCase()}:candidates'`));
  assert(initialQueue.addresses.length >= 128);
  const fullBatchGas = await client.estimateContractGas({ address: projects[0].rewards, account,
    abi: artifact('ArcRewards').abi, functionName: 'distribute', args: [0n, initialQueue.addresses.slice(0, 128)] });
  assert(fullBatchGas * 120n / 100n > 4_000_000n && fullBatchGas * 120n / 100n <= 5_000_000n,
    'A fresh 128-address batch must fit 5M but not 4M including margin');
  // Raise the budget: fit the largest prefix, retaining leftovers for later confirmations.
  for (let i = 0; i < 20; i++) {
    snapshot = await run(['--once'], dir, '4000000');
    if ((await Promise.all(projects.map(p => readReward(p.rewards, 'totalPaid')))).some(v => v >= 100n)) break;
    assert(i < 19);
  }
  const paidInitially = await Promise.all(projects.map(p => readReward(p.rewards, 'totalPaid')));
  assert(paidInitially.some(v => v >= 100n && v < 128n), '4M gas budget must split this queue');
  console.log('PASS: too-small gas budget sends nobody; larger budget sends the maximal affordable batch.');
  // Every --once restarts the worker; the durable queue must retain unpaid addresses.
  for (let i = 0; i < 8; i++) snapshot = await run(['--once']);
  const totalsBefore = await Promise.all(projects.map(p => readReward(p.rewards, 'totalPaid')));
  assert(totalsBefore.every(v => v >= 100n && v <= 128n));
  // A bounded pass now advances both projects. Both may already have spent 114 recipients
  // under 4M, leaving fewer than 100 each; raising the limit cannot pay these leftovers alone.
  assert(totalsBefore.every(v => v > 100n), 'Gas-sized batches must allow more than 100 recipients');
  for (let i = 0; i < 3; i++) snapshot = await run(['--once']);
  assert.deepEqual(await Promise.all(projects.map(p => readReward(p.rewards, 'totalPaid'))), totalsBefore, 'Less than 100 remaining must wait');
  // Add 100 real signed local transactions; old leftovers and new candidates can now be combined.
  await client.request({ method: 'anvil_setAutomine', params: [false] });
  for (let i = 1000; i < 1100; i++) {
    const sender = privateKeyToAccount(`0x${i.toString(16).padStart(64, '0')}`);
    await client.request({ method: 'anvil_setBalance', params: [sender.address, `0x${parseEther('1').toString(16)}`] });
    await createWalletClient({ account: sender, chain, transport: http(url) }).sendTransaction({ to: account.address, value: 1n, gas: 21000n, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 0n });
  }
  await client.request({ method: 'evm_mine', params: [] });
  await client.request({ method: 'anvil_setAutomine', params: [true] });
  await client.request({ method: 'anvil_mine', params: ['0x40', '0x0'] });
  for (let i = 0; i < 20; i++) {
    snapshot = await run(['--once']);
    if ((await Promise.all(projects.map(p => readReward(p.rewards, 'totalPaid')))).every(v => v === 228n)) break;
    assert(i < 19, 'Both token queues must drain without duplicate recipients');
  }
  assert.equal(snapshot.economicsVersion, 3);
  assert.equal(snapshot.launchProtection, true);
  assert.equal(snapshot.openingTaxToPlatform, true);
  assert.equal(snapshot.keeperGasSupport, true);
  assert((await client.readContract({ address: deployment.launch, abi: artifact('ArcLaunchV2').abi, functionName: 'totalKeeperGasPaid' })) > 0n);
  const gasResults = [];
  for (const project of projects) {
    const events = await client.getContractEvents({ address: project.rewards, abi: artifact('ArcRewards').abi, eventName: 'RewardPaid', fromBlock: BigInt(deployment.fromBlock) });
    const byTx = Map.groupBy(events, event => event.transactionHash);
    for (const [hash, rows] of byTx) {
      const receipt = await client.getTransactionReceipt({ hash });
      const tx = await client.getTransaction({ hash });
      assert(rows.length >= 100);
      assert(tx.gas <= 5_000_000n);
      gasResults.push({ token: project.symbol, recipients: rows.length, gasUsed: Number(receipt.gasUsed), gasLimit: Number(tx.gas) });
    }
    assert.equal(new Set(events.map(event => event.args.recipient.toLowerCase())).size, 228);
    assert.equal(await readReward(project.rewards, 'totalPaid'), 228n);
  }
  writeFileSync(resolve(dir, 'gas.json'), JSON.stringify(gasResults, null, 2));
  console.log(JSON.stringify({ directDistributionGas: gasResults }));
  await client.request({ method: 'anvil_mine', params: ['0x40', '0x0'] });
  for (let i = 0; i < 3; i++) snapshot = await run(['--once']);
  api = spawn(resolve('SingleSparkBackend/api/target/debug/jet-arc-backend'), [], { env: { ...env, ARC_KEEPER_PRIVATE_KEY: '' } });
  let output = '', apiErrors = ''; api.stdout.on('data', b => output += b); api.stderr.on('data', b => apiErrors += b);
  let base;
  for (let i = 0; i < 100; i++) {
    const match = output.match(/listening on (127\.0\.0\.1:\d+)/); if (match) { base = `http://${match[1]}`; break; }
    assert(api.exitCode === null, apiErrors); await new Promise(r => setTimeout(r, 100));
  }
  assert(base, 'Read-only API must start');
  for (let i = 0; i < 100; i++) { if ((await fetch(`${base}/api/arc/snapshot`)).ok) break; await new Promise(r => setTimeout(r, 100)); }
  const reserveTreasury = (requestId, token) => fetch(`${base}/api/arc/treasury`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ requestId }) });
  assert.equal((await reserveTreasury('integration-1')).status, 401);
  const challenge = await (await fetch(`${base}/api/auth/nonce?address=${account.address}&chainId=5042002`)).json();
  const signatureAuth = await account.signMessage({ message: challenge.message });
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: challenge.message, chainId: 5042002, signature: signatureAuth }) });
  assert.equal(login.status, 200);
  const session = await login.json();
  const firstTreasury = await (await reserveTreasury('integration-1', session.token)).json();
  assert.deepEqual(Object.keys(firstTreasury).sort(), ['address', 'chainId']);
  assert.match(firstTreasury.address, /^0x[0-9a-f]{40}$/i);
  assert.deepEqual(await (await reserveTreasury('integration-1', session.token)).json(), firstTreasury);
  assert.notEqual((await (await reserveTreasury('integration-2', session.token)).json()).address, firstTreasury.address);
  const treasuryView = await (await fetch(`${base}/api/arc/snapshot`)).json();
  for (const item of treasuryView.tokens) {
    const treasury = await (await fetch(`${base}/api/arc/treasury?token=${item.token}`)).json();
    assert.equal(BigInt(treasury.balance), await client.getBalance({ address: item.community, blockNumber: BigInt(treasury.blockNumber) }));
    assert.equal(BigInt(treasury.pending), await client.readContract({ address: deployment.launch, abi: artifact('ArcLaunchV2').abi,
      functionName: 'communityCredit', args: [item.token], blockNumber: BigInt(treasury.blockNumber) }));
  }
  console.log('Managed treasuries: SIWE authorization, idempotent encrypted creation and exact on-chain balances verified.');
  for (const project of projects) {
    const result = await (await fetch(`${base}/api/arc/rewards/payouts?token=${project.token}&limit=100`)).json();
    assert.equal(result.token.toLowerCase(), project.token.toLowerCase());
    assert.equal(result.total, 228); assert.equal(result.uniqueRecipients, 228);
    assert(result.items.every(item => item.amount === String(parseEther('10'))));
    assert(result.nextCursor, "228 records require pagination");
    const first = await (await fetch(`${base}/api/arc/rewards/payouts?token=${project.token}&limit=20`)).json();
    const next = await (await fetch(`${base}/api/arc/rewards/payouts?token=${project.token}&limit=20&before=${first.nextCursor}`)).json();
    assert.equal(first.items.length, 20); assert.equal(next.items.length, 20);
    assert(!first.items.some(a => next.items.some(b => a.transactionHash === b.transactionHash && a.payoutIndex === b.payoutIndex)));
  }
  assert.equal((await fetch(`${base}/api/arc/rewards?token=${zeroAddress}`)).status, 404);
  assert((await client.readContract({ address: deployment.launch, abi: arcAbi, functionName: 'communityCredit', args: [projects[1].token] })) >= parseEther('1'));
  assert(snapshot.keeperErrors?.includes('community'), 'Failed treasury delivery must remain visible without blocking burns or rewards');
  if (checkUI) {
    const { chromium, expect } = await import('@playwright/test');
    vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'arc', '--host', '127.0.0.1', '--port', '5180', '--strictPort'], {
      env: { ...process.env, VITE_API_BASE: base, VITE_ARC_LAUNCH_ENABLED: 'true', VITE_ARC_CHAIN_ID: '5042002',
        VITE_CHAIN_CONFIG_SIGNERS: JSON.stringify({ 'arc-local': account.address }) }, stdio: 'ignore',
    });
    for (let i = 0; ; i++) {
      try { if ((await fetch(site)).ok) break; } catch { /* Wait for Vite. */ }
      assert(i < 100 && vite.exitCode === null, 'Vite must start'); await new Promise(r => setTimeout(r, 100));
    }
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(site);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { localStorage.setItem('ember-locale', 'en'); localStorage.setItem('jet-theme', theme); }, theme);
      await page.goto(`${site}/create`);
      await expect(page.locator('#arc-buy-fee')).toHaveValue('0');
      await expect(page.locator('#arc-sell-fee')).toHaveValue('0');
      await page.locator('#arc-create-name').fill('Own Token');
      await page.locator('#arc-create-symbol').fill('OWN');
      await expect(page.locator('#arc-community')).toHaveCount(0);
      await page.locator('#arc-buy-fee').focus();
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('.arc-create-terms')).toContainText('0.01%');
      await expect(page.locator('#arc-sell-fee')).toHaveValue('0');
      await page.locator('#arc-sell-fee').focus();
      await page.keyboard.press('End');
      await expect(page.locator('#arc-sell-fee')).toHaveValue('10');
      await expect(page.locator('#arc-buy-fee')).toHaveValue('0.01');
      await expect(page.locator('.arc-fee-split')).toContainText('Buy OWN for distributions');
      for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.locator('.pg-main').evaluate(async el => { el.getBoundingClientRect(); await Promise.allSettled(el.getAnimations().map(a => a.finished)); });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Create must fit viewport');
        await page.screenshot({ path: resolve(dir, `create-${theme}-${width}.png`), fullPage: true });
      }
      for (const project of projects) {
        await page.goto(`${site}/token/${project.token}`);
        await page.getByRole('button', { name: 'Distributions', exact: true }).click();
        const rows = page.locator('.arc-history tbody tr');
        await expect(rows).toHaveCount(20);
        await expect(rows.first()).toContainText(`10 ${project.symbol}`);
        const firstRecipient = await rows.first().locator('a').first().getAttribute('href');
        await page.getByRole('button', { name: 'Next', exact: true }).click();
        await expect(rows).toHaveCount(20);
        await expect(rows.first().locator('a').first()).not.toHaveAttribute('href', firstRecipient);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Distributions must fit mobile');
        await page.screenshot({ path: resolve(dir, `rewards-${project.symbol}-${theme}.png`), fullPage: true });
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: real API UI; custom fees, own-token labels, separate histories, pagination, desktop/mobile and light/dark.');
  }
  writeFileSync(resolve(dir, 'checked.json'), JSON.stringify({ deployment, projects, snapshot, base }));
  console.log(`PASS: custom fees, five-way funds, two isolated own-token queues, 456 recipients, gas sizing and restart recovery and paginated APIs. Evidence: ${dir}`);
} finally { await browser?.close(); vite?.kill('SIGTERM'); api?.kill('SIGTERM'); anvil.kill('SIGTERM'); }
