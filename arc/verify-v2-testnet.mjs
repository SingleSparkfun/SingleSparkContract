// Read-only verification at the final deployment block; never signs or sends transactions.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, erc20Abi, encodeDeployData, formatEther, keccak256, parseEther, parseEventLogs, zeroAddress } from 'viem';
import { artifact } from './deploy.mjs';
import { resolveProfile, keeperGasArgument } from './chains/profile.mjs';

const [deploymentPath, reportPath] = process.argv.slice(2);
assert(deploymentPath && reportPath && process.env.ARC_RPC_URL, 'Provide deployment JSON, report path and ARC_RPC_URL');
const record = JSON.parse(readFileSync(deploymentPath, 'utf8'));
const deployment = record.deployment || record;
const client = createPublicClient({ transport: http(process.env.ARC_RPC_URL) });
assert.equal(await client.getChainId(), deployment.chainId);
// The committed profile for this chain (or ARC_CHAIN_PROFILE for a local one) is what the contracts must hold.
const profile = resolveProfile(deployment.chainId);
const { halfSupplyCost, keeperGas } = profile.economics;
assert.equal(deployment.independentFees, true);
const transactions = {};
let gasCost = 0n;
let blockNumber = 0n;
for (const [step, hash] of Object.entries(deployment.transactions)) {
  const receipt = await client.getTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', step);
  const gas = receipt.gasUsed * receipt.effectiveGasPrice;
  gasCost += gas;
  if (receipt.blockNumber > blockNumber) blockNumber = receipt.blockNumber;
  transactions[step] = { hash, block: String(receipt.blockNumber), gasUSDC: formatEther(gas) };
}
const read = (name, address, functionName, args = []) => client.readContract({ address, abi: artifact(name).abi, functionName, args, blockNumber });
const factory = (fn, args) => read('ArcLaunchV2', deployment.launch, fn, args);
const sameAddress = (actual, expected) => assert.equal(actual.toLowerCase(), expected.toLowerCase());
assert.equal(deployment.economicsVersion, 3, 'Use archived reports for older factories');
assert.equal(await factory('ECONOMICS_VERSION'), 3n);
assert.equal(await factory('INDEPENDENT_FEES'), true);
assert.equal(await factory('INTERVAL'), 180n);
assert.equal(await factory('minBuyback'), parseEther(deployment.minBuyback));
for (const [fn, value] of Object.entries({ KEEPER_GAS_TRIGGER: keeperGas.trigger, KEEPER_GAS_BUFFER: keeperGas.buffer,
  KEEPER_GAS_MAX_TOPUP: keeperGas.maxTopup, KEEPER_GAS_MIN_TOPUP: keeperGas.minTopup, KEEPER_GAS_DAILY_LIMIT: keeperGas.dailyLimit })) {
  assert.equal(await factory(fn), value, `factory.${fn}`);
}
for (const key of ['keeper', 'operations', 'platformToken', 'strategy', 'feeSplitter', 'positionManager', 'poolManager']) sameAddress(await factory(key), deployment[key]);
assert.notEqual(deployment.keeper.toLowerCase(), deployment.operations.toLowerCase());
assert.deepEqual(await factory('tradeFees', [deployment.platformToken]), [deployment.platformBuyFee, deployment.platformSellFee]);
const [fee, community, rewards] = await factory('terms', [deployment.platformToken]);
assert.equal(fee, 0x800000);
sameAddress(community, deployment.platformCommunity ?? deployment.community ?? zeroAddress);
if (deployment.platformCommunity != null) {
  assert.equal(await factory('platformToken'), deployment.platformToken, 'platform token must be bound during launch');
  assert.equal(await factory('communityCredit', [deployment.platformToken]), 0n);
}
sameAddress(rewards, deployment.rewards);
assert.equal(deployment.keeperPriceGuardVersion, 2, 'Use the archived verification report for legacy factories');
const guarded = true;
assert.equal(BigInt(deployment.strategy) & 0x3fffn, guarded ? 0x28ecn : 0x80n);
let keeperGuard;
if (guarded) {
  assert.equal(await factory('KEEPER_PRICE_GUARD_VERSION'), BigInt(deployment.keeperPriceGuardVersion));
  const [sqrtPriceX96, maxInput] = await read('ArcLaunchStrategy', deployment.strategy, 'keeperSwapState', [deployment.platformToken, true]);
  // 50 USDC on Arc: halfSupplyCost / 200 in the chain's currency.
  assert(sqrtPriceX96 > 0n && maxInput >= parseEther(deployment.minBuyback) && maxInput < halfSupplyCost * 50n / 10_000n);
  assert.equal(await read('ArcLaunchStrategy', deployment.strategy, 'HALF_SUPPLY_COST'), halfSupplyCost);
  assert.equal(await read('ArcLaunchStrategy', deployment.strategy, 'MIN_LAUNCH_TICK'), profile.economics.minLaunchTick);
  assert.equal(await read('ArcLaunchStrategy', deployment.strategy, 'accruedNative', [deployment.platformToken]), 0n);
  assert.equal(await read('ArcRewards', rewards, 'lastPurchaseAt'), 0n);
  keeperGuard = { version: deployment.keeperPriceGuardVersion, hookFlags: '0x28ec', initialMaxBuyUSDC: formatEther(maxInput),
    virtualReserveInputPpm: deployment.keeperPriceGuardVersion >= 2 ? Math.min(5000, Math.floor((deployment.platformBuyFee + deployment.platformSellFee) / 8)) : 5000,
    actionCooldownSeconds: 180 };
}
for (const [fn, expected] of Object.entries({ token: deployment.platformToken, launch: deployment.launch, keeper: deployment.keeper })) sameAddress(await read('ArcRewards', rewards, fn), expected);
assert.equal(await read('ArcRewards', rewards, 'PAYOUT'), parseEther('10'));
assert.equal(await read('ArcRewards', rewards, 'MIN_RECIPIENTS'), 100n);
assert.equal(await read('ArcRewards', rewards, 'totalPaid'), 0n);
const [positionId] = await factory('tokens', [deployment.platformToken]);
sameAddress(await read('PositionManager', deployment.positionManager, 'ownerOf', [positionId]), deployment.feeSplitter);
const [poolKey] = await read('PositionManager', deployment.positionManager, 'getPoolAndPositionInfo', [positionId]);
sameAddress(poolKey.currency0, zeroAddress);
sameAddress(poolKey.currency1, deployment.platformToken);
sameAddress(poolKey.hooks, deployment.strategy);
assert.equal(poolKey.fee, 0x800000);
assert.equal(poolKey.tickSpacing, 25);
const supply = await client.readContract({ address: deployment.platformToken, abi: erc20Abi, functionName: 'totalSupply', blockNumber });
assert.equal(supply, parseEther('1000000000'));
const [platformName, platformSymbol] = await Promise.all(['name', 'symbol'].map(functionName => client.readContract({ address: deployment.platformToken, abi: erc20Abi, functionName, blockNumber })));
if (deployment.platformName != null) assert.equal(platformName, deployment.platformName);
if (deployment.platformSymbol != null) assert.equal(platformSymbol, deployment.platformSymbol);
let openingProtection, effectiveBuyFee = deployment.platformBuyFee;
if (deployment.launchProtectionVersion != null) {
  assert.equal(deployment.launchProtectionVersion, 2);
  assert.equal(await read('ArcLaunchStrategy', deployment.strategy, 'launchProtectionVersion'), 2n);
  assert.equal(await read('ArcLaunchStrategy', deployment.strategy, 'OPENING_BUY_FEE'), 990000);
  assert.equal(await read('ArcLaunchStrategy', deployment.strategy, 'OPENING_SECONDS'), 3n);
  const [startsAt, endsAt, buyFee] = await read('ArcLaunchStrategy', deployment.strategy, 'launchProtection', [deployment.platformToken]);
  const launchBlock = await client.getBlock({ blockNumber: BigInt(transactions.launch.block) });
  const at = await client.getBlock({ blockNumber });
  assert.equal(startsAt, launchBlock.timestamp);
  assert.equal(endsAt, startsAt + (deployment.platformBuyFee || deployment.platformSellFee ? 3n : 0n));
  const elapsed = Number(at.timestamp - startsAt);
  assert.equal(buyFee, at.timestamp >= endsAt ? deployment.platformBuyFee
    : Math.max(deployment.platformBuyFee, Math.floor(990000 / 4 ** elapsed)));
  effectiveBuyFee = buyFee;
  openingProtection = { version: 2, excessTaxDestination: 'platform-buyback', startsAt: String(startsAt), endsAt: String(endsAt), buyFeePpm: buyFee };
}
// The profile's half-supply cost (10,000 USDC on Arc) should buy about half the supply at the base fee.
const { result: [tokensFor10000USDC] } = await client.simulateContract({ address: deployment.quoter, abi: artifact('V4Quoter').abi,
  functionName: 'quoteExactInputSingle', args: [{ poolKey, zeroForOne: true, exactAmount: halfSupplyCost, hookData: '0x' }], blockNumber });
