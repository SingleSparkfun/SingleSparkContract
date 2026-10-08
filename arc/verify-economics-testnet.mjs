// Isolated ARC testnet V2 proof. Uses the explicitly funded 80-USDC wallet; never mainnet.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, chmodSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, parseEther, formatEther, erc20Abi,
  encodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, parseEventLogs } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { deployArc, artifact } from './deploy.mjs';
import { persist, stringify } from './runtime.mjs';
import { positionManagerAbi, quoterAbi } from '../../SingleSparkFront/front/web3/arcAbi.ts';

const gasCheck = process.argv.includes('--gas');
assert(!(gasCheck && process.argv.includes('--rewards')), 'Gas proof uses its own bounded worker run');
const dir = gasCheck ? 'SingleSparkContract/arc/data/keeper-gas-testnet' : 'SingleSparkContract/arc/data/economics-v2-testnet';
const reportPath = gasCheck ? 'SingleSparkContract/arc/deployments/arc-keeper-gas-testnet.json' : 'SingleSparkContract/arc/deployments/arc-economics-v2-testnet.json';
mkdirSync(dir, { recursive: true, mode: 0o700 });
process.loadEnvFile('SingleSparkContract/arc/.env.testnet.local');
assert.equal(Number(process.env.ARC_CHAIN_ID), 5042002);
const key = JSON.parse(readFileSync('SingleSparkContract/arc/data/jet-test-wallets-20260916/wallets.json')).wallets[1].privateKey;
const account = privateKeyToAccount(key);
assert.equal(account.address.toLowerCase(), '0x0ca76906cef08981717f81dfa1519b5a3cecca57');
const walletsPath = `${dir}/wallets.json`;
if (!existsSync(walletsPath)) persist(walletsPath, Object.fromEntries(['keeper', 'community', 'platform'].map(role => {
  const privateKey = generatePrivateKey(); return [role, { privateKey, address: privateKeyToAccount(privateKey).address }];
})));
const wallets = JSON.parse(readFileSync(walletsPath));
for (const entry of Object.values(wallets)) assert.equal(privateKeyToAccount(entry.privateKey).address, entry.address);
const keeper = privateKeyToAccount(wallets.keeper.privateKey);
const chain = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL] } } });
const transport = http(process.env.ARC_RPC_URL, { timeout: 15000, retryCount: 1 });
const client = createPublicClient({ chain, transport, cacheTime: 0, pollingInterval: 1500 });
const wallet = createWalletClient({ account, chain, transport });
assert.equal(await client.getChainId(), chain.id);
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath)) : {
  chainId: chain.id, purpose: 'ARC testnet V2 economics proof; test assets only',
  funder: account.address, minBuybackUSDC: '0.001', productionMinimumUSDC: '5',
  community: wallets.community.address, platformTreasury: wallets.platform.address, keeper: keeper.address,
  startedAt: new Date().toISOString(), transactions: {},
};
assert.equal(report.funder, account.address);
assert.equal(report.keeper, keeper.address);
assert.equal(report.community, wallets.community.address);
assert.equal(report.platformTreasury, wallets.platform.address);
const log = value => console.log(stringify(value));
const save = () => persist(reportPath, report);
if (!process.argv.includes('--broadcast')) {
  log({ mode: 'preflight', balanceUSDC: formatEther(await client.getBalance({ address: account.address })),
    ...Object.fromEntries(Object.entries(wallets).map(([role, w]) => [role, w.address])),
    testPrincipalUSDC: gasCheck ? '1' : '13', keeperFundingUSDC: gasCheck ? '0.65' : '3',
    ...(gasCheck ? { gasBufferUSDC: '2.5' } : {}), minimumFunderReserveUSDC: '50',
    projectBuyFeePercent: 1, projectSellFeePercent: 5, minBuybackUSDC: '0.001' });
  process.exit(0);
}
const lockPath = `${dir}/verification.lock`;
const lock = openSync(lockPath, 'wx', 0o600);
writeFileSync(lock, String(process.pid));
const journalPath = `${dir}/transactions.json`;
const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath)) : {};
const abi = artifact('ArcLaunchV2').abi;
const rewardAbi = artifact('ArcRewards').abi;
try {
  if (process.argv.includes('--rewards')) {
    assert(report.deployment && report.project, 'Deploy and verify real trades first');
    const scope = `rewards:5042002:${report.project.rewards.toLowerCase()}`;
    // Strip the legacy env loaded above; dotenv must load the V2 runtime's own keys and addresses.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ARC_')));
    let previous = '', failures = 0;
    for (let attempt = 0; attempt < 320; attempt++) {
      let output = '', errors = '';
      const child = spawn('SingleSparkBackend/api/target/debug/jet-arc-backend', ['SingleSparkContract/arc/.env.economics-v2.local', '--once'], { env, timeout: 300000 });
      child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => errors += bytes);
      const { code, signal } = await new Promise((ok, fail) => { child.once('error', fail); child.once('exit', (code, signal) => ok({ code, signal })); });
      if (errors) appendFileSync(`${dir}/worker.log`, errors, { mode: 0o600 });
      if (code !== 0) {
        log({ status: 'worker_retry', attempt, reason: errors.slice(-700) || `Worker exited: ${signal ?? code}` });
        assert(++failures < 6, 'Repeated worker failure; signed journal retained');
        await new Promise(r => setTimeout(r, 5000)); continue;
      }
      failures = 0;
      const snapshot = JSON.parse(output);
      assert.equal(snapshot.launch.toLowerCase(), report.deployment.launch.toLowerCase());
      persist(`${dir}/last-snapshot.json`, snapshot);
      const db = new DatabaseSync(`${dir}/runtime/arc.sqlite`, { readOnly: true });
      const state = JSON.parse(db.prepare('SELECT value FROM kv WHERE key = ?').get(`${scope}:worker`)?.value ?? '{}');
      const rows = db.prepare('SELECT data FROM reward_payouts WHERE scope = ? ORDER BY id').all(scope).map(row => JSON.parse(row.data));
      db.close();
      const progress = `${state.status}:${state.nextPayoutIndex ?? rows.length}:${rows.length}`;
      if (progress !== previous || attempt % 10 === 0) log({ attempt, status: state.status, paid: state.nextPayoutIndex ?? rows.length, confirmedRecords: rows.length });
      previous = progress;
      if (rows.length === 100) {
        assert.equal(new Set(rows.map(row => row.recipient.toLowerCase())).size, 100);
        assert(rows.every(row => row.amount === String(parseEther('10'))));
        assert.equal(await client.readContract({ address: report.project.rewards, abi: rewardAbi, functionName: 'nextPayoutIndex' }), 100n);
        assert.equal(await client.readContract({ address: report.project.rewards, abi: rewardAbi, functionName: 'reserved' }), 0n);
        report.status = 'passed'; report.completedAt = new Date().toISOString();
        report.distribution = { token: report.project.token, recipients: 100, amountEach: '10', total: '1000', payments: rows };
        report.finalSnapshot = snapshot;
        report.funderBalanceUSDC = formatEther(await client.getBalance({ address: account.address }));
        report.keeperBalanceUSDC = formatEther(await client.getBalance({ address: keeper.address }));
        save(); log({ status: 'passed', recipients: 100, token: report.project.token, funderBalanceUSDC: report.funderBalanceUSDC, keeperBalanceUSDC: report.keeperBalanceUSDC });
        break;
      }
      assert(attempt < 319, 'Batch still pending; resume with the same runtime directory');
      await new Promise(r => setTimeout(r, state.status === 'waiting_randomness' ? 5000 : 500));
    }
    process.exitCode = 0;
  } else {
  // Freeze/recover signed bytes before any broadcast; all subsequent invocations reuse receipts.
  async function send(label, signer, target, build) {
    let step = journal[label];
    if (!step) {
      const tx = await build();
      const latest = await client.getTransactionCount({ address: signer.address });
      assert.equal(latest, await client.getTransactionCount({ address: signer.address, blockTag: 'pending' }), 'Pending nonce must resolve');
      await client.call({ ...tx, to: target, account: signer });
      const estimated = await client.estimateGas({ ...tx, to: target, account: signer });
      const gas = estimated + estimated / 5n;
      const fees = await client.estimateFeesPerGas();
      if (fees.maxFeePerGas < 20_000_000_000n) fees.maxFeePerGas = 20_000_000_000n;
      assert(gas <= 6_000_000n && gas * fees.maxFeePerGas <= parseEther('0.15'), 'Per-transaction gas budget');
      const reserve = signer.address === account.address ? parseEther('50') : parseEther('1');
      assert(await client.getBalance({ address: signer.address }) >= reserve + (tx.value ?? 0n) + gas * fees.maxFeePerGas, 'Preserve wallet reserve');
      const sender = createWalletClient({ account: signer, chain, transport });
      const raw = await sender.signTransaction({ ...tx, to: target, ...fees, gas, nonce: latest, type: 'eip1559', chainId: chain.id });
      step = { raw, hash: keccak256(raw), transaction: tx }; journal[label] = step; persist(journalPath, journal);
    }
    const decoded = parseTransaction(step.raw);
    assert.equal(decoded.chainId, chain.id);
    assert.equal(decoded.to.toLowerCase(), target.toLowerCase());
    assert.equal(decoded.value ?? 0n, BigInt(step.transaction.value ?? 0));
    assert.equal(decoded.data ?? '0x', step.transaction.data ?? '0x');
    assert.equal(keccak256(step.raw), step.hash);
    assert.equal((await recoverTransactionAddress({ serializedTransaction: step.raw })).toLowerCase(), signer.address.toLowerCase());
    let receipt;
    try { receipt = await client.getTransactionReceipt({ hash: step.hash }); }
    catch (error) { if (error.name !== 'TransactionReceiptNotFoundError') throw error; }
    if (!receipt) {
      try { await client.sendRawTransaction({ serializedTransaction: step.raw }); }
      catch (error) { if (!/already known|nonce too low/i.test(error.message)) throw error; }
      receipt = await client.waitForTransactionReceipt({ hash: step.hash, timeout: 90000 });
    }
    assert.equal(receipt.status, 'success', label);
    report.transactions[label] = { hash: step.hash, block: String(receipt.blockNumber), gasUSDC: formatEther(receipt.gasUsed * receipt.effectiveGasPrice) };
    save(); log({ step: label, ...report.transactions[label] }); return receipt;
  }
  if (!report.deployment) {
    assert(await client.getBalance({ address: account.address }) >= parseEther(gasCheck ? '56' : '60'), 'Deployment reserve');
    report.deployment = await deployArc(client, wallet, { positionManager: process.env.ARC_POSITION_MANAGER,
      keeper: keeper.address, operations: wallets.platform.address, community: wallets.community.address,
      platformName: 'Jet', platformSymbol: 'JET', platformBuyFee: 30000, platformSellFee: 30000,
      minBuyback: '0.001', journalPath: `${dir}/deployment-journal.json` });
    persist(`${dir}/deployment.json`, report.deployment); save();
  }
  const d = report.deployment;
  assert.equal(keccak256(await client.getCode({ address: d.launch })), d.launchCodeHash);
  log({ deployment: d });
  const env = { ARC_CHAIN_ID: '5042002', ARC_RPC_URL: process.env.ARC_RPC_URL, ARC_PUBLIC_RPC_URL: process.env.ARC_PUBLIC_RPC_URL,
    ARC_EXPLORER_URL: process.env.ARC_EXPLORER_URL, ARC_WEB_ORIGIN: gasCheck ? 'http://127.0.0.1:5182' : 'http://127.0.0.1:5181', ARC_HOST: '127.0.0.1', ARC_PORT: gasCheck ? '8095' : '8094',
    ARC_DATA_DIR: `${dir}/runtime`, ARC_LAUNCH_ADDRESS: d.launch, ARC_QUOTER_ADDRESS: d.quoter, ARC_FROM_BLOCK: d.fromBlock,
    ARC_CONFIG_SIGNING_KEY: process.env.ARC_CONFIG_SIGNING_KEY, ARC_CONFIG_KEY_ID: process.env.ARC_CONFIG_KEY_ID,
    ARC_KEEPER_PRIVATE_KEY: wallets.keeper.privateKey, ARC_GAS_RESERVE_USDC: '1', ARC_SLIPPAGE_BPS: '300',
    ARC_MAX_GAS_PER_TX: '1500000', ARC_KEEPER_BATCH_SIZE: '20', ARC_REWARDS_ADDRESS: '', ARC_REWARDS_FROM_BLOCK: '' };
  const envPath = gasCheck ? 'SingleSparkContract/arc/.env.keeper-gas.local' : 'SingleSparkContract/arc/.env.economics-v2.local';
  const encryptionPath = `${dir}/treasury-encryption.key`;
  if (!existsSync(encryptionPath)) writeFileSync(encryptionPath, generatePrivateKey().slice(2), { mode: 0o600 });
  env.ARC_TREASURY_ENCRYPTION_KEY = readFileSync(encryptionPath, 'utf8').trim();
  writeFileSync(envPath, Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v ?? '')}`).join('\n') + '\n', { mode: 0o600 });
  chmodSync(envPath, 0o600);
  await send('keeper-funding', account, keeper.address, async () => ({ value: parseEther(gasCheck ? '0.65' : '3') }));
  const read = (functionName, args = [], blockNumber) => client.readContract({ address: d.launch, abi, functionName, args, blockNumber });
  const contractCall = (label, signer, address, contractAbi, functionName, buildArgs, value = 0n) => send(label, signer, address,
    async () => ({ data: encodeFunctionData({ abi: contractAbi, functionName, args: await buildArgs() }), value }));
  if (gasCheck) {
    assert.equal(await read('KEEPER_GAS_SUPPORT'), true);
    const funding = await contractCall('gas-reserve', account, d.launch, abi, 'fundKeeperGas', async () => [], parseEther('2.5'));
    const bootstrap = parseEventLogs({ abi, eventName: 'KeeperGasPaid', logs: funding.logs });
    assert.equal(bootstrap.length, 1);
    assert.equal(bootstrap[0].args.amount, parseEther('0.25'));
    if (!report.keeperBeforeWorker) {
      report.keeperBeforeWorker = String(await client.getBalance({ address: keeper.address }));
      assert(BigInt(report.keeperBeforeWorker) < parseEther('1'), 'Start below the normal protected reserve'); save();
    }
    const state = await read('tokens', [d.platformToken]);
    const [poolKey] = await client.readContract({ address: d.positionManager, abi: positionManagerAbi, functionName: 'getPoolAndPositionInfo', args: [state[0]] });
    await contractCall('gas-proof-buy', account, d.launch, abi, 'trade', async () => {
      const quoted = (await client.simulateContract({ address: d.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle',
        args: [{ poolKey, zeroForOne: true, exactAmount: parseEther('1'), hookData: '0x' }] })).result[0];
      return [d.platformToken, true, parseEther('1'), quoted * 97n / 100n, (await client.getBlock()).timestamp + 115n];
    }, parseEther('1'));
    for (let attempt = 0; attempt < 6; attempt++) {
      const child = spawn('SingleSparkBackend/api/target/debug/jet-arc-backend', [envPath, '--once'], {
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ARC_'))), timeout: 180000,
      });
      let output = '', errors = '';
      child.stdout.on('data', b => output += b); child.stderr.on('data', b => errors += b);
      const code = await new Promise((ok, fail) => { child.once('error', fail); child.once('exit', ok); });
      appendFileSync(`${dir}/worker.log`, errors, { mode: 0o600 });
      assert.equal(code, 0, errors.slice(-500));
      const snapshot = JSON.parse(output);
      assert.equal(snapshot.keeperGasSupport, true);
      assert.equal(snapshot.launch.toLowerCase(), d.launch.toLowerCase());
      report.snapshot = snapshot; save();
      if ((await read('tokens', [d.platformToken]))[6] > 0n) break;
      assert(attempt < 5, 'Keeper did not complete the burn; keep journal for diagnosis');
    }
    const paid = await read('totalKeeperGasPaid');
    assert(paid > parseEther('0.25'), 'Worker must trigger further top-ups without external funding');
    assert((await client.getBalance({ address: keeper.address })) > parseEther('1'));
    const at = await client.getBlockNumber();
    const topups = await client.getContractEvents({ address: d.launch, abi, eventName: 'KeeperGasPaid', fromBlock: BigInt(d.fromBlock), toBlock: at });
    assert(topups.every(log => log.args.keeper.toLowerCase() === keeper.address.toLowerCase() && log.args.amount <= parseEther('0.25')));
    assert.equal(topups.reduce((sum, log) => sum + log.args.amount, 0n), paid);
    assert.equal(await client.getBalance({ address: d.launch, blockNumber: at }), await read('nativeAccounted', [], at));
    report.status = 'passed'; report.totalKeeperGasPaidUSDC = formatEther(paid);
    report.keeperBalanceUSDC = formatEther(await client.getBalance({ address: keeper.address }));
    report.platformCreditUSDC = formatEther(await read('operationsCredit'));
    report.funderBalanceUSDC = formatEther(await client.getBalance({ address: account.address }));
    report.topups = topups.map(log => ({ ...log.args, transactionHash: log.transactionHash, blockNumber: log.blockNumber }));
    report.completedAt = new Date().toISOString(); save();
    log({ status: report.status, factory: d.launch, totalKeeperGasPaidUSDC: report.totalKeeperGasPaidUSDC,
      keeperBalanceUSDC: report.keeperBalanceUSDC, funderBalanceUSDC: report.funderBalanceUSDC, reportPath });
  } else {
  // Fresh V2 artifacts retain a platform buffer; old deployments have no gas-support selector.
  let supportsGas = false;
  try { supportsGas = await read('KEEPER_GAS_SUPPORT'); }
  catch (error) { if (!/revert/i.test(error.message)) throw error; }
  if (supportsGas) await contractCall('gas-reserve', account, d.launch, abi, 'fundKeeperGas', async () => [], parseEther('1'));
  const receipt = await contractCall('project-launch', account, d.launch, abi, 'launch', async () => ['Spark Fee Test', 'SPKTEST', '', 10000, 50000, wallets.community.address]);
  const token = parseEventLogs({ abi, eventName: 'Launched', logs: receipt.logs })[0].args.token;
  const terms = await read('terms', [token]);
  report.project = { token, symbol: 'SPKTEST', buyFee: 10000, sellFee: 50000, rewards: terms[2] }; save();
  const quote = async (token, buy, amount) => {
    const state = await read('tokens', [token]);
    const [poolKey] = await client.readContract({ address: d.positionManager, abi: positionManagerAbi, functionName: 'getPoolAndPositionInfo', args: [state[0]] });
    return (await client.simulateContract({ address: d.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey, zeroForOne: buy, exactAmount: amount, hookData: '0x' }] })).result[0];
  };
  const deadline = async () => (await client.getBlock()).timestamp + 115n;
  const trade = (label, token, buy, amount) => contractCall(label, account, d.launch, abi, 'trade',
    async () => [token, buy, amount, await quote(token, buy, amount) * 97n / 100n, await deadline()], buy ? amount : 0n);
  const buy = await trade('project-buy', token, true, parseEther('10'));
  const bought = parseEventLogs({ abi, eventName: 'Traded', logs: buy.logs })[0].args.amountOut;
  const collected = await contractCall('project-collect-buy', keeper, d.launch, abi, 'collectFees', async () => [token]);
  const allocation = parseEventLogs({ abi, eventName: 'FeesAllocated', logs: collected.logs })[0].args;
  assert.equal(allocation.ownBuyback, allocation.nativeAmount * 83n / 100n);
  assert.equal(allocation.jetBuyback, allocation.nativeAmount * 7n / 100n);
  assert.equal(allocation.distributions, allocation.nativeAmount * 5n / 100n);
  assert.equal(allocation.community, allocation.nativeAmount * 4n / 100n);
  assert.equal(allocation.platform, allocation.nativeAmount - allocation.ownBuyback - allocation.jetBuyback - allocation.distributions - allocation.community);
  assert(allocation.jetBuyback >= parseEther('0.001'));
  // No JET user trade has occurred yet: this burn can only spend the new project's 7% allocation.
  const jetBurn = await contractCall('project-seven-percent-burns-jet', keeper, d.launch, abi, 'executeBurn', async () => {
    const pending = (await read('tokens', [d.platformToken]))[1];
    assert.equal(pending, allocation.jetBuyback);
    return [d.platformToken, pending, await quote(d.platformToken, true, pending) * 97n / 100n, await deadline()];
  });
  const jetEvent = parseEventLogs({ abi, eventName: 'Burned', logs: jetBurn.logs })[0].args;
  const supply = blockNumber => client.readContract({ address: d.platformToken, abi: erc20Abi, functionName: 'totalSupply', blockNumber });
  assert.equal(jetEvent.nativeAmount, allocation.jetBuyback);
  assert(jetEvent.totalBurned > 0n);
  assert.equal(await supply(jetBurn.blockNumber - 1n) - await supply(jetBurn.blockNumber), jetEvent.totalBurned);
  report.platformBuybackProof = { sourceToken: token, feeAllocation: allocation, burn: jetEvent,
    collectionHash: collected.transactionHash, jetBurnHash: jetBurn.transactionHash, verifiedSupplyReduction: true }; save();
  await contractCall('project-own-buyback-burn', keeper, d.launch, abi, 'executeBurn', async () => {
    const pending = (await read('tokens', [token]))[1];
    return [token, pending, await quote(token, true, pending) * 97n / 100n, await deadline()];
  });
  const rewards = terms[2];
  await contractCall('project-rewards-buy-own', keeper, rewards, rewardAbi, 'buyOwnToken', async () => {
    const pending = await client.readContract({ address: rewards, abi: rewardAbi, functionName: 'pendingNative' });
    return [pending, await quote(token, true, pending) * 97n / 100n, await deadline()];
  });
  await contractCall('project-sell-approval', account, token, erc20Abi, 'approve', async () => [d.launch, bought / 2n]);
  await trade('project-sell', token, false, bought / 2n);
  await contractCall('project-collect-sell', keeper, d.launch, abi, 'collectFees', async () => [token]);
  await contractCall('project-convert-token-fees', keeper, d.launch, abi, 'convertFees', async () => {
    const pending = await read('conversionTokens', [token]);
    return [token, pending, await quote(token, false, pending) * 97n / 100n, await deadline()];
  });
  await contractCall('community-treasury-payment', keeper, d.launch, abi, 'claimCommunity', async () => [token]);
  await contractCall('platform-treasury-payment', keeper, d.launch, abi, 'claimOperations', async () => []);
  await trade('jet-user-buy', d.platformToken, true, parseEther('3'));
  await contractCall('jet-user-fees', keeper, d.launch, abi, 'collectFees', async () => [d.platformToken]);
  const available = await client.readContract({ address: rewards, abi: rewardAbi, functionName: 'available' });
  assert(available >= parseEther('1000'), 'Project must have a fully funded 100-person batch');
  assert.equal(await client.readContract({ address: d.platformToken, abi: erc20Abi, functionName: 'balanceOf', args: [rewards] }), 0n);
  assert(await client.getBalance({ address: wallets.community.address }) > 0n);
  assert(await client.getBalance({ address: wallets.platform.address }) > 0n);
  report.status = 'deployed_trades_and_platform_buyback_verified';
  report.projectRewardAvailable = String(available);
  report.funderBalanceUSDC = formatEther(await client.getBalance({ address: account.address }));
  report.communityBalanceUSDC = formatEther(await client.getBalance({ address: wallets.community.address }));
  report.platformTreasuryBalanceUSDC = formatEther(await client.getBalance({ address: wallets.platform.address }));
  save(); log({ status: report.status, project: report.project, platformBuybackProof: report.platformBuybackProof,
    funderBalanceUSDC: report.funderBalanceUSDC, reportPath, runtimeEnvironment: envPath });
  }
  }
} finally { closeSync(lock); unlinkSync(lockPath); }
