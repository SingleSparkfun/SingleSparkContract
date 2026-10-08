// A throwaway preview stack for the browser checks: node SingleSparkContract/arc/local-preview-stack.mjs [--run <script> ...]
//
// Starts Anvil, deploys the factory with a tiny minimum buyback, launches memes, trades them over a
// few hours of *chain* time and lets the real Rust keeper (`--once`) collect and burn, so the page has
// real candles, holders, trades and burn records to show. Then it starts the backend (no keeper key:
// nothing more is signed) and `vite --mode arc` on temporary ports.
//
// Everything here is SYNTHETIC: Anvil's public development keys trading on a chain that lives only as
// long as this process, the PostgreSQL *test* database and a schema dropped at the end. It never
// touches a public chain or the developer's own stack (8090/8091/8546/5176).
//
// Without --run it prints `READY {json}` and stays up until SIGINT/SIGTERM. With --run it runs each
// given script in turn with ARC_CHECK_API / ARC_CHECK_SITE / ARC_CHECK_FIXTURE set, then tears down;
// the exit code is non-zero if any script failed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, parseEther, parseEventLogs, erc20Abi, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deployArc, artifact } from './deploy.mjs';
import { testDatabase, testSql, localApiLimits, localRpcLimits } from './test-database.mjs';
import { arcAbi } from '../../SingleSparkFront/front/web3/arcAbi.ts';

const runIndex = process.argv.indexOf('--run');
const scripts = runIndex < 0 ? [] : process.argv.slice(runIndex + 1);
const freePort = async () => {
  const reserve = createServer();
  await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const { port } = reserve.address();
  await new Promise(r => reserve.close(r));
  assert(![8090, 8091, 8546, 5176].includes(port));
  return port;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Anvil's public development keys: never funds or authority anywhere else.
const key = index => `0x${['ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'][index]}`;
const deployer = privateKeyToAccount(key(0));
const keeper = privateKeyToAccount(key(1));
const trader = privateKeyToAccount(key(2));
const operations = privateKeyToAccount(key(3)).address;
const community = privateKeyToAccount(key(4)).address;

// Resolved before anything is spawned, so a missing test database cannot orphan Anvil.
const dir = mkdtempSync(resolve(tmpdir(), 'arc-preview-'));
const database = testDatabase(dir);
const [rpcPort, apiPort, sitePort] = [await freePort(), await freePort(), await freePort()];
const rpc = `http://127.0.0.1:${rpcPort}`, api = `http://127.0.0.1:${apiPort}`, site = `http://127.0.0.1:${sitePort}`;
// Chain time starts four hours ago and ends a minute ago, so the history is "recent" for the page.
const start = Math.floor(Date.now() / 1000) - 4 * 3600;
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(rpcPort), '--chain-id', '5042002',
  '--timestamp', String(start), '--silent'], { stdio: 'ignore' });
const chain = defineChain({ id: 5042002, name: 'Arc Local', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [rpc] } } });
const client = createPublicClient({ chain, transport: http(rpc, { retryCount: 0 }), cacheTime: 0 });
const walletOf = account => createWalletClient({ account, chain, transport: http(rpc) });
let backend, vite, schemaUsed = false, exitCode = 0;

// Sets the next block's time; never backwards (a slow keeper run may already have passed it).
const at = async seconds => {
  const latest = Number((await client.getBlock()).timestamp);
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [Math.max(seconds, latest + 1)] });
};
const send = async (account, address, abi, functionName, args, value = 0n) => {
  const hash = await walletOf(account).writeContract({ address, abi, functionName, args, value });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', functionName);
  return receipt;
};
const teardown = async () => {
  vite?.kill('SIGTERM');
  if (backend && backend.exitCode === null) {
    backend.kill('SIGTERM');
    for (let i = 0; i < 200 && backend.exitCode === null; i++) await sleep(50);
    if (backend.exitCode === null) backend.kill('SIGKILL');
  }
  anvil.kill('SIGTERM');
  if (schemaUsed) {
    try { testSql(dir, `DROP SCHEMA IF EXISTS "${database.ARC_DATABASE_SCHEMA}" CASCADE`); }
    catch (error) { console.error(`Could not drop the test schema: ${error.message}`); }
  }
};

