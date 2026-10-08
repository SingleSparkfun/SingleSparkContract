// Six explicitly labelled test projects on the deployed V2 factory. Never uses mainnet or invented trades.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, openSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, parseEther, formatEther, erc20Abi,
  encodeFunctionData, decodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { artifact } from './deploy.mjs';
import { persist, stringify } from './runtime.mjs';

process.loadEnvFile('SingleSparkContract/arc/.env.testnet-v2.local');
const deployment = JSON.parse(readFileSync('SingleSparkContract/arc/deployments/jet-v2-testnet-verification.json')).deployment;
assert.equal(Number(process.env.ARC_CHAIN_ID), 5042002);
assert.equal(process.env.ARC_LAUNCH_ADDRESS.toLowerCase(), deployment.launch.toLowerCase());
const plans = [
  ['Tax Test Zero', 'T00', 0, 0], ['Tax Test Buy 1 Sell 5', 'T15', 10000, 50000],
  ['Tax Test Buy 5 Sell 1', 'T51', 50000, 10000], ['Tax Test Sell Only', 'T010', 0, 100000],
  ['Tax Test Buy Only', 'T100', 100000, 0], ['Tax Test Fractional', 'TF235', 23500, 78900],
];
const account = privateKeyToAccount(process.env.ARC_DEPLOYER_PRIVATE_KEY);
const rpc = process.env.ARC_TEST_RPC_URL || 'https://rpc.drpc.testnet.arc.network';
const chain = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const transport = http(rpc, { timeout: 20000, retryCount: 2 });
const client = createPublicClient({ chain, transport, cacheTime: 0 });
const wallet = createWalletClient({ chain, account, transport });
const abi = artifact('ArcLaunchV2').abi;
const rewardAbi = artifact('ArcRewards').abi;
const api = 'http://127.0.0.1:8091';
const dir = process.env.ARC_DATA_DIR;
const journalPath = `${dir}/tax-check-journal.json`;
const reportPath = 'SingleSparkContract/arc/deployments/v2-tax-check-testnet.json';
const identity = stringify({ chainId: chain.id, launch: deployment.launch, account: account.address, plans, buyUSDC: '1', sellShare: '50%' });
const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath)) : { identity, steps: {} };
assert.equal(journal.identity, identity);
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath)) : { identity, chainId: chain.id, launch: deployment.launch,
  syntheticTestActivity: true, trader: account.address, projects: [], transactions: {}, startedAt: new Date().toISOString(), status: 'running' };
