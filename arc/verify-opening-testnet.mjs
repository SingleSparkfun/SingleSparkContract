// Read-only finalized accounting proof. No wallet, signatures or transactions.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, parseEther, formatEther, parseEventLogs } from 'viem';
import { artifact } from './deploy.mjs';

const [deploymentPath, proofPath] = process.argv.slice(2);
assert(deploymentPath && proofPath && process.env.ARC_RPC_URL);
const report = JSON.parse(readFileSync(deploymentPath));
const d = report.deployment, test = report.openingTaxTest;
assert.equal(d.launchProtectionVersion, 2);
assert(['trades-passed-awaiting-keeper', 'passed'].includes(test.status));
const client = createPublicClient({ transport: http(process.env.ARC_RPC_URL), cacheTime: 0 });
assert.equal(await client.getChainId(), 5042002);
const final = await client.getBlock({ blockTag: 'finalized' });
const abi = artifact('ArcLaunchV2').abi;
const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, blockNumber: final.number });
const factory = (functionName, args = []) => read(d.launch, abi, functionName, args);
const strategy = (functionName, token) => read(d.strategy, artifact('ArcLaunchStrategy').abi, functionName, [token]);
const lower = address => address.toLowerCase();
const events = [];
for (let from = BigInt(d.fromBlock); from <= final.number; from += 10000n) {
  events.push(...parseEventLogs({ abi, strict: true, logs: await client.getLogs({ address: d.launch, fromBlock: from,
    toBlock: from + 9999n < final.number ? from + 9999n : final.number }) }));
}
const scoped = (eventName, token) => events.filter(e => e.eventName === eventName && lower(e.args.token) === lower(token));
const sum = (events, field) => events.reduce((v, e) => v + e.args[field], 0n);
const tokenProofs = [];
let accounted = 0n, claims = 0n, collectedExtra = 0n;
for (const token of [test.token, d.platformToken]) {
  const isPlatform = lower(token) === lower(d.platformToken);
  const allocations = scoped('FeesAllocated', token);
  const burns = scoped('Burned', token);
  const state = await factory('tokens', [token]);
  const [, , rewards] = await factory('terms', [token]);
  const uncollected = await strategy('accruedNative', token);
  const extra = await strategy('accruedOpeningNative', token);
  const expectedExtra = isPlatform ? 0n : parseEther('7.68');
  assert(extra === 0n || extra === expectedExtra);
  let openingRemaining = expectedExtra - extra;
  collectedExtra += openingRemaining;
  for (const event of allocations) {
    const a = event.args, opening = openingRemaining;
    openingRemaining = 0n;
    const base = a.nativeAmount - opening;
    assert(base >= 0n);
    assert.equal(a.tokenAmount, 0n);
    assert.equal(a.ownBuyback, base * 83n / 100n);
    assert.equal(a.jetBuyback, base * 7n / 100n + opening);
    assert.equal(a.distributions, base * 5n / 100n);
    assert.equal(a.community, base * 4n / 100n);
    assert.equal(a.platform, base - a.ownBuyback - (a.jetBuyback - opening) - a.distributions - a.community);
  }
  assert.equal(openingRemaining, 0n);
  const normal = test.normalTrades[token];
  const userTax = parseEther(normal.buy.taxUSDC) + parseEther(normal.sell.taxUSDC) + (isPlatform ? 0n : parseEther('7.92'));
  const burnTax = burns.reduce((v, e) => v + (e.args.nativeAmount * 30000n + 999999n) / 1000000n, 0n);
  assert.equal(sum(allocations, 'nativeAmount') + uncollected, userTax + burnTax);
  const allocatedBuyback = sum(allocations, 'ownBuyback') + (isPlatform ? sum(events.filter(e => e.eventName === 'FeesAllocated'), 'jetBuyback') : 0n);
  assert.equal(state[1], allocatedBuyback - sum(burns, 'nativeAmount'));
  assert.equal(state[2], 0n);
  assert.equal(state[4], sum(burns, 'nativeAmount'));
  assert.equal(state[5], sum(burns, 'totalBurned'));
  assert.equal(await read(token, artifact('ArcLaunch', 'ArcToken').abi, 'totalSupply'), parseEther('1000000000') - state[5]);
  const rewardBudget = await read(rewards, artifact('ArcRewards').abi, 'pendingNative');
  assert.equal(rewardBudget, sum(allocations, 'distributions'));
  assert.equal(await client.getBalance({ address: rewards, blockNumber: final.number }), rewardBudget);
  const community = await factory('communityCredit', [token]);
  assert.equal(community, sum(allocations, 'community'));
  accounted += state[1] + community;
  claims += uncollected;
  for (const burn of burns) {
    assert.equal(burn.args.feeTokens, 0n);
    assert.equal(lower((await client.getTransaction({ hash: burn.transactionHash })).from), lower(d.keeper));
  }
  tokenProofs.push({ token, userTaxUSDC: formatEther(userTax), allocatedTaxUSDC: formatEther(sum(allocations, 'nativeAmount')),
    uncollectedTaxUSDC: formatEther(uncollected), pendingBuybackUSDC: formatEther(state[1]),
    buybackUSDC: formatEther(state[4]), burnedTokens: formatEther(state[5]), rewardBudgetUSDC: formatEther(rewardBudget),
    communityUSDC: formatEther(community), allocationTransactions: allocations.map(e => e.transactionHash), burnTransactions: burns.map(e => e.transactionHash) });
}
accounted += await factory('operationsCredit');
assert.equal(await factory('nativeAccounted'), accounted);
assert.equal(await client.getBalance({ address: d.launch, blockNumber: final.number }), accounted);
assert.equal(await read(d.poolManager, artifact('PoolManager').abi, 'balanceOf', [d.strategy, 0n]), claims);
const snapshot = await (await fetch('http://127.0.0.1:8090/api/arc/snapshot')).json();
assert.equal(lower(snapshot.launch), lower(d.launch));
assert(snapshot.launchProtection && snapshot.openingTaxToPlatform);
const burns = scoped('Burned', d.platformToken);
const indexed = burns.every(b => snapshot.records.some(r => r.transactionHash === b.transactionHash));
const tradeHashes = [test.transactions.openingBuy.hash, ...Object.values(test.normalTrades).flatMap(row => [row.buy.transactionHash, row.sell.transactionHash])];
const tradesIndexed = tradeHashes.every(hash => snapshot.trades.some(trade => trade.transactionHash === hash));
const status = collectedExtra === parseEther('7.68') && burns.length > 0 && indexed && tradesIndexed ? 'passed' : 'waiting-keeper-or-index';
const proof = { status, checkedAt: new Date().toISOString(), finalizedBlock: String(final.number), factory: d.launch,
  platformToken: d.platformToken, probe: test.probe, openingTrade: test.transactions.openingBuy, collectedExtraUSDC: formatEther(collectedExtra),
  nativeAccountedUSDC: formatEther(accounted), tokens: tokenProofs, keeper: d.keeper, burnsIndexed: indexed, tradesIndexed,
  limits: 'Bounded testnet trades and SPARK automatic buyback. Reward budgets remain below 5 USDC; public reward purchase/distribution not exercised. Local integration separately validated 456 synthetic recipient payments.' };
writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify(proof, null, 2));
