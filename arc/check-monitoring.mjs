// Metrics, alerting and readiness, end to end on a local chain:
//   node SingleSparkContract/arc/check-monitoring.mjs
//
// A throwaway Anvil chain, Anvil's public development keys, the PostgreSQL *test* database and
// isolated schemas that are dropped again at the end. Nothing here reaches a public chain and no
// running service is touched: every port is asked for from the kernel, never 8090 or 5176.
//
// EVERY NUMBER BELOW IS A LOCAL LOOPBACK NUMBER. Anvil mines on a one-second timer over 127.0.0.1,
// the two "RPC endpoints" are Node processes on this machine and so is the webhook receiver, so
// every latency here is a lower bound on what a real deployment would see. Nothing here measures
// the ARC testnet and no public endpoint, chat service or webhook was contacted.
//
// Build the backend first: cargo build --locked --manifest-path SingleSparkBackend/api/Cargo.toml
//
// The alert `for` windows are driven by documented TEST KNOBS (ARC_ALERT_*_SECONDS, listed in
// SingleSparkContract/arc/.env.example) so a sixty-second window can be exercised in ten. The rules themselves are
// unchanged; only the clock they are compared against is shortened.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer, connect as tcpConnect } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, parseEther,
  parseEventLogs, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deployArc, artifact } from './deploy.mjs';
import { testDatabase, testSql, localApiLimits } from './test-database.mjs';
import { arcAbi } from '../../SingleSparkFront/front/web3/arcAbi.ts';

/** A fake credential in the RPC URLs and in the webhook URL. It must never appear in the backend's
 *  output, in /metrics, in the alert endpoint or in the snapshot. */
const SECRET = 'SECRET123';
/** The scrape credential the access scenario uses. Throwaway, for the life of this process. */
const METRICS_TOKEN = 'm'.repeat(40);
/** A throwaway management token, so the check can ask for a keeper cycle instead of waiting out
 *  the 180-second round timer. It exists only for the life of this process. */
const ADMIN_TOKEN = 'a1'.repeat(32);
/** The read flood in scenario (a): requests per second, for this long, while /metrics is scraped. */
const FLOOD_RPS = 200;
const FLOOD_MS = 20_000;
/** How long the process is frozen in scenario (e). */
const FREEZE_MS = 90_000;

/** The test knobs. Real deployments leave every one of these unset. */
const KNOBS = {
  // Every `for` window that is a minute in production becomes ten seconds here.
  ARC_ALERT_FOR_SECONDS: '10',
  ARC_ALERT_RESOLVE_SECONDS: '10',
  ARC_ALERT_INDEX_STALE_SECONDS: '20',
  ARC_ALERT_INDEX_CRITICAL_SECONDS: '150',
  ARC_ALERT_WS_DOWN_SECONDS: '10',
  ARC_ALERT_FAILOVER_SECONDS: '600',
  ARC_ALERT_NOT_CYCLING_SECONDS: '60',
  // Left long on purpose: a half-hour re-notify interval is what proves there is no storm.
  ARC_ALERT_RENOTIFY_SECONDS: '1800',
  // Readiness must flip inside a scenario rather than after five minutes.
  ARC_READY_INDEX_SECONDS: '30',
};

const freePort = async () => {
  const reserve = createTcpServer();
  await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const { port } = reserve.address();
  await new Promise(r => reserve.close(r));
  return port;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const round = (value, digits = 2) => Number(value.toFixed(digits));

const key = index => `0x${['ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'][index]}`;

const rpcPort = await freePort();
const apiPort = await freePort();
const hookPort = await freePort();
const proxyPorts = [await freePort(), await freePort()];
const socketPort = await freePort();
const anvilUrl = `http://127.0.0.1:${rpcPort}`;
const base = `http://127.0.0.1:${apiPort}`;
/** The URLs the backend is configured with, credential and all. None may ever be printed. */
const endpointUrls = proxyPorts.map(port => `http://127.0.0.1:${port}/?apikey=${SECRET}`);
const socketUrl = `ws://127.0.0.1:${socketPort}/?apikey=${SECRET}`;
const webhookUrl = `http://127.0.0.1:${hookPort}/hook?token=${SECRET}`;

const anvil = spawn('anvil', ['--port', String(rpcPort), '--chain-id', '5042002', '--silent',
  '--block-time', '1']);
let api, receiver, proxies = [], socketProxy = null, schemaCreated = false, pacer = null;
/** Extra data directories used by the short-lived second backend; each owns its own PG schema,
 *  because one schema may only ever have one backend, and all of them are dropped at the end. */
const extraDirs = [];

const account = privateKeyToAccount(key(0));
const keeper = privateKeyToAccount(key(5));
const operations = privateKeyToAccount(key(3)).address;
const platformCommunity = privateKeyToAccount(key(4)).address;

const chain = defineChain({ id: 5042002, name: 'Arc Local',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [anvilUrl] } } });
// The check talks to Anvil directly, so nothing it does is counted against the backend's RPC use.
const client = createPublicClient({ chain, transport: http(anvilUrl, { retryCount: 0 }),
  cacheTime: 0, pollingInterval: 50 });
const wallet = createWalletClient({ account, chain, transport: http(anvilUrl) });
const dir = mkdtempSync(resolve(tmpdir(), 'arc-monitoring-'));
const database = testDatabase(dir);

const results = [];
const notes = [];
let deployment, environment, token;

const scenario = async (id, title, body) => {
  const started = Date.now();
  try {
    const detail = (await body()) || {};
    results.push({ id, title, status: 'passed', seconds: round((Date.now() - started) / 1000, 1), ...detail });
    console.log(`PASS ${id} :: ${title} :: ${JSON.stringify(detail)}`);
    return true;
  } catch (error) {
    results.push({ id, title, status: 'failed', seconds: round((Date.now() - started) / 1000, 1),
      expectedVsActual: error.message, stack: error.stack?.split('\n').slice(0, 8).join('\n') });
    console.error(`FAIL ${id} :: ${title} :: ${error.message}`);
    return false;
  }
};

// ---- a strict reader for the exposition format ------------------------------------------------
/** Deliberately unforgiving: one HELP and one TYPE per family, a declared type for every sample,
 *  no repeated series, quoted and escaped label values, a numeric value on every line. A body that
 *  a real Prometheus would complain about fails here instead. */