try {
  for (let i = 0; ; i++) {
    try { await client.getChainId(); break; } catch (error) { if (i > 50) throw error; await sleep(100); }
  }
  const deployContract = async (name, args) => {
    const compiled = artifact(name);
    const hash = await walletOf(deployer).deployContract({ abi: compiled.abi, bytecode: compiled.bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    return receipt.contractAddress;
  };
  const pool = await deployContract('PoolManager', [deployer.address]);
  const positionManager = await deployContract('PositionManager', [pool, zeroAddress, 100000, zeroAddress, zeroAddress]);
  const deployment = await deployArc(client, walletOf(deployer), { positionManager, keeper: keeper.address, operations, community,
    platformName: 'SingleSpark', platformSymbol: 'SPARK', minBuyback: '0.001', journalPath: resolve(dir, 'deployment.json') });
  const memes = [];
  for (const [name, symbol, buyFee, sellFee] of [['Ember Cat', 'ECAT', 30000, 30000], ['Quiet Frog', 'QFROG', 0, 0]]) {
    await at(start + 30 + memes.length);
    const receipt = await send(deployer, deployment.launch, arcAbi, 'launch', [name, symbol, '', buyFee, sellFee, community]);
    memes.push({ name, symbol, token: parseEventLogs({ abi: arcAbi, eventName: 'Launched', logs: receipt.logs })[0].args.token });
  }
  const tokens = [{ name: 'SingleSpark', symbol: 'SPARK', token: deployment.platformToken }, ...memes];
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ARC_'))), ...database, ...localApiLimits, ...localRpcLimits,
    ARC_CHAIN_ID: '5042002', ARC_RPC_URL: rpc, ARC_PUBLIC_RPC_URL: rpc,
    ARC_EXPLORER_URL: 'https://testnet.arcscan.app', ARC_WEB_ORIGIN: site, ARC_HOST: '127.0.0.1', ARC_PORT: String(apiPort),
    ARC_DATA_DIR: dir, ARC_MEDIA_PUBLIC_BASE: `${api}/api/arc/media`, ARC_LAUNCH_ADDRESS: deployment.launch,
    ARC_QUOTER_ADDRESS: deployment.quoter, ARC_FROM_BLOCK: deployment.fromBlock, ARC_CONFIG_SIGNING_KEY: key(0),
    ARC_CONFIG_KEY_ID: 'arc-preview', ARC_TREASURY_ENCRYPTION_KEY: '0a'.repeat(32), ARC_GAS_RESERVE_USDC: '1',
    ARC_SLIPPAGE_BPS: '300', ARC_KEEPER_ADMIN_TOKEN: '', ARC_KEEPER_BATCH_SIZE: '20', ARC_MAX_GAS_PER_TX: '5000000',
    ARC_REWARDS_ADDRESS: '', ARC_REWARDS_FROM_BLOCK: '', ARC_SATISFACTION_ADDRESS: '', ARC_SATISFACTION_FROM_BLOCK: '' };
  const binary = resolve(process.env.ARC_BACKEND_BINARY || 'SingleSparkBackend/api/target/debug/jet-arc-backend');
  const keeperOnce = () => {
    schemaUsed = true;
    const run = spawnSync(binary, ['--once'], { env: { ...env, ARC_KEEPER_PRIVATE_KEY: key(1) }, encoding: 'utf8', timeout: 180_000 });
    return run.status === 0 ? JSON.parse(run.stdout) : { error: (run.stderr || '').trim().split('\n').at(-1) };
  };

  // Five rounds, forty minutes apart: trades, then ten quiet minutes (the keeper's price guard wants a
  // settled 10-minute history), then keeper cycles 180 s apart.
  // Mined at `when` (or just after the latest block); the deadline is measured from that time.
  const trade = async (token, buy, amount, when) => {
    if (!buy) await send(trader, token, erc20Abi, 'approve', [deployment.launch, amount]);
    await at(when);
    const mined = Math.max(when, Number((await client.getBlock()).timestamp) + 1);
    return send(trader, deployment.launch, arcAbi, 'trade', [token, buy, amount, 1n, BigInt(mined + 600)], buy ? amount : 0n);
  };
  const keeperResults = [];
  for (let round = 0; round < 5; round++) {
    const base = start + 120 + round * 2400;
    let t = base;
    for (const { token } of tokens) {
      for (const amount of ['40', '15', '25']) { await trade(token, true, parseEther(amount), t); t += 20; }
      const balance = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [trader.address] });
      await trade(token, false, balance / 5n, t); t += 20;
    }
    for (const offset of [720, 900, 1080]) {
      await at(t + offset); await client.request({ method: 'evm_mine', params: [] });
      const result = keeperOnce();
      keeperResults.push({ round, error: result.error ?? null });
    }
  }
  // The backend trusts `finalized` (Anvil: latest - 64); end the chain a minute before real time.
  await at(Math.floor(Date.now() / 1000) - 60);
  await client.request({ method: 'anvil_mine', params: ['0x41', '0x0'] });

  backend = spawn(binary, [], { env: { ...env, ARC_KEEPER_PRIVATE_KEY: '' } });
  schemaUsed = true;
  let out = '', errors = '';
  backend.stdout.on('data', b => (out += b)); backend.stderr.on('data', b => (errors += b));
  for (let i = 0; !/listening on 127\.0\.0\.1:\d+/.test(out); i++) {
    assert(i < 600 && backend.exitCode === null, `Backend must start: ${errors.slice(-600)}`);
    await sleep(100);
  }
  let snapshot;
  for (let i = 0; ; i++) {
    try { const r = await fetch(`${api}/api/arc/snapshot`); if (r.ok) { snapshot = await r.json(); if (snapshot.tokens?.length === tokens.length) break; } } catch { /* starting */ }
    assert(i < 600, 'Snapshot must list every launched token');
    await sleep(200);
  }
  const burns = Object.fromEntries(snapshot.tokens.map(t => [t.symbol, t.market?.burns ?? 0]));
  assert(burns.SPARK > 0 && burns.ECAT > 0, `The keeper must have burned on SPARK and ECAT: ${JSON.stringify({ burns, keeperResults })}`);

  vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'arc', '--host', '127.0.0.1', '--port', String(sitePort), '--strictPort'],
    { stdio: 'ignore', env: { ...process.env, VITE_BACKENDS: '', VITE_API_BASE: api, VITE_ARC_LAUNCH_ENABLED: 'true',
      VITE_ARC_CHAIN_ID: '5042002', VITE_CHAIN_CONFIG_SIGNERS: JSON.stringify({ 'arc-preview': deployer.address }) } });
  for (let i = 0; ; i++) {
    try { if ((await fetch(site)).ok) break; } catch { /* Vite is still booting. */ }
    assert(i < 600 && vite.exitCode === null, 'Vite must start on the temporary port');
    await sleep(100);
  }
  const fixture = { api, site, rpc, dir, launch: deployment.launch, platformToken: deployment.platformToken, tokens,
    burns, trades: Object.fromEntries(snapshot.tokens.map(t => [t.symbol, t.market?.trades ?? 0])), keeperResults,
    trader: trader.address, configSigner: deployer.address,
    note: 'Synthetic: Anvil development keys on a throwaway chain; not users, not a public deployment.' };
  writeFileSync(resolve(dir, 'fixture.json'), JSON.stringify(fixture, null, 2));
  console.log(`READY ${JSON.stringify(fixture)}`);
  if (!scripts.length) {
    await new Promise(done => { process.once('SIGINT', done); process.once('SIGTERM', done); });
  } else {
    for (const script of scripts) {
      console.log(`--- ${script}`);
      const run = spawnSync(process.execPath, [script], { stdio: 'inherit',
        env: { ...process.env, ARC_CHECK_API: api, ARC_CHECK_SITE: site, ARC_CHECK_FIXTURE: JSON.stringify(fixture) } });
      console.log(`--- ${script}: exit ${run.status}`);
      if (run.status !== 0) exitCode = 1;
    }
  }
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await teardown();
  process.exit(exitCode);
}
