// Keeper active–standby failover, end to end on a local chain:
//   node SingleSparkContract/arc/check-keeper-failover.mjs
//
// Several backend processes on ONE PostgreSQL schema, each with its own data directory and its own
// recording JSON-RPC proxy in front of a throwaway Anvil chain. The proxy writes down every
// eth_sendRawTransaction a process makes, so "no second signature at the same nonce" is checked
// against what was actually sent, not against what the backend says it did.
//
// Scenarios:
//   (0) a lock holder that is not a lease-aware backend (a plain psql session) and an expired
//       lease row: the first backend waits as a standby, reports it on /ready and /metrics, fires
//       `no_leader`, and leads the moment that session ends;
//   (1) leader + standby; a baseline keeper run on the leader;
//   (2) the leader is SIGKILLed after it signed and journalled a keeper transaction but before any
//       receipt (mining is paused): the standby takes over, rebroadcasts exactly those bytes, the
//       transaction confirms, the journal clears, and the new leader keeps buying back;
//   (3) the new leader is SIGSTOPped (hung, connection still open) with another signed transaction
//       in flight: a fresh standby waits out the lease, fences it off, takes over and recovers the
//       transaction; the hung leader is then resumed and must exit with EXIT_DEPOSED (75) without
//       sending a single raw transaction;
//   (4) across the whole run, every keeper nonce was sent with exactly one signed transaction.
//
// EVERY NUMBER HERE IS A LOCAL LOOPBACK NUMBER: one machine, one PostgreSQL, Anvil on 127.0.0.1.
// It does not show failover between real hosts, across a network partition or with a remote
// database. Nothing here reaches a public chain and no running service is touched; every port is
// asked for from the kernel, never 8090, 8091, 8546 or 5176.
//
// Build the backend first: cargo build --release --locked --manifest-path SingleSparkBackend/api/Cargo.toml
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseEther,
  parseEventLogs, parseTransaction, recoverTransactionAddress, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deployArc, artifact } from './deploy.mjs';
import { testDatabase, testSql, localApiLimits } from './test-database.mjs';
import { arcAbi } from '../../SingleSparkFront/front/web3/arcAbi.ts';

const ADMIN_TOKEN = 'b2'.repeat(32);
const EXIT_DEPOSED = 75;
/** The production defaults, on purpose: the takeover times below are the ones a deployment gets. */
const LEASE_SECONDS = 20;
const POLL_SECONDS = 2;

const freePort = async () => {
  const reserve = createTcpServer();
  await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const { port } = reserve.address();
  await new Promise(r => reserve.close(r));
  return port;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const round = (value, digits = 2) => Number(value.toFixed(digits));
const key = index => `0x${['ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'][index]}`;

const binary = ['release', 'debug'].map(profile => resolve(`SingleSparkBackend/api/target/${profile}/jet-arc-backend`))
  .find(existsSync);
assert.ok(binary, 'Build the backend first');

const rpcPort = await freePort();
const hookPort = await freePort();
const anvilUrl = `http://127.0.0.1:${rpcPort}`;
const anvil = spawn('anvil', ['--port', String(rpcPort), '--chain-id', '5042002', '--silent']);

const account = privateKeyToAccount(key(0));
const keeper = privateKeyToAccount(key(5));
const chain = defineChain({ id: 5042002, name: 'Arc Local',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [anvilUrl] } } });
const client = createPublicClient({ chain, transport: http(anvilUrl, { retryCount: 0 }), cacheTime: 0, pollingInterval: 50 });
const wallet = createWalletClient({ account, chain, transport: http(anvilUrl) });

// One schema for every process; each process has a data directory of its own (its file lock).
const shared = mkdtempSync(resolve(tmpdir(), 'arc-failover-'));
const database = testDatabase(shared);
const sql = text => testSql(shared, text);
const directories = [];
const newDirectory = () => { const dir = mkdtempSync(resolve(tmpdir(), 'arc-failover-node-')); directories.push(dir); return dir; };

const results = [];
const measured = {};
const processes = [];
const proxies = [];
let deployment, token, environment, receiver, ghost = null;

