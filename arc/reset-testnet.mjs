// Explicit reset of the active ARC test deployment. Old chain state and local data are archived, never erased.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, chmodSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, parseEther, formatEther,
  keccak256, encodeDeployData, encodeFunctionData, parseEventLogs, parseTransaction, recoverTransactionAddress,
  concatHex, getAddress, getCreate2Address, zeroHash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deployArc, artifact } from './deploy.mjs';
import { persist, stringify } from './runtime.mjs';

const dir = process.env.ARC_DEPLOYMENT_DIR || 'SingleSparkContract/arc/data/spark-testnet-20260917';
const envFile = `${dir}/runtime.env`;
const reportPath = process.env.ARC_DEPLOYMENT_REPORT || 'SingleSparkContract/arc/deployments/arc-current-testnet.json';
const base = process.env.ARC_DEPLOYMENT_API_BASE || 'http://127.0.0.1:8090';
assert.equal(new URL(base).hostname, '127.0.0.1');
const mediaBase = `${base}/api/arc/media`;
const keeperSeed = process.env.ARC_KEEPER_SEED_USDC || '1.5';
mkdirSync(`${dir}/runtime/media`, { recursive: true, mode: 0o700 });
process.loadEnvFile(existsSync(envFile) ? envFile : 'SingleSparkContract/arc/.env.testnet.local');
const reserveUSDC = process.env.ARC_DEPLOYER_RESERVE_USDC || '50';
assert(/^\d+(\.\d{1,18})?$/.test(reserveUSDC), 'Invalid deployment reserve');
const reserve = parseEther(reserveUSDC);
const platformName = process.env.ARC_PLATFORM_NAME;
const platformSymbol = process.env.ARC_PLATFORM_SYMBOL;
assert(platformName && platformSymbol && /^[A-Za-z0-9]{1,12}$/.test(platformSymbol), 'Set the platform name and symbol before deployment');
const source = { keeper: { address: privateKeyToAccount(process.env.ARC_KEEPER_PRIVATE_KEY).address, privateKey: process.env.ARC_KEEPER_PRIVATE_KEY },
  platform: { address: process.env.ARC_OPERATIONS_ADDRESS } };
// Explicit opt-in: without `--satisfaction` this script deploys exactly as before, so old flows stay reproducible.
// With it the satisfaction vault becomes the factory's operations address and the keeper executor its keeper,
// and the current keeper wallet keeps its key but acts as the executor's replaceable operator.
const satisfactionMode = process.argv.includes('--satisfaction');
// The defaults are the ones a real deployment should get: a 7-day round with voting open for 6 d 23 h.
// A fast acceptance run overrides them (that is what the existing 30-minute testnet vault was deployed with):
// ARC_SATISFACTION_ROUND_SECONDS=1800 ARC_SATISFACTION_VOTING_SECONDS=600. See SingleSparkContract/arc/README.md for what the
// long window implies: the pot is fixed about an hour in, and a quorum-sized stake must be in by mid-window.
const satisfaction = satisfactionMode ? { team: getAddress(process.env.ARC_SATISFACTION_TEAM || source.platform.address),
  roundDuration: Number(process.env.ARC_SATISFACTION_ROUND_SECONDS || 604800),
  votingDuration: Number(process.env.ARC_SATISFACTION_VOTING_SECONDS || 601200),
  quorum: process.env.ARC_SATISFACTION_QUORUM || '1000' } : undefined;
