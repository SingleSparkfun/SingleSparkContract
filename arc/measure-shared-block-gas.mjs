// Local Anvil only: measures how far a gas estimate taken against state S falls short once another
// party's transaction is mined first in the same block. Public development keys, synthetic accounts;
// never sends anything to a public network. Run after `forge build --root backend`:
//   node SingleSparkContract/arc/measure-shared-block-gas.mjs [output.json]
// Readiness checklist item 4 (`docs/production-readiness-20260920.md`).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, erc20Abi, http, keccak256, parseEther, parseEventLogs, toHex, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deployArc, artifact } from './deploy.mjs';

const reserve = createServer();
await new Promise(r => reserve.listen(0, '127.0.0.1', r));
const port = reserve.address().port;
await new Promise(r => reserve.close(r));
const url = `http://127.0.0.1:${port}`;
const anvil = spawn('anvil', ['--port', String(port), '--chain-id', '5042002', '--silent']);
// Anvil's public development key deploys.
const deployer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
// Synthetic, reproducible accounts; funded below with anvil_setBalance.
const derived = label => privateKeyToAccount(keccak256(toHex(`singlespark-shared-block-gas/${label}`)));
const operator = derived('operator');
const user = derived('user');
const other = derived('other');
const community = privateKeyToAccount(`0x${'2'.padStart(64, '0')}`).address;
const treasury = privateKeyToAccount(`0x${'3'.padStart(64, '0')}`).address;
const chain = defineChain({ id: 5042002, name: 'Arc Local', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
const client = createPublicClient({ chain, transport: http(url, { retryCount: 0 }), cacheTime: 0 });
const walletOf = account => createWalletClient({ account, chain, transport: http(url) });
const launchAbi = artifact('ArcLaunchV2').abi;
const strategyAbi = artifact('ArcLaunchStrategy').abi;
const executorAbi = artifact('ArcKeeperExecutor').abi;
const rpc = (method, params = []) => client.request({ method, params });
const hex = value => `0x${value.toString(16)}`;
const results = [];

try {
  for (let i = 0; ; i++) {
    try { await client.getChainId(); break; } catch (error) { if (i > 50) throw error; await new Promise(r => setTimeout(r, 100)); }
  }
  const wallet = walletOf(deployer);
  const deploy = async (name, args) => {
    const a = artifact(name);
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, 'success'); return receipt.contractAddress;
  };
  const poolManager = await deploy('PoolManager', [deployer.address]);
  const positionManager = await deploy('PositionManager', [poolManager, zeroAddress, 100000, zeroAddress, zeroAddress]);
  const dir = mkdtempSync(resolve(tmpdir(), 'arc-shared-block-gas-'));
  const deployment = await deployArc(client, wallet, { positionManager, operations: treasury, community, minBuyback: '0.001',
    platformName: 'SingleSpark', platformSymbol: 'SPARK', executor: { owner: deployer.address, operator: operator.address },
    journalPath: resolve(dir, 'deployment.json') });
  const { launch, strategy, platformToken: spark, keeperExecutor: executor } = deployment;
  const now = async () => (await client.getBlock()).timestamp;

  const send = async (account, request, gas = 3_000_000n) => {
    const hash = await walletOf(account).sendTransaction({ ...request, gas });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success'); return receipt;
  };
  const tradeTx = async (token, buy, amount) => ({ to: launch, value: buy ? amount : 0n,
    data: encodeFunctionData({ abi: launchAbi, functionName: 'trade', args: [token, buy, amount, 1n, (await now()) + 600n] }) });
  const keeperTx = (functionName, args) => ({ to: executor,
    data: encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: [launch, encodeFunctionData({ abi: launchAbi, functionName, args })] }) });
  const accrued = token => client.readContract({ address: strategy, abi: strategyAbi, functionName: 'accruedNative', args: [token] });

  // Exactly what the keeper (`chain.rs::estimate_gas`) and a wallet do: no fee fields, so the node runs it at price 0.
  const estimate = (account, tx) => rpc('eth_estimateGas', [{ from: account.address, to: tx.to, data: tx.data, value: hex(tx.value ?? 0n) }]).then(BigInt);

  // Gas limits tried for the target: the bare estimate, the old x1.2, and what the code now signs
  // (`SingleSparkFront/front/web3/arcLaunch.ts::tradeGasLimit`, `SingleSparkBackend/api/src/chain.rs::keeper_gas_limit`).
  const limits = account => [['bare', e => e], ['x1.2', e => e * 12n / 10n],
    ['current', e => e * 12n / 10n + (account === operator ? 80_000n : 40_000n)]];

  /**
   * Estimate `target` against the current state, then mine `first` and `target` in one block with
   * each gas limit from `limits`. `needed` is the estimate against the post-`first` state.
   */
  const scenario = async (name, { first, target, note }) => {
    const snapshot = await rpc('evm_snapshot');
    const estimated = await estimate(target.account, await target.tx());
    const firstTx = first && await first.tx();
    // What the target needs once `first` has run: estimate against the pending state in a throwaway copy.
    const inner = await rpc('evm_snapshot');
    if (first) await send(first.account, firstTx);
    const needed = await estimate(target.account, await target.tx());
    await rpc('evm_revert', [inner]);
    const outcomes = {};
    for (const [label, limitOf] of limits(target.account)) {
      const run = await rpc('evm_snapshot');
      await rpc('evm_setAutomine', [false]);
      const hashes = [];
      if (first) hashes.push(await walletOf(first.account).sendTransaction({ ...firstTx, gas: 3_000_000n }));
      hashes.push(await walletOf(target.account).sendTransaction({ ...(await target.tx()), gas: limitOf(estimated) }));
      await rpc('evm_mine');
      await rpc('evm_setAutomine', [true]);
      const receipts = await Promise.all(hashes.map(hash => client.getTransactionReceipt({ hash })));
      assert.equal(new Set(receipts.map(r => r.blockNumber)).size, 1, 'both transactions must share one block');
      if (first) assert.equal(receipts[0].status, 'success', `${name}: first transaction failed`);
      const mine = receipts.at(-1);
      outcomes[label] = { gasLimit: String(limitOf(estimated)), gasUsed: String(mine.gasUsed), status: mine.status };
      await rpc('evm_revert', [run]);
    }
    await rpc('evm_revert', [snapshot]);
    const row = { name, note, estimateAtS: String(estimated), estimateAfterFirst: String(needed),
      shortfall: String(needed - estimated), shortfallPercent: Number((needed - estimated) * 10000n / estimated) / 100, outcomes };
    results.push(row);
    console.log(`${name}: estimate ${estimated} -> needs ${needed} (${row.shortfallPercent}%); bare ${outcomes.bare.status}, x1.2 ${outcomes['x1.2'].status}, current ${outcomes.current.status}`);
    return row;
  };

  for (const account of [operator, user, other]) await rpc('anvil_setBalance', [account.address, hex(parseEther('1000000'))]);
  // Seed the factory's platform credit so its keeper top-up never blocks anything, and fund the executor
  // above KEEPER_GAS_TRIGGER so the factory does not top it up (that path is measured separately below).
  await send(deployer, { to: launch, value: parseEther('10'), data: encodeFunctionData({ abi: launchAbi, functionName: 'fundKeeperGas' }) });
  await rpc('anvil_setBalance', [executor, hex(parseEther('5'))]);

  const launchToken = async (symbol, buyFee, sellFee) => {
    const receipt = await send(deployer, { to: launch, data: encodeFunctionData({ abi: launchAbi, functionName: 'launch', args: [symbol, symbol, '', buyFee, sellFee, community] }) });
    return parseEventLogs({ abi: launchAbi, eventName: 'Launched', logs: receipt.logs })[0].args.token;
  };
  const token = await launchToken('GAS', 30_000, 30_000);
  const second = await launchToken('TWO', 30_000, 30_000);
  const buyOnlyOpening = await launchToken('OPEN', 0, 50_000);
  // Leave every opening window, then give both users tokens to sell and approve the factory.
  await rpc('evm_increaseTime', [10]); await rpc('evm_mine');
  for (const account of [user, other]) {
    for (const t of [token, second, spark]) {
      await send(account, await tradeTx(t, true, parseEther('50')));
      await send(account, { to: t, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [launch, 2n ** 255n] }) });
    }
  }
  const collect = t => ({ account: operator, tx: async () => keeperTx('collectFees', [t]) });
  const userBuy = (t, account = user) => ({ account, tx: () => tradeTx(t, true, parseEther('5')) });
  const userSell = (t, account = user) => ({ account, tx: () => tradeTx(t, false, parseEther('1000')) });
  const collectAll = async () => { for (const t of [token, second, spark, buyOnlyOpening]) if (await accrued(t) > 0n) await send(operator, keeperTx('collectFees', [t])); };

  // --- The user trade is the victim --------------------------------------------------------------
  // Only GAS has uncollected tax, so its collectFees drains the hook's shared ERC-6909 claim balance too.
  await collectAll();
  await send(other, await tradeTx(token, true, parseEther('3')));
  assert.equal(await accrued(second), 0n); assert.equal(await accrued(spark), 0n);
  const baseline = await scenario('baseline: user buy, nothing mined first', { target: userBuy(token), note: 'Estimate and inclusion see the same state.' });
  await scenario('user buy after keeper collectFees(same token), only token with uncollected tax', { first: collect(token), target: userBuy(token),
    note: 'accruedNative[token] and the hook\'s aggregate PoolManager claim balance both go nonzero -> 0 -> nonzero: two 0->nonzero SSTOREs (2 x 17,100).' });
  await scenario('user sell after keeper collectFees(same token), only token with uncollected tax', { first: collect(token), target: userSell(token),
    note: 'Same two slots on the sell path.' });
  // Another token still holds tax, so the aggregate claim balance stays nonzero: one slot flips.
  await send(other, await tradeTx(second, true, parseEther('3')));
  await scenario('user buy after keeper collectFees(same token), other tokens still hold tax', { first: collect(token), target: userBuy(token),
    note: 'Only accruedNative[token] flips; the shared claim balance stays nonzero.' });
  // Cross-token: the user's token has nothing uncollected; the keeper collects a different token.
  await collectAll();
  await send(other, await tradeTx(second, true, parseEther('3')));
  await scenario('user buy of token A after keeper collectFees(token B), B the only token with tax', { first: collect(second), target: userBuy(token),
    note: 'A different token\'s collection zeroes the shared claim balance; the victim need not share a token with the keeper.' });

  // --- The keeper is the victim ------------------------------------------------------------------
  await collectAll();
  await send(other, await tradeTx(token, true, parseEther('3')));
  await scenario('keeper collectFees after a user buy of the same token', { first: userBuy(token, other), target: collect(token),
    note: 'A larger amount through the same code path.' });
  // OPEN has a 0% buy fee: opening-window buys accrue only opening tax, so the base split is zero and
  // collectFees skips the rewards call and several zero writes. A user sell adds base tax first.
  await collectAll();
  {
    const opening = await launchToken('OPEN2', 0, 50_000);
    // Pin the buy to the first opening second (24.75 % floor) so the run does not depend on the wall clock.
    await rpc('evm_setNextBlockTimestamp', [Number((await now()) + 1n)]);
    await send(other, await tradeTx(opening, true, parseEther('1')));
    await rpc('evm_increaseTime', [10]); await rpc('evm_mine');
    await send(other, { to: opening, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [launch, 2n ** 255n] }) });
    assert.ok(await accrued(opening) > 0n);
    await scenario('keeper collectFees of opening-only tax after a user sell adds base tax', { first: userSell(opening, other), target: collect(opening),
      note: 'Estimated with base = 0 (no rewards funding, no own/community credit); a user sell first makes all of them nonzero. Edge case: needs a 0% buy fee.' });
  }
  await collectAll();
  await send(deployer, { to: launch, value: parseEther('20'), data: encodeFunctionData({ abi: launchAbi, functionName: 'fundFees', args: [token] }) });
  await rpc('evm_increaseTime', [200]); await rpc('evm_mine');
  const [, limit] = await client.readContract({ address: strategy, abi: strategyAbi, functionName: 'keeperSwapState', args: [token, true] });
  const [, pending] = await client.readContract({ address: launch, abi: launchAbi, functionName: 'tokens', args: [token] });
  const spend = limit < pending ? limit : pending;
  await scenario('keeper executeBurn after a user buy of the same token', { first: userBuy(token, other),
    target: { account: operator, tx: async () => keeperTx('executeBurn', [token, spend, 1n, (await now()) + 60n]) },
    note: 'The user buy leaves accruedNative nonzero, so the keeper swap gets cheaper, not dearer.' });
  await scenario('keeper executeBurn after a user sell of the same token', { first: userSell(token, other),
    target: { account: operator, tx: async () => keeperTx('executeBurn', [token, spend, 1n, (await now()) + 60n]) },
    note: 'Price moves; no tick is crossed inside the single locked position.' });

  // --- Not a shared-block effect: the estimate runs at gas price 0 --------------------------------
  // ArcKeeperExecutor tops its operator up to exactly OPERATOR_GAS_TARGET (2 USDC) after every call. The next
  // estimate sees 2 USDC (not below target: no forward); the mined call sees 2 USDC minus the up-front gas debit.
  await send(other, await tradeTx(token, true, parseEther('3')));
  await rpc('anvil_setBalance', [operator.address, hex(parseEther('2'))]);
  await rpc('anvil_setBalance', [executor, hex(parseEther('5'))]);
  {
    const tx = keeperTx('collectFees', [token]);
    const snapshot = await rpc('evm_snapshot');
    const bare = await estimate(operator, tx);
    const block = await client.getBlock();
    const maxFeePerGas = block.baseFeePerGas * 2n + 1_000_000_000n;
    const priced = BigInt(await rpc('eth_estimateGas', [{ from: operator.address, to: tx.to, data: tx.data, maxFeePerGas: hex(maxFeePerGas), maxPriorityFeePerGas: hex(1_000_000_000n) }]));
    const outcomes = {};
    for (const [label, limitOf] of limits(operator)) {
      const run = await rpc('evm_snapshot');
      const hash = await walletOf(operator).sendTransaction({ ...tx, gas: limitOf(bare), maxFeePerGas, maxPriorityFeePerGas: 1_000_000_000n });
      const receipt = await client.waitForTransactionReceipt({ hash });
      outcomes[label] = { gasLimit: String(limitOf(bare)), gasUsed: String(receipt.gasUsed), status: receipt.status };
      await rpc('evm_revert', [run]);
    }
    await rpc('evm_revert', [snapshot]);
    const row = { name: 'keeper collectFees with the operator at exactly 2 USDC (no other transaction)',
      note: 'Estimate without fee fields runs at price 0 and skips ArcKeeperExecutor._forward; the mined call debits gas up front, drops below 2 USDC and forwards.',
      estimateAtS: String(bare), estimateAfterFirst: String(priced), shortfall: String(priced - bare),
      shortfallPercent: Number((priced - bare) * 10000n / bare) / 100, outcomes };
    results.push(row);
    console.log(`${row.name}: no-fee estimate ${bare}, priced estimate ${priced} (${row.shortfallPercent}%); bare ${outcomes.bare.status}, x1.2 ${outcomes['x1.2'].status}, current ${outcomes.current.status}`);
  }

  const output = { environment: 'local anvil only (chain id 5042002, default block gas); synthetic accounts and test funds',
    generatedAt: new Date().toISOString(), baselineBuyGasUsed: baseline.outcomes.bare.gasUsed, scenarios: results };
  if (process.argv[2]) writeFileSync(process.argv[2], `${JSON.stringify(output, null, 2)}\n`);
} finally {
  anvil.kill();
}