const scenario = async (id, title, body) => {
  const started = Date.now();
  try {
    const detail = (await body()) || {};
    results.push({ id, title, status: 'passed', seconds: round((Date.now() - started) / 1000, 1), ...detail });
    console.log(`PASS ${id} :: ${title} :: ${JSON.stringify(detail)}`);
  } catch (error) {
    results.push({ id, title, status: 'failed', seconds: round((Date.now() - started) / 1000, 1),
      expectedVsActual: error.message, stack: error.stack?.split('\n').slice(0, 8).join('\n') });
    console.error(`FAIL ${id} :: ${title} :: ${error.message}`);
    throw error;
  }
};

// ---- a recording JSON-RPC proxy per process ---------------------------------------------------
const sent = []; // { at, proxy, raw, hash, nonce, from }
const startProxy = async (name) => {
  const port = await freePort();
  const server = createHttpServer((request, response) => {
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        for (const call of Array.isArray(parsed) ? parsed : [parsed]) {
          if (call?.method === 'eth_sendRawTransaction') {
            const raw = call.params[0];
            sent.push({ at: Date.now(), proxy: name, raw, hash: keccak256(raw), nonce: Number(parseTransaction(raw).nonce),
              from: (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase() });
          }
        }
        const upstream = await fetch(anvilUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        response.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(await upstream.text());
      } catch (error) {
        response.writeHead(502).end(JSON.stringify({ error: error.message }));
      }
    });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const proxy = { name, port, server, url: `http://127.0.0.1:${port}` };
  proxies.push(proxy);
  return proxy;
};

// ---- a webhook receiver, for the no_leader alert ----------------------------------------------
const startReceiver = async () => {
  const deliveries = [];
  const server = createHttpServer((request, response) => {
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      try { deliveries.push({ at: Date.now(), body: JSON.parse(body) }); } catch { deliveries.push({ at: Date.now(), raw: body }); }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise(r => server.listen(hookPort, '127.0.0.1', r));
  return { server, deliveries };
};

// ---- backend processes ------------------------------------------------------------------------
const startBackend = async (name, { overrides = {} } = {}) => {
  const proxy = await startProxy(name);
  const port = await freePort();
  const child = spawn(binary, [], { env: { ...environment, ARC_PORT: String(port), ARC_DATA_DIR: newDirectory(),
    ARC_RPC_URLS: proxy.url, ARC_INSTANCE_NAME: name, ...overrides } });
  const handle = { name, child, port, proxy, base: `http://127.0.0.1:${port}`, out: '', errors: '', exit: null };
  child.stdout.on('data', b => (handle.out += b));
  child.stderr.on('data', b => (handle.errors += b));
  child.on('exit', (code, signal) => { handle.exit = { code, signal, at: Date.now() }; });
  processes.push(handle);
  await poll(async () => handle.exit ? { exited: handle.exit } : (/probes on 127\.0\.0\.1:\d+/.test(handle.out) ? {} : null),
    value => { if (value.exited) throw new Error(`${name} exited: ${handle.errors.slice(-900)}`); return true; },
    { ms: 30_000, label: `${name} to bind its port` });
  return handle;
};
const leading = handle => /API listening on 127\.0\.0\.1:\d+/.test(handle.out);
const fetchWithTimeout = async (url, options = {}, ms = 10_000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...options, signal: controller.signal }); } finally { clearTimeout(timer); }
};
const ready = async handle => (await fetchWithTimeout(`${handle.base}/ready`, {}, 3_000)).status;
const health = async handle => (await fetchWithTimeout(`${handle.base}/health`, {}, 3_000)).json();
const metric = async (handle, name, labels = {}) => {
  const text = await (await fetchWithTimeout(`${handle.base}/metrics`, {}, 3_000)).text();
  const want = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',');
  const line = text.split('\n').find(l => want ? l.startsWith(`${name}{${want}}`) : l.startsWith(`${name} `));
  return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(' ') + 1));
};
const snapshot = async handle => (await fetchWithTimeout(`${handle.base}/api/arc/snapshot`)).json();
const runKeeper = handle => fetchWithTimeout(`${handle.base}/api/arc/keeper/run`,
  { method: 'POST', headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } }, 5_000);