const funderKey = process.env.ARC_DEPLOYER_PRIVATE_KEY;
const account = privateKeyToAccount(funderKey);
assert.equal(account.address.toLowerCase(), '0x0ca76906cef08981717f81dfa1519b5a3cecca57');
const chain = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL] } } });
const transport = http(process.env.ARC_RPC_URL, { timeout: 15000, retryCount: 1 });
const client = createPublicClient({ chain, transport, cacheTime: 0 });
const wallet = createWalletClient({ account, chain, transport });
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath)) : { chainId: chain.id, startedAt: new Date().toISOString(), transactions: {}, projects: [] };
if (report.deployment) {
  assert.equal(report.platformMetadata?.name, platformName, 'Existing deployment name differs; use an isolated deployment for a new token');
  assert.equal(report.platformMetadata?.symbol, platformSymbol, 'Existing deployment symbol differs; use an isolated deployment for a new token');
}
assert.equal(await client.getChainId(), 5042002);
if (!process.argv.includes('--broadcast')) {
  console.log(stringify({ mode: 'preflight', chainId: chain.id, funder: account.address,
    balanceUSDC: formatEther(await client.getBalance({ address: account.address })), reserveUSDC,
    platform: `${platformName} / ${platformSymbol}`, platformFees: '3% / 3%', minBuybackUSDC: '5', mediaBase, gasReserveFundingUSDC: keeperSeed,
    ...(satisfactionMode ? { satisfaction, keeperExecutor: { owner: account.address, operator: source.keeper.address },
      deploymentDir: dir, reportPath, envFile } : {}),
    existingDeployment: report.deployment?.launch ?? null }));
  process.exit(0);
}
const lockPath = `${dir}/reset.lock`;
const lock = openSync(lockPath, 'wx', 0o600);
const save = () => persist(reportPath, report);
const journalPath = `${dir}/transactions.json`;
const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath)) : {};
const abi = artifact('ArcLaunchV2').abi;
// `gasHeadroomPercent` covers calls whose estimate follows a cheaper branch than execution will: the factory
// forwards only 30,000 gas to the keeper, and the executor forwards to its operator only with gas left over.
async function send(label, to, data, value = 0n, gasHeadroomPercent = 0) {
  let step = journal[label];
  if (!step) {
    const nonce = await client.getTransactionCount({ address: account.address });
    assert.equal(nonce, await client.getTransactionCount({ address: account.address, blockTag: 'pending' }));
    const tx = await wallet.prepareTransactionRequest({ to, data, value, nonce });
    if (gasHeadroomPercent) tx.gas = tx.gas * BigInt(100 + gasHeadroomPercent) / 100n;
    const maxCost = tx.gas * (tx.maxFeePerGas ?? tx.gasPrice);
    assert(maxCost <= parseEther('0.2'), 'Per-transaction gas budget');
    assert(await client.getBalance({ address: account.address }) >= reserve + value + maxCost, 'Keep configured funding reserve');
    await client.call({ to, data, value, account });
    const raw = await wallet.signTransaction(tx);
    step = { raw, hash: keccak256(raw) }; journal[label] = step; persist(journalPath, journal);
  }
  const decoded = parseTransaction(step.raw);
  assert.equal(decoded.chainId, chain.id); assert.equal(decoded.to.toLowerCase(), to.toLowerCase());
  assert.equal(decoded.data, data); assert.equal(decoded.value ?? 0n, value);
  assert.equal(keccak256(step.raw), step.hash);
  assert.equal((await recoverTransactionAddress({ serializedTransaction: step.raw })).toLowerCase(), account.address.toLowerCase());
  let receipt;
  try { receipt = await client.getTransactionReceipt({ hash: step.hash }); }
  catch (error) { if (error.name !== 'TransactionReceiptNotFoundError') throw error; }
  if (!receipt) {
    try { await client.sendRawTransaction({ serializedTransaction: step.raw }); }
    catch (error) { if (!/already known|nonce too low/i.test(error.message)) throw error; }
    receipt = await client.waitForTransactionReceipt({ hash: step.hash, timeout: 120000 });
  }
  assert.equal(receipt.status, 'success', label);
  report.transactions[label] = { hash: step.hash, block: String(receipt.blockNumber) }; save();
  console.log(stringify({ step: label, hash: step.hash })); return receipt;
}
try {
  if (!report.deployment || !existsSync(envFile)) {
    const bytes = readFileSync('SingleSparkFront/front/static/assets/brands/singlespark-glossy-v1-still.png');
    const imageName = `${keccak256(bytes).slice(2)}.png`;
    writeFileSync(`${dir}/runtime/media/${imageName}`, bytes);
    const metadata = { name: platformName, symbol: platformSymbol, image: `${mediaBase}/${imageName}`, channels: { website: 'https://singlespark.fun/' } };
    const json = stringify(metadata);
    const metadataName = `${keccak256(new TextEncoder().encode(json)).slice(2)}.json`;
    writeFileSync(`${dir}/runtime/media/${metadataName}`, json);
    const safeWallet = { ...wallet, prepareTransactionRequest: async args => {
      const tx = await wallet.prepareTransactionRequest(args);
      assert(await client.getBalance({ address: account.address }) >= reserve + (tx.value ?? 0n) + tx.gas * (tx.maxFeePerGas ?? tx.gasPrice), 'Deployment reserve');
      return tx;
    } };
    report.deployment = await deployArc(client, safeWallet, { positionManager: process.env.ARC_POSITION_MANAGER,
      ...(satisfactionMode ? { satisfaction, executor: { owner: account.address, operator: source.keeper.address } }
        : { keeper: source.keeper.address, operations: source.platform.address }),
      platformName, platformSymbol, platformMetadataURI: `${mediaBase}/${metadataName}`,
      minBuyback: '5', journalPath: `${dir}/runtime/deployment-journal.json` });
    report.platformMetadata = metadata; report.platformMetadataURI = `${mediaBase}/${metadataName}`;
    report.status = 'deployed'; save();
    const d = report.deployment;
    const encryptionKey = process.env.ARC_TREASURY_ENCRYPTION_KEY;
    assert(encryptionKey && /^[0-9a-f]{64}$/i.test(encryptionKey), 'Treasury encryption key is required');
    const env = { ARC_CHAIN_ID: '5042002', ARC_RPC_URL: process.env.ARC_RPC_URL, ARC_PUBLIC_RPC_URL: process.env.ARC_PUBLIC_RPC_URL,
      ARC_EXPLORER_URL: 'https://testnet.arcscan.app', ARC_WEB_ORIGIN: 'http://127.0.0.1:5176', ARC_HOST: '127.0.0.1', ARC_PORT: new URL(base).port,
      ARC_DATA_DIR: `${dir}/runtime`, ARC_DATABASE_SCHEMA: `arc_${d.launch.slice(2).toLowerCase()}`, ARC_MEDIA_PUBLIC_BASE: mediaBase, ARC_LAUNCH_ADDRESS: d.launch, ARC_QUOTER_ADDRESS: d.quoter,
      ARC_POSITION_MANAGER: d.positionManager, ARC_FROM_BLOCK: d.fromBlock, ARC_CONFIG_SIGNING_KEY: process.env.ARC_CONFIG_SIGNING_KEY,
      ARC_CONFIG_KEY_ID: process.env.ARC_CONFIG_KEY_ID, ARC_KEEPER_PRIVATE_KEY: source.keeper.privateKey,
      ARC_KEEPER_ADDRESS: source.keeper.address, ARC_OPERATIONS_ADDRESS: source.platform.address,
      ARC_DEPLOYER_PRIVATE_KEY: funderKey,
      ARC_DEPLOYER_RESERVE_USDC: reserveUSDC,
      ARC_PLATFORM_NAME: platformName, ARC_PLATFORM_SYMBOL: platformSymbol, ARC_PLATFORM_METADATA_URI: report.platformMetadataURI,
      ARC_PLATFORM_BUY_FEE: '30000', ARC_PLATFORM_SELL_FEE: '30000', ARC_MIN_BUYBACK_USDC: '5',
      ARC_GAS_RESERVE_USDC: '1', ARC_SLIPPAGE_BPS: '50', ARC_MAX_GAS_PER_TX: '5000000', ARC_KEEPER_BATCH_SIZE: '20',
      ARC_TREASURY_ENCRYPTION_KEY: encryptionKey, ARC_REWARDS_ADDRESS: '', ARC_REWARDS_FROM_BLOCK: '',
      // The keeper key is unchanged; on this deployment it signs as the executor's operator.
      ...(satisfactionMode ? { ARC_KEEPER_ADDRESS: d.keeperExecutor, ARC_OPERATIONS_ADDRESS: d.satisfaction,
        ARC_KEEPER_EXECUTOR: d.keeperExecutor, ARC_KEEPER_OPERATOR_ADDRESS: d.keeperOperator,
        ARC_SATISFACTION_ADDRESS: d.satisfaction, ARC_SATISFACTION_FROM_BLOCK: d.fromBlock,
        ARC_SATISFACTION_TEAM: d.satisfactionParams.team } : {}) };
    writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v ?? '')}`).join('\n') + '\n', { mode: 0o600 });
  }
  const d = report.deployment;
  assert.equal(keccak256(await client.getCode({ address: d.launch })), d.launchCodeHash);
  await send('keeper-reserve', d.launch, encodeFunctionData({ abi, functionName: 'fundKeeperGas' }), parseEther(keeperSeed), satisfactionMode ? 20 : 0);
  if (process.argv.includes('--fund-new-keeper')) {
    // With the executor in place the factory's gas goes to the executor, which keeps it until it can forward;
    // the wallet that must be able to pay for transactions is the operator, so fund and assert on that one.
    const gasWallet = satisfactionMode ? d.keeperOperator : d.keeper;
    for (let i = 0; i < 4 && await client.getBalance({ address: gasWallet }) < parseEther('1.2'); i++) {
      await send(`keeper-topup-${i}`, d.launch, encodeFunctionData({ abi, functionName: 'topUpKeeper' }), 0n, satisfactionMode ? 20 : 0);
    }
    if (satisfactionMode && await client.getBalance({ address: gasWallet }) < parseEther('1.2')
      && await client.getBalance({ address: d.keeperExecutor }) > 0n) {
      // Permissionless release of gas the executor is holding for an operator that could not be topped up in place.
      await send('keeper-flush', d.keeperExecutor, encodeFunctionData({ abi: artifact('ArcKeeperExecutor').abi, functionName: 'flush' }));
    }
    assert(await client.getBalance({ address: gasWallet }) >= parseEther('1.2'), 'New keeper funding is incomplete');
  }
  if (process.argv.includes('--verify-usdc-tax')) {
    assert.equal(d.economicsVersion, 3);
    // Bounded real trades: recycle 40 USDC three times, retaining the configured source reserve.
    // Existing receipts/plans are reused on restart; never repeat a confirmed trade.
    report.nativeTaxTest ||= { rounds: [], inputPerRoundUSDC: '40', testFundingUSDC: '0' };
    const token = d.platformToken;
    const [id] = await client.readContract({ address: d.launch, abi, functionName: 'tokens', args: [token] });
    const [poolKey] = await client.readContract({ address: d.positionManager, abi: artifact('PositionManager').abi,
      functionName: 'getPoolAndPositionInfo', args: [id] });
    for (let i = 0; i < 3; i++) {
      const row = report.nativeTaxTest.rounds[i] ||= {};
      for (const buy of [true, false]) {
        const side = buy ? 'buy' : 'sell';
        let label = `native-tax-${i}-${side}`;
        // A journaled trade that reverted on chain (a keeper transaction in the same block can make execution
        // costlier than the estimate) is never re-sent: it stays on record and the trade is retried under a new
        // label with a fresh quote and deadline.
        for (let retry = 1; journal[label] && !row[side]?.transactionHash; retry++) {
          let failed;
          try { failed = (await client.getTransactionReceipt({ hash: journal[label].hash })).status === 'reverted'; }
          catch (error) { if (error.name !== 'TransactionReceiptNotFoundError') throw error; }
          if (!failed) break;
          assert(retry <= 3, `${label} reverted too often`);
          row.reverted = [...new Set([...(row.reverted ?? []), journal[label].hash])];
          if ((row[side]?.label ?? `native-tax-${i}-${side}`) === label) delete row[side];
          label = `native-tax-${i}-${side}-retry${retry}`; save();
        }
        const amount = buy ? parseEther('40') : BigInt(row.buy.amountOut);
        if (!row[side]) {
          const { result: [quoted] } = await client.simulateContract({ address: d.quoter, abi: artifact('V4Quoter').abi,
            functionName: 'quoteExactInputSingle', args: [{ poolKey, zeroForOne: buy, exactAmount: amount, hookData: '0x' }] });
          row[side] = { label, amountIn: amount.toString(), minOut: (quoted * 995n / 1000n).toString(),
            deadline: ((await client.getBlock()).timestamp + 120n).toString() }; save();
        }
        const step = row[side];
        if (!buy) await send(`native-tax-${i}-approve`, token, encodeFunctionData({ abi: artifact('ArcLaunch', 'ArcToken').abi,
          functionName: 'approve', args: [d.launch, amount] }));
        const receipt = await send(label, d.launch, encodeFunctionData({ abi, functionName: 'trade',
          args: [token, buy, amount, BigInt(step.minOut), BigInt(step.deadline)] }), buy ? amount : 0n, satisfactionMode ? 20 : 0);
        const trade = parseEventLogs({ abi, eventName: 'Traded', logs: receipt.logs })[0].args;
        const swap = parseEventLogs({ abi: artifact('PoolManager').abi, eventName: 'Swap', logs: receipt.logs })[0].args;
        assert.equal(swap.fee, 0, 'No additional LP input tax');
        const gross = buy ? amount : swap.amount0;
        const tax = (gross * 30_000n + 999_999n) / 1_000_000n;
        assert.equal(buy ? -swap.amount0 : trade.amountOut, gross - tax);
        assert.equal(parseEventLogs({ abi, eventName: 'Burned', logs: receipt.logs }).length, 0, 'A trade is not a burn');
        Object.assign(step, { amountOut: trade.amountOut.toString(), grossUSDC: formatEther(gross), taxUSDC: formatEther(tax),
          transactionHash: receipt.transactionHash, block: String(receipt.blockNumber) }); save();
      }
    }
    const state = await client.readContract({ address: d.launch, abi, functionName: 'tokens', args: [token] });
    const accrued = await client.readContract({ address: d.strategy, abi: artifact('ArcLaunchStrategy').abi,
      functionName: 'accruedNative', args: [token] });
    assert.equal(state[2], 0n, 'No fee-token burn budget');
    Object.assign(report.nativeTaxTest, { status: 'trades-passed', accruedUSDC: formatEther(accrued), pendingFeeTokens: '0' }); save();
  }
  if (process.argv.includes('--verify-opening-tax')) {
    assert.equal(d.launchProtectionVersion, 2);
    const test = report.openingTaxTest ||= { status: 'preparing', inputUSDC: '8', transactions: {}, normalTrades: {} };
    const read = (address, abi, functionName, args = [], blockNumber) => client.readContract({ address, abi, functionName, args, blockNumber });
    const strategyAbi = artifact('ArcLaunchStrategy').abi;
    assert.equal(await read(d.strategy, strategyAbi, 'launchProtectionVersion'), 2n);
    if (!test.metadataURI) {
      const snapshot = await (await fetch(`${base}/api/arc/snapshot`)).json();
      assert.equal(snapshot.launch.toLowerCase(), d.launch.toLowerCase());
      assert.equal(snapshot.openingTaxToPlatform, true);
      const bytes = readFileSync('SingleSparkFront/front/static/assets/tokens/ember-cat.png');
      const imageName = `${keccak256(bytes).slice(2)}.png`;
      writeFileSync(`${dir}/runtime/media/${imageName}`, bytes);
      const metadata = stringify({ name: 'Opening Tax Test', symbol: 'OTAX', image: `${mediaBase}/${imageName}`, channels: {} });
      const metadataName = `${keccak256(new TextEncoder().encode(metadata)).slice(2)}.json`;
      writeFileSync(`${dir}/runtime/media/${metadataName}`, metadata);
      test.metadataURI = `${mediaBase}/${metadataName}`;
      save();
    }
    const probeArtifact = artifact('ArcOpeningProbe');
    const initCode = encodeDeployData({ abi: probeArtifact.abi, bytecode: probeArtifact.bytecode.object, args: [d.launch] });
    const create2 = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
    test.probe = getCreate2Address({ from: create2, salt: zeroHash, bytecode: initCode });
    await send('opening-probe', create2, concatHex([zeroHash, initCode]));
    const receipt = await send('opening-buy', test.probe, encodeFunctionData({ abi: probeArtifact.abi,
      functionName: 'launchAndBuy', args: [test.metadataURI] }), parseEther(test.inputUSDC));
    const launched = parseEventLogs({ abi, eventName: 'Launched', logs: receipt.logs })[0].args;
    test.community = parseEventLogs({ abi, eventName: 'ProjectTreasuryCreated', logs: receipt.logs })[0].args.treasury;
    const trade = parseEventLogs({ abi, eventName: 'Traded', logs: receipt.logs })[0].args;
    const swap = parseEventLogs({ abi: artifact('PoolManager').abi, eventName: 'Swap', logs: receipt.logs })[0].args;
    test.token = launched.token;
    if (!report.projects.some(project => project.token.toLowerCase() === test.token.toLowerCase())) {
      report.projects.push({ token: test.token, name: launched.name, symbol: launched.symbol, creator: launched.creator,
        community: test.community, metadataURI: test.metadataURI, buyFee: 30000, sellFee: 30000, purpose: 'opening-tax-test' });
    }
    assert.equal(trade.buy, true); assert.equal(trade.amountIn, parseEther('8'));
    assert.equal(-swap.amount0, parseEther('0.08')); assert.equal(swap.fee, 0);
    assert.equal(await read(d.strategy, strategyAbi, 'accruedNative', [test.token], receipt.blockNumber), parseEther('7.92'));
    assert.equal(await read(d.strategy, strategyAbi, 'accruedOpeningNative', [test.token], receipt.blockNumber), parseEther('7.68'));
    const tokenAbi = artifact('ArcLaunch', 'ArcToken').abi;
    assert.equal(await read(test.token, tokenAbi, 'balanceOf', [test.probe], receipt.blockNumber), 0n);
    assert.equal(await read(test.token, tokenAbi, 'balanceOf', [account.address], receipt.blockNumber), trade.amountOut);
    test.transactions.openingBuy = { hash: receipt.transactionHash, block: String(receipt.blockNumber),
      grossUSDC: '8', totalTaxUSDC: '7.92', baseTaxUSDC: '0.24', extraTaxUSDC: '7.68', poolInputUSDC: '0.08' };
    save();
    const [, endsAt] = await read(d.strategy, strategyAbi, 'launchProtection', [test.token]);
    for (let attempts = 0; (await client.getBlock()).timestamp < endsAt; attempts++) {
      assert(attempts < 30, 'Wait for chain opening protection to expire');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal((await read(d.strategy, strategyAbi, 'launchProtection', [test.token]))[2], 30000);
    for (const token of [test.token, d.platformToken]) {
      const row = test.normalTrades[token] ||= {};
      const [id] = await read(d.launch, abi, 'tokens', [token]);
      const [poolKey] = await read(d.positionManager, artifact('PositionManager').abi, 'getPoolAndPositionInfo', [id]);
      for (const buy of [true, false]) {
        const side = buy ? 'buy' : 'sell';
        const amount = buy ? parseEther('1') : BigInt(row.buy.amountOut);
        if (!row[side]) {
          const { result: [quote] } = await client.simulateContract({ address: d.quoter, abi: artifact('V4Quoter').abi,
            functionName: 'quoteExactInputSingle', args: [{ poolKey, zeroForOne: buy, exactAmount: amount, hookData: '0x' }] });
          row[side] = { amountIn: String(amount), minOut: String(quote * 995n / 1000n), deadline: String((await client.getBlock()).timestamp + 120n) };
          save();
        }
        const step = row[side];
        if (!buy) await send(`opening-normal-${token}-approve`, token, encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [d.launch, amount] }));
        const tx = await send(`opening-normal-${token}-${side}`, d.launch, encodeFunctionData({ abi, functionName: 'trade',
          args: [token, buy, amount, BigInt(step.minOut), BigInt(step.deadline)] }), buy ? amount : 0n);
        const traded = parseEventLogs({ abi, eventName: 'Traded', logs: tx.logs })[0].args;
        const swapped = parseEventLogs({ abi: artifact('PoolManager').abi, eventName: 'Swap', logs: tx.logs })[0].args;
        const gross = buy ? amount : swapped.amount0;
        const tax = (gross * 30000n + 999999n) / 1000000n;
        assert.equal(buy ? -swapped.amount0 : traded.amountOut, gross - tax);
        assert.equal(parseEventLogs({ abi, eventName: 'Burned', logs: tx.logs }).length, 0);
        Object.assign(step, { transactionHash: tx.transactionHash, block: String(tx.blockNumber), amountOut: String(traded.amountOut), taxUSDC: formatEther(tax) });
        save();
      }
    }
    test.status = 'trades-passed-awaiting-keeper'; save();
    console.log(stringify({ openingTaxTest: test.status, token: test.token, extraTaxUSDC: '7.68', reserveUSDC,
      balanceUSDC: formatEther(await client.getBalance({ address: account.address })) }));
  }
  if (process.argv.includes('--activate')) {
    // Never open two writers for the same runtime; archived deployments may run independently.
    const paths = ['SingleSparkContract/arc/.env.testnet.local', 'SingleSparkContract/arc/.env.testnet-v2.local', '.env.arc.local', '.env.arc-v2.local'];
    mkdirSync(`${dir}/previous-env`, { recursive: true, mode: 0o700 });
    for (const path of paths) {
      const backup = `${dir}/previous-env/${path.replaceAll('/', '_')}`;
      if (!existsSync(backup) && existsSync(path)) { copyFileSync(path, backup); chmodSync(backup, 0o600); }
      if (path.startsWith('SingleSparkContract/arc/')) { copyFileSync(envFile, path); chmodSync(path, 0o600); }
      else {
        let content = readFileSync(path, 'utf8').replace(/^VITE_API_BASE=.*$/m, `VITE_API_BASE=${base}`);
        const configKey = process.env.ARC_CONFIG_SIGNING_KEY;
        const signers = `VITE_CHAIN_CONFIG_SIGNERS='${stringify({ [process.env.ARC_CONFIG_KEY_ID]: privateKeyToAccount(configKey.startsWith('0x') ? configKey : `0x${configKey}`).address })}'`;
        content = /^VITE_CHAIN_CONFIG_SIGNERS=/m.test(content) ? content.replace(/^VITE_CHAIN_CONFIG_SIGNERS=.*$/m, signers) : `${content}\n${signers}\n`;
        writeFileSync(path, content, { mode: 0o600 });
      }
    }
    report.status = 'activated'; save();
  }
  if (process.argv.includes('--projects')) {
    const snapshot = await (await fetch(`${base}/api/arc/snapshot`)).json();
    assert.equal(snapshot.launch.toLowerCase(), d.launch.toLowerCase(), 'Start the new backend before creating projects');
    const challenge = await (await fetch(`${base}/api/auth/nonce?address=${account.address}&chainId=5042002`)).json();
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: stringify({ message: challenge.message, signature: await account.signMessage({ message: challenge.message }), chainId: 5042002 }) });
    assert.equal(login.status, 200); const session = await login.json();
    const post = async (path, body, type = 'application/json') => {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': type, Authorization: `Bearer ${session.token}` }, body });
      assert(response.ok, `${path}: ${response.status}`); return response.json();
    };
    for (const [name, symbol, image, buyFee, sellFee] of [
      ['Ember Cat Test', 'ECAT', 'ember-cat.png', 30000, 30000], ['Moon Frog Test', 'MFROG', 'moon-frog.png', 10000, 50000],
    ]) {
      const { publicUrl } = await post('/api/arc/media', readFileSync(`SingleSparkFront/front/static/assets/tokens/${image}`), 'image/png');
      const { metadataURI } = await post('/api/arc/metadata', stringify({ name, symbol, image: publicUrl, channels: { website: 'https://singlespark.fun/' } }));
      const vaultReceipt = await send(`treasury-${symbol}`, d.launch, encodeFunctionData({ abi, functionName: 'createProjectTreasury' }));
      const community = parseEventLogs({ abi, eventName: 'ProjectTreasuryCreated', logs: vaultReceipt.logs })[0].args.treasury;
      const receipt = await send(`launch-${symbol}`, d.launch, encodeFunctionData({ abi, functionName: 'launch', args: [name, symbol, metadataURI, buyFee, sellFee, community] }));
      const token = parseEventLogs({ abi, eventName: 'Launched', logs: receipt.logs })[0].args.token;
      const details = { name, symbol, token, metadataURI, imageUrl: publicUrl, buyFee, sellFee, community, transactionHash: receipt.transactionHash };
      report.projects = [...report.projects.filter(item => item.symbol !== symbol), details]; save();
      const metadata = await (await fetch(metadataURI)).json();
      assert.equal(metadata.image, publicUrl); assert.equal(metadata.channels.website, 'https://singlespark.fun/');
    }
    report.status = 'projects_created'; save();
  }
  report.funderBalanceUSDC = formatEther(await client.getBalance({ address: account.address })); save();
  console.log(stringify({ status: report.status, factory: d.launch, platformToken: d.platformToken, projects: report.projects,
    funderBalanceUSDC: report.funderBalanceUSDC, reportPath, envFile }));
} finally { closeSync(lock); unlinkSync(lockPath); }
