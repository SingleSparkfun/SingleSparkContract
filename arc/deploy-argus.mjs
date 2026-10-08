// Argus V7 deployment. Default is read-only; --broadcast uses a durable, resumable signature journal.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, statSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toHex, getCreate2Address,
  encodeAbiParameters, parseAbiParameters, encodeFunctionData, encodeDeployData, parseEventLogs,
  parseTransaction, recoverTransactionAddress, parseEther, formatEther, erc20Abi, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { artifact } from './deploy.mjs';
import { persist, stringify } from './runtime.mjs';

const option = name => process.argv[process.argv.indexOf(name) + 1];
const PORTAL = '0xB021Be536808f551b31789422Fd28a6c9c6e97Da';
const QUOTE = '0x3600000000000000000000000000000000000000';
const portalAbi = JSON.parse(readFileSync(new URL('./abi/argus-portal-v7.json', import.meta.url)));
const splitterAbi = JSON.parse(readFileSync(new URL('./abi/argus-splitter-v7.json', import.meta.url)));

async function main() {
  assert(process.argv.includes('--env'), 'Pass --env <private configuration file>');
  const envPath = resolve(option('--env'));
  assert.equal(statSync(envPath).mode & 0o077, 0, 'Configuration must be owner-only');
  const env = parseEnv(readFileSync(envPath, 'utf8'));
  assert.equal(env.ARC_CHAIN_ID, '5042');
  const account = privateKeyToAccount(env.ARC_DEPLOYER_PRIVATE_KEY);
  const chain = defineChain({ id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [env.ARC_RPC_URL] } } });
  const client = createPublicClient({ chain, transport: http(env.ARC_RPC_URL, { timeout: 30000, retryCount: 1 }) });
  const wallet = createWalletClient({ account, chain, transport: http(env.ARC_RPC_URL, { retryCount: 0 }) });
  assert.equal(await client.getChainId(), 5042);
  assert.equal((await client.getCode({ address: account.address })) ?? '0x', '0x', 'Custody must be an undelegated EOA');
  const read = (address, abi, functionName, args = [], blockNumber) => client.readContract({ address, abi, functionName, args, blockNumber });
  async function pins(blockNumber) {
    for (const [name, expected] of Object.entries({ tokenImpl: '0x1B74922c01DDfD9C77B37D02C0a236611E8Fe500', splitterImpl: '0xd9578dd861b2fe59675C2C4B09b026FcB0df37FC', lockerImpl: '0xb2eD8112Db1bc11F7e7AB7969C2a9d1f819Cfc6A', defaultQuoteAsset: QUOTE })) {
      assert.equal((await read(PORTAL, portalAbi, name, [], blockNumber)).toLowerCase(), expected.toLowerCase(), name);
    }
    assert.equal(await read(PORTAL, portalAbi, 'treasuryBps', [], blockNumber), 1000);
    assert.equal(await read(PORTAL, portalAbi, 'hookInitCodeHash', ['0x0000000000000000000000000000000000000001', 100, 100, QUOTE], blockNumber), '0xd7513ecefb0b31485d7e935f7df8e0754f6ccf3a82e62d5126fdcc8c28c3bee8');
  }
  const router = artifact('ArgusCustodyRouter');
  assert((router.deployedBytecode.object.length - 2) / 2 <= 24576, 'Contract exceeds EIP-170');
  assert.equal(env.ARC_ARGUS_GOVERNANCE_ENABLED, 'false', 'This deployment has no voting');
  const p = { name: env.ARC_PLATFORM_NAME, symbol: env.ARC_PLATFORM_SYMBOL, totalSupply: 10n ** 27n,
    startFdvUsdc6: 2500n * 10n ** 6n, bondFdvUsdc6: 45000n * 10n ** 6n,
    buyTaxBps: Number(env.ARC_PLATFORM_BUY_FEE) / 100, sellTaxBps: Number(env.ARC_PLATFORM_SELL_FEE) / 100,
    creatorBps: 10000, burnBps: 0, dividendBps: 0, liquidityBps: 0, devBuyQuote: 0n, quoteAsset: QUOTE, expectConvert: 1 };
  assert(p.name?.trim() === p.name && p.name.length > 0 && p.name.length <= 64);
  assert(/^[A-Za-z0-9]{1,12}$/.test(p.symbol));
  assert([p.buyTaxBps, p.sellTaxBps].every(x => Number.isInteger(x) && x >= 0 && x <= 1000 && x % 100 === 0));
  assert(p.buyTaxBps + p.sellTaxBps > 0);
  const meta = { imageURI: env.ARC_PLATFORM_IMAGE_URI, website: 'https://singlespark.fun', twitter: '', telegram: '', description: 'SingleSpark platform token.' };
  assert(new URL(meta.imageURI).protocol === 'https:');
  const image = await fetch(meta.imageURI, { signal: AbortSignal.timeout(20000) });
  assert(image.ok && image.headers.get('content-type')?.startsWith('image/'), 'Published image is unavailable');
  await image.body?.cancel();
  const team = env.ARC_OPERATIONS_ADDRESS;
  assert(/^0x[0-9a-fA-F]{40}$/.test(team) && team !== zeroAddress && team.toLowerCase() !== account.address.toLowerCase());
  const budget = parseEther(env.ARC_DEPLOY_GAS_BUDGET_USDC);
  assert(budget > 0n && budget <= parseEther('1'), 'This deployment is capped at 1 USDC');
  const directory = resolve(env.ARC_DATA_DIR);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = resolve(directory, 'deployment.lock');
  const lock = openSync(lockPath, 'wx', 0o600);
  try {
    const path = resolve(directory, 'deployment-journal.json');
    const identity = stringify({ chainId: chain.id, rpcHash: keccak256(toHex(env.ARC_RPC_URL)), custody: account.address, p, meta, team, governanceEnabled: false,
      budget, routerHash: keccak256(router.bytecode.object) });
    const journal = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { identity, salt: toHex(randomBytes(32)), steps: {} };
    assert.equal(journal.identity, identity, 'Deployment settings changed; preserve the original journal');
    const head = await client.getBlock({ blockTag: 'finalized' });
    await pins(head.number);
    const splitter = await read(PORTAL, portalAbi, 'predictSplitter', [account.address, journal.salt]);
    const bytecodeHash = await read(PORTAL, portalAbi, 'hookInitCodeHash', [splitter, p.buyTaxBps, p.sellTaxBps, QUOTE]);
    if (!journal.hookSalt) {
      for (let i = 0n; i < 1000000n; i++) {
        const salt = toHex(i, { size: 32 });
        const scoped = keccak256(encodeAbiParameters(parseAbiParameters('address,bytes32'), [account.address, salt]));
        const hook = getCreate2Address({ from: PORTAL, salt: scoped, bytecodeHash });
        if ((BigInt(hook) & 0x3fffn) === 0x2044n) { journal.hookSalt = salt; journal.hook = hook; break; }
      }
      assert(journal.hookSalt, 'Hook salt search exhausted');
    }
    // Portal prediction rejects an already deployed hook. Keep the prediction before signing.
    const token = journal.token ?? (journal.steps.launch?.receipt
      ? parseEventLogs({ abi: portalAbi, logs: journal.steps.launch.receipt.logs, eventName: 'TokenCreated' })[0]?.args.token
      : await read(PORTAL, portalAbi, 'predictToken', [account.address, journal.salt, journal.hook, QUOTE]));
    assert(token, 'Missing journal token');
    journal.token = token;
    const args = [p, meta, journal.salt, journal.hookSalt];
    const launchData = encodeFunctionData({ abi: portalAbi, functionName: 'launch', args });
    persist(path, journal);
    if (!journal.steps.launch) {
      assert.equal((await client.getCode({ address: token })) ?? '0x', '0x', 'Predicted token already exists');
      await client.simulateContract({ account: account.address, address: PORTAL, abi: portalAbi, functionName: 'launch', args });
    }
    const balance = await client.getBalance({ address: account.address });
    console.log(stringify({ status: 'preflight_passed', custody: account.address, team, name: p.name, symbol: p.symbol, balanceUSDC: formatEther(balance), maximumDeploymentGasUSDC: formatEther(budget), predictedToken: token }));
    if (!process.argv.includes('--broadcast')) return;
    async function send(label, transaction) {
      let step = journal.steps[label];
      if (!step) {
        const latest = await client.getTransactionCount({ address: account.address });
        assert.equal(latest, await client.getTransactionCount({ address: account.address, blockTag: 'pending' }), 'Another transaction is pending');
        const request = await wallet.prepareTransactionRequest({ ...transaction, nonce: latest, value: 0n });
        const maximum = request.gas * (request.maxFeePerGas ?? request.gasPrice);
        const committed = Object.values(journal.steps).reduce((n, x) => n + BigInt(x.maximumGasCost), 0n);
        assert(committed + maximum <= budget, 'Deployment gas budget exceeded');
        assert((await client.getBalance({ address: account.address })) >= maximum + parseEther('1'), 'Keep at least 1 USDC outside deployment');
        const raw = await wallet.signTransaction(request);
        step = { raw, hash: keccak256(raw), maximumGasCost: maximum.toString() };
        journal.steps[label] = step;
        persist(path, journal);
      }
      const decoded = parseTransaction(step.raw);
      assert.equal(keccak256(step.raw), step.hash);
      assert.equal(decoded.chainId, 5042);
      assert.equal((await recoverTransactionAddress({ serializedTransaction: step.raw })).toLowerCase(), account.address.toLowerCase());
      assert.equal((decoded.to ?? '').toLowerCase(), (transaction.to ?? '').toLowerCase());
      assert.equal(decoded.data, transaction.data);
      assert.equal(decoded.value ?? 0n, 0n);
      let receipt;
      try { receipt = await client.getTransactionReceipt({ hash: step.hash }); }
      catch (e) { if (e.name !== 'TransactionReceiptNotFoundError') throw e; }
      if (!receipt) {
        try { await client.sendRawTransaction({ serializedTransaction: step.raw }); }
        catch (e) { if (!/already known|nonce too low|known transaction/i.test(e.message)) throw e; }
        receipt = await client.waitForTransactionReceipt({ hash: step.hash, timeout: 120000 });
      }
      assert.equal(receipt.status, 'success', `${label} reverted: ${step.hash}`);
      for (let i = 0; ; i++) {
        const finalized = await client.getBlock({ blockTag: 'finalized' });
        if (finalized.number >= receipt.blockNumber) break;
        assert(i < 60, 'Finality timeout; resume the same journal');
        await new Promise(r => setTimeout(r, 1000));
      }
      assert.equal((await client.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash);
      step.receipt = receipt;
      persist(path, journal);
      console.log(stringify({ step: label, status: 'finalized', transactionHash: receipt.transactionHash, gasCostUSDC: formatEther(receipt.gasUsed * receipt.effectiveGasPrice) }));
      return receipt;
    }
    await pins();
    const launch = await send('launch', { to: PORTAL, data: launchData });
    const logs = launch.logs.filter(x => x.address.toLowerCase() === PORTAL.toLowerCase());
    const created = parseEventLogs({ abi: portalAbi, logs, eventName: 'TokenCreated' });
    assert.equal(created.length, 1);
    for (const [key, value] of Object.entries({ token, creator: account.address, name: p.name, symbol: p.symbol, ...meta })) {
      if (key === 'description') continue; // Not included in TokenCreated; calldata is journal-bound above.
      assert.equal(String(created[0].args[key]).toLowerCase(), value.toLowerCase(), key);
    }
    const parts = parseEventLogs({ abi: portalAbi, logs, eventName: 'PartsDeployed' });
    assert.equal(parts.length, 1);
    assert.equal(parts[0].args.splitter.toLowerCase(), splitter.toLowerCase());
    assert.equal(parts[0].args.hook.toLowerCase(), journal.hook.toLowerCase());
    const fees = parseEventLogs({ abi: portalAbi, logs, eventName: 'FeeConfigured' });
    assert.equal(fees.length, 1);
    for (const [key, value] of Object.entries({ buyTaxBps: p.buyTaxBps, sellTaxBps: p.sellTaxBps, creatorBps: 10000, treasuryBps: 1000, burnBps: 0, dividendBps: 0, liquidityBps: 0 })) assert.equal(Number(fees[0].args[key]), value, key);
    const state = await read(PORTAL, portalAbi, 'launches', [token], launch.blockNumber);
    assert.equal(state[0].toLowerCase(), account.address.toLowerCase());
    assert.equal(state[10].toLowerCase(), QUOTE.toLowerCase());
    assert(state[8] > 0n);
    assert.equal(await read(token, erc20Abi, 'name'), p.name);
    assert.equal(await read(token, erc20Abi, 'symbol'), p.symbol);
    assert.equal(await read(token, erc20Abi, 'totalSupply'), p.totalSupply);
    assert.equal((await read(splitter, splitterAbi, 'creator')).toLowerCase(), account.address.toLowerCase());
    assert.equal(await read(splitter, splitterAbi, 'converts'), false);
    assert.equal(await read(splitter, splitterAbi, 'rewardTracker'), zeroAddress);
    await pins(launch.blockNumber);
    const routerReceipt = await send('router', { data: encodeDeployData({ abi: router.abi, bytecode: router.bytecode.object, args: [account.address, token, team, false] }) });
    const route = routerReceipt.contractAddress;
    for (const [key, value] of Object.entries({ custody: account.address, platformToken: token, operations: team })) assert.equal((await read(route, router.abi, key)).toLowerCase(), value.toLowerCase());
    assert.equal(await read(route, router.abi, 'independentWallets'), true);
    assert.equal(await read(route, router.abi, 'governanceEnabled'), false);
    const result = { status: 'passed_argus_deployment', chainId: 5042, protocol: 'argus-v7-custody', portal: PORTAL, custody: account.address,
      platformToken: token, platformName: p.name, platformSymbol: p.symbol, router: route, routerCodeHash: keccak256(await client.getCode({ address: route })),
      governanceEnabled: false, projectReserveWithdrawals: false, team, fromBlock: launch.blockNumber, splitter, hook: journal.hook, locker: parts[0].args.locker,
      buyTaxBps: p.buyTaxBps, sellTaxBps: p.sellTaxBps, startFDV: '2500', targetFDV: '45000', devBuyQuote: '0',
      transactions: Object.fromEntries(Object.entries(journal.steps).map(([label, step]) => [label, step.hash])),
      gasSpentUSDC: formatEther(Object.values(journal.steps).reduce((sum, step) => sum + BigInt(step.receipt.gasUsed) * BigInt(step.receipt.effectiveGasPrice), 0n)),
      remainingUSDC: formatEther(await client.getBalance({ address: account.address })), checkedAt: new Date().toISOString() };
    persist(resolve(directory, 'deployment.json'), result);
    console.log(stringify(result));
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
main().catch(e => { console.error(e.shortMessage ?? e.message); process.exitCode = 1; });