// The deployment block may still carry opening tax. Calibrate against the same net pool input.
const calibrationInput = halfSupplyCost * BigInt(1000000 - deployment.platformBuyFee) / BigInt(1000000 - effectiveBuyFee);
const { result: [calibrationTokens] } = await client.simulateContract({ address: deployment.quoter, abi: artifact('V4Quoter').abi,
  functionName: 'quoteExactInputSingle', args: [{ poolKey, zeroForOne: true, exactAmount: calibrationInput, hookData: '0x' }], blockNumber });
assert(calibrationTokens > supply * 49n / 100n && calibrationTokens < supply * 51n / 100n);
const creation = await client.getTransaction({ hash: deployment.transactions.ArcLaunchV2 });
const compiled = artifact('ArcLaunchV2');
assert.equal(creation.input, encodeDeployData({ abi: compiled.abi, bytecode: compiled.bytecode.object,
  args: [deployment.positionManager, deployment.keeper, deployment.operations, parseEther(deployment.minBuyback), keeperGasArgument(profile)] }));
const codeHashes = {};
for (const key of ['launch', 'strategy', 'feeSplitter', 'quoter', 'platformToken', 'rewards']) {
  const code = await client.getCode({ address: deployment[key], blockNumber });
  assert(code && code !== '0x', key);
  codeHashes[key] = keccak256(code);
  if (guarded) {
    const name = { launch: 'ArcLaunchV2', strategy: 'ArcLaunchStrategy', feeSplitter: 'FeeSplitter', quoter: 'V4Quoter',
      platformToken: 'ArcToken', rewards: 'ArcRewards' }[key];
    const compiled = (name === 'ArcToken' ? artifact('ArcLaunch', name) : artifact(name)).deployedBytecode;
    const expected = Buffer.from(compiled.object.slice(2), 'hex');
    const actual = Buffer.from(code.slice(2), 'hex');
    for (const { start, length } of Object.values(compiled.immutableReferences || {}).flat()) {
      expected.fill(0, start, start + length); actual.fill(0, start, start + length);
    }
    assert.deepEqual(actual, expected, `${key}: compiled runtime mismatch`);
  }
}
assert.equal(codeHashes.launch, deployment.launchCodeHash);
const report = { status: 'passed', checkedAt: new Date().toISOString(), blockNumber: String(blockNumber), deployment, transactions, codeHashes,
  platformIdentity: { name: platformName, symbol: platformSymbol },
  ...(guarded ? { keeperGuard, compiledRuntimeVerified: Object.keys(codeHashes) } : {}),
  deploymentGasUSDC: formatEther(gasCost), platformFees: { buyPercent: deployment.platformBuyFee / 10000, sellPercent: deployment.platformSellFee / 10000 },
  nativeSymbol: profile.nativeCurrency.symbol,
  initialQuote: { inputUSDC: formatEther(halfSupplyCost), tokens: formatEther(tokensFor10000USDC), supplyPercent: Number(tokensFor10000USDC * 100000000n / supply) / 1000000 },
  openingProtection, baseFeeCalibration: { equivalentBaseInputUSDC: formatEther(halfSupplyCost), quotedGrossInputUSDC: formatEther(calibrationInput), tokens: formatEther(calibrationTokens) },
  lockedPositionId: String(positionId), rewards: { mode: 'gas-batched', minimumRecipients: 100, maximumRecipients: null, tokensPerRecipient: 10, totalPaidAtDeployment: '0', randomnessRequired: false }, verification: 'Successful receipts, compiled factory creation code, on-chain configuration, locked LP, fee hook and real V4 quote. No verification trades broadcast.' };
