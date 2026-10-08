import { testDatabase, localApiLimits, localRpcLimits } from './test-database.mjs';
// Local Anvil only: real V2 contracts, synthetic tokens, and delayed RPC reads.
// cargo build --locked --manifest-path SingleSparkBackend/api/Cargo.toml
// node SingleSparkContract/arc/check-performance.mjs [--baseline=/path/to/previous/backend] [--ui]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, zeroAddress, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deployArc, artifact } from './deploy.mjs';
import { arcAbi } from '../../SingleSparkFront/front/web3/arcAbi.ts';

const reserve = createServer();
await new Promise(done => reserve.listen(0, '127.0.0.1', done));
const rpcPort = reserve.address().port;
await new Promise(done => reserve.close(done));
const rpc = `http://127.0.0.1:${rpcPort}`;
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(rpcPort), '--chain-id', '5042002', '--silent'], { stdio: 'ignore' });
const directory = mkdtempSync(resolve(tmpdir(), 'arc-performance-'));
const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Public Anvil key.
const account = privateKeyToAccount(key);
const community = privateKeyToAccount(`0x${'2'.padStart(64, '0')}`).address;
const operations = privateKeyToAccount(`0x${'3'.padStart(64, '0')}`).address;
const chain = defineChain({ id: 5042002, name: 'Arc Local', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const client = createPublicClient({ chain, transport: http(rpc, { retryCount: 0 }) });
const wallet = createWalletClient({ account, chain, transport: http(rpc) });
let active = 0, peak = 0, start = 0, end = 0;
let api, vite, browser;
const tokensSelector = toFunctionSelector('tokens(address)');
const snapshotSelectors = [tokensSelector, toFunctionSelector('totalSupply()'), toFunctionSelector('communityCredit(address)')];
const proxy = createServer(async (request, response) => {
  try {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const call = JSON.parse(body);
    const isSnapshot = call.method === 'eth_getBalance' || (call.method === 'eth_call' && snapshotSelectors.includes((call.params[0].data ?? call.params[0].input).slice(0, 10)));
    if (isSnapshot) { if (!start) start = performance.now(); peak = Math.max(peak, ++active); await new Promise(done => setTimeout(done, 40)); }
    const upstream = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const result = await upstream.text();
    if (isSnapshot) { active--; end = performance.now(); }
    response.writeHead(upstream.status, { 'Content-Type': 'application/json' }); response.end(result);
  } catch (error) { response.writeHead(502); response.end(String(error)); }
});
try {
  for (let i = 0; ; i++) {
    try { await client.getChainId(); break; } catch (error) { if (i === 30) throw error; await new Promise(done => setTimeout(done, 100)); }
  }
  const deploy = async (name, args) => {
    const contract = artifact(name);
    const hash = await wallet.deployContract({ abi: contract.abi, bytecode: contract.bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, 'success'); return receipt.contractAddress;
  };
  const pool = await deploy('PoolManager', [account.address]);
  const manager = await deploy('PositionManager', [pool, zeroAddress, 100000, zeroAddress, zeroAddress]);
  const deployment = await deployArc(client, wallet, { positionManager: manager, keeper: account.address, operations, community,
    platformName: 'Performance Fixture', platformSymbol: 'PERF', journalPath: resolve(directory, 'deployment.json') });
  for (let i = 1; i < 8; i++) {
    const hash = await wallet.writeContract({ address: deployment.launch, abi: arcAbi, functionName: 'launch', args: [`Test ${i}`, `T${i}`, '', 0, 0, community] });
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success');
  }
  await new Promise(done => proxy.listen(0, '127.0.0.1', done));
  const publicRpc = `http://127.0.0.1:${proxy.address().port}`;
  const env = { ...process.env, ...testDatabase(directory), ...localApiLimits, ...localRpcLimits, ARC_CHAIN_ID: '5042002', ARC_RPC_URL: publicRpc, ARC_PUBLIC_RPC_URL: publicRpc,
    ARC_EXPLORER_URL: 'https://testnet.arcscan.app', ARC_WEB_ORIGIN: 'http://127.0.0.1:5176', ARC_HOST: '127.0.0.1', ARC_PORT: '0',
    ARC_DATA_DIR: directory, ARC_LAUNCH_ADDRESS: deployment.launch, ARC_QUOTER_ADDRESS: deployment.quoter, ARC_FROM_BLOCK: deployment.fromBlock,
    ARC_KEEPER_PRIVATE_KEY: '', ARC_CONFIG_SIGNING_KEY: key, ARC_CONFIG_KEY_ID: 'performance-local', ARC_GAS_RESERVE_USDC: '1',
    ARC_REWARDS_ADDRESS: '', ARC_REWARDS_FROM_BLOCK: '', ARC_KEEPER_ADMIN_TOKEN: '', ARC_MEDIA_PUBLIC_BASE: '', ARC_TREASURY_ENCRYPTION_KEY: '' };
  const run = async binary => {
    start = end = active = peak = 0;
    const child = spawn(binary, ['--resume-only'], { env });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 45_000);
    try {
      await new Promise((done, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? done() : reject(Error(errors || `backend exited ${code}`))); });
    } finally { clearTimeout(timer); }
    const snapshot = JSON.parse(output);
    assert.equal(snapshot.tokens.length, 8); assert.deepEqual(snapshot.tokenErrors, []);
    assert.equal(snapshot.tokens[0].token.toLowerCase(), deployment.platformToken.toLowerCase());
    for (const token of snapshot.tokens) { assert.equal(token.totalSupply, '1000000000000000000000000000'); assert.equal(token.holders, 0); assert.equal(token.communityPending, '0'); }
    return { snapshot, milliseconds: Math.round(end - start), peak };
  };
  const binary = resolve('SingleSparkBackend/api/target/debug/jet-arc-backend');
  await run(binary); // Warm checkpoint: both measured runs read the same already indexed history.
  const baseline = process.argv.find(value => value.startsWith('--baseline='))?.slice('--baseline='.length);
  const before = baseline ? await run(resolve(baseline)) : undefined;
  const after = await run(binary);
  assert(after.peak >= 4 && after.peak <= 8, `expected bounded concurrent RPC reads, got ${after.peak}`);
  if (before) {
    const stable = snapshot => snapshot.tokens.map(({ stateUpdatedAt, ...token }) => token);
    assert.deepEqual(stable(after.snapshot), stable(before.snapshot));
    // Since 2026-09-21 no snapshot carries `holderHistory` (it is served by GET /api/arc/holders,
    // which --resume-only does not start), so the series itself cannot be compared here; each
    // token's indexed `holders` count is still compared by the line above. A baseline binary from
    // before that change still emits the field; comparing it against its absence would only
    // measure the change of contract, not the parallel reads.
    assert(after.milliseconds < before.milliseconds * 0.65, 'parallel snapshot reads should beat the sequential baseline');
  }
  console.log(JSON.stringify({ syntheticTokens: 8, rpcDelayMs: 40, before: before && { ms: before.milliseconds, peak: before.peak }, after: { ms: after.milliseconds, peak: after.peak }, stateAndSupplyVerified: true }, null, 2));
  if (process.argv.includes('--ui')) {
    const { chromium, expect } = await import('@playwright/test');
    const site = 'http://127.0.0.1:5182';
    api = spawn(binary, [], { env: { ...env, ARC_WEB_ORIGIN: site } });
    let output = ''; api.stdout.on('data', data => { output += data; });
    for (let i = 0; !output.includes('listening on'); i++) {
      assert(i < 100 && api.exitCode === null, 'API must start'); await new Promise(done => setTimeout(done, 100));
    }
    const base = `http://${output.match(/listening on (127\.0\.0\.1:\d+)/)[1]}`;
    vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'arc', '--host', '127.0.0.1', '--port', '5182', '--strictPort'], {
      env: { ...process.env, VITE_API_BASE: base, VITE_ARC_LAUNCH_ENABLED: 'true', VITE_ARC_CHAIN_ID: '5042002',
        VITE_CHAIN_CONFIG_SIGNERS: JSON.stringify({ 'performance-local': account.address }) }, stdio: 'ignore',
    });
    for (let i = 0; ; i++) {
      try { if ((await fetch(site)).ok && (await fetch(`${base}/ready`)).ok) break; } catch { /* Wait for local servers. */ }
      assert(i < 100 && vite.exitCode === null, 'UI must start'); await new Promise(done => setTimeout(done, 100));
    }
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    console.log('Browser ready; checking local wallet and trades.');
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [], methods = [];
    let configs = 0, snapshots = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().endsWith('/api/v2/chain-config')) configs++; if (request.url().endsWith('/api/arc/snapshot')) snapshots++; });
    await page.exposeFunction('localWalletRequest', async ({ method, params }) => {
      methods.push(method);
      if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [account.address];
      if (method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }];
      if (method === 'personal_sign') return account.signMessage({ message: params[0] });
      return client.request({ method, params });
    });
    await page.addInitScript(() => {
      localStorage.setItem('singlespark-intro-v1-seen', '1');
      window.ethereum = { isMetaMask: true, request: args => window.localWalletRequest(args), on() {}, removeListener() {} };
    });
    const token = after.snapshot.tokens[1].token;
    await page.goto(`${site}/token/${token}`);
    console.log('Token page loaded.');
    const form = page.getByRole('form', { name: 'Trade token' });
    await form.getByRole('button', { name: 'Connect wallet', exact: true }).click();
    await page.locator('.wallet-connect-primary').click();
    await page.locator('.wallet-picker__option').filter({ has: page.getByText('MetaMask', { exact: true }) }).click();
    await expect(form.getByRole('button', { name: 'Confirm buy', exact: true })).toBeEnabled();
    console.log('Wallet authenticated.');
    assert.equal(configs, 1, 'market and wallet actions reuse the verified config');
    await form.getByRole('textbox').fill('1');
    const buyStart = performance.now();
    await form.getByRole('button', { name: 'Confirm buy', exact: true }).click();
    await expect(form.getByText('Transaction confirmed.', { exact: true })).toBeVisible({ timeout: 20_000 });
    const buyMs = Math.round(performance.now() - buyStart);
    console.log(`Buy confirmed in ${buyMs}ms.`);
    await form.getByRole('button', { name: 'Sell', exact: true }).click();
    await form.getByRole('textbox').fill('100');
    await form.getByRole('button', { name: 'Confirm sell', exact: true }).click();
    await expect(form.getByText('Transaction confirmed.', { exact: true })).toBeVisible({ timeout: 20_000 });
    assert.equal(methods.filter(method => method === 'eth_sendTransaction').length, 3, 'buy, exact approval and sell each submitted once');
    assert(!methods.includes('eth_call'), 'contract reads use the signed public RPC rather than the wallet');
    const signatures = methods.filter(method => method === 'personal_sign').length;
    await page.reload();
    await expect(form.getByRole('button', { name: 'Confirm buy', exact: true })).toBeEnabled();
    assert.equal(methods.filter(method => method === 'personal_sign').length, signatures, 'passive restoration does not sign in again');
    const beforeNavigation = snapshots;
    await page.locator('.arc-token-back').click();
    await page.getByRole('button', { name: 'Search tokens', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search tokens' }).fill('T1');
    await page.locator('.token-search-modal__result').filter({ hasText: 'Test 1' }).click();
    await expect(form.getByRole('button', { name: 'Confirm buy', exact: true })).toBeEnabled();
    assert.equal(snapshots, beforeNavigation, 'list, search and detail reuse the fresh snapshot');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { localStorage.setItem('jet-theme', theme); }, theme);
      await page.reload();
      for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        await expect(form.getByRole('button', { name: 'Confirm buy', exact: true })).toBeEnabled();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'trade UI must fit viewport');
        await page.screenshot({ path: resolve(directory, `trade-${theme}-${width}.png`), fullPage: true });
      }
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ui: 'passed', buyMs, snapshots, walletTransactions: 3, screenshots: directory }));
  }
} catch (error) { console.error(error); throw error;
} finally { await browser?.close(); vite?.kill('SIGTERM'); api?.kill('SIGTERM'); proxy.closeAllConnections(); proxy.close(); anvil.kill('SIGTERM'); }