assert.equal(report.identity, identity);
const save = () => persist(reportPath, report);
const read = (address, abi, functionName, args = [], blockNumber) => client.readContract({ address, abi, functionName, args, blockNumber });
const factory = (fn, args = [], block) => read(deployment.launch, abi, fn, args, block);
const events = (receipt, name) => parseEventLogs({ abi, eventName: name, logs: receipt.logs }).filter(e => e.address.toLowerCase() === deployment.launch.toLowerCase());
const same = (a, b) => assert.equal(a.toLowerCase(), b.toLowerCase());
const abs = n => n < 0n ? -n : n;
const apiCall = async (path, body, bearer) => {
  const response = await fetch(api + path, { method: body == null ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json',
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, ...(body == null ? {} : { body: stringify(body) }), signal: AbortSignal.timeout(15000) });
  assert(response.ok, `API ${path}: ${response.status}`); return response.json();
};
assert.equal(await client.getChainId(), 5042002);
assert.equal(keccak256(await client.getCode({ address: deployment.launch })), deployment.launchCodeHash);
if (process.argv.includes('--verify-keeper')) {
  assert.equal(report.status, 'trade_and_accounting_passed');
  let snapshot;
  for (let attempt = 0; attempt < 48; attempt++) {
    snapshot = await apiCall('/api/arc/snapshot');
    const waiting = report.projects.filter(p => {
      const token = snapshot.tokens.find(t => t.token.toLowerCase() === p.token.toLowerCase());
      return !token || BigInt(token.totalBurned) < parseEther(p.accounting.pendingBurnTokens);
    });
    if (waiting.length === 0) break;
    if (attempt % 6 === 0) console.log(stringify({ waitingForKeeper: waiting.map(p => p.symbol), workerError: snapshot.worker.error }));
    assert(attempt < 47, 'Keeper burn verification timed out');
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  for (const p of report.projects) {
    const token = snapshot.tokens.find(t => t.token.toLowerCase() === p.token.toLowerCase());
    assert.equal(BigInt(token.totalSupply), parseEther('1000000000') - BigInt(token.totalBurned));
    const records = snapshot.records.filter(r => r.token.toLowerCase() === p.token.toLowerCase());
    for (const record of records) {
      const receipt = await client.getTransactionReceipt({ hash: record.transactionHash });
      assert.equal(receipt.status, 'success');
      const burn = events(receipt, 'Burned').find(e => e.args.token.toLowerCase() === p.token.toLowerCase());
      assert(burn); assert.equal(burn.args.totalBurned, BigInt(record.totalBurned));
    }
    p.keeper = { cycles: token.cycles, burnedTokens: formatEther(BigInt(token.totalBurned)), remainingSupply: formatEther(BigInt(token.totalSupply)), transactions: records.map(r => r.transactionHash) };
  }
  report.keeperVerifiedAt = new Date().toISOString(); save();
  console.log(stringify({ keeperVerified: report.projects.map(p => ({ symbol: p.symbol, ...p.keeper })) }));
  process.exit(0);
}
console.log(stringify({ mode: process.argv.includes('--broadcast') ? 'broadcast' : 'preflight', balanceUSDC: formatEther(await client.getBalance({ address: account.address })),
  projects: plans.map(([name, symbol, buy, sell]) => ({ name, symbol, buyPercent: buy / 10000, sellPercent: sell / 10000 })), buyPerProjectUSDC: '1', sellShare: '50%' }));
if (!process.argv.includes('--broadcast')) process.exit(0);
const lockPath = `${dir}/tax-check.lock`;
const lock = openSync(lockPath, 'wx', 0o600); writeFileSync(lock, String(process.pid));

async function send(label, address, contractAbi, functionName, args, value = 0n) {
  let step = journal.steps[label];
  if (!step) {
    const [nonce, pending, fees, estimate] = await Promise.all([
      client.getTransactionCount({ address: account.address, blockTag: 'latest' }), client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
      client.estimateFeesPerGas(), client.estimateContractGas({ address, abi: contractAbi, functionName, args, account, value }),
    ]);
    assert.equal(nonce, pending, 'Another transaction is pending for the test account');
    const gas = estimate + estimate / 5n;
    assert(gas * fees.maxFeePerGas < parseEther('0.2'), 'Per-transaction gas budget');
    assert(await client.getBalance({ address: account.address }) > value + gas * fees.maxFeePerGas + parseEther('1'), 'Keep a 1 test USDC reserve');
    const raw = await wallet.signTransaction({ to: address, data: encodeFunctionData({ abi: contractAbi, functionName, args }), value, nonce, gas, ...fees, type: 'eip1559' });
    step = { raw, hash: keccak256(raw) }; journal.steps[label] = step; persist(journalPath, journal);
  }
  assert.equal(step.hash, keccak256(step.raw));
  const tx = parseTransaction(step.raw); assert.equal(tx.chainId, 5042002); same(tx.to, address); assert.equal(tx.value ?? 0n, value);
  same(await recoverTransactionAddress({ serializedTransaction: step.raw }), account.address);
  const decoded = decodeFunctionData({ abi: contractAbi, data: tx.data }); assert.equal(decoded.functionName, functionName);
  const count = functionName === 'trade' ? 3 : args.length;
  assert.equal(stringify(decoded.args.slice(0, count)).toLowerCase(), stringify(args.slice(0, count)).toLowerCase());
  let receipt;
  try { receipt = await client.getTransactionReceipt({ hash: step.hash }); } catch (e) { if (e.name !== 'TransactionReceiptNotFoundError') throw e; }
  if (!receipt) {
    try { await client.sendRawTransaction({ serializedTransaction: step.raw }); } catch (e) { if (!/already known|nonce too low/i.test(e.message)) throw e; }
    receipt = await client.waitForTransactionReceipt({ hash: step.hash, timeout: 90000 });
  }
  assert.equal(receipt.status, 'success', `${label}: ${step.hash}`);
  report.transactions[label] = { hash: step.hash, block: String(receipt.blockNumber), gasUSDC: formatEther(receipt.gasUsed * receipt.effectiveGasPrice) }; save();
  console.log(stringify({ confirmed: label, hash: step.hash })); return receipt;
}
const quote = async (poolKey, buy, amount, blockNumber) => (await client.simulateContract({ address: deployment.quoter, abi: artifact('V4Quoter').abi,
  functionName: 'quoteExactInputSingle', args: [{ poolKey, zeroForOne: buy, exactAmount: amount, hookData: '0x' }], blockNumber })).result[0];

async function trade(project, buy, amount, poolKey) {
  const label = `${project.symbol}-${buy ? 'buy' : 'sell'}`;
  const saved = journal.steps[label];
  const quoted = saved ? 0n : await quote(poolKey, buy, amount);
  const deadline = saved ? 0n : (await client.getBlock()).timestamp + 120n;
  const receipt = await send(label, deployment.launch, abi, 'trade', [project.token, buy, amount, quoted * 97n / 100n, deadline], buy ? amount : 0n);
  const tradeEvent = events(receipt, 'Traded'); assert.equal(tradeEvent.length, 1);
  const actual = tradeEvent[0].args; same(actual.token, project.token); same(actual.trader, account.address); assert.equal(actual.buy, buy); assert.equal(actual.amountIn, amount);
  const swaps = parseEventLogs({ abi: artifact('PoolManager').abi, eventName: 'Swap', logs: receipt.logs }).filter(e => e.address.toLowerCase() === deployment.poolManager.toLowerCase());
  assert.equal(swaps.length, 1); assert.equal(swaps[0].args.fee, buy ? project.buyFee : project.sellFee);
  const before = receipt.blockNumber - 1n;
  const [expectedOut, nativeBefore, nativeAfter, tokenBefore, tokenAfter] = await Promise.all([
    quote(poolKey, buy, amount, before), client.getBalance({ address: account.address, blockNumber: before }), client.getBalance({ address: account.address, blockNumber: receipt.blockNumber }),
    read(project.token, erc20Abi, 'balanceOf', [account.address], before), read(project.token, erc20Abi, 'balanceOf', [account.address], receipt.blockNumber),
  ]);
  assert.equal(actual.amountOut, expectedOut, `${label} quote must equal execution`);
  const gas = receipt.gasUsed * receipt.effectiveGasPrice;
  assert.equal(nativeAfter - nativeBefore + gas, buy ? -amount : actual.amountOut, `${label} USDC balance excluding gas`);
  assert.equal(tokenAfter - tokenBefore, buy ? actual.amountOut : -amount, `${label} token balance`);
  return { inputRaw: String(amount), outputRaw: String(actual.amountOut), quoteRaw: String(expectedOut), appliedFee: swaps[0].args.fee, transactionHash: receipt.transactionHash };
}

async function collect(project, direction, expectedNative, expectedTokens) {
  if (expectedNative === 0n && expectedTokens === 0n) return { nativeAmount: '0', tokenAmount: '0', ownBuyback: '0', jetBuyback: '0', distributions: '0', community: '0', platform: '0' };
  const receipt = await send(`${project.symbol}-collect-${direction}`, deployment.launch, abi, 'collectFees', [project.token]);
  const allocation = events(receipt, 'FeesAllocated'); assert.equal(allocation.length, 1); const a = allocation[0].args; same(a.token, project.token);
  assert(abs(a.nativeAmount - expectedNative) <= 10n, `${project.symbol} native LP fee`);
  assert(abs(a.tokenAmount - expectedTokens) <= 10n, `${project.symbol} token LP fee`);
  for (const [key, percent] of [['ownBuyback', 83n], ['jetBuyback', 7n], ['distributions', 5n], ['community', 4n]]) assert.equal(a[key], a.nativeAmount * percent / 100n);
  assert.equal(a.platform, a.nativeAmount - a.ownBuyback - a.jetBuyback - a.distributions - a.community);
  return JSON.parse(stringify(a));
}

try {
  const challenge = await apiCall(`/api/auth/nonce?address=${account.address}&chainId=5042002`);
  const session = await apiCall('/api/auth/login', { message: challenge.message, signature: await account.signMessage({ message: challenge.message }), chainId: 5042002 });
  for (const [name, symbol, buyFee, sellFee] of plans) {
    let project = report.projects.find(p => p.symbol === symbol);
    if (!project) {
      const treasury = await apiCall('/api/arc/treasury', { requestId: `tax-check-20260916-${symbol}` }, session.token);
      project = { name, symbol, buyFee, sellFee, community: treasury.address }; report.projects.push(project); save();
    }
    const receipt = await send(`${symbol}-launch`, deployment.launch, abi, 'launch', [name, symbol, '', buyFee, sellFee, project.community]);
    const launched = events(receipt, 'Launched'); assert.equal(launched.length, 1); same(launched[0].args.creator, account.address);
    project.token = launched[0].args.token; project.launchHash = receipt.transactionHash; project.positionId = String(launched[0].args.positionId);
    const [terms, fees] = await Promise.all([factory('terms', [project.token]), factory('tradeFees', [project.token])]);
    assert.deepEqual(fees, [buyFee, sellFee]); same(terms[1], project.community); project.rewards = terms[2]; save();
    // Temporarily pause only these new test projects so accounting can be measured without an overlapping keeper collection.
    for (let attempt = 0; ; attempt++) {
      const managed = await apiCall('/api/arc/keeper/tokens?limit=100', null, process.env.ARC_KEEPER_ADMIN_TOKEN);
      const item = managed.items.find(item => item.token.toLowerCase() === project.token.toLowerCase());
      if (item) { project.previousPaused ??= item.management.paused; save(); break; }
      assert(attempt < 60, 'Project indexing did not complete'); await new Promise(r => setTimeout(r, 5000));
    }
    await apiCall(`/api/arc/keeper/tokens/${project.token}`, { paused: true }, process.env.ARC_KEEPER_ADMIN_TOKEN);
  }
  assert.equal(new Set(report.projects.map(p => p.community.toLowerCase())).size, plans.length);
  assert.equal(new Set(report.projects.map(p => p.rewards.toLowerCase())).size, plans.length);
  if (!report.baseline) {
    const block = await client.getBlockNumber();
    report.baseline = { block: String(block), platformPending: String((await factory('tokens', [deployment.platformToken], block))[1]), operationsCredit: String(await factory('operationsCredit', [], block)) }; save();
  }
  for (const project of report.projects) {
    const [poolKey] = await read(deployment.positionManager, artifact('PositionManager').abi, 'getPoolAndPositionInfo', [BigInt(project.positionId)]);
    same(poolKey.hooks, deployment.strategy); assert.equal(poolKey.fee, 0x800000);
    project.buy = await trade(project, true, parseEther('1'), poolKey); save();
    project.buyAllocation = await collect(project, 'buy', parseEther('1') * BigInt(project.buyFee) / 1000000n, 0n); save();
    const sellAmount = BigInt(project.buy.outputRaw) / 2n;
    await send(`${project.symbol}-approve`, project.token, erc20Abi, 'approve', [deployment.launch, sellAmount]);
    project.sell = await trade(project, false, sellAmount, poolKey); save();
    project.sellAllocation = await collect(project, 'sell', 0n, sellAmount * BigInt(project.sellFee) / 1000000n); save();
    if (BigInt(project.buyAllocation.community) > 0n) {
      const receipt = await send(`${project.symbol}-community`, deployment.launch, abi, 'claimCommunity', [project.token]);
      const claimed = events(receipt, 'CommunityClaimed')[0].args;
      same(claimed.recipient, project.community); assert.equal(claimed.amount, BigInt(project.buyAllocation.community));
    }
    console.log(stringify({ checked: project.symbol, boughtTokens: formatEther(BigInt(project.buy.outputRaw)), soldTokens: formatEther(sellAmount), receivedUSDC: formatEther(BigInt(project.sell.outputRaw)),
      buyFeeUSDC: formatEther(BigInt(project.buyAllocation.nativeAmount)), sellFeeTokens: formatEther(BigInt(project.sellAllocation.tokenAmount)) }));
  }
  report.auditBlock ??= String(await client.getBlockNumber()); save();
  const block = BigInt(report.auditBlock);
  let ownTotal = 0n, jetTotal = 0n, opsTotal = 0n;
  for (const p of report.projects) {
    const a = p.buyAllocation, sellFee = BigInt(p.sellAllocation.tokenAmount);
    const burn = sellFee * 83n / 100n, reward = sellFee * 5n / 100n, conversion = sellFee - burn - reward;
    const [state, pendingRewardUSDC, available, conversionState, communityCredit, communityBalance, held, allowance, contractTokens] = await Promise.all([
      factory('tokens', [p.token], block), read(p.rewards, rewardAbi, 'pendingNative', [], block), read(p.rewards, rewardAbi, 'available', [], block),
      factory('conversionTokens', [p.token], block), factory('communityCredit', [p.token], block), client.getBalance({ address: p.community, blockNumber: block }),
      read(p.token, erc20Abi, 'balanceOf', [account.address], block), read(p.token, erc20Abi, 'allowance', [account.address, deployment.launch], block), read(p.token, erc20Abi, 'balanceOf', [deployment.launch], block),
    ]);
    assert.equal(state[1], BigInt(a.ownBuyback)); assert.equal(state[2], burn); assert.equal(state[5], 0n);
    assert.equal(pendingRewardUSDC, BigInt(a.distributions)); assert.equal(available, reward); assert.equal(conversionState, conversion);
    assert.equal(communityCredit, 0n); assert.equal(communityBalance, BigInt(a.community));
    assert.equal(held, BigInt(p.buy.outputRaw) - BigInt(p.sell.inputRaw)); assert.equal(allowance, 0n); assert.equal(contractTokens, burn + conversion);
    ownTotal += state[1]; jetTotal += BigInt(a.jetBuyback); opsTotal += BigInt(a.platform);
    p.accounting = { ownBuybackUSDC: formatEther(state[1]), jetBuybackUSDC: formatEther(BigInt(a.jetBuyback)), rewardsUSDC: formatEther(pendingRewardUSDC),
      communityUSDC: formatEther(communityBalance), platformUSDC: formatEther(BigInt(a.platform)), pendingBurnTokens: formatEther(burn), rewardTokens: formatEther(reward), conversionTokens: formatEther(conversion) };
  }
  assert.equal((await factory('tokens', [deployment.platformToken], block))[1], BigInt(report.baseline.platformPending) + jetTotal);
  assert.equal(await factory('operationsCredit', [], block), BigInt(report.baseline.operationsCredit) + opsTotal);
  const accounted = await factory('nativeAccounted', [], block);
  assert.equal(await client.getBalance({ address: deployment.launch, blockNumber: block }), accounted);
  assert.equal(accounted, ownTotal + jetTotal + opsTotal + BigInt(report.baseline.platformPending) + BigInt(report.baseline.operationsCredit));
  delete report.error; report.status = 'trade_and_accounting_passed'; report.completedAt = new Date().toISOString();
  report.gasUSDC = formatEther(Object.values(report.transactions).reduce((v, tx) => v + parseEther(tx.gasUSDC), 0n)); save();
  for (const p of report.projects) await apiCall(`/api/arc/keeper/tokens/${p.token}`, { paused: p.previousPaused }, process.env.ARC_KEEPER_ADMIN_TOKEN);
  await apiCall('/api/arc/keeper/run', {}, process.env.ARC_KEEPER_ADMIN_TOKEN);
  console.log(stringify({ status: report.status, projects: report.projects.length, transactions: Object.keys(report.transactions).length, gasUSDC: report.gasUSDC, reportPath, keeperResumed: true }));
} catch (error) {
  report.status = 'verification_incomplete'; report.error = error.shortMessage || error.message; save();
  console.error('Verification stopped; the new test projects remain paused for resumable accounting. Existing projects are unchanged.');
  console.error(report.error); process.exitCode = 1;
} finally { closeSync(lock); unlinkSync(lockPath); }