if (record.nativeTaxTest?.status === 'trades-passed') {
  const final = await client.getBlock({ blockTag: 'finalized' });
  const d = deployment, token = d.platformToken;
  const at = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, blockNumber: final.number });
  const f = (name, args) => at(d.launch, artifact('ArcLaunchV2').abi, name, args);
  const logs = [];
  for (let from = BigInt(d.fromBlock); from <= final.number; from += 1000n) {
    const raw = await client.getLogs({ address: d.launch, fromBlock: from,
      toBlock: from + 999n < final.number ? from + 999n : final.number });
    logs.push(...parseEventLogs({ abi: artifact('ArcLaunchV2').abi, logs: raw, strict: true }));
  }
  const sum = (event, field) => logs.filter(x => x.eventName === event).reduce((a, x) => a + x.args[field], 0n);
  const burns = logs.filter(x => x.eventName === 'Burned');
  assert(burns.length > 0, 'Wait for the automatic USDC buyback');
  for (const b of burns) { assert.equal(b.args.feeTokens, 0n); assert(b.args.nativeAmount >= parseEther(deployment.minBuyback)); }
  assert.equal(logs.filter(x => x.eventName === 'Launched').length, 1, 'This proof is scoped to the new SPARK-only deployment');
  assert.equal(sum('FeesAllocated', 'tokenAmount'), 0n);
  const state = await f('tokens', [token]);
  const own = sum('FeesAllocated', 'ownBuyback') + sum('FeesAllocated', 'jetBuyback') - sum('Burned', 'nativeAmount');
  const community = sum('FeesAllocated', 'community') - sum('CommunityClaimed', 'amount');
  const operations = sum('FeesAllocated', 'platform') + sum('KeeperGasFunded', 'amount') - sum('KeeperGasPaid', 'amount') - sum('OperationsClaimed', 'amount');
  assert.equal(state[1], own); assert.equal(state[2], 0n);
  assert.equal(state[4], sum('Burned', 'nativeAmount')); assert.equal(state[5], sum('Burned', 'totalBurned'));
  assert.equal(await f('communityCredit', [token]), community);
  assert.equal(await f('operationsCredit'), operations);
  assert.equal(await f('nativeAccounted'), own + community + operations);
  assert.equal(await client.getBalance({ address: d.launch, blockNumber: final.number }), own + community + operations);
  assert.equal(await at(token, erc20Abi, 'totalSupply'), parseEther('1000000000') - state[5]);
  const pendingReward = await at(d.rewards, artifact('ArcRewards').abi, 'pendingNative');
  assert.equal(pendingReward, sum('FeesAllocated', 'distributions'));
  assert.equal(await client.getBalance({ address: d.rewards, blockNumber: final.number }), pendingReward);
  const uncollected = await at(d.strategy, artifact('ArcLaunchStrategy').abi, 'accruedNative', [token]);
  const userTax = record.nativeTaxTest.rounds.flatMap(r => [r.buy, r.sell]).reduce((a, r) => a + parseEther(r.taxUSDC), 0n);
  const buybackTax = burns.reduce((a, b) => a + (b.args.nativeAmount * 30000n + 999999n) / 1000000n, 0n);
  assert.equal(userTax + buybackTax, sum('FeesAllocated', 'nativeAmount') + uncollected);
  assert.equal(await at(d.poolManager, artifact('PoolManager').abi, 'balanceOf', [d.strategy, 0n]), uncollected);
  const snapshot = await (await fetch('http://127.0.0.1:8090/api/arc/snapshot')).json();
  assert.equal(snapshot.launch.toLowerCase(), d.launch.toLowerCase()); assert.equal(snapshot.economicsVersion, 3);
  assert.equal(snapshot.trades.length, 6);
  for (const b of burns) assert(snapshot.records.some(r => r.transactionHash === b.transactionHash), 'Confirmed buyback is indexed');
  report.nativeTaxProof = { status: 'passed', finalizedBlock: String(final.number), userTrades: 6, userTaxUSDC: formatEther(userTax),
    buybackUSDC: formatEther(state[4]), burnedTokens: formatEther(state[5]), directFeeBurnTokens: '0',
    pendingRewardUSDC: formatEther(pendingReward), uncollectedTaxUSDC: formatEther(uncollected),
    communityCreditUSDC: formatEther(community), platformCreditUSDC: formatEther(operations),
    buybackTransactions: burns.map(b => b.transactionHash),
    limits: 'Real trade-tax collection, five-way accounting and automatic buyback passed. Reward funding remains below 5 USDC; public reward purchase/distribution was not exercised. Local integration separately paid 456 synthetic recipients.' };
}
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, reportPath, deploymentGasUSDC: report.deploymentGasUSDC, initialQuote: report.initialQuote }, null, 2));