const parseExposition = (text) => {
  const types = new Map(), helps = new Set(), seen = new Set(), samples = [];
  const lines = text.split('\n');
  assert.equal(lines[lines.length - 1], '', 'the body must end with a newline');
  for (const [index, line] of lines.slice(0, -1).entries()) {
    const where = `line ${index + 1}: ${line}`;
    assert.notEqual(line.trim(), '', `no blank lines (${where})`);
    if (line.startsWith('# TYPE ')) {
      const [name, kind, ...rest] = line.slice(7).split(' ');
      assert.equal(rest.length, 0, `a TYPE line is "# TYPE <name> <kind>" (${where})`);
      assert.ok(['gauge', 'counter', 'histogram', 'summary', 'untyped'].includes(kind), where);
      assert.ok(!types.has(name), `one TYPE per family (${where})`);
      types.set(name, kind);
      continue;
    }
    if (line.startsWith('# HELP ')) {
      const name = line.slice(7).split(' ')[0];
      assert.ok(!helps.has(name), `one HELP per family (${where})`);
      assert.ok(line.slice(7).length > name.length + 1, `HELP needs text (${where})`);
      helps.add(name);
      continue;
    }
    assert.ok(!line.startsWith('#'), `only HELP and TYPE comments (${where})`);
    const split = line.lastIndexOf(' ');
    assert.ok(split > 0, `a sample needs a value (${where})`);
    const series = line.slice(0, split), raw = line.slice(split + 1);
    assert.ok(/^-?(\d+(\.\d+)?([eE][-+]?\d+)?|[+-]?Inf|NaN)$/.test(raw), `a numeric value (${where})`);
    const open = series.indexOf('{');
    const name = open === -1 ? series : series.slice(0, open);
    assert.ok(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name), `a legal metric name (${where})`);
    const labels = {};
    if (open !== -1) {
      assert.ok(series.endsWith('}'), `labels must close (${where})`);
      for (const pair of series.slice(open + 1, -1).split(',')) {
        if (!pair) continue;
        const equals = pair.indexOf('=');
        assert.ok(equals > 0, `a label needs a value (${where})`);
        const label = pair.slice(0, equals), quoted = pair.slice(equals + 1);
        assert.ok(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label), `a legal label name (${where})`);
        assert.ok(quoted.startsWith('"') && quoted.endsWith('"'), `label values are quoted (${where})`);
        const value = quoted.slice(1, -1);
        assert.ok(!value.includes('\n'), `label values escape newlines (${where})`);
        assert.ok(!/(^|[^\\])"/.test(value), `label values escape quotes (${where})`);
        labels[label] = value.replaceAll('\\"', '"').replaceAll('\\n', '\n').replaceAll('\\\\', '\\');
      }
    }
    const family = types.has(name) ? name : name.replace(/_(bucket|count|sum)$/, '');
    assert.ok(types.has(family), `${name} has no TYPE line (${where})`);
    assert.ok(!seen.has(series), `a series appears once (${where})`);
    seen.add(series);
    samples.push({ name, labels, value: Number(raw), series });
  }
  assert.deepEqual([...helps].sort(), [...types.keys()].sort(), 'every family has HELP and TYPE');
  return {
    samples, types,
    value: (name, labels = {}) => samples.find(sample => sample.name === name
      && Object.entries(labels).every(([k, v]) => sample.labels[k] === v))?.value,
    // "Exported" means the family is declared: `arc_alert_firing` is present and correct with no
    // rows at all when nothing is firing.
    has: name => types.has(name),
    passes: () => samples.filter(sample => sample.name === 'arc_index_passes_total')
      .reduce((total, sample) => total + sample.value, 0),
    names: () => [...new Set(samples.map(sample => sample.name))],
  };
};

/** Every metric the operations package and SingleSparkContract/arc/README.md document. All of them must exist on a
 *  healthy backend on this platform; the two Linux-only ones are listed separately below. */
const DOCUMENTED = ['arc_build_info', 'arc_process_start_time_seconds', 'arc_uptime_seconds',
  'arc_index_head_block', 'arc_index_indexed_block', 'arc_index_lag_blocks', 'arc_index_age_seconds',
  'arc_index_last_pass_duration_seconds', 'arc_index_passes_total', 'arc_snapshot_bytes',
  'arc_snapshot_version', 'arc_tokens_total', 'arc_trades_in_memory', 'arc_price_points_in_memory',
  'arc_ws_configured', 'arc_ws_connected', 'arc_ws_endpoint_index', 'arc_ws_endpoints',
  'arc_ws_reconnects_total', 'arc_ws_last_head_age_seconds',
  'arc_rpc_active_endpoint', 'arc_rpc_endpoints_configured', 'arc_rpc_requests_total',
  'arc_rpc_failures_total', 'arc_rpc_rate_limited_total', 'arc_rpc_failovers_out_total',
  'arc_rpc_failovers_in_total', 'arc_rpc_breaker_opens_total', 'arc_rpc_breaker_state',
  'arc_rpc_endpoint_excluded', 'arc_rpc_effective_rps', 'arc_rpc_priority_requests_total',
  'arc_rpc_priority_queue_wait_ms_total', 'arc_rpc_priority_queue_timeouts_total',
  'arc_keeper_enabled', 'arc_keeper_paused', 'arc_keeper_cycles_total',
  'arc_keeper_consecutive_deferrals', 'arc_keeper_last_error', 'arc_keeper_error_cycles',
  'arc_keeper_pending_journal', 'arc_keeper_actions_total',
  'arc_finalized_index_errors_total', 'arc_http_requests_total', 'arc_http_in_flight',
  'arc_http_limiter_rejections_total', 'arc_http_limiter_class_rejections_total',
  'arc_proxy_requests_total', 'arc_proxy_denied_total',
  'arc_proxy_cache_hits_total', 'arc_database_reachable', 'arc_database_probe_age_seconds',
  'arc_host_suspends_total', 'arc_alerts_evaluated_age_seconds', 'arc_alert_deliveries_total',
  'arc_alert_firing', 'arc_tokio_tasks'];
/** Read from /proc; absent on macOS by design rather than faked. */
const LINUX_ONLY = ['arc_process_resident_memory_bytes', 'arc_process_open_fds'];
/** Only exported once the keeper has read them, or once the thing exists. */
const CONDITIONAL = ['arc_keeper_operator_balance_usdc', 'arc_keeper_operator_balance_age_seconds',
  'arc_keeper_gas_available_usdc', 'arc_keeper_gas_available_age_seconds',
  'arc_keeper_pending_journal_age_seconds', 'arc_keeper_last_cycle_start_age_seconds',
  'arc_keeper_last_cycle_finish_age_seconds', 'arc_finalized_index_age_seconds',
  'arc_ws_last_event_age_seconds'];

// ---- the fault-injecting endpoints ------------------------------------------------------------
/** One HTTP endpoint in front of Anvil that the check can cut and restore. */
const startEndpoint = async (index) => {
  const state = { dead: false };
  const server = createHttpServer((request, response) => {
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', async () => {
      if (state.dead) { request.socket.destroy(); return; }
      try {
        const upstream = await fetch(anvilUrl, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body });
        const text = await upstream.text();
        response.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        response.end(text);
      } catch (error) {
        response.writeHead(502).end(JSON.stringify({ error: error.message }));
      }
    });
  });
  await new Promise(r => server.listen(proxyPorts[index], '127.0.0.1', r));
  return { index, server, state };
};

/** A TCP pipe to Anvil's WebSocket that the check can cut and re-open. */
const startSocketProxy = async () => {
  const live = new Set();
  const server = createTcpServer(downstream => {
    const upstream = tcpConnect(rpcPort, '127.0.0.1');
    live.add(downstream); live.add(upstream);
    const close = () => { for (const socket of [downstream, upstream]) { socket.destroy(); live.delete(socket); } };
    downstream.on('error', close).on('close', close);
    upstream.on('error', close).on('close', close);
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });
  await new Promise(r => server.listen(socketPort, '127.0.0.1', r));
  return { server, drop: async () => {
    for (const socket of live) socket.destroy();
    live.clear();
    await new Promise(r => server.close(r));
  } };
};

// ---- the webhook receiver ---------------------------------------------------------------------
/** Stands in for a chat room. It records every delivery with its arrival time, and can be told to
 *  refuse for a while so the retry path is exercised. It never forwards anything anywhere. */
