// Read-only audit of the V2 synthetic wallet run, at one indexed testnet block.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicClient, http, fallback, erc20Abi, parseEther, formatEther, keccak256, zeroAddress } from 'viem';
import { artifact } from './deploy.mjs';
import { persist } from './runtime.mjs';

const report = JSON.parse(readFileSync('SingleSparkContract/arc/deployments/arc-v2-random-wallets.json'));
assert.equal(report.status, 'transactions_confirmed');
const d = JSON.parse(readFileSync('SingleSparkContract/arc/deployments/arc-economics-v2-testnet.json')).deployment;
assert.equal(report.launch, d.launch);
const client = createPublicClient({ transport: fallback(['https://rpc.blockdaemon.testnet.arc.network', 'https://rpc.testnet.arc.network']
  .map(url => http(url, { timeout: 15000, retryCount: 1 })), { retryCount: 1 }), cacheTime: 0 });
assert.equal(await client.getChainId(), 5042002);
assert.equal(keccak256(await client.getCode({ address: d.launch })), d.launchCodeHash);
const response = await fetch('http://127.0.0.1:8094/api/arc/snapshot'); assert(response.ok);
const snapshot = await response.json(); assert.equal(snapshot.launch.toLowerCase(), d.launch.toLowerCase());
const block = BigInt(snapshot.blockNumber), abi = artifact('ArcLaunchV2').abi, rewardAbi = artifact('ArcRewards').abi;
assert((await client.getBlock({ blockTag: 'finalized' })).number >= block, 'Wait until the audit block is finalized');
assert(Object.values(report.transactions).every(tx => BigInt(tx.block) <= block), 'Wait for the indexer to catch up');
const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, blockNumber: block });
const wallets = report.wallets.slice(0, report.testWalletCount), projects = report.projects;
for (const [hash, failed] of Object.entries(report.failedTransactions ?? {})) {
  const receipt = await client.getTransactionReceipt({ hash }); assert.equal(receipt.status, 'reverted');
  assert.equal(String(receipt.blockNumber), failed.block);
  assert.equal(receipt.gasUsed * receipt.effectiveGasPrice, parseEther(failed.gasUSDC));
}
for (const prefix of ['buy-', 'sell-', 'approve-']) assert.equal(Object.keys(report.transactions).filter(k => k.startsWith(prefix)).length, wallets.length * 2);
for (const p of projects) p.rewards = (await read(d.launch, abi, 'terms', [p.token]))[2];
const events = [], transfers = [], rewards = [];
for (let from = BigInt(d.fromBlock); from <= block; from += 1000n) {
  const to = from + 999n < block ? from + 999n : block;
  const results = await Promise.allSettled([
    client.getContractEvents({ address: d.launch, abi, fromBlock: from, toBlock: to, strict: true }),
    client.getContractEvents({ address: projects.map(p => p.token), abi: erc20Abi, eventName: 'Transfer', fromBlock: from, toBlock: to, strict: true }),
    client.getContractEvents({ address: projects.map(p => p.rewards), abi: rewardAbi, fromBlock: from, toBlock: to, strict: true }),
  ]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  events.push(...results[0].value); transfers.push(...results[1].value); rewards.push(...results[2].value);
  if ((from - BigInt(d.fromBlock)) % 10000n === 0n) console.log(`Reading finalized history: ${to}/${block}`);
}
const lower = address => address.toLowerCase();
const trades = events.filter(e => e.eventName === 'Traded');
const paid = rewards.filter(e => e.eventName === 'RewardPaid');
const checks = [];
for (let offset = 0; offset < wallets.length; offset += 4) {
  const results = await Promise.allSettled(wallets.slice(offset, offset + 4).map(async w => {
    const actual = trades.filter(e => lower(e.args.trader) === lower(w.address)); assert.equal(actual.length, 4);
    let native = parseEther(report.fundingPerWalletUSDC);
    for (const [i,t] of w.trades.entries()) {
      const p = projects[t.project];
      const buy = actual.find(e => e.transactionHash === t.buyHash), sell = actual.find(e => e.transactionHash === t.sellHash);
      assert(buy?.args.buy === true && sell?.args.buy === false);
      assert.equal(lower(buy.args.token), lower(p.token)); assert.equal(lower(sell.args.token), lower(p.token));
      assert.equal(buy.args.amountIn, BigInt(t.buyRaw)); assert.equal(buy.args.amountOut, BigInt(t.boughtRaw));
      assert.equal(sell.args.amountIn, BigInt(t.soldRaw)); assert.equal(sell.args.amountOut, BigInt(t.receivedNativeRaw));
      const reward = paid.filter(e => lower(e.address) === lower(p.rewards) && lower(e.args.recipient) === lower(w.address)).reduce((n,e) => n + e.args.amount, 0n);
      assert.equal(await read(p.token, erc20Abi, 'balanceOf', [w.address]), buy.args.amountOut - sell.args.amountIn + reward, `Token balance ${w.index}/${p.symbol}`);
      assert.equal(await read(p.token, erc20Abi, 'allowance', [w.address, d.launch]), 0n, 'Exact approvals must be consumed');
      native += sell.args.amountOut - buy.args.amountIn;
      for (const prefix of ['buy', 'approve', 'sell']) native -= parseEther(report.transactions[`${prefix}-${w.index}-${i}`].gasUSDC);
      for (const tx of Object.values(report.failedTransactions ?? {})) if (tx.label === `buy-${w.index}-${i}` || tx.label === `sell-${w.index}-${i}`) native -= parseEther(tx.gasUSDC);
    }
    assert.equal(await client.getBalance({ address: w.address, blockNumber: block }), native, `USDC balance ${w.index}`);
  }));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  console.log(`Verified wallet balances: ${Math.min(offset + 4, wallets.length)}/${wallets.length}`);
}
for (const p of projects) {
  const token = snapshot.tokens.find(t => lower(t.token) === lower(p.token)); assert(token);
  const balances = new Map();
  const add = (address, amount) => { if (address !== zeroAddress) balances.set(address, (balances.get(address) ?? 0n) + amount); };
  for (const e of transfers.filter(e => lower(e.address) === lower(p.token))) { add(lower(e.args.from), -e.args.value); add(lower(e.args.to), e.args.value); }
  assert([...balances.values()].every(n => n >= 0n));
  const supply = await read(p.token, erc20Abi, 'totalSupply');
  assert.equal([...balances.values()].reduce((sum,n) => sum + n, 0n), supply);
  const excluded = new Set(snapshot.holderExcludedAddresses.map(lower));
  const holders = [...balances].filter(([address, balance]) => balance > 0n && !excluded.has(address)).length;
  assert.equal(token.holders, holders, `Indexed holders ${p.symbol}`);
  const burns = events.filter(e => e.eventName === 'Burned' && lower(e.args.token) === lower(p.token));
  const totalBurned = burns.reduce((n,e) => n + e.args.totalBurned, 0n);
  assert.equal(10n**27n - supply, totalBurned); assert.equal(BigInt(token.totalBurned), totalBurned);
  assert.equal(BigInt(token.totalSupply), supply);
  assert.equal(BigInt(token.totalBuyback), burns.reduce((n,e) => n + e.args.nativeAmount, 0n));
  for (const e of burns) assert(snapshot.records.some(r => r.transactionHash === e.transactionHash), 'Burn missing from API');
  const allocations = events.filter(e => e.eventName === 'FeesAllocated' && lower(e.args.token) === lower(p.token));
  for (const { args: a } of allocations) {
    for (const [field, percent] of [['ownBuyback',83n],['jetBuyback',7n],['distributions',5n],['community',4n]]) assert.equal(a[field], a.nativeAmount * percent / 100n);
    assert.equal(a.platform, a.nativeAmount - a.ownBuyback - a.jetBuyback - a.distributions - a.community);
  }
  const rewardEvents = rewards.filter(e => lower(e.address) === lower(p.rewards)), payouts = rewardEvents.filter(e => e.eventName === 'RewardPaid');
  assert.equal(new Set(payouts.map(e => lower(e.args.recipient))).size, payouts.length, 'Cross-round recipient deduplication');
  assert(payouts.every(e => e.args.amount === parseEther('10')));
  const available = await read(p.rewards, rewardAbi, 'available'), reserved = await read(p.rewards, rewardAbi, 'reserved');
  assert.equal(await client.getBalance({ address: p.rewards, blockNumber: block }), await read(p.rewards, rewardAbi, 'pendingNative'), 'Rewards USDC accounting');
  assert.equal(await read(p.token, erc20Abi, 'balanceOf', [p.rewards]), available + reserved);
  assert.equal(rewardEvents.filter(e => e.eventName === 'RewardFunded').reduce((n,e) => n + e.args.amount, 0n), available + reserved + BigInt(payouts.length) * parseEther('10'));
  const baseline = report.baseline.records.filter(r => lower(r.token) === lower(p.token)).length;
  const testTrades = trades.filter(e => lower(e.args.token) === lower(p.token) && wallets.some(w => lower(w.address) === lower(e.args.trader)));
  checks.push({ symbol: p.symbol, token: p.token, buys: testTrades.filter(e=>e.args.buy).length, sells: testTrades.filter(e=>!e.args.buy).length,
    holders, newBurns: burns.length - baseline, totalBurned: formatEther(totalBurned), rewardAvailable: formatEther(available), rewardReserved: formatEther(reserved), confirmedPayouts: payouts.length });
}
assert.equal(await client.getBalance({ address: d.launch, blockNumber: block }), await read(d.launch, abi, 'nativeAccounted'), 'Factory USDC accounting');
const result = { status: 'passed', syntheticTestActivity: true, chainId: 5042002, checkedAt: new Date().toISOString(), blockNumber: String(block),
  wallets: wallets.length, fundedUSDC: String(wallets.length / 2), trades: wallets.length * 4, confirmedTransactions: Object.keys(report.transactions).length,
  confirmedFailures: Object.keys(report.failedTransactions ?? {}).length, transactionGasUSDC: report.gasUSDC, funderBalanceUSDC: formatEther(await client.getBalance({ address: report.funder })), projects: checks,
  checks: ['same-block wallet native/token balances', 'exact approvals consumed', '80 actual trade events', 'Transfer-derived holders and supply', '83/7/5/4/1 fee allocation', 'burn history', 'reward budget conservation and recipient deduplication', 'factory USDC accounting'] };
persist('SingleSparkContract/arc/deployments/arc-v2-random-wallets-validation.json', result); console.log(JSON.stringify(result));
