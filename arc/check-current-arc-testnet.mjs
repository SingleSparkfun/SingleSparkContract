// Bounded public-testnet acceptance. The existing API is the only Keeper signer.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { createPublicClient, defineChain, http, erc20Abi, parseEther, formatEther,
  encodeFunctionData, decodeFunctionData, parseEventLogs, keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { artifact } from './deploy.mjs';
import { persist, stringify } from './runtime.mjs';

const minimum = quote => quote * 99n / 100n;
const tax = (gross, fee) => (gross * BigInt(fee) + 999999n) / 1000000n;
const canonicalArgs = args => stringify(args.map(v => typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) ? v.toLowerCase() : v));
const allocation = native => {
  const shares = [83n, 7n, 5n, 4n].map(p => native * p / 100n);
  return [...shares, native - shares.reduce((a, b) => a + b, 0n)];
};
if (process.argv.includes('--self-check')) {
  for (const n of [0n, 1n, 99n, 100n, parseEther('5.2')]) assert.equal(allocation(n).reduce((a, b) => a + b, 0n), n);
  assert.equal(minimum(100n), 99n);
  assert.equal(tax(1n, 30000), 1n);
  assert.equal(tax(parseEther('1'), 30000), parseEther('0.03'));
  assert.equal(canonicalArgs(['CAT', '0x0293818Ba95c93a9A0101276218878476b33C854']), canonicalArgs(['CAT', '0x0293818ba95c93a9a0101276218878476b33c854']));
  assert.notEqual(canonicalArgs(['CAT']), canonicalArgs(['cat']));
  console.log('PASS: integer allocation conserves funds and minimum output retains 1% slippage.');
  process.exit(0);
}
const record = JSON.parse(readFileSync('SingleSparkContract/arc/deployments/arc-current-testnet.json'));
const d = record.deployment;
assert.equal(d.chainId, 5042002);
assert.equal(d.launch.toLowerCase(), '0xd6a56abcddc83d4b780ef4cbfb8f6b7fc093ecf4');
const dir = 'SingleSparkContract/arc/data/current-arc-acceptance-20261005';
const reportPath = 'SingleSparkContract/arc/deployments/current-arc-acceptance-20261005.json';
mkdirSync(dir, { recursive: true, mode: 0o700 });
const wallets = JSON.parse(readFileSync('SingleSparkContract/arc/data/jet-test-wallets-20260916/wallets.json')).wallets;
const funder = privateKeyToAccount(wallets[1].privateKey), tester = privateKeyToAccount(wallets[0].privateKey);
assert.equal(funder.address.toLowerCase(), '0x0ca76906cef08981717f81dfa1519b5a3cecca57');
assert.equal(tester.address.toLowerCase(), '0xdb8953d77d1948c3be9920dfada33a0639045134');
const rpc = 'https://rpc.testnet.arc.network';
const chain = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const c = createPublicClient({ chain, transport: http(rpc, { timeout: 15000, retryCount: 3, retryDelay: 1500 }), cacheTime: 0, pollingInterval: 1500 });
const abi = artifact('ArcLaunchV2').abi, rewardsAbi = artifact('ArcRewards').abi;
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath)) : {
  chainId: chain.id, factory: d.launch, platformToken: d.platformToken, startedAt: new Date().toISOString(),
  scope: 'Current legacy public ARC testnet, controlled test wallets; not Argus or mainnet',
  status: 'preflight', transactions: {},
  limits: { funderReserveUSDC: '50', testerReserveUSDC: '1', perTransactionGasUSDC: '0.15', totalGasUSDC: '1',
    platformSyntheticFundingUSDC: '5.2', operatorSyntheticFundingUSDC: '0.4', buyPerTokenUSDC: '1' },
};
assert.equal(report.factory.toLowerCase(), d.launch.toLowerCase());
const journalPath = `${dir}/journal.json`;
const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath)) : {};
const save = () => persist(reportPath, report);
const same = (a, b) => assert.equal(a.toLowerCase(), b.toLowerCase());
const read = (address, abi, functionName, args = [], blockNumber) => c.readContract({ address, abi, functionName, args, blockNumber });
const factory = (functionName, args = [], blockNumber) => read(d.launch, abi, functionName, args, blockNumber);
const api = async (path, body, token) => {
  const r = await fetch(`http://127.0.0.1:8090${path}`, { method: body == null ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body == null ? {} : { body: stringify(body) }), signal: AbortSignal.timeout(15000) });
  assert(r.ok, `API ${path.split('?')[0]}: ${r.status}`); return r.json();
};
const events = (receipt, name) => parseEventLogs({ abi, eventName: name, logs: receipt.logs }).filter(e => e.address.toLowerCase() === d.launch.toLowerCase());
async function state(block) {
  return { supply: await read(d.platformToken, erc20Abi, 'totalSupply', [], block),
    token: await factory('tokens', [d.platformToken], block),
    rewardNative: await read(d.rewards, rewardsAbi, 'pendingNative', [], block),
    available: await read(d.rewards, rewardsAbi, 'available', [], block),
    totalPaid: await read(d.rewards, rewardsAbi, 'totalPaid', [], block) };
}
async function send(label, account, to, contractAbi, fn, buildArgs, value = 0n) {
  report.stage = label; save();
  let step = journal[label];
  if (!step) {
    const reserve = parseEther(account.address === funder.address ? '50' : '1');
    const nonce = await c.getTransactionCount({ address: account.address });
    assert.equal(nonce, await c.getTransactionCount({ address: account.address, blockTag: 'pending' }), 'Resolve external pending transaction first');
    const args = await buildArgs();
    const data = fn ? encodeFunctionData({ abi: contractAbi, functionName: fn, args }) : '0x';
    const gas = (await c.estimateGas({ account: account.address, to, data, value, prepare: false })) * 120n / 100n;
    const fees = await c.estimateFeesPerGas();
    const maximum = gas * fees.maxFeePerGas;
    assert(maximum <= parseEther('0.15'), 'Per-transaction gas limit');
    const spent = Object.values(report.transactions).reduce((n, tx) => n + BigInt(tx.gasRaw), 0n);
    assert(spent + maximum <= parseEther('1'), 'Total test gas limit');
    assert(await c.getBalance({ address: account.address }) >= reserve + value + maximum, 'Preserve wallet reserve');
    const freshArgs = await buildArgs();
    const freshData = fn ? encodeFunctionData({ abi: contractAbi, functionName: fn, args: freshArgs }) : '0x';
    await c.call({ account: account.address, to, data: freshData, value });
    const raw = await account.signTransaction({ chainId: chain.id, nonce, to, data: freshData, value, gas, ...fees, type: 'eip1559' });
    step = { raw, hash: keccak256(raw), from: account.address, to, fn, args: freshArgs, value: String(value) };
    journal[label] = step; persist(journalPath, journal);
  }
  const tx = parseTransaction(step.raw);
  assert.equal(tx.chainId, chain.id); same(tx.to, to); same(await recoverTransactionAddress({ serializedTransaction: step.raw }), account.address);
  assert.equal(tx.value ?? 0n, value); assert.equal(keccak256(step.raw), step.hash);
  if (fn) {
    const decoded = decodeFunctionData({ abi: contractAbi, data: tx.data });
    assert.equal(decoded.functionName, fn); assert.equal(canonicalArgs(decoded.args), canonicalArgs(step.args));
  } else assert.equal(tx.data ?? '0x', '0x');
  let receipt;
  try { receipt = await c.getTransactionReceipt({ hash: step.hash }); }
  catch (e) { if (e.name !== 'TransactionReceiptNotFoundError') throw e; }
  if (!receipt) {
    try { await c.sendRawTransaction({ serializedTransaction: step.raw }); }
    catch (e) { if (!/already known|nonce too low/i.test(e.message)) throw e; }
    receipt = await c.waitForTransactionReceipt({ hash: step.hash, timeout: 90000 });
  }
  report.transactions[label] = { hash: step.hash, block: String(receipt.blockNumber), from: account.address, to, valueUSDC: formatEther(value),
    gasRaw: String(receipt.gasUsed * receipt.effectiveGasPrice), status: receipt.status };
  save(); assert.equal(receipt.status, 'success', `${label} reverted; journal retained`);
  console.log(stringify({ confirmed: label, hash: step.hash })); return receipt;
}
async function roundTrip(token, account, prefix, fee) {
  assert.deepEqual(await factory('tradeFees', [token]), [fee, fee]);
  const [key] = await read(d.positionManager, artifact('PositionManager').abi, 'getPoolAndPositionInfo', [(await factory('tokens', [token]))[0]]);
  const quote = async (buy, amount) => (await c.simulateContract({ address: d.quoter, abi: artifact('V4Quoter').abi, functionName: 'quoteExactInputSingle',
    args: [{ poolKey: key, zeroForOne: buy, exactAmount: amount, hookData: '0x' }] })).result[0];
  const trade = (buy, amount) => send(`${prefix}-${buy ? 'buy' : 'sell'}`, account, d.launch, abi, 'trade', async () => {
    const out = await quote(buy, amount);
    return [token, buy, amount, minimum(out), (await c.getBlock()).timestamp + 110n];
  }, buy ? amount : 0n);
  const bought = await trade(true, parseEther('1'));
  const buy = events(bought, 'Traded')[0]; assert(buy); same(buy.args.token, token); same(buy.args.trader, account.address);
  assert.equal(buy.args.buy, true); assert.equal(buy.args.amountIn, parseEther('1'));
  await send(`${prefix}-approve`, account, token, erc20Abi, 'approve', async () => [d.launch, buy.args.amountOut]);
  const sold = await trade(false, buy.args.amountOut), sell = events(sold, 'Traded')[0];
  assert(sell); same(sell.args.token, token); same(sell.args.trader, account.address);
  assert.equal(sell.args.buy, false); assert.equal(sell.args.amountIn, buy.args.amountOut);
  assert.equal(await read(token, erc20Abi, 'allowance', [account.address, d.launch]), 0n);
  const taxes = [];
  for (const [r, trade] of [[bought, buy], [sold, sell]]) {
    const swap = parseEventLogs({ abi: artifact('PoolManager').abi, eventName: 'Swap', logs: r.logs }).filter(e => e.address.toLowerCase() === d.poolManager.toLowerCase());
    assert.equal(swap.length, 1); assert.equal(swap[0].args.fee, 0); // V3 charges USDC through the Hook, not an LP fee.
    const gross = trade.args.buy ? trade.args.amountIn : swap[0].args.amount0;
    const charged = trade.args.buy ? gross + swap[0].args.amount0 : gross - trade.args.amountOut;
    assert.equal(charged, tax(gross, fee));
    const minted = parseEventLogs({ abi: artifact('PoolManager').abi, eventName: 'Transfer', logs: r.logs }).filter(e =>
      e.address.toLowerCase() === d.poolManager.toLowerCase() && e.args.id === 0n && e.args.from === '0x0000000000000000000000000000000000000000');
    assert.equal(minted.reduce((n, e) => n + e.args.amount, 0n), charged);
    for (const e of minted) same(e.args.to, key.hooks);
    taxes.push(charged);
  }
  report[prefix] = { token, buy: buy.args, sell: sell.args, checkedFee: fee, taxRaw: taxes, exactAllowanceConsumed: true }; save();
}
async function verify() {
  const final = await c.getBlock({ blockTag: 'finalized' });
  const start = BigInt(report.baselineBlock) + 1n, logs = [];
  for (let from = start; from <= final.number; from += 1000n) logs.push(...await c.getLogs({ address: [d.launch, d.rewards], fromBlock: from, toBlock: from + 999n < final.number ? from + 999n : final.number }));
  const factoryEvents = parseEventLogs({ abi, logs: logs.filter(l => l.address.toLowerCase() === d.launch.toLowerCase()) });
  const rewardEvents = parseEventLogs({ abi: rewardsAbi, logs: logs.filter(l => l.address.toLowerCase() === d.rewards.toLowerCase()) });
  const allocations = factoryEvents.filter(e => e.eventName === 'FeesAllocated');
  for (const e of allocations) assert.deepEqual([e.args.ownBuyback, e.args.jetBuyback, e.args.distributions, e.args.community, e.args.platform], allocation(e.args.nativeAmount));
  const burns = factoryEvents.filter(e => e.eventName === 'Burned' && e.args.token.toLowerCase() === d.platformToken.toLowerCase());
  const purchases = rewardEvents.filter(e => e.eventName === 'RewardPurchased'), paid = rewardEvents.filter(e => e.eventName === 'RewardPaid');
  const after = await state(final.number), before = report.baseline;
  const sum = (items, field) => items.reduce((n, e) => n + e.args[field], 0n);
  assert.equal(BigInt(before.supply) - after.supply, sum(burns, 'totalBurned'));
  const own = allocations.filter(e => e.args.token.toLowerCase() === d.platformToken.toLowerCase());
  assert.equal(after.rewardNative, BigInt(before.rewardNative) + sum(own, 'distributions') - sum(purchases, 'nativeAmount'));
  assert.equal(after.available, BigInt(before.available) + sum(purchases, 'tokensBought') - sum(paid, 'amount'));
  assert.equal(after.totalPaid - BigInt(before.totalPaid), BigInt(paid.length));
  assert(paid.every(e => e.args.amount === parseEther('10')));
  assert.equal(new Set(paid.map(e => e.args.recipient.toLowerCase())).size, paid.length);
  const batches = [...new Set(paid.map(e => e.transactionHash))].map(hash => ({ hash, recipients: paid.filter(e => e.transactionHash === hash).length }));
  assert(batches.every(b => b.recipients >= 100));
  let history = await api(`/api/arc/rewards/payouts?token=${d.platformToken}&limit=100`);
  const indexedPayouts = [...history.items];
  const payoutMatches = e => indexedPayouts.some(p => p.transactionHash === e.transactionHash && p.logIndex === Number(e.logIndex)
    && p.recipient.toLowerCase() === e.args.recipient.toLowerCase() && p.amount === String(e.args.amount));
  // ponytail: bounded acceptance history; increase the page cap for larger test runs.
  for (let page = 1; page < 20 && history.nextCursor && !paid.every(payoutMatches); page++) {
    history = await api(`/api/arc/rewards/payouts?token=${d.platformToken}&limit=100&before=${history.nextCursor}`);
    indexedPayouts.push(...history.items);
  }
  const snapshot = await api('/api/arc/snapshot');
  const tradeHashes = ['spark-buy', 'spark-sell', 'zero-buy', 'zero-sell'].map(k => report.transactions[k]?.hash).filter(Boolean);
  const indexedTrades = await Promise.all([d.platformToken, report.zeroToken].filter(Boolean).map(token => api(`/api/arc/trades?token=${token}&limit=100`)));
  const tradesIndexed = tradeHashes.every(hash => indexedTrades.some(p => p.items.some(t => t.transactionHash === hash)));
  const burnsIndexed = burns.every(e => snapshot.records.some(r => r.transactionHash === e.transactionHash));
  const payoutsIndexed = history.indexComplete && paid.every(payoutMatches);
  same((await c.getBlock({ blockNumber: final.number })).hash, final.hash);
  report.verification = { finalizedBlock: String(final.number), blockHash: final.hash, supplyReductionRaw: String(sum(burns, 'totalBurned')),
    burnTransactions: burns.map(e => e.transactionHash), rewardPurchaseTransactions: purchases.map(e => e.transactionHash), batches,
    confirmedRecipients: paid.length, rewardAfter: after, tradesIndexed, burnsIndexed, payoutsIndexed,
    funderBalanceUSDC: formatEther(await c.getBalance({ address: funder.address })), testerBalanceUSDC: formatEther(await c.getBalance({ address: tester.address })) };
  report.status = burns.length && purchases.length && paid.length >= 100 && tradesIndexed && burnsIndexed && payoutsIndexed ? 'passed_current_legacy_testnet' : 'waiting_for_keeper_or_index';
  report.checkedAt = new Date().toISOString(); delete report.error; delete report.errorDetails; delete report.stage; save();
  console.log(stringify({ status: report.status, burns: burns.length, purchases: purchases.length, paid: paid.length, tradesIndexed, burnsIndexed, payoutsIndexed }));
}
try {
  assert.equal(await c.getChainId(), chain.id); assert.equal(keccak256(await c.getCode({ address: d.launch })), d.launchCodeHash);
  const snapshot = await api('/api/arc/snapshot'); same(snapshot.launch, d.launch); same(snapshot.platformToken, d.platformToken);
  assert.equal(snapshot.testnet, true); assert.equal(snapshot.keeperEnabled, true); assert.equal(snapshot.keeperPaused, false);
  assert.equal(snapshot.worker.pendingHash, null); assert.equal(snapshot.worker.error, null);
  const operator = record.runtime.keeperOperator; same(snapshot.keeperOperator, operator);
  if (!process.argv.includes('--run') && !process.argv.includes('--verify')) {
    console.log(stringify({ mode: 'read-only', limits: report.limits, funderBalanceUSDC: formatEther(await c.getBalance({ address: funder.address })),
      testerBalanceUSDC: formatEther(await c.getBalance({ address: tester.address })) }));
  } else {
    const lockPath = `${dir}/run.lock`, lock = openSync(lockPath, 'wx', 0o600);
    try {
      if (process.argv.includes('--run')) {
        if (!report.baseline) { const b = await c.getBlock({ blockTag: 'finalized' }); report.baselineBlock = String(b.number); report.baseline = await state(b.number); save(); }
        if (!report.zeroToken) {
          const challenge = await api(`/api/auth/nonce?address=${tester.address}&chainId=5042002`);
          const session = await api('/api/auth/login', { message: challenge.message, signature: await tester.signMessage({ message: challenge.message }), chainId: chain.id });
          const treasury = await api('/api/arc/treasury', { requestId: 'public-arc-acceptance-20261005-zero' }, session.token);
          const launched = await send('zero-launch', tester, d.launch, abi, 'launch', async () => ['ARC Acceptance Test', 'AT1005', '', 0, 0, treasury.address]);
          const event = events(launched, 'Launched')[0]; assert(event); same(event.args.creator, tester.address);
          report.zeroToken = event.args.token; report.zeroTreasury = treasury.address; save();
        }
        assert.deepEqual(await factory('tradeFees', [report.zeroToken]), [0, 0]);
        await roundTrip(report.zeroToken, tester, 'zero', 0);
        await roundTrip(d.platformToken, funder, 'spark', 30000);
        // Explicit test top-ups, never attributed to organic trading fees.
        await send('synthetic-fees-tester', tester, d.launch, abi, 'fundFees', async () => [d.platformToken], parseEther('1.2'));
        await send('synthetic-fees-funder', funder, d.launch, abi, 'fundFees', async () => [d.platformToken], parseEther('4'));
        await send('synthetic-operator-gas', funder, operator, null, null, async () => [], parseEther('0.4'));
        report.status = 'submitted_awaiting_existing_keeper'; save();
      }
      await verify();
    } finally { closeSync(lock); unlinkSync(lockPath); }
  }
} catch (e) {
  report.error = String(e.shortMessage || e.message).replace(/0x[0-9a-fA-F]{64,}/g, '[redacted]').slice(0, 300);
  report.errorDetails = String(e.details || '').replace(/0x[0-9a-fA-F]{64,}/g, '[redacted]').slice(0, 300);
  report.status = 'incomplete'; save(); console.error(report.error); process.exitCode = 1;
}