const startReceiver = async () => {
  const deliveries = [];
  const state = { failures: 0, failAlert: null, seenToken: null };
  const server = createHttpServer((request, response) => {
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      const url = new URL(request.url, 'http://127.0.0.1');
      state.seenToken = url.searchParams.get('token');
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* recorded raw below */ }
      deliveries.push({ at: Date.now(), body: parsed, raw: body, path: url.pathname });
      if (state.failures > 0 && (!state.failAlert || parsed?.alert === state.failAlert)) {
        state.failures -= 1;
        response.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"receiver down"}');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise(r => server.listen(hookPort, '127.0.0.1', r));
  return {
    server, state, deliveries,
    since: at => deliveries.filter(entry => entry.at >= at),
    find: (alert, status, at = 0) => deliveries.find(entry =>
      entry.at >= at && entry.body?.alert === alert && entry.body?.status === status),
    count: (alert, status, at = 0) => deliveries.filter(entry =>
      entry.at >= at && entry.body?.alert === alert && entry.body?.status === status).length,
  };
};

// ---- chain helpers ----------------------------------------------------------------------------
const call = async (address, abi, functionName, args = [], value = 0n) => {
  const hash = await wallet.writeContract({ address, abi, functionName, args, value });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', `${functionName} reverted`);
  return receipt;
};
const blockTime = async () => Number((await client.getBlock()).timestamp);
const buy = async amount => {
  // Simulated first: a revert then names its own custom error instead of arriving as a receipt
  // status with no explanation.
  const args = [token, true, parseEther(amount), 1n, BigInt(await blockTime()) + 60n];
  const { request } = await client.simulateContract({ account, address: deployment.launch,
    abi: arcAbi, functionName: 'trade', args, value: parseEther(amount) });
  // The keeper is trading in the same pool; a cheap estimate taken a block earlier can fall short
  // once its transaction lands first. This is a test harness on a throwaway chain, so it simply
  // pays for generous headroom rather than racing.
  const gas = await client.estimateContractGas({ account, address: deployment.launch, abi: arcAbi,
    functionName: 'trade', args, value: parseEther(amount) });
  const hash = await wallet.writeContract({ ...request, gas: gas * 3n });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    // Replay it against the block it landed in, so the failure names its own custom error.
    const reason = await client.call({ account, to: deployment.launch, data: request.data,
      value: parseEther(amount), blockNumber: receipt.blockNumber })
      .then(() => 'no revert on replay', error => error.shortMessage ?? error.message);
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    throw new Error(`trade reverted in block ${receipt.blockNumber} (timestamp ${block.timestamp}, `
      + `deadline base ${await blockTime()}, gas ${receipt.gasUsed}): ${reason}`);
  }
  return hash.toLowerCase();
};

// ---- API helpers ------------------------------------------------------------------------------
const fetchWithTimeout = async (url, options = {}, ms = 10_000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
};
const snapshot = async () => {
  const response = await fetchWithTimeout(`${base}/api/arc/snapshot`);
  assert.equal(response.status, 200, 'snapshot must be 200');
  return response.json();
};
const scrape = async (target = base, headers = {}) => {
  const started = Date.now();
  const response = await fetchWithTimeout(`${target}/metrics`, { headers });
  const text = await response.text();
  return { status: response.status, text, ms: Date.now() - started,
    contentType: response.headers.get('content-type'), cacheControl: response.headers.get('cache-control') };
};
const readiness = async () => (await fetchWithTimeout(`${base}/ready`)).status;
const alertsEndpoint = async () => {
  const response = await fetchWithTimeout(`${base}/api/arc/keeper/alerts`,
    { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
  return { status: response.status, body: await response.json() };
};
const requestKeeperRun = () => fetchWithTimeout(`${base}/api/arc/keeper/run`,
  { method: 'POST', headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } }, 5_000).catch(() => null);

const poll = async (produce, predicate, { ms = 120_000, label = '', every = 250 } = {}) => {
  const until = Date.now() + ms;
  for (;;) {
    const last = await produce().catch(() => null);
    if (last && (await predicate(last))) return last;
    if (Date.now() > until) throw new Error(`Timed out ${label}; last: ${JSON.stringify(last).slice(0, 500)}`);
    await sleep(every);
  }
};
/** Waits for one delivery of this alert in this state, at or after `at`. */
const waitForAlert = (alert, status, at, ms = 120_000) =>
  poll(async () => receiver.find(alert, status, at) ?? null, entry => !!entry,
    { ms, label: `waiting for ${alert} ${status}`, every: 250 });

const startApi = async (overrides = {}, port = apiPort) => {
  const child = spawn(resolve('SingleSparkBackend/api/target/debug/jet-arc-backend'), [],
    { env: { ...environment, ARC_PORT: String(port), ...overrides } });
  let out = '', errors = '';
  child.stdout.on('data', b => (out += b));
  child.stderr.on('data', b => (errors += b));
  for (let i = 0; i < 900; i++) {
    if (/listening on 127\.0\.0\.1:\d+/.test(out)) return { child, out: () => out, errors: () => errors };
    if (child.exitCode !== null) throw new Error(`Backend exited (${child.exitCode}): ${errors.slice(-900)}`);
    await sleep(100);
  }
  throw new Error(`Backend did not start: ${errors.slice(-900)}`);
};
const stopApi = async handle => {
  if (!handle?.child || handle.child.exitCode !== null) return;
  try { handle.child.kill('SIGCONT'); } catch { /* it may not be stopped */ }
  handle.child.kill('SIGTERM');
  for (let i = 0; i < 300 && handle.child.exitCode === null; i++) await sleep(50);
  if (handle.child.exitCode === null) handle.child.kill('SIGKILL');
};
/** The backend prints nothing about its RPC URLs or its webhook; this proves it for a whole run. */
const forbiddenLiterals = () => [SECRET, 'apikey', 'token=', METRICS_TOKEN, ADMIN_TOKEN,
  `127.0.0.1:${hookPort}`, ...proxyPorts.map(port => `127.0.0.1:${port}`), `127.0.0.1:${socketPort}`];
const assertNoLeak = (handle, extra = []) => {
  const log = `${handle.out()}\n${handle.errors()}`;
  const found = [...forbiddenLiterals(), ...extra].filter(literal => log.includes(literal));
  assert.deepEqual(found, [], `The backend log leaked: ${found.join(', ')}`);
  return log;
};
const assertNoLeakInBody = (value, where) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const found = forbiddenLiterals().filter(literal => text.includes(literal));
  assert.deepEqual(found, [], `${where} leaked: ${found.join(', ')}`);
};

/** Keeps the keeper cycling faster than its 180-second round timer, so that "no cycle has
 *  finished" means the process stopped rather than that the round simply has not come round. */
const startPacer = () => {
  const state = { stop: false };
  const loop = (async () => {
    while (!state.stop) {
      await requestKeeperRun();
      for (let i = 0; i < 80 && !state.stop; i++) await sleep(250);
    }
  })();
  return { stop: async () => { state.stop = true; await loop; } };
};

let scrapeCost = null, floodResult = null, freezeResult = null;