const poll = async (produce, predicate, { ms = 120_000, label = '', every = 200 } = {}) => {
  const until = Date.now() + ms;
  for (;;) {
    const last = await produce().catch(() => null);
    if (last && (await predicate(last))) return last;
    if (Date.now() > until) throw new Error(`Timed out ${label}; last: ${JSON.stringify(last)?.slice(0, 400)}`);
    await sleep(every);
  }
};
const stop = async handle => {
  if (!handle || handle.exit) return;
  try { handle.child.kill('SIGCONT'); } catch { /* not stopped */ }
  handle.child.kill('SIGTERM');
  for (let i = 0; i < 200 && !handle.exit; i++) await sleep(50);
  if (!handle.exit) handle.child.kill('SIGKILL');
};

// ---- the shared state, read straight from PostgreSQL ------------------------------------------
const journal = () => { const value = sql("SELECT value FROM kv WHERE key='journal'"); return value && value !== 'null' ? JSON.parse(value) : null; };
const lease = () => {
  const row = sql("SELECT holder||'|'||epoch||'|'||(expires_at>now()) FROM leader_lease WHERE id=1");
  if (!row) return null;
  const [holder, epoch, valid] = row.split('|');
  return { holder, epoch: Number(epoch), valid: valid === 'true' };
};

// ---- chain helpers ----------------------------------------------------------------------------
const blockTime = async () => Number((await client.getBlock()).timestamp);
const mining = async on => {
  await client.request({ method: 'evm_setAutomine', params: [on] });
  if (on) await client.request({ method: 'evm_mine', params: [] });
};
const buy = async amount => {
  const args = [token, true, parseEther(amount), 1n, BigInt(await blockTime()) + 600n];
  const { request } = await client.simulateContract({ account, address: deployment.launch, abi: arcAbi,
    functionName: 'trade', args, value: parseEther(amount) });
  const hash = await wallet.writeContract({ ...request, gas: 3_000_000n });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', 'trade reverted');
  return hash.toLowerCase();
};
const burns = async handle => (await snapshot(handle)).records?.length ?? 0;
/** Trades, then a keeper run on `handle`, and waits until the keeper has spent at least one more
 *  nonce and a new burn is indexed. */
const buyback = async (handle, label) => {
  const before = { nonce: await client.getTransactionCount({ address: keeper.address }), burns: await burns(handle) };
  await buy('0.5'); await buy('0.5');
  // Past the 180 s chain-time cooldown a previous buyback left on each swap path.
  await client.request({ method: 'evm_increaseTime', params: [200] });
  await client.request({ method: 'evm_mine', params: [] });
  await runKeeper(handle);
  const after = await poll(async () => ({ nonce: await client.getTransactionCount({ address: keeper.address }),
    burns: await burns(handle) }), value => value.nonce > before.nonce && value.burns > before.burns,
  { ms: 120_000, label: `${label}: a keeper transaction and a new burn` });
  return { keeperNonce: [before.nonce, after.nonce], burnRecords: [before.burns, after.burns] };
};
/** Pauses mining, asks `handle` for a keeper run, and waits until a signed transaction is in the
 *  journal. Returns it, with its nonce. */
const signedButUnmined = async (handle, label) => {
  const trades = [await buy('0.5'), await buy('0.5')];
  await poll(() => snapshot(handle), value => trades.every(hash => (value.trades ?? []).some(trade =>
    trade.transactionHash?.toLowerCase() === hash)), { label: 'both new trades indexed' });
  // Each swap path cools down for 180 s of chain time after a buyback; step past it.
  await client.request({ method: 'evm_increaseTime', params: [200] });
  await client.request({ method: 'evm_mine', params: [] });
  // A cycle still finishing from before may have journalled a transaction that is already mined;
  // only a journal whose transaction has no receipt is "signed but not confirmed".
  await poll(async () => ({ journal: journal() }), value => value.journal === null, { label: `${label}: a quiet journal` });
  await mining(false);
  let asked = 0;
  const unmined = async () => {
    const value = journal();
    // Keep asking: a run can land while the previous round is still finishing its batch.
    if (!value) { if (Date.now() - asked > 5_000) { asked = Date.now(); await runKeeper(handle); } return null; }
    const mined = await client.getTransactionReceipt({ hash: value.hash }).then(() => true, () => false);
    return mined ? null : value;
  };
  const entry = await poll(unmined, value => !!value, { ms: 90_000, label: `${label}: a journalled, unmined transaction` });
  return { ...entry, nonce: Number(parseTransaction(entry.raw).nonce) };
};

