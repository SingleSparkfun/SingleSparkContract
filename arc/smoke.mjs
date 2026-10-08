import { testDatabase, testSql, testRows, sqlString, localApiLimits } from './test-database.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createPortReservation } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, erc20Abi, parseEventLogs, encodeFunctionData, keccak256, verifyMessage, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcAbi } from '../../SingleSparkFront/front/web3/arcAbi.ts';
import { artifact, deployArc } from './deploy.mjs';
import { createRuntime, stringify } from './runtime.mjs';
import { startServer } from './server.mjs';

// Public Anvil development key. Never fund this address on a public network.
const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const account = privateKeyToAccount(key);
const rust = process.argv.includes('--rust');
const reservation = createPortReservation();
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(process.argv.includes('--serve') ? 18545 : 0, '127.0.0.1', resolve); });
const rpcPort = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const rpcUrl = `http://127.0.0.1:${rpcPort}`;
const chain = defineChain({ id: 5042002, name: 'Arc Local', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const client = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0 }) });
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
const dataDir = mkdtempSync(resolve(tmpdir(), 'arc-smoke-'));
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(rpcPort), '--chain-id', '5042002', '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] });
let app;
let anvilError = '';
anvil.stderr.on('data', data => { anvilError += data; });
try {
  for (let attempt = 0; ; attempt++) {
    if (anvil.exitCode !== null) throw new Error(`Anvil stopped: ${anvilError}`);
    try { await client.getBlockNumber(); break; } catch (error) {
      if (attempt === 30) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const deploy = async (name, args) => {
    const compiled = artifact(name);
    const hash = await wallet.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    return receipt.contractAddress;
  };
  const pool = await deploy('PoolManager', [account.address]);
  // Local-only unused Permit2, descriptor and wrapper endpoints; never broadcast this setup publicly.
  const pm = await deploy('PositionManager', [pool, zeroAddress, 100_000, zeroAddress, zeroAddress]);
  const deployOptions = { version: 1, positionManager: pm, keeper: account.address, operations: account.address,
    platformName: 'Jet', platformSymbol: 'JET', journalPath: resolve(dataDir, 'deployment-journal.json') };
  const deployment = await deployArc(client, wallet, deployOptions);
  const deployedNonce = await client.getTransactionCount({ address: account.address });
  assert.deepEqual(await deployArc(client, wallet, deployOptions), deployment, 'resuming deployment must reuse all receipts');
  assert.equal(await client.getTransactionCount({ address: account.address }), deployedNonce, 'resuming must not deploy twice');
  await assert.rejects(deployArc(client, wallet, { ...deployOptions, platformSymbol: 'WRONG' }), /configuration mismatch/);
  const write = async (functionName, args, value = 0n, address = deployment.launch, abi = arcAbi) => {
    const hash = await wallet.writeContract({ address, abi, functionName, args, value });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success', `${functionName} reverted`);
    return receipt;
  };
  const receipt = await write('launch', ['Local Project', 'TEST', '']);
  const token = parseEventLogs({ abi: arcAbi, eventName: 'Launched', logs: receipt.logs })[0].args.token;
  await write('trade', [token, true, 4000n * 10n ** 18n, 1n, (await client.getBlock()).timestamp + 120n], 4000n * 10n ** 18n);
  const balance = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
  await write('approve', [deployment.launch, balance / 2n], 0n, token, erc20Abi);
  await write('trade', [token, false, balance / 2n, 1n, (await client.getBlock()).timestamp + 120n]);
  await write('fundFees', [token], 100n * 10n ** 18n);
  const config = { ...deployment, chainId: 5042002, dataDir, rpcUrl, publicRpcUrl: rpcUrl, origin: 'http://127.0.0.1:5176',
    explorer: 'https://testnet.arcscan.app', keeperKey: key, signingKey: key, keyId: 'arc-local', slippageBps: 300,
    gasReserve: 10n ** 18n, host: '127.0.0.1', port: process.argv.includes('--serve') ? 8088 : 0 };
  const runtime = await createRuntime(config);
  const rustEnv = { ...process.env, ...testDatabase(dataDir), ...localApiLimits, ARC_CHAIN_ID: '5042002', ARC_RPC_URL: rpcUrl, ARC_PUBLIC_RPC_URL: rpcUrl,
    ARC_EXPLORER_URL: config.explorer, ARC_WEB_ORIGIN: config.origin, ARC_HOST: config.host, ARC_PORT: String(config.port),
    ARC_DATA_DIR: dataDir, ARC_LAUNCH_ADDRESS: deployment.launch, ARC_QUOTER_ADDRESS: deployment.quoter,
    ARC_MEDIA_PUBLIC_BASE: 'https://images.example.test/api/arc/media',
    ARC_FROM_BLOCK: deployment.fromBlock, ARC_KEEPER_PRIVATE_KEY: key, ARC_CONFIG_SIGNING_KEY: key,
    ARC_CONFIG_KEY_ID: config.keyId, ARC_GAS_RESERVE_USDC: '1', ARC_SLIPPAGE_BPS: '300',
    ARC_KEEPER_ADMIN_TOKEN: '', ARC_KEEPER_BATCH_SIZE: '20', ARC_MAX_GAS_PER_TX: '1500000',
    ARC_REWARDS_ADDRESS: '', ARC_REWARDS_FROM_BLOCK: '' };
  function rustProcess(args = []) {
    const child = spawn(resolve('SingleSparkBackend/api/target/debug/jet-arc-backend'), args, { env: rustEnv });
    let output = '';
    let error = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { error += data; });
    const completed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve(output) : reject(new Error(`Rust backend exited ${code}: ${error}`)));
    });
    completed.catch(() => {});
    return { child, completed, output: () => output };
  }
  const rustOnce = async () => JSON.parse(await rustProcess(['--once']).completed);
  async function rustServer() {
    const process = rustProcess();
    let port;
    for (let i = 0; i < 300; i++) {
      const match = process.output().match(/listening on 127\.0\.0\.1:(\d+)/);
      if (match) { port = Number(match[1]); break; }
      if (process.child.exitCode !== null) await process.completed;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!port) { process.child.kill('SIGTERM'); throw new Error('Rust API did not start'); }
    const base = `http://127.0.0.1:${port}`;
    const ready = async () => {
      for (let i = 0; i < 300; i++) {
        if ((await fetch(`${base}/ready`)).ok) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Rust index did not become ready');
    };
    return { server: { address: () => ({ port }) }, runtime: { index: ready },
      close: async () => { process.child.kill('SIGTERM'); await process.completed; } };
  }
  if (rust) runtime.cycle = rustOnce;
  const supplyBefore = await client.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' });
  assert.equal((await runtime.tokenState(token)).pendingNative, 90n * 10n ** 18n);
  await runtime.cycle();
  const after = await runtime.tokenState(token);
  assert.equal(after.cycles, 1n);
  const supplyAfter = await client.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' });
  assert.equal(supplyBefore - supplyAfter, after.totalBurned);
  assert(after.totalBuyback >= 90n * 10n ** 18n);
  assert.equal(await runtime.read('operationsCredit'), 0n);
  await runtime.cycle();
  assert.equal((await runtime.tokenState(token)).cycles, 1n, '180-second guard must prevent duplicate burns');
  await client.request({ method: 'evm_increaseTime', params: [180] });
  await client.request({ method: 'evm_mine', params: [] });
  await write('fundFees', [token], 10n * 10n ** 18n);
  await runtime.cycle();
  assert.equal((await runtime.tokenState(token)).cycles, 2n);

  // Crash before broadcast: restart must send the exact journaled transaction once.
  await write('fundFees', [token], 10n ** 18n);
  const nonceBeforeRecovery = await client.getTransactionCount({ address: account.address });
  const request = await wallet.prepareTransactionRequest({ to: deployment.launch, data: encodeFunctionData({ abi: arcAbi, functionName: 'claimOperations' }) });
  const raw = await wallet.signTransaction(request);
  const journal = stringify({ identity: `5042002:${deployment.launch.toLowerCase()}:${deployment.fromBlock}`,
    sender: account.address, raw, hash: keccak256(raw) });
  if (rust) {
    testSql(dataDir, `INSERT INTO kv(key,value) VALUES('journal',${sqlString(journal)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  } else writeFileSync(resolve(dataDir, 'transaction.json'), journal);
  const restarted = await createRuntime(config);
  if (rust) restarted.resume = async () => JSON.parse(await rustProcess(['--resume-only']).completed);
  await restarted.resume();
  assert.equal(await runtime.read('operationsCredit'), 0n);
  assert.equal((await client.getTransactionReceipt({ hash: keccak256(raw) })).status, 'success');
  assert.equal(await client.getTransactionCount({ address: account.address }), nonceBeforeRecovery + 1);
  await restarted.resume();
  assert.equal(await client.getTransactionCount({ address: account.address }), nonceBeforeRecovery + 1);
  if (!rust) assert.equal(JSON.parse(readFileSync(resolve(dataDir, 'transaction.json'))), null);

  // Supply can also change when a holder burns directly, outside the keeper's accounting.
  await write('burn', [123n * 10n ** 18n], 0n, token, artifact('ArcLaunch', 'ArcToken').abi);
  app = rust ? await rustServer() : await startServer(config, { schedule: process.argv.includes('--serve') });
  await app.runtime.index();
  if (rust) {
    await assert.rejects(rustOnce(), /Another keeper owns this data directory/);
    await app.close();
    // Upgrade an existing price-only checkpoint, without touching the keeper journal or settings.
    const oldIndex = JSON.parse(testRows(dataDir, "SELECT value FROM kv WHERE key='index'")[0].value);
    oldIndex.version = 1;
    for (const point of oldIndex.prices) delete point.nativeAmount;
    testSql(dataDir, `UPDATE kv SET value=${sqlString(stringify(oldIndex))} WHERE key='index'`);
    const settings = testRows(dataDir, 'SELECT token,paused FROM keeper_tokens ORDER BY token');
    const journal = testRows(dataDir, "SELECT value FROM kv WHERE key='journal'")[0];
    app = await rustServer();
    await app.runtime.index();
    assert.deepEqual(testRows(dataDir, 'SELECT token,paused FROM keeper_tokens ORDER BY token'), settings);
    assert.deepEqual(testRows(dataDir, "SELECT value FROM kv WHERE key='journal'")[0], journal);
    assert.equal(JSON.parse(testRows(dataDir, "SELECT value FROM kv WHERE key='index'")[0].value).version, 6);
    assert.equal((await runtime.tokenState(token)).cycles, 2n, 'restart preserves the burn interval and checkpoint');
  }
  let base = `http://127.0.0.1:${app.server.address().port}`;
  const snapshot = await (await fetch(`${base}/api/arc/snapshot`)).json();
  assert.equal(snapshot.chainId, 5042002);
  assert.equal(snapshot.tokens.length, 2);
  assert(snapshot.records.some(record => record.token.toLowerCase() === token.toLowerCase()));
  if (rust) {
    assert(snapshot.holderHistory.length > 0, 'backfill actual holder and supply history');
    assert(snapshot.holderExcludedAddresses.some(address => address.toLowerCase() === pool.toLowerCase()));
    for (const item of snapshot.tokens) {
      const history = snapshot.holderHistory.filter(point => point.token.toLowerCase() === item.token.toLowerCase());
      assert.equal(history.at(-1).totalSupply, item.totalSupply, 'transfer-derived supply matches the contract');
      assert.equal(history.at(-1).holders, item.holders);
      const balance = await client.readContract({ address: item.token, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
      assert.equal(item.holders, balance > 0n ? 1 : 0, 'single trader counts once; system funds do not count');
    }
    const rewards = await (await fetch(`${base}/api/arc/rewards/payouts`)).json();
    assert.equal(rewards.status, 'not_configured');
    assert.deepEqual(rewards.items, []);
    assert.equal(rewards.hasReceived, null, 'unconfigured rewards must not claim an address is unpaid');
    for (const query of ['limit=0', 'limit=101', 'before=-1', 'before=0', 'recipient=invalid']) {
      assert.equal((await fetch(`${base}/api/arc/rewards/payouts?${query}`)).status, 400);
    }
    assert.equal(snapshot.tokens.find(item => item.token.toLowerCase() === token.toLowerCase()).totalSupply,
      String(await client.readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' })));
    const poolEvents = await client.getContractEvents({ address: pool, abi: artifact('PoolManager').abi, fromBlock: BigInt(deployment.fromBlock), strict: true });
    const priceEvents = poolEvents.filter(event => event.eventName === 'Initialize' || event.eventName === 'Swap');
    assert.equal(snapshot.prices.length, priceEvents.length, 'index every pool initialization and swap');
    for (const event of priceEvents) {
      const point = snapshot.prices.find(point => point.transactionHash === event.transactionHash && point.logIndex === String(event.logIndex));
      assert(point, 'price observation must retain its real transaction');
      assert.equal(point.sqrtPriceX96, String(event.args.sqrtPriceX96));
      const amount = event.eventName === 'Swap' ? event.args.amount0 : 0n;
      assert.equal(point.nativeAmount, String(amount < 0n ? -amount : amount), 'volume is the absolute native USDC delta, including sells');
    }
    for (const burn of snapshot.records) {
      assert(snapshot.prices.some(point => point.token.toLowerCase() === burn.token.toLowerCase() && point.transactionHash === burn.transactionHash));
      const price = snapshot.prices.filter(point => point.token === burn.token && BigInt(point.blockNumber) <= BigInt(burn.blockNumber)).at(-1);
      const state = snapshot.holderHistory.filter(point => point.token === burn.token && BigInt(point.blockNumber) <= BigInt(burn.blockNumber)).at(-1);
      assert.equal(burn.supplyAtBurn, state.totalSupply);
      assert.equal(burn.marketCapUsdcRaw, String((BigInt(state.totalSupply) << 192n) / BigInt(price.sqrtPriceX96) ** 2n), 'persist actual burn-block market cap');
    }
    assert(Number.isFinite(Date.parse(snapshot.worker.nextCheckAt)));
  }
  const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? `[${value.map(canonical)}]`
    : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
  const { signature, ...signed } = await (await fetch(`${base}/api/v2/chain-config`)).json();
  assert(await verifyMessage({ address: account.address, message: canonical(signed), signature }));
  const challenge = await (await fetch(`${base}/api/auth/nonce?address=${account.address}&chainId=5042002`)).json();
  const loginBody = { chainId: 5042002, message: challenge.message, signature: await account.signMessage({ message: challenge.message }) };
  const login = () => fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stringify(loginBody) });
  const loginResponse = await login();
  assert.equal(loginResponse.status, 200);
  const session = await loginResponse.json();
  assert.equal((await login()).status, 400, 'SIWE replay must fail');
  let mediaPath;
  if (rust) {
    const bytes = readFileSync('SingleSparkFront/front/static/assets/brands/singlespark.png');
    const postImage = (body, type = 'image/png', authorization = `Bearer ${session.token}`) => fetch(`${base}/api/arc/media`, {
      method: 'POST', headers: { 'Content-Type': type, Authorization: authorization }, body,
    });
    assert.equal((await postImage(bytes, 'image/png', 'Bearer invalid')).status, 401);
    assert.equal((await postImage(bytes, 'image/jpeg')).status, 415, 'declared type must match bytes');
    assert.equal((await postImage(Buffer.from('<svg/>'), 'image/png')).status, 415);
    assert.equal((await postImage(Buffer.alloc(5 * 1024 * 1024 + 1))).status, 413);
    const uploaded = await postImage(bytes);
    assert.equal(uploaded.status, 201);
    const { publicUrl } = await uploaded.json();
    assert(publicUrl.startsWith(rustEnv.ARC_MEDIA_PUBLIC_BASE + '/'));
    mediaPath = new URL(publicUrl).pathname;
    const image = await fetch(base + mediaPath);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
    assert.equal((await fetch(`${base}/api/arc/media/not-a-hash.png`)).status, 404);
    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${session.token}` } });
    assert.equal((await postImage(bytes)).status, 401, 'logout revokes image upload access');
  }
  assert.equal((await fetch(`${base}/api/arc/snapshot`, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  if (rust && !process.argv.includes('--serve')) {
    assert.equal((await fetch(`${base}/api/arc/keeper/tokens`)).status, 503, 'admin is disabled without its own key');
    await app.close(); app = null;
    rustEnv.ARC_KEEPER_ADMIN_TOKEN = 'b'.repeat(64); // Local test credential, independent of SIWE.
    rustEnv.ARC_KEEPER_BATCH_SIZE = '1';
    const start = async () => {
      app = await rustServer();
      base = `http://127.0.0.1:${app.server.address().port}`;
      await app.runtime.index();
      assert.equal((await fetch(base + mediaPath)).status, 200, 'uploaded images survive backend restart');
    };
    const admin = (path, body) => fetch(`${base}/api/arc/keeper/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${rustEnv.ARC_KEEPER_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const pause = async (address, paused) => assert.equal((await admin(`tokens/${address}`, { paused })).status, 200);
    const waitFor = async predicate => {
      for (let i = 0; i < 45; i++) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      assert.fail('keeper management check timed out');
    };
    const worker = async () => (await (await fetch(`${base}/api/arc/snapshot`)).json()).worker;
    await start();
    assert.equal((await fetch(`${base}/api/arc/keeper/tokens`)).status, 401);
    assert.equal((await fetch(`${base}/api/arc/keeper/run`, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const page = await (await admin('tokens?offset=0&limit=1')).json();
    assert.equal(page.total, 2); assert.equal(page.items.length, 1); assert.equal(page.nextOffset, 1);
    assert.equal(page.batchSize, 1);
    assert.notEqual((await (await admin('tokens?offset=1&limit=1')).json()).items[0].token, page.items[0].token);
    for (const query of ['limit=0', 'limit=101', 'offset=-1', 'offset=18446744073709551615']) {
      assert.equal((await admin(`tokens?${query}`)).status, 400);
    }
    assert.equal((await admin(`tokens/${zeroAddress}`, { paused: true })).status, 404);
    assert.equal((await admin('tokens/invalid', { paused: true })).status, 400);
    assert.equal((await admin(`tokens/${token}`, { paused: 'true' })).status, 400);
    assert.equal((await admin(`tokens/${token}`, { paused: true, arbitrary: true })).status, 400);
    await pause(deployment.platformToken, true);
    await pause(token, true);
    await app.close(); app = null;
    await write('fundFees', [deployment.platformToken], 10n * 10n ** 18n);
    await write('fundFees', [token], 10n * 10n ** 18n);
    await client.request({ method: 'evm_increaseTime', params: [180] });
    await client.request({ method: 'evm_mine', params: [] });
    const pausedNonce = await client.getTransactionCount({ address: account.address });
    const jetCycles = (await runtime.tokenState(deployment.platformToken)).cycles;
    const projectCycles = (await runtime.tokenState(token)).cycles;
    await start();
    await waitFor(async () => (await worker()).remainingInRound === 0);
    const pausedPage = await (await admin('tokens')).json();
    assert(pausedPage.items.every(item => item.management.paused && item.management.lastResult === 'paused'),
      'pause survives restart and batches continue to later tokens');
    assert.equal(await client.getTransactionCount({ address: account.address }), pausedNonce, 'paused tokens send no transactions');
    await pause(deployment.platformToken, false);
    const previousRound = (await worker()).lastCycleAt;
    assert.equal((await admin('run', {})).status, 202);
    assert.equal((await admin('run', {})).status, 202);
    await waitFor(async () => { const state = await worker(); return state.lastCycleAt !== previousRound && state.remainingInRound === 0; });
    assert.equal((await runtime.tokenState(deployment.platformToken)).cycles, jetCycles + 1n);
    assert.equal((await runtime.tokenState(token)).cycles, projectCycles, 'one token can stay paused while another burns');
    const created = await write('launch', ['Managed Project', 'AUTO', '']);
    const newToken = parseEventLogs({ abi: arcAbi, eventName: 'Launched', logs: created.logs })[0].args.token;
    await waitFor(async () => (await (await admin('tokens')).json()).total === 3);
    const enrolled = (await (await admin('tokens')).json()).items.find(item => item.token.toLowerCase() === newToken.toLowerCase());
    assert.equal(enrolled.management.paused, false, 'new factory tokens enroll automatically');
    await pause(token, false);
    await app.close(); app = null;

    // An unreadable/failing first token must not gate another token's collection and burn.
    const collectJet = encodeFunctionData({ abi: arcAbi, functionName: 'collectFees', args: [deployment.platformToken] }).toLowerCase();
    let rejectJet = true;
    let hideReceipts = false;
    const proxy = createHttpServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks));
        const forward = async rpc => {
          const tx = rpc.params?.[0];
          const data = (tx?.input ?? tx?.data ?? '').toLowerCase();
          if (hideReceipts && rpc.method === 'eth_getTransactionReceipt') {
            return { jsonrpc: '2.0', id: rpc.id, result: null };
          }
          if (rejectJet && rpc.method === 'eth_call' && (data === collectJet ||
              (tx?.to?.toLowerCase() === deployment.platformToken.toLowerCase() && data === '0x18160ddd'))) {
            return { jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'injected token failure' } };
          }
          return (await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rpc) })).json();
        };
        const output = Array.isArray(input) ? await Promise.all(input.map(forward)) : await forward(input);
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(output));
      } catch { response.writeHead(502); response.end(); }
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    rustEnv.ARC_RPC_URL = `http://127.0.0.1:${proxy.address().port}`;
    rustEnv.ARC_KEEPER_BATCH_SIZE = '20';
    try {
      await write('fundFees', [deployment.platformToken], 10n * 10n ** 18n);
      await client.request({ method: 'evm_increaseTime', params: [180] });
      await client.request({ method: 'evm_mine', params: [] });
      const failed = await rustOnce();
      assert.match(failed.keeperErrors, /injected token failure/);
      assert(failed.tokenErrors.some(item => item.token.toLowerCase() === deployment.platformToken.toLowerCase()));
      assert.equal((await runtime.tokenState(token)).cycles, projectCycles + 1n, 'a failed token does not stop a later burn');
      rejectJet = false;
      hideReceipts = true;
      await write('fundFees', [token], 10n * 10n ** 18n);
      await client.request({ method: 'evm_increaseTime', params: [180] });
      await client.request({ method: 'evm_mine', params: [] });
      const beforePending = await client.getTransactionCount({ address: account.address });
      const pending = await rustOnce();
      assert.match(pending.keeperErrors, /not confirmed/);
      assert.equal(pending.remainingInRound, 2, 'unknown confirmation stops new sends before later tokens');
      assert.equal((await runtime.tokenState(token)).cycles, projectCycles + 1n);
      assert.equal(await client.getTransactionCount({ address: account.address }), beforePending + 1);
      assert(JSON.parse(testRows(dataDir, "SELECT value FROM kv WHERE key='journal'")[0].value)?.hash);
      hideReceipts = false;
      await rustProcess(['--resume-only']).completed;
      assert.equal(JSON.parse(testRows(dataDir, "SELECT value FROM kv WHERE key='journal'")[0].value), null);
      assert.equal(await client.getTransactionCount({ address: account.address }), beforePending + 1, 'receipt recovery does not create a replacement transaction');
    } finally {
      rustEnv.ARC_RPC_URL = rpcUrl;
      await new Promise(resolve => proxy.close(resolve));
    }
    rustEnv.ARC_MAX_GAS_PER_TX = '21000';
    const gasNonce = await client.getTransactionCount({ address: account.address });
    assert.match((await rustOnce()).keeperErrors, /exceeds ARC_MAX_GAS_PER_TX/);
    assert.equal(await client.getTransactionCount({ address: account.address }), gasNonce, 'gas ceiling rejects before signing or broadcasting');
    rustEnv.ARC_MAX_GAS_PER_TX = '1500000';
    await rustOnce();

    // A successful burn just happened: even fresh pool fees must wait before a collection transaction.
    await write('trade', [token, true, 100n * 10n ** 18n, 1n, (await client.getBlock()).timestamp + 120n], 100n * 10n ** 18n);
    testSql(dataDir, `UPDATE keeper_tokens SET paused=true WHERE token<>${sqlString(token.toLowerCase())}`);
    if (await runtime.read('operationsCredit') > 0n) await write('claimOperations', []);
    const cooldownNonce = await client.getTransactionCount({ address: account.address });
    await rustOnce();
    assert.equal(await client.getTransactionCount({ address: account.address }), cooldownNonce, 'cooldown is checked before collecting fresh fees');
    console.log('Keeper management passed: auth, pagination, auto-enrollment, persistent pause, bounded continuation, failure isolation, pending receipt recovery, gas ceiling and pre-collection cooldown.');
  }
  console.log(`ARC ${rust ? 'Rust' : 'Node'} smoke passed: real V4 launch/buy/sell, 90/7/3 fees, 180s burns, totalSupply reduction, journal recovery, signed API and SIWE. ${snapshot.records.length} burns.`);
  if (process.argv.includes('--serve')) {
    writeFileSync(resolve(dataDir, 'deployment.json'), stringify(deployment));
    console.log(`LOCAL ONLY: API ${base}; RPC ${rpcUrl}; signer arc-local=${account.address}; token ${token}; data ${dataDir}`);
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  }
} finally {
  if (app) await app.close();
  anvil.kill('SIGTERM');
}