try {
  for (let i = 0; ; i++) {
    try { await client.getChainId(); break; } catch (error) { if (i > 80) throw error; await sleep(100); }
  }
  proxies = [await startEndpoint(0), await startEndpoint(1)];
  socketProxy = await startSocketProxy();
  receiver = await startReceiver();

  const deployContract = async (name, args) => {
    const compiled = artifact(name);
    const hash = await wallet.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    return receipt.contractAddress;
  };

  // ------------------------------------------------------------------ Step 1: the stack
  await scenario('step1-stack', 'Deploy the factory behind two cuttable endpoints and a webhook receiver', async () => {
    const pool = await deployContract('PoolManager', [account.address]);
    const positionManager = await deployContract('PositionManager', [pool, zeroAddress, 100000, zeroAddress, zeroAddress]);
    deployment = await deployArc(client, wallet, { positionManager, keeper: keeper.address, operations,
      community: platformCommunity, platformName: 'SingleSpark', platformSymbol: 'SPARK',
      minBuyback: '0.001', journalPath: resolve(dir, 'deployment.json') });
    // The keeper needs gas of its own; this is a throwaway development key on a throwaway chain.
    await wallet.sendTransaction({ to: keeper.address, value: parseEther('50') });
    environment = { ...process.env, ...database, ...localApiLimits, ARC_CHAIN_ID: '5042002',
      // Both endpoints and the webhook carry a fake credential, so any leak shows as SECRET123.
      ARC_RPC_URLS: endpointUrls.join(','), ARC_PUBLIC_RPC_URL: anvilUrl,
      ARC_WS_URLS: socketUrl,
      ARC_EXPLORER_URL: 'https://testnet.arcscan.app', ARC_WEB_ORIGIN: 'http://127.0.0.1:5176',
      ARC_HOST: '127.0.0.1', ARC_PORT: String(apiPort), ARC_DATA_DIR: dir,
      ARC_LAUNCH_ADDRESS: deployment.launch, ARC_QUOTER_ADDRESS: deployment.quoter,
      ARC_FROM_BLOCK: deployment.fromBlock, ARC_CONFIG_SIGNING_KEY: key(0),
      ARC_TREASURY_ENCRYPTION_KEY: '09'.repeat(32), ARC_CONFIG_KEY_ID: 'arc-local',
      ARC_GAS_RESERVE_USDC: '1', ARC_SLIPPAGE_BPS: '300',
      ARC_KEEPER_BATCH_SIZE: '20', ARC_MAX_GAS_PER_TX: '5000000',
      // This check's own keeper, on its own throwaway chain. It is never the operator's.
      ARC_KEEPER_PRIVATE_KEY: key(5), ARC_REWARDS_ADDRESS: '', ARC_REWARDS_FROM_BLOCK: '',
      ARC_SATISFACTION_ADDRESS: '', ARC_SATISFACTION_FROM_BLOCK: '',
      ARC_INDEX_IDLE_SECONDS: '15', ARC_INDEX_MIN_GAP_MS: '750',
      ARC_RPC_MAX_RPS: '25', ARC_RPC_BURST: '50', ARC_RPC_PROXY_PER_MINUTE: '1000000',
      ARC_KEEPER_ADMIN_TOKEN: ADMIN_TOKEN, ARC_METRICS_TOKEN: METRICS_TOKEN,
      ARC_ALERT_WEBHOOK_URL: webhookUrl, ARC_ALERT_WEBHOOK_KIND: 'generic',
      ARC_INSTANCE_NAME: 'monitoring-check', ...KNOBS };
    schemaCreated = true;
    const receipt = await call(deployment.launch, arcAbi, 'launch',
      ['Monitored Ember Cat', 'MONCAT', '', 30_000, 30_000, privateKeyToAccount(`0x${'d2'.repeat(32)}`).address]);
    token = parseEventLogs({ abi: arcAbi, eventName: 'Launched', logs: receipt.logs })[0].args.token;
    // Clear the three-second opening window before any measured trade.
    await client.request({ method: 'evm_setNextBlockTimestamp', params: [(await blockTime()) + 10] });
    await client.request({ method: 'evm_mine', params: [] });
    return { launch: deployment.launch, token, endpoints: proxyPorts.length,
      schema: database.ARC_DATABASE_SCHEMA, keeper: 'this check\'s own throwaway key' };
  });

  // ------------------------------------------------------------------ (a) the body itself
  await scenario('a-exposition', '/metrics is valid exposition format, complete, and moves with the chain', async () => {
    api = await startApi();
    await poll(snapshot, value => (value.tokens ?? []).length >= 2,
      { ms: 90_000, label: 'waiting for the first snapshot', every: 200 });
    // The socket's own ages only exist once a head has arrived; wait for that rather than
    // asserting a metric into existence.
    await poll(async () => parseExposition((await scrape()).text),
      body => body.value('arc_ws_connected') === 1 && body.has('arc_ws_last_head_age_seconds'),
      { ms: 90_000, label: 'waiting for the socket to report a head' });
    const first = await scrape();
    assert.equal(first.status, 200, 'a loopback scrape is served');
    assert.match(first.contentType ?? '', /^text\/plain; version=0\.0\.4/, 'the exposition content type');
    assert.match(first.cacheControl ?? '', /no-store/, 'metrics are never cached');
    const before = parseExposition(first.text);
    const missing = DOCUMENTED.filter(name => !before.has(name));
    assert.deepEqual(missing, [], `documented metrics missing from the body: ${missing.join(', ')}`);
    const platformAbsent = LINUX_ONLY.filter(name => !before.has(name));
    assert.equal(before.value('arc_build_info'), 1, 'build info is always 1');
    assert.equal(before.value('arc_keeper_enabled'), 1, 'this backend holds a keeper key');
    assert.equal(before.value('arc_ws_configured'), 1, 'a socket is configured');
    assert.equal(before.value('arc_database_reachable'), 1, 'the database answered its probe');
    assert.equal(before.value('arc_rpc_endpoints_configured'), 2);
    assert.equal(before.value('arc_rpc_breaker_state', { endpoint: '0', state: 'closed' }), 1);
    // Two trades, then the same numbers again: the body is a reading, not a constant.
    const hashes = [await buy('0.5'), await buy('0.5')];
    await poll(snapshot, value => hashes.every(hash =>
      (value.trades ?? []).some(trade => trade.transactionHash?.toLowerCase() === hash)),
      { ms: 90_000, label: 'waiting for both trades to be indexed' });
    const after = parseExposition((await scrape()).text);
    const moved = {
      trades: [before.value('arc_trades_in_memory'), after.value('arc_trades_in_memory')],
      indexed: [before.value('arc_index_indexed_block'), after.value('arc_index_indexed_block')],
      passes: [before.passes(), after.passes()],
      rpc: [before.value('arc_rpc_requests_total', { endpoint: '0' }),
        after.value('arc_rpc_requests_total', { endpoint: '0' })],
      version: [before.value('arc_snapshot_version'), after.value('arc_snapshot_version')],
      http: [before.value('arc_http_requests_total', { route: '/api/arc/snapshot', status: '2xx' }),
        after.value('arc_http_requests_total', { route: '/api/arc/snapshot', status: '2xx' })],
    };
    for (const [name, [start, end]] of Object.entries(moved)) {
      assert.ok(end > start, `${name} must move with the chain: ${start} -> ${end}`);
    }
    assert.ok(after.value('arc_trades_in_memory') >= 2, 'both trades are held');
    assert.ok(after.value('arc_index_age_seconds') < 30, 'the index is fresh');
    // A scanner cannot grow the series set.
    const seriesBefore = after.samples.filter(s => s.name === 'arc_http_requests_total').length;
    for (const path of ['/nope', '/wp-admin.php', '/api/arc/media/0xdeadbeef', '/x/y/z']) {
      await fetchWithTimeout(`${base}${path}`).catch(() => null);
    }
    const scanned = parseExposition((await scrape()).text);
    const seriesAfter = scanned.samples.filter(s => s.name === 'arc_http_requests_total').length;
    assert.ok(seriesAfter - seriesBefore <= 2,
      `unknown paths must collapse into route templates: ${seriesBefore} -> ${seriesAfter}`);
    assert.ok(scanned.value('arc_http_requests_total', { route: 'other', status: '4xx' }) >= 3);
    assertNoLeak(api);
    assertNoLeakInBody(scanned.samples.map(s => s.series).join('\n'), '/metrics');
    return { families: scanned.types.size, series: scanned.samples.length,
      bodyBytes: first.text.length, documented: DOCUMENTED.length,
      linuxOnlyAbsentHere: platformAbsent, platform: process.platform,
      conditionalPresent: CONDITIONAL.filter(name => scanned.has(name)),
      httpSeriesBeforeAfterScan: [seriesBefore, seriesAfter], moved };
  });

  // ------------------------------------------------------------------ (a2) scrape cost
  await scenario('a-scrape-cost', 'Scraping stays cheap while browsers flood the snapshot', async () => {
    const quiet = [];
    for (let i = 0; i < 20; i++) { quiet.push((await scrape()).ms); await sleep(100); }
    let sent = 0, ok = 0, other = 0;
    const floodOnce = async () => {
      sent += 1;
      try {
        const response = await fetchWithTimeout(`${base}/api/arc/snapshot`, {}, 20_000);
        if (response.status === 200) ok += 1; else other += 1;
        await response.arrayBuffer();
      } catch { other += 1; }
    };
    const under = [];
    const flood = (async () => {
      const gap = 1_000 / FLOOD_RPS;
      const until = Date.now() + FLOOD_MS;
      const inFlight = new Set();
      while (Date.now() < until) {
        const task = floodOnce().finally(() => inFlight.delete(task));
        inFlight.add(task);
        if (inFlight.size > 400) await Promise.race(inFlight);
        await sleep(gap);
      }
      await Promise.allSettled([...inFlight]);
    })();
    const scraping = (async () => {
      const until = Date.now() + FLOOD_MS;
      while (Date.now() < until) { under.push((await scrape()).ms); await sleep(250); }
    })();
    await Promise.all([flood, scraping]);
    const body = parseExposition((await scrape()).text);
    // The bound is this run's own quiet p95 with headroom, not a number chosen in advance.
    const bound = Math.max(quiet.length ? percentile(quiet, 95) * 6 : 0, 1_000);
    assert.ok(percentile(under, 95) <= bound,
      `scrape p95 under the flood was ${percentile(under, 95)} ms; the bound from this run's quiet p95 is ${bound} ms`);
    assert.ok(ok > 0, 'the flood must have been served');
    assert.equal(body.value('arc_database_reachable'), 1, 'the flood did not break the database probe');
    scrapeCost = { quietP50Ms: percentile(quiet, 50), quietP95Ms: percentile(quiet, 95),
      floodP50Ms: percentile(under, 50), floodP95Ms: percentile(under, 95),
      floodMaxMs: Math.max(...under), boundMs: round(bound, 0), scrapes: under.length };
    floodResult = { targetRps: FLOOD_RPS, seconds: FLOOD_MS / 1000, sent,
      achievedRps: round(sent / (FLOOD_MS / 1000)), ok, failed: other };
    return { ...scrapeCost, ...floodResult };
  });

  // ------------------------------------------------------------------ (a3) who may scrape
  await scenario('a-headers', 'Every response carries the hardening headers, and HSTS only where it would be honoured', async () => {
    const seen = {};
    for (const path of ['/metrics', '/api/arc/snapshot', '/health']) {
      const response = await fetchWithTimeout(`${base}${path}`);
      const read = name => response.headers.get(name);
      assert.equal(read('x-content-type-options'), 'nosniff', `${path} must refuse content sniffing`);
      assert.equal(read('referrer-policy'), 'no-referrer', `${path} must send no referrer`);
      assert.equal(read('x-frame-options'), 'DENY', `${path} must refuse framing`);
      assert.equal(read('content-security-policy'), "frame-ancestors 'none'", `${path} CSP`);
      // This backend binds loopback with no reverse proxy, so HSTS would pin the browser to HTTPS
      // for localhost itself and break every other project on the machine. It must stay absent.
      assert.equal(read('strict-transport-security'), null, `${path} must not send HSTS from loopback`);
      seen[path] = { status: response.status, csp: read('content-security-policy'), hsts: read('strict-transport-security') };
    }
    return { paths: seen };
  });

  await scenario('a-access', 'Loopback, the token, and nobody else', async () => {
    // This backend has no trusted proxy, so loopback alone is enough and the token is optional.
    assert.equal((await scrape()).status, 200, 'loopback without a token');
    assert.equal((await scrape(base, { Authorization: `Bearer ${METRICS_TOKEN}` })).status, 200,
      'loopback with the right token');
    // Loopback is checked first, so a local scraper carrying a stale token still works. The
    // 401 case only exists where loopback is not by itself a statement about who is calling.
    assert.equal((await scrape(base, { Authorization: 'Bearer wrong-token-entirely' })).status, 200,
      'loopback wins over a wrong token on a backend with no reverse proxy');
    // A second backend, configured exactly as it would be behind a reverse proxy on the same host.
    // Every caller then looks like loopback, so loopback stops counting and the token is the way in.
    const proxiedPort = await freePort();
    const proxiedDir = mkdtempSync(resolve(tmpdir(), 'arc-monitoring-proxied-'));
    extraDirs.push(proxiedDir);
    const proxied = await startApi({ ...testDatabase(proxiedDir), ARC_DATA_DIR: proxiedDir,
      ARC_TRUSTED_PROXIES: '127.0.0.1', ARC_CLIENT_IP_HEADER: 'x-forwarded-for',
      ARC_ALERT_WEBHOOK_URL: '', ARC_WS_URLS: '' }, proxiedPort);
    const proxiedBase = `http://127.0.0.1:${proxiedPort}`;
    let denied, deniedForwarded, wrong, allowed, allowedForwarded;
    try {
      denied = await scrape(proxiedBase);
      deniedForwarded = await scrape(proxiedBase, { 'X-Forwarded-For': '203.0.113.7' });
      wrong = await scrape(proxiedBase, { Authorization: 'Bearer not-the-token' });
      allowed = await scrape(proxiedBase, { Authorization: `Bearer ${METRICS_TOKEN}` });
      allowedForwarded = await scrape(proxiedBase,
        { Authorization: `Bearer ${METRICS_TOKEN}`, 'X-Forwarded-For': '203.0.113.7' });
      assert.equal(denied.status, 404, 'behind a proxy, loopback alone gets the same 404 as any stranger');
      assert.equal(deniedForwarded.status, 404, 'a forwarded stranger gets 404, not 401');
      assert.equal(wrong.status, 401, 'a wrong token is 401');
      assert.equal(allowed.status, 200, 'the right token is served');
      assert.equal(allowedForwarded.status, 200, 'the token works whatever the forwarded address');
      parseExposition(allowed.text);
      assert.equal(denied.text.includes('arc_'), false, 'a refused scrape says nothing at all');
      assertNoLeak(proxied);
    } finally {
      await stopApi(proxied);
    }
    // And with no token configured at all, a proxied backend simply has no endpoint to find.
    const bareDir = mkdtempSync(resolve(tmpdir(), 'arc-monitoring-bare-'));
    extraDirs.push(bareDir);
    const barePort = await freePort();
    const bare = await startApi({ ...testDatabase(bareDir), ARC_DATA_DIR: bareDir,
      ARC_TRUSTED_PROXIES: '127.0.0.1', ARC_CLIENT_IP_HEADER: 'x-forwarded-for',
      ARC_METRICS_TOKEN: '', ARC_ALERT_WEBHOOK_URL: '', ARC_WS_URLS: '' }, barePort);
    let unset;
    try {
      unset = await scrape(`http://127.0.0.1:${barePort}`);
      assert.equal(unset.status, 404, 'no token configured and not loopback: 404, never 401');
      assert.equal((await scrape(`http://127.0.0.1:${barePort}`,
        { Authorization: `Bearer ${METRICS_TOKEN}` })).status, 404,
        'a token nobody configured buys nothing and is not acknowledged');
    } finally {
      await stopApi(bare);
    }
    return { loopbackNoToken: 200, loopbackWrongTokenStillLoopback: 200, proxiedNoToken: denied.status,
      proxiedForwardedNoToken: deniedForwarded.status, proxiedWrongToken: wrong.status,
      proxiedRightToken: allowed.status, proxiedRightTokenForwarded: allowedForwarded.status,
      tokenUnsetProxied: unset.status };
  });

  // ------------------------------------------------------------------ (b) both endpoints cut
  await scenario('b-rpc-down', 'Both RPC endpoints cut: rpc_all_endpoints_unhealthy and index_stale fire, then resolve', async () => {
    const at = Date.now();
    proxies.forEach(proxy => { proxy.state.dead = true; });
    const unhealthy = await waitForAlert('rpc_all_endpoints_unhealthy', 'firing', at, 180_000);
    const stale = await waitForAlert('index_stale', 'firing', at, 240_000);
    assert.equal(unhealthy.body.severity, 'critical');
    assert.equal(unhealthy.body.instance, 'monitoring-check');
    assert.ok(stale.body.value > Number(KNOBS.ARC_ALERT_INDEX_STALE_SECONDS),
      `the alert carries the age it saw: ${stale.body.value}`);
    const duringMetrics = parseExposition((await scrape()).text);
    assert.equal(duringMetrics.value('arc_alert_firing',
      { alert: 'rpc_all_endpoints_unhealthy', severity: 'critical' }), 1,
      '/metrics shows what is firing');
    const duringEndpoint = await alertsEndpoint();
    assert.equal(duringEndpoint.status, 200);
    assert.ok(duringEndpoint.body.firing.some(entry => entry.alert === 'index_stale'),
      'the management endpoint shows the same set');
    assert.equal(duringEndpoint.body.webhookConfigured, true);
    // Restore and wait for both to resolve.
    const restored = Date.now();
    proxies.forEach(proxy => { proxy.state.dead = false; });
    const unhealthyResolved = await waitForAlert('rpc_all_endpoints_unhealthy', 'resolved', restored, 240_000);
    const staleResolved = await waitForAlert('index_stale', 'resolved', restored, 240_000);
    assert.ok(unhealthyResolved.body.summary.startsWith('Resolved: '));
    assert.ok(staleResolved.body.summary.startsWith('Resolved: '));
    await poll(async () => parseExposition((await scrape()).text),
      body => !body.samples.some(sample => sample.name === 'arc_alert_firing'
        && ['index_stale', 'rpc_all_endpoints_unhealthy'].includes(sample.labels.alert)),
      { ms: 60_000, label: 'waiting for /metrics to drop the resolved alerts' });
    assertNoLeak(api);
    assertNoLeakInBody(duringEndpoint.body, '/api/arc/keeper/alerts');
    return {
      firedAfterSeconds: {
        rpcAllUnhealthy: round((unhealthy.at - at) / 1000, 1),
        indexStale: round((stale.at - at) / 1000, 1),
      },
      resolvedAfterSeconds: {
        rpcAllUnhealthy: round((unhealthyResolved.at - restored) / 1000, 1),
        indexStale: round((staleResolved.at - restored) / 1000, 1),
      },
      indexAgeReported: stale.body.value, severities: [unhealthy.body.severity, stale.body.severity],
      firingDuring: duringEndpoint.body.firing.map(entry => entry.alert).sort(),
    };
  });

  // ------------------------------------------------------------------ (c) keeper deferrals
  await scenario('c-keeper-deferred', 'Three deferred keeper cycles raise keeper_deferred', async () => {
    // Start from a clean count: the previous scenario cut the same endpoints, so the keeper may
    // already have stood aside once. A successful cycle resets the streak and any firing alert.
    await requestKeeperRun();
    await poll(async () => parseExposition((await scrape()).text),
      body => body.value('arc_keeper_consecutive_deferrals') === 0,
      { ms: 120_000, label: 'waiting for the keeper to complete a cycle', every: 1_000 });
    await poll(alertsEndpoint, answer => !answer.body.firing.some(e => e.alert === 'keeper_deferred'),
      { ms: 120_000, label: 'waiting for any earlier deferral alert to resolve', every: 1_000 });
    const at = Date.now();
    const errorsBefore = parseExposition((await scrape()).text)
      .value('arc_keeper_cycles_total', { outcome: 'error' });
    proxies.forEach(proxy => { proxy.state.dead = true; });
    // The keeper defers once the committed index it reads is more than thirty seconds old.
    await sleep(35_000);
    for (let i = 0; i < 4; i++) {
      await requestKeeperRun();
      await sleep(7_000);
    }
    const fired = await waitForAlert('keeper_deferred', 'firing', at, 180_000);
    const body = parseExposition((await scrape()).text);
    assert.ok(body.value('arc_keeper_consecutive_deferrals') >= 3,
      `three in a row: ${body.value('arc_keeper_consecutive_deferrals')}`);
    assert.ok(body.value('arc_keeper_cycles_total', { outcome: 'deferred_stale_index' }) >= 3,
      'deferrals are counted apart from errors');
    assert.equal(body.value('arc_keeper_cycles_total', { outcome: 'error' }), errorsBefore,
      'standing aside for a stale index is counted as a deferral, not as an error');
    assert.ok(fired.body.value >= 3, 'the alert carries the count it saw');
    proxies.forEach(proxy => { proxy.state.dead = false; });
    // Ask for a cycle rather than waiting out the 180-second round timer: the streak only resets
    // when one completes.
    await poll(async () => { await requestKeeperRun(); return parseExposition((await scrape()).text); },
      body => body.value('arc_keeper_consecutive_deferrals') === 0,
      { ms: 180_000, label: 'waiting for a keeper cycle to complete again', every: 5_000 });
    const resolved = await waitForAlert('keeper_deferred', 'resolved', Date.now() - 1, 240_000);
    assertNoLeak(api);
    return { deferrals: body.value('arc_keeper_consecutive_deferrals'),
      deferredCycles: body.value('arc_keeper_cycles_total', { outcome: 'deferred_stale_index' }),
      errorCyclesBeforeAfter: [errorsBefore,
        body.value('arc_keeper_cycles_total', { outcome: 'error' })],
      ranCycles: body.value('arc_keeper_cycles_total', { outcome: 'ran' }),
      valueInAlert: fired.body.value, resolvedAfterSeconds: round((resolved.at - at) / 1000, 1) };
  });

  // ------------------------------------------------------------------ (g) readiness
  await scenario('g-ready', '/ready flips to 503 while the index is critically stale, and back', async () => {
    await poll(readiness, status => status === 200,
      { ms: 180_000, label: 'waiting for the backend to be ready again', every: 500 });
    const at = Date.now();
    proxies.forEach(proxy => { proxy.state.dead = true; });
    await poll(readiness, status => status === 503,
      { ms: 120_000, label: 'waiting for readiness to drop', every: 500 });
    const downAfter = round((Date.now() - at) / 1000, 1);
    // Liveness is a different question and must not follow it.
    const health = await fetchWithTimeout(`${base}/health`);
    assert.equal(health.status, 200, '/health is liveness only and stays up');
    const restored = Date.now();
    proxies.forEach(proxy => { proxy.state.dead = false; });
    // Generous: each cut opens the breaker again and its cool-down doubles, so by the third
    // outage in one run the pool waits tens of seconds before it will even probe an endpoint.
    await poll(readiness, status => status === 200,
      { ms: 300_000, label: 'waiting for readiness to return', every: 500 });
    return { readyThreshold: Number(KNOBS.ARC_READY_INDEX_SECONDS), downAfterSeconds: downAfter,
      backAfterSeconds: round((Date.now() - restored) / 1000, 1), healthDuringOutage: health.status };
  });

  // ------------------------------------------------------------------ (d) the socket
  await scenario('d-ws-down', 'Cutting the WebSocket raises ws_down, restoring it resolves', async () => {
    const at = Date.now();
    await socketProxy.drop();
    const fired = await waitForAlert('ws_down', 'firing', at, 120_000);
    const during = parseExposition((await scrape()).text);
    assert.equal(during.value('arc_ws_connected'), 0, 'the socket is reported down');
    assert.equal(during.value('arc_ws_configured'), 1, 'it is still configured');
    assert.equal(fired.body.severity, 'warning');
    socketProxy = await startSocketProxy();
    const resolved = await waitForAlert('ws_down', 'resolved', Date.now(), 180_000);
    const after = await poll(async () => parseExposition((await scrape()).text),
      body => body.value('arc_ws_connected') === 1,
      { ms: 120_000, label: 'waiting for the socket to come back' });
    assert.ok(after.value('arc_ws_reconnects_total') >= 1, 'the reconnection is counted');
    assertNoLeak(api);
    return { firedAfterSeconds: round((fired.at - at) / 1000, 1),
      resolvedAfterSeconds: round((resolved.at - at) / 1000, 1),
      reconnects: after.value('arc_ws_reconnects_total'),
      wsEndpointIndex: after.value('arc_ws_endpoint_index') };
  });

  // ------------------------------------------------------------------ (e) the process freeze
  await scenario('e-freeze', 'A frozen process is reported when it comes back, and the gap is visible', async () => {
    // Keep the keeper cycling faster than its own round timer, so "no cycle finished" means the
    // process stopped rather than that the 180-second round simply has not come round yet.
    pacer = startPacer();
    await sleep(45_000);
    const quiet = (await alertsEndpoint()).body.firing.map(entry => entry.alert);
    assert.ok(!quiet.includes('keeper_not_cycling'), `nothing is firing before the freeze: ${quiet}`);
    // Stop pacing BEFORE freezing. A request sent while the process is stopped sits in the
    // kernel's accept queue and is served the instant it resumes, which would start a keeper
    // cycle in the same breath as the resume and hide the very gap being measured.
    await pacer.stop();
    pacer = null;
    // Freeze inside a gap that is longer than the freeze itself. The keeper's next cycle is due
    // on a 180-second wall-clock grid, and a cycle that falls due WHILE the process is stopped
    // runs the instant it resumes — which would reset the very age being measured before the
    // alerting task ever evaluates it. `worker.nextCheckAt` is when the backend itself says the
    // next cycle is due, so this waits for a window with room to spare.
    const margin = FREEZE_MS + 20_000;
    await poll(snapshot, value => {
      const next = Date.parse(value.worker?.nextCheckAt ?? '');
      return Number.isFinite(next) && next - Date.now() > margin;
    }, { ms: 300_000, label: 'waiting for a gap longer than the freeze', every: 1_000 });
    const cycledBefore = parseExposition((await scrape()).text)
      .value('arc_keeper_last_cycle_finish_age_seconds');
    const lastDeliveryBefore = receiver.deliveries[receiver.deliveries.length - 1]?.at ?? Date.now();
    const at = Date.now();
    api.child.kill('SIGSTOP');
    await sleep(FREEZE_MS);
    api.child.kill('SIGCONT');
    const reported = await Promise.race([
      waitForAlert('keeper_not_cycling', 'firing', at, 120_000).then(entry => ({ ...entry, which: 'keeper_not_cycling' })),
      waitForAlert('host_suspended', 'firing', at, 120_000).then(entry => ({ ...entry, which: 'host_suspended' })),
    ]);
    // The silence that spans the freeze: nothing could be delivered while the process was stopped.
    const silence = reported.at - lastDeliveryBefore;
    assert.ok(silence >= FREEZE_MS * 0.8,
      `the receiver must see the silence: ${silence} ms across a ${FREEZE_MS} ms freeze`);
    assert.equal(receiver.since(at).filter(entry => entry.at < at + FREEZE_MS).length, 0,
      'nothing at all arrives while the process is stopped');
    assert.ok(reported.body.value >= Number(KNOBS.ARC_ALERT_NOT_CYCLING_SECONDS) * 0.8,
      `the alert carries how long it was: ${reported.body.value}`);
    const body = parseExposition((await scrape()).text);
    // It only resolves once a cycle completes again, so ask for one and keep asking.
    pacer = startPacer();
    const resolved = await waitForAlert(reported.which, 'resolved', Date.now() - 1, 180_000)
      .catch(() => null);
    await pacer.stop();
    pacer = null;
    freezeResult = { frozenSeconds: FREEZE_MS / 1000, reported: reported.which,
      valueInAlert: round(reported.body.value, 1),
      reportedAfterResumeSeconds: round((reported.at - (at + FREEZE_MS)) / 1000, 1),
      receiverSilenceSeconds: round(silence / 1000, 1),
      lastDeliveryBeforeFreezeSeconds: round((at - lastDeliveryBefore) / 1000, 1),
      keeperCycleAgeBeforeFreezeSeconds: cycledBefore === undefined ? null : round(cycledBefore, 1),
      hostSuspendsCounted: body.value('arc_host_suspends_total'),
      resolved: resolved ? resolved.body.status : 'not observed within the window' };
    assertNoLeak(api);
    return freezeResult;
  });

  // ------------------------------------------------------------------ (f) a receiver that refuses
  await scenario('f-delivery', 'A receiver that returns 500 is retried, not stormed, and no secret escapes', async () => {
    const at = Date.now();
    const sentBefore = parseExposition((await scrape()).text)
      .value('arc_alert_deliveries_total', { outcome: 'sent' });
    // Refuse every attempt at this one message, then recover. Three attempts, then the message is
    // given up on — which is what makes the `failed` counter and the fixed log line observable.
    receiver.state.failAlert = 'ws_down';
    receiver.state.failures = 3;
    await socketProxy.drop();
    const fired = await waitForAlert('ws_down', 'firing', at, 180_000);
    // Every attempt is recorded by the receiver, so the retries are visible as repeats.
    await poll(async () => receiver.count('ws_down', 'firing', at), count => count >= 3,
      { ms: 60_000, label: 'waiting for the retries', every: 250 });
    const attempts = receiver.count('ws_down', 'firing', at);
    await sleep(20_000);
    const settled = receiver.count('ws_down', 'firing', at);
    assert.equal(settled, 3,
      `three attempts and no more until the re-notify interval: ${settled} deliveries`);
    assert.equal(receiver.state.failures, 0, 'the receiver was refusing and then recovered');
    receiver.state.failAlert = null;
    const during = parseExposition((await scrape()).text);
    assert.ok(during.value('arc_alert_deliveries_total', { outcome: 'failed' }) >= 1,
      'a message that could not be delivered at all is counted as failed');
    // The fixed text, and only the fixed text.
    const log = `${api.out()}\n${api.errors()}`;
    const complaints = log.split('ARC alerts: delivery failed').length - 1;
    assert.ok(complaints >= 1, 'a failure is reported');
    assert.ok(complaints <= 3, `at most once a minute: ${complaints} lines in this run`);
    // The credential in the webhook URL must be nowhere at all.
    assertNoLeak(api);
    assertNoLeakInBody(await scrape().then(result => result.text), '/metrics');
    assertNoLeakInBody((await alertsEndpoint()).body, '/api/arc/keeper/alerts');
    assertNoLeakInBody(await snapshot(), '/api/arc/snapshot');
    assert.equal(receiver.state.seenToken, SECRET,
      'the receiver really was given the credential, so its absence elsewhere means something');
    socketProxy = await startSocketProxy();
    await waitForAlert('ws_down', 'resolved', Date.now(), 240_000);
    // The receiver has recovered, so the resolve gets through: delivery works again after the
    // outage rather than the channel staying wedged.
    const body = parseExposition((await scrape()).text);
    assert.ok(body.value('arc_alert_deliveries_total', { outcome: 'sent' }) > sentBefore,
      'delivery recovers once the receiver does');
    return { refusedDeliveries: 3, attemptsSeenByReceiver: attempts, settledDeliveries: settled,
      deliveriesFailed: body.value('arc_alert_deliveries_total', { outcome: 'failed' }),
      deliveriesSentBeforeAfter: [sentBefore, body.value('arc_alert_deliveries_total', { outcome: 'sent' })],
      deliveriesDropped: body.value('arc_alert_deliveries_total', { outcome: 'dropped' }),
      fixedTextLines: complaints, secretFoundAnywhere: false,
      firedAfterSeconds: round((fired.at - at) / 1000, 1) };
  });

  notes.push(
    'Local loopback numbers only. Anvil mines on a one-second timer over 127.0.0.1, both "RPC '
      + 'endpoints" and the webhook receiver are Node servers on this machine, and the database is '
      + 'the local PostgreSQL test instance. Every latency here is a lower bound on what a real '
      + 'deployment would see. Nothing here measures the ARC testnet, and no public endpoint, chat '
      + 'service or webhook was contacted.',
    'The alert `for` windows were shortened with the documented test knobs (ARC_ALERT_*_SECONDS). '
      + 'What is exercised is the rule machinery and the delivery path, not the production timings; '
      + 'the production defaults are covered by the unit tests in SingleSparkBackend/api/src/alerts.rs.',
    'Scenario (e) is a SIGSTOP, not a host suspend. A stopped process still has both of its clocks '
      + 'running, so the wall-clock-versus-monotonic detector cannot fire here and the alert that '
      + 'reported the outage was keeper_not_cycling. The suspend detector itself is covered by unit '
      + 'tests (alerts::tests::a_clock_that_jumps_without_the_monotonic_one_is_a_suspend). This '
      + 'machine was never put to sleep.',
    'The keeper here is this check\'s own throwaway key on this throwaway chain. The operator\'s '
      + 'keeper was not started, stopped, reconfigured or contacted, and no service on port 8090 or '
      + '5176 was touched.',
    'The trades are a development key buying its own synthetic meme on a chain that exists for the '
      + 'length of this process. They are not users and not volume.',
    'The flood in scenario (a-scrape-cost) is a load generator on loopback: its achieved rate is '
      + 'reported alongside its target, because the target is an intention and the achieved rate is '
      + 'the measurement.',
    'Resident memory and open file descriptors are read from /proc and are therefore absent on '
      + 'macOS rather than faked. On this run the platform is reported in the (a-exposition) result.');

  const passed = results.every(entry => entry.status === 'passed');
  const report = { status: passed ? 'passed' : 'failed', checkedAt: new Date().toISOString(),
    environment: 'Local throwaway Anvil chain (chain id 5042002) behind two cuttable HTTP proxies '
      + 'and one TCP socket proxy, a local webhook receiver, all on 127.0.0.1, with Anvil\'s public '
      + 'development keys, the PostgreSQL test database and schemas dropped at the end. NOT a public '
      + 'chain and NOT a public measurement: no address, token or transaction here exists anywhere '
      + 'else, and no running service was touched.',
    platform: process.platform, chainId: 5042002,
    testKnobs: KNOBS,
    deployment: deployment && { launch: deployment.launch, token },
    measured: { scrape: scrapeCost, flood: floodResult, freeze: freezeResult },
    webhookDeliveries: receiver ? receiver.deliveries.length : 0,
    scenarios: results, notes };
  const outputPath = resolve('SingleSparkContract/arc/deployments/monitoring-local-acceptance-20260920.json');
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.status.toUpperCase()}: ${results.filter(r => r.status === 'passed').length}/${results.length} scenarios in ${outputPath}`);
  if (!passed) process.exitCode = 1;
} finally {
  if (pacer) await pacer.stop().catch(() => {});
  await stopApi(api);
  await socketProxy?.drop().catch(() => {});
  for (const proxy of proxies) await new Promise(r => (proxy ? proxy.server.close(r) : r()));
  if (receiver) await new Promise(r => receiver.server.close(r));
  anvil.kill('SIGTERM');
  for (const extra of extraDirs) {
    try { testSql(extra, `DROP SCHEMA IF EXISTS "${testDatabase(extra).ARC_DATABASE_SCHEMA}" CASCADE`); }
    catch (error) { console.error(`Could not drop a test schema: ${error.message}`); }
  }
  if (schemaCreated) {
    try { testSql(dir, `DROP SCHEMA IF EXISTS "${database.ARC_DATABASE_SCHEMA}" CASCADE`); }
    catch (error) { console.error(`Could not drop the test schema: ${error.message}`); }
  }
}