try {
  for (let i = 0; ; i++) {
    try { await client.getChainId(); break; } catch (error) { if (i > 80) throw error; await sleep(100); }
  }
  receiver = await startReceiver();
  const deployContract = async (name, args) => {
    const compiled = artifact(name);
    const hash = await wallet.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    return receipt.contractAddress;
  };

  await scenario('setup', 'Deploy a factory and one meme on a throwaway chain', async () => {
    const pool = await deployContract('PoolManager', [account.address]);
    const positionManager = await deployContract('PositionManager', [pool, zeroAddress, 100000, zeroAddress, zeroAddress]);
    deployment = await deployArc(client, wallet, { positionManager, keeper: keeper.address,
      operations: privateKeyToAccount(key(3)).address, community: privateKeyToAccount(key(4)).address,
      platformName: 'SingleSpark', platformSymbol: 'SPARK', minBuyback: '0.001', journalPath: resolve(shared, 'deployment.json') });
    await wallet.sendTransaction({ to: keeper.address, value: parseEther('50') });
    environment = { ...process.env, ...database, ...localApiLimits, ARC_CHAIN_ID: '5042002',
      ARC_PUBLIC_RPC_URL: anvilUrl, ARC_EXPLORER_URL: 'https://testnet.arcscan.app', ARC_WEB_ORIGIN: 'http://127.0.0.1:5176',
      ARC_HOST: '127.0.0.1', ARC_LAUNCH_ADDRESS: deployment.launch, ARC_QUOTER_ADDRESS: deployment.quoter,
      ARC_FROM_BLOCK: deployment.fromBlock, ARC_CONFIG_SIGNING_KEY: key(0),
      ARC_TREASURY_ENCRYPTION_KEY: '09'.repeat(32), ARC_CONFIG_KEY_ID: 'arc-local',
      ARC_GAS_RESERVE_USDC: '1', ARC_SLIPPAGE_BPS: '300', ARC_KEEPER_BATCH_SIZE: '20', ARC_MAX_GAS_PER_TX: '5000000',
      // Every process uses the same operator key: that is the point of a standby.
      ARC_KEEPER_PRIVATE_KEY: key(5), ARC_REWARDS_ADDRESS: '', ARC_REWARDS_FROM_BLOCK: '',
      ARC_SATISFACTION_ADDRESS: '', ARC_SATISFACTION_FROM_BLOCK: '', ARC_RPC_PROXY_PER_MINUTE: '1000000',
      ARC_KEEPER_ADMIN_TOKEN: ADMIN_TOKEN, ARC_KEEPER_ROLE: 'auto',
      ARC_LEADER_LEASE_SECONDS: String(LEASE_SECONDS), ARC_LEADER_POLL_SECONDS: String(POLL_SECONDS),
      ARC_ALERT_WEBHOOK_URL: `http://127.0.0.1:${hookPort}/hook`, ARC_ALERT_WEBHOOK_KIND: 'generic',
      // A test knob, like every ARC_ALERT_*_SECONDS: sixty seconds in production.
      ARC_ALERT_NO_LEADER_SECONDS: '5' };
    const receipt = await wallet.writeContract({ address: deployment.launch, abi: arcAbi, functionName: 'launch',
      args: ['Failover Ember Cat', 'FAILCAT', '', 30_000, 30_000, privateKeyToAccount(`0x${'d3'.repeat(32)}`).address] })
      .then(hash => client.waitForTransactionReceipt({ hash }));
    token = parseEventLogs({ abi: arcAbi, eventName: 'Launched', logs: receipt.logs })[0].args.token;
    await client.request({ method: 'evm_setNextBlockTimestamp', params: [(await blockTime()) + 10] });
    await client.request({ method: 'evm_mine', params: [] });
    // The keeper's price guard needs ten and a half minutes of pool history before it will buy
    // back: one trade, then chain time moves on past the window.
    await buy('0.5');
    await client.request({ method: 'evm_increaseTime', params: [700] });
    await client.request({ method: 'evm_mine', params: [] });
    return { launch: deployment.launch, token, schema: database.ARC_DATABASE_SCHEMA, binary: binary.replace(process.cwd() + '/', '') };
  });

  let first, second, third;

  await scenario('0-foreign-holder', 'A foreign lock holder keeps a standby waiting, visibly, until its session ends', async () => {
    const schema = database.ARC_DATABASE_SCHEMA;
    // An expired lease of a holder with no sessions, and the schema lock held by a plain psql
    // session: what an older binary, or a leader whose sessions cannot be ended, looks like.
    sql(`CREATE SCHEMA IF NOT EXISTS "${schema}"; CREATE TABLE IF NOT EXISTS "${schema}".leader_lease(id SMALLINT PRIMARY KEY CHECK(id=1),
      holder TEXT NOT NULL,epoch BIGINT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,acquired_at TIMESTAMPTZ NOT NULL,renewed_at TIMESTAMPTZ NOT NULL);
      INSERT INTO "${schema}".leader_lease VALUES(1,'ghost',7,now()-interval '1 second',now(),now())`);
    const url = new URL(database.ARC_DATABASE_URL);
    ghost = spawn('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1'], { env: { ...process.env, PGHOST: url.hostname,
      PGPORT: url.port || '5432', PGDATABASE: url.pathname.slice(1), PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password) } });
    ghost.stdin.write(`SELECT pg_advisory_lock(hashtextextended(current_database() || '.' || '${schema}',0));\n`);
    await sleep(1_000);
    first = await startBackend('A');
    await poll(async () => (await health(first)).role, role => role === 'standby', { label: 'A to report standby' });
    assert.equal(await ready(first), 503, 'a standby is never ready');
    assert.equal((await fetchWithTimeout(`${first.base}/api/arc/snapshot`)).status, 503, 'a standby serves no data');
    assert.equal(await metric(first, 'arc_leader_role', { role: 'standby' }), 1);
    assert.equal(await metric(first, 'arc_leader'), 0);
    const alert = await poll(async () => receiver.deliveries.find(d => d.body?.alert === 'no_leader' && d.body?.status === 'firing'),
      Boolean, { ms: 60_000, label: 'the no_leader alert' });
    const leaderless = await metric(first, 'arc_leader_leaderless_seconds');
    assert.ok(leaderless > 5, `leaderless seconds on /metrics: ${leaderless}`);
    const released = Date.now();
    ghost.stdin.end();
    await poll(async () => leading(first), Boolean, { ms: 60_000, label: 'A to lead once the foreign session ends' });
    const listening = Date.now() - released;
    await poll(() => ready(first), status => status === 200, { ms: 60_000, label: 'A ready' });
    measured.foreignHolderReleasedToLeading = round(listening / 1000);
    return { standbyWhileHeld: true, alert: alert.body.alert, alertSummary: alert.body.summary,
      leaderlessSecondsOnMetrics: leaderless, releasedToListeningSeconds: measured.foreignHolderReleasedToLeading,
      leaseAfter: lease() };
  });

  await scenario('1-leader-and-standby', 'A leads and buys back; B waits as a standby', async () => {
    second = await startBackend('B');
    await poll(async () => (await health(second)).role, role => role === 'standby', { label: 'B standby' });
    assert.equal(await ready(second), 503);
    assert.equal(await metric(first, 'arc_leader'), 1);
    const epoch = await metric(first, 'arc_leader_epoch');
    const baseline = await buyback(first, 'baseline on A');
    assert.ok(!sent.some(entry => entry.proxy === 'B'), 'a standby sends nothing');
    return { epoch, ...baseline };
  });

  await scenario('2-kill-after-signing', 'SIGKILL the leader after it signed, before any receipt: the standby recovers those exact bytes', async () => {
    const pending = await signedButUnmined(first, 'A');
    const sentByA = sent.filter(entry => entry.proxy === 'A' && entry.hash === pending.hash).length;
    const killedAt = Date.now();
    first.child.kill('SIGKILL');
    await poll(async () => leading(second), Boolean, { ms: 60_000, label: 'B to lead' });
    const leadAt = Date.now();
    await poll(() => ready(second), status => status === 200, { ms: 60_000, label: 'B ready' });
    const readyAt = Date.now();
    // B must rebroadcast the journalled bytes, and nothing else, while the block is still unmined.
    const rebroadcast = await poll(async () => sent.find(entry => entry.proxy === 'B' && entry.raw === pending.raw),
      Boolean, { ms: 60_000, label: 'B to rebroadcast the journalled bytes' });
    const atNonce = sent.filter(entry => entry.from === keeper.address.toLowerCase() && entry.nonce === pending.nonce);
    assert.deepEqual([...new Set(atNonce.map(entry => entry.hash))], [pending.hash], 'one signature at the pending nonce');
    await mining(true);
    const receipt = await client.waitForTransactionReceipt({ hash: pending.hash });
    assert.equal(receipt.status, 'success', 'the recovered transaction succeeded');
    await poll(async () => journal() === null, Boolean, { ms: 60_000, label: 'the journal to clear' });
    const continued = await buyback(second, 'after takeover on B');
    measured.processDeath = { killToLeadingSeconds: round((leadAt - killedAt) / 1000),
      killToReadySeconds: round((readyAt - killedAt) / 1000),
      killToRebroadcastSeconds: round((rebroadcast.at - killedAt) / 1000) };
    return { pendingNonce: pending.nonce, pendingHash: pending.hash, sentByAbeforeKill: sentByA,
      exitSignal: first.exit?.signal, ...measured.processDeath, leaseAfter: lease(),
      signaturesAtPendingNonce: atNonce.length, distinctHashesAtPendingNonce: 1, ...continued };
  });

  await scenario('3-hung-leader', 'SIGSTOP the leader with a transaction in flight: a new standby fences it off; on SIGCONT it exits 75 and sends nothing', async () => {
    third = await startBackend('C');
    await poll(async () => (await health(third)).role, role => role === 'standby', { label: 'C standby' });
    const pending = await signedButUnmined(second, 'B');
    const epochBefore = lease().epoch;
    const stoppedAt = Date.now();
    second.child.kill('SIGSTOP');
    await poll(async () => leading(third), Boolean, { ms: 120_000, label: 'C to lead', every: 250 });
    const leadAt = Date.now();
    await poll(() => ready(third), status => status === 200, { ms: 60_000, label: 'C ready' });
    const readyAt = Date.now();
    const rebroadcast = await poll(async () => sent.find(entry => entry.proxy === 'C' && entry.raw === pending.raw),
      Boolean, { ms: 60_000, label: 'C to rebroadcast B\'s journalled bytes' });
    // Wake the hung leader while the transaction is still unmined, and give it every chance to
    // send something: its keeper loop, its renewal and its indexer all resume at once.
    const resumedAt = Date.now();
    second.child.kill('SIGCONT');
    await poll(async () => second.exit, Boolean, { ms: 60_000, label: 'B to step down' });
    const sentByBAfterResume = sent.filter(entry => entry.proxy === 'B' && entry.at >= resumedAt);
    assert.equal(second.exit.code, EXIT_DEPOSED, `B exits with EXIT_DEPOSED: ${JSON.stringify(second.exit)} ${second.errors.slice(-600)}`);
    assert.deepEqual(sentByBAfterResume, [], 'a deposed leader sends nothing');
    assert.match(second.errors, /stepping down/);
    const atNonce = sent.filter(entry => entry.from === keeper.address.toLowerCase() && entry.nonce === pending.nonce);
    assert.deepEqual([...new Set(atNonce.map(entry => entry.hash))], [pending.hash], 'one signature at the pending nonce');
    await mining(true);
    const receipt = await client.waitForTransactionReceipt({ hash: pending.hash });
    assert.equal(receipt.status, 'success');
    await poll(async () => journal() === null, Boolean, { ms: 60_000, label: 'the journal to clear' });
    const continued = await buyback(third, 'after fencing on C');
    measured.hungLeader = { stopToLeadingSeconds: round((leadAt - stoppedAt) / 1000),
      stopToReadySeconds: round((readyAt - stoppedAt) / 1000),
      stopToRebroadcastSeconds: round((rebroadcast.at - stoppedAt) / 1000),
      resumeToExitSeconds: round((second.exit.at - resumedAt) / 1000), leaseSeconds: LEASE_SECONDS };
    return { pendingNonce: pending.nonce, epochBefore, epochAfter: lease().epoch, deposedExitCode: second.exit.code,
      rawTransactionsSentByDeposedLeaderAfterResume: sentByBAfterResume.length, ...measured.hungLeader, ...continued };
  });

  await scenario('4-one-signature-per-nonce', 'Every keeper nonce was sent with exactly one signed transaction', async () => {
    const byNonce = new Map();
    for (const entry of sent.filter(entry => entry.from === keeper.address.toLowerCase())) {
      byNonce.set(entry.nonce, new Set([...(byNonce.get(entry.nonce) ?? []), entry.hash]));
    }
    const doubled = [...byNonce].filter(([, hashes]) => hashes.size !== 1);
    assert.deepEqual(doubled, [], 'no nonce was signed twice');
    const final = await client.getTransactionCount({ address: keeper.address });
    // Every nonce the chain consumed was one this check saw sent.
    for (let nonce = 0; nonce < final; nonce++) assert.ok(byNonce.has(nonce), `nonce ${nonce} was sent through a recorded proxy`);
    return { keeperNonces: final, rawSends: sent.filter(entry => entry.from === keeper.address.toLowerCase()).length,
      byProcess: Object.fromEntries(['A', 'B', 'C'].map(name => [name, sent.filter(entry => entry.proxy === name).length])) };
  });
} finally {
  const passed = results.length > 0 && results.every(entry => entry.status === 'passed');
  const workers = {};
  if (!passed) {
    for (const handle of processes.filter(handle => !handle.exit)) {
      workers[handle.name] = await snapshot(handle).then(value => value.worker, error => error.message);
    }
  }
  const report = { status: passed && results.length === 6 ? 'passed' : 'failed', checkedAt: new Date().toISOString(),
    environment: 'Local throwaway Anvil chain (chain id 5042002), one local PostgreSQL test database and one schema '
      + 'shared by three backend processes on this machine, each behind its own recording JSON-RPC proxy on 127.0.0.1. '
      + 'Anvil public development keys; the schema is dropped at the end. NOT a public chain and NOT separate hosts.',
    settings: { leaseSeconds: LEASE_SECONDS, pollSeconds: POLL_SECONDS, noLeaderAlertSeconds: 5 },
    measured, scenarios: results,
    // Only on failure: what each process said. There is nothing secret in it (development keys,
    // loopback URLs), and it is what makes a failed run diagnosable.
    ...(passed && results.length === 6 ? {} : { logs: Object.fromEntries(processes.map(handle =>
      [handle.name, { exit: handle.exit, stderr: handle.errors.slice(-3000), worker: workers[handle.name] }])) }),
    notes: [
      'Every timing is a loopback number on one machine: process start-up, PostgreSQL and the chain are all local. '
        + 'A standby on another host adds its network round trips and, today, needs its PostgreSQL connection to look '
        + 'local (for example an SSH tunnel), because the backend refuses a non-loopback database without TLS.',
      'SIGSTOP stands in for a hung or sleeping host: the process keeps its TCP connections open and stops renewing. '
        + 'A real laptop sleep was not exercised.',
      'The keeper transactions are this check\'s own development key buying back a synthetic meme on a chain that '
        + 'exists for the length of this process. They are not users and not volume.',
      'The no_leader alert window was shortened with ARC_ALERT_NO_LEADER_SECONDS=5, a documented test knob.'],
  };
  const output = resolve('SingleSparkContract/arc/deployments/keeper-failover-local-acceptance-20260922.json');
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.status.toUpperCase()}: ${results.filter(r => r.status === 'passed').length}/${results.length} in ${output}`);
  if (report.status !== 'passed') process.exitCode = 1;
  for (const handle of processes) await stop(handle);
  if (ghost && ghost.exitCode === null) ghost.kill('SIGTERM');
  for (const proxy of proxies) await new Promise(r => proxy.server.close(r));
  if (receiver) await new Promise(r => receiver.server.close(r));
  anvil.kill('SIGTERM');
  try { sql(`DROP SCHEMA IF EXISTS "${database.ARC_DATABASE_SCHEMA}" CASCADE`); }
  catch (error) { console.error(`Could not drop the test schema: ${error.message}`); }
}
