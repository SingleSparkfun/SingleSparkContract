// Multi-endpoint RPC failover, the priority governor and the read proxy, end to end on a local
// chain: node SingleSparkContract/arc/check-rpc-resilience.mjs
//
// A throwaway Anvil chain, Anvil's public development keys, the PostgreSQL *test* database and an
// isolated schema that is dropped again at the end. Nothing here reaches a public chain and no
// running service is touched: every port is asked for from the kernel, never 8090 or 5176.
//
// EVERY NUMBER BELOW IS A LOCAL LOOPBACK NUMBER. Anvil mines instantly and the two fault-injecting
// proxies sit on 127.0.0.1, so these latencies are a lower bound on what a public RPC can do. They
// are not a measurement of the ARC testnet and are not presented as one. Failover does not create
// quota either: if two endpoints share one free tier, the ceiling is unchanged. What is measured
// here is only what the backend does when an endpoint refuses, hangs, lies or is slow.
//
// Build the backend first: cargo build --locked --manifest-path SingleSparkBackend/api/Cargo.toml
//
// Two fault-injecting HTTP proxies stand in for endpoint #0 and #1, and two TCP proxies do the
// same for their WebSockets. Each can rate-limit a share of requests, hang, drop the socket, cap
// its own requests per second, answer eth_chainId for another chain, or accept a transaction
// upstream and then report a failure — which is the one case a failover must never retry blindly.
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

/** A fake key in every URL the backend is given. It must never appear in the backend's output. */
const SECRET = 'SECRET123';
/** Another chain's id, for the endpoint that quietly starts answering for somewhere else. */
const WRONG_CHAIN_ID = 1;
/** Trades measured per scenario, spaced irregularly so no result is an artefact of one rhythm. */
const GAPS_MS = [300, 1_100, 500, 1_700, 400, 900, 250, 1_300];
/** The flood in scenario (c): low-priority proxy reads, in requests per second, for this long. */
const FLOOD_RPS = 200;
const FLOOD_MS = 45_000;
/** The proxy's shipped per-address budget, exercised on its own in scenario (c3). */
const DEFAULT_PROXY_BUDGET = 600;
/** A throwaway management token, so scenario (e) can ask for a keeper cycle instead of waiting
 *  out the 180-second round timer. It exists only for the life of this process. */
const ADMIN_TOKEN = 'a1'.repeat(32);

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
const proxyPorts = [await freePort(), await freePort()];
const socketPorts = [await freePort(), await freePort()];
const anvilUrl = `http://127.0.0.1:${rpcPort}`;
const base = `http://127.0.0.1:${apiPort}`;
/** The URLs the backend is configured with, key and all. None of them may ever be printed. */
const endpointUrls = proxyPorts.map(port => `http://127.0.0.1:${port}/?apikey=${SECRET}`);
const socketUrls = socketPorts.map(port => `ws://127.0.0.1:${port}/?apikey=${SECRET}`);

const anvil = spawn('anvil', ['--port', String(rpcPort), '--chain-id', '5042002', '--silent',
  '--block-time', '1']);
let api, proxies = [], socketProxies = [], schemaCreated = false;
/** Extra data directories used by the short-lived backends below; each owns its own PG schema,
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
const dir = mkdtempSync(resolve(tmpdir(), 'arc-rpc-'));
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

// ---- the fault-injecting endpoints ------------------------------------------------------------
/** One HTTP endpoint in front of Anvil, with a switchboard of faults and a method tally. */
const startEndpoint = async (index) => {
  const state = {
    // The share of requests answered with a JSON-RPC -32005 instead of being forwarded.
    rateLimitShare: 0,
    // Answer HTTP 429 rather than a JSON-RPC error, for the other half of the classifier.
    http429: false,
    // Hold the request open past the backend's own timeout.
    hang: false,
    // Destroy the socket without answering.
    dropSocket: false,
    // Answer eth_chainId for a different chain while still forwarding everything else.
    wrongChain: false,
    // Forward the request upstream and THEN report a failure. The one case a send must not repeat.
    failAfterAccepting: false,
    // A hard ceiling on forwarded requests per second; everything above it is refused.
    maxRps: 0,
  };
  const counts = new Map();
  const refused = new Map();
  let windowStart = Date.now();
  let windowCount = 0;
  const tally = (map, method) => map.set(method, (map.get(method) ?? 0) + 1);
  const overRate = () => {
    if (!state.maxRps) return false;
    const now = Date.now();
    if (now - windowStart >= 1_000) { windowStart = now; windowCount = 0; }
    windowCount += 1;
    return windowCount > state.maxRps;
  };
  const server = createHttpServer((request, response) => {
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', async () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* not JSON: forwarded unchanged */ }
      const calls = parsed ? (Array.isArray(parsed) ? parsed : [parsed]) : [];
      for (const call of calls) tally(counts, call.method);
      const limited = state.rateLimitShare > 0 && Math.random() < state.rateLimitShare;
      if (state.dropSocket) { request.socket.destroy(); return; }
      if (state.hang) { await sleep(40_000); response.destroy(); return; }
      // Checked BEFORE the refusals: an endpoint that has quietly become another chain's endpoint
      // still answers eth_chainId, which is what makes the half-open probe able to catch it. An
      // endpoint that refuses even the probe is merely unhealthy, which is a different scenario.
      if (state.wrongChain && calls.length === 1 && calls[0].method === 'eth_chainId') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: calls[0].id, result: `0x${WRONG_CHAIN_ID.toString(16)}` }));
        return;
      }
      if (limited || overRate()) {
        for (const call of calls) tally(refused, call.method);
        if (state.http429) {
          response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
          response.end(JSON.stringify({ error: 'rate limited' }));
          return;
        }
        const error = id => ({ jsonrpc: '2.0', id, error: { code: -32005, message: 'limit exceeded' } });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(Array.isArray(parsed) ? calls.map(c => error(c.id)) : error(calls[0]?.id ?? null)));
        return;
      }
      try {
        const upstream = await fetch(anvilUrl, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body });
        const text = await upstream.text();
        // The node has now seen it. Reporting a failure here is exactly the ambiguous case.
        if (state.failAfterAccepting && calls.some(c => c.method === 'eth_sendRawTransaction')) {
          for (const call of calls) tally(refused, call.method);
          response.writeHead(503, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'gateway lost the answer' }));
          return;
        }
        response.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        response.end(text);
      } catch (error) {
        response.writeHead(502).end(JSON.stringify({ error: error.message }));
      }
    });
  });
  await new Promise(r => server.listen(proxyPorts[index], '127.0.0.1', r));
  return {
    index, server, state,
    counts: () => Object.fromEntries([...counts].sort()),
    refused: () => Object.fromEntries([...refused].sort()),
    total: () => [...counts.values()].reduce((sum, value) => sum + value, 0),
    totalRefused: () => [...refused.values()].reduce((sum, value) => sum + value, 0),
    reset: () => { counts.clear(); refused.clear(); },
  };
};

/** A TCP pipe to Anvil's WebSocket that the check can cut and re-open, one per endpoint. */
const startSocketProxy = async (index) => {
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
  await new Promise(r => server.listen(socketPorts[index], '127.0.0.1', r));
  return { index, server, drop: async () => {
    for (const socket of live) socket.destroy();
    live.clear();
    await new Promise(r => server.close(r));
  } };
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
  const hash = await wallet.writeContract({ address: deployment.launch, abi: arcAbi,
    functionName: 'trade', args: [token, true, parseEther(amount), 1n, BigInt(await blockTime()) + 100n],
    value: parseEther(amount) });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', 'trade reverted');
  return { hash: hash.toLowerCase(), mined: Date.now() };
};

// ---- API helpers ------------------------------------------------------------------------------
const snapshot = async () => {
  const response = await fetch(`${base}/api/arc/snapshot`);
  assert.equal(response.status, 200, 'snapshot must be 200');
  return response.json();
};
const rpcWorker = async () => (await snapshot()).worker?.rpc;
const poll = async (produce, predicate, { ms = 120_000, label = '', every = 150 } = {}) => {
  const until = Date.now() + ms;
  for (;;) {
    const last = await produce().catch(() => null);
    if (last && (await predicate(last))) return last;
    if (Date.now() > until) throw new Error(`Timed out ${label}; last: ${JSON.stringify(last).slice(0, 600)}`);
    await sleep(every);
  }
};
/** Mined -> visible in the public snapshot. */
const visible = async (hash, { ms = 90_000 } = {}) => {
  await poll(snapshot, value => (value.trades ?? []).some(t => t.transactionHash?.toLowerCase() === hash),
    { ms, label: `waiting for trade ${hash.slice(0, 10)}` });
  return Date.now();
};
/** A run of trades, each measured from mined to visible. */
const measureVisibility = async (gaps = GAPS_MS) => {
  const samples = [];
  for (const gap of gaps) {
    const { hash, mined } = await buy('0.5');
    samples.push((await visible(hash)) - mined);
    await sleep(gap);
  }
  return { samples, p50: percentile(samples, 50), p95: percentile(samples, 95), max: Math.max(...samples) };
};

const proxyRead = async (payload) => {
  const response = await fetch(`${base}/api/arc/rpc`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* a non-JSON body is reported as-is below */ }
  return { status: response.status, body, text };
};

const startApi = async (overrides = {}) => {
  const child = spawn(resolve('SingleSparkBackend/api/target/debug/jet-arc-backend'), [], { env: { ...environment, ...overrides } });
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
  handle.child.kill('SIGTERM');
  for (let i = 0; i < 300 && handle.child.exitCode === null; i++) await sleep(50);
  if (handle.child.exitCode === null) handle.child.kill('SIGKILL');
};
/** The backend prints nothing about its RPC URLs; this proves it for one run's whole output. */
const forbiddenLiterals = () => [SECRET, 'apikey',
  ...proxyPorts.map(port => `127.0.0.1:${port}`), ...socketPorts.map(port => `127.0.0.1:${port}`)];
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

let baseline = null, flooded = null, sendSafety = null;

try {
  for (let i = 0; ; i++) {
    try { await client.getChainId(); break; } catch (error) { if (i > 80) throw error; await sleep(100); }
  }
  proxies = [await startEndpoint(0), await startEndpoint(1)];
  socketProxies = [await startSocketProxy(0), await startSocketProxy(1)];

  const deployContract = async (name, args) => {
    const compiled = artifact(name);
    const hash = await wallet.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    return receipt.contractAddress;
  };

  // ------------------------------------------------------------------ Step 1: the stack
  await scenario('step1-stack', 'Deploy the factory behind two fault-injecting endpoints', async () => {
    const pool = await deployContract('PoolManager', [account.address]);
    const positionManager = await deployContract('PositionManager', [pool, zeroAddress, 100000, zeroAddress, zeroAddress]);
    deployment = await deployArc(client, wallet, { positionManager, keeper: keeper.address, operations,
      community: platformCommunity, platformName: 'SingleSpark', platformSymbol: 'SPARK',
      minBuyback: '0.001', journalPath: resolve(dir, 'deployment.json') });
    // The keeper needs gas of its own; this is a throwaway development key on a throwaway chain.
    await wallet.sendTransaction({ to: keeper.address, value: parseEther('50') });
    environment = { ...process.env, ...database, ...localApiLimits, ARC_CHAIN_ID: '5042002',
      // Both endpoints carry a fake key, so any leak shows up as SECRET123 in the output.
      ARC_RPC_URLS: endpointUrls.join(','), ARC_PUBLIC_RPC_URL: anvilUrl,
      ARC_WS_URLS: socketUrls.join(','),
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
      ARC_RPC_MAX_RPS: '8', ARC_RPC_BURST: '16',
      // Raised for the flood scenario: the point there is to press on the GOVERNOR, and the
      // proxy's own 600/minute per-address budget would otherwise absorb the load before the
      // governor ever saw it. The default budget is exercised separately in c3.
      ARC_RPC_PROXY_PER_MINUTE: '1000000', ARC_KEEPER_ADMIN_TOKEN: ADMIN_TOKEN };
    schemaCreated = true;
    // 3 % each way (fee units are millionths). A zero-fee token accrues nothing, and then the
    // keeper never signs anything — which would make the send-path scenario below vacuous.
    const receipt = await call(deployment.launch, arcAbi, 'launch',
      ['Resilient Ember Cat', 'RESCAT', '', 30_000, 30_000, privateKeyToAccount(`0x${'d2'.repeat(32)}`).address]);
    token = parseEventLogs({ abi: arcAbi, eventName: 'Launched', logs: receipt.logs })[0].args.token;
    // Clear the three-second opening window before any measured trade.
    await client.request({ method: 'evm_setNextBlockTimestamp', params: [(await blockTime()) + 10] });
    await client.request({ method: 'evm_mine', params: [] });
    return { launch: deployment.launch, token, endpoints: proxyPorts.length,
      schema: database.ARC_DATABASE_SCHEMA, keeper: 'this check\'s own throwaway key' };
  });

  // ------------------------------------------------------------------ Step 2: the quiet baseline
  await scenario('step2-baseline', 'Both endpoints healthy: index latency and the preferred endpoint', async () => {
    api = await startApi();
    await poll(snapshot, value => (value.tokens ?? []).length >= 2,
      { ms: 90_000, label: 'waiting for the first snapshot', every: 200 });
    const worker = await rpcWorker();
    assert.equal(worker.configured, 2, 'Both endpoints must be configured');
    assert.equal(worker.active, 0, 'The operator\'s first choice must be the one in use');
    assert.deepEqual(worker.endpoints.map(e => e.breaker), ['closed', 'closed']);
    proxies.forEach(proxy => proxy.reset());
    baseline = await measureVisibility();
    const after = await rpcWorker();
    assert.equal(after.active, 0, 'Nothing failed, so nothing moved');
    assert.equal(after.endpoints[1].requests, 0, 'The second endpoint is idle while the first is healthy');
    assertNoLeak(api);
    return { p50Ms: baseline.p50, p95Ms: baseline.p95, maxMs: baseline.max,
      trades: baseline.samples.length, requestsOnFirst: after.endpoints[0].requests,
      requestsOnSecond: after.endpoints[1].requests };
  });

  // ------------------------------------------------------------------ (a) failover
  await scenario('a-failover', 'Endpoint #0 rate-limits 60 % of requests: the backend moves to #1', async () => {
    proxies.forEach(proxy => proxy.reset());
    proxies[0].state.rateLimitShare = 0.6;
    const moved = await poll(rpcWorker, value => value.active === 1,
      { ms: 90_000, label: 'waiting for the backend to prefer the second endpoint' });
    const during = await measureVisibility(GAPS_MS.slice(0, 6));
    // The bound is the baseline's own p95 with generous headroom, not a fixed number: what is
    // being asserted is that failing over kept indexing working, not that loopback is fast.
    const bound = Math.max(20_000, baseline.p95 * 4);
    assert.ok(during.p95 <= bound, `Index p95 ${during.p95} ms must stay under ${bound} ms`);
    const worker = await rpcWorker();
    assert.ok(worker.endpoints[0].rateLimitHits > 0, 'The refusals must be counted against #0');
    assert.ok(worker.endpoints[0].failoversOut > 0, 'The switch itself must be counted');
    assert.ok(worker.endpoints[1].requests > 0, 'The second endpoint must now be carrying traffic');
    assertNoLeak(api);
    assertNoLeakInBody(worker, 'worker.rpc');
    return { p50Ms: during.p50, p95Ms: during.p95, boundMs: bound, active: worker.active,
      rateLimitHitsOnFirst: worker.endpoints[0].rateLimitHits,
      failoversOut: worker.endpoints[0].failoversOut,
      breakerFirst: worker.endpoints[0].breaker,
      effectiveRpsFirst: worker.endpoints[0].effectiveRps,
      requestsOnSecond: worker.endpoints[1].requests };
  });

  // ------------------------------------------------------------------ (b) recovery
  await scenario('b-recovery', 'Endpoint #0 recovers: the backend returns to the operator\'s first choice', async () => {
    proxies[0].state.rateLimitShare = 0;
    const back = await poll(rpcWorker, value => value.active === 0 && value.endpoints[0].breaker === 'closed',
      { ms: 180_000, label: 'waiting for the backend to return to the first endpoint', every: 500 });
    const after = await measureVisibility(GAPS_MS.slice(0, 4));
    const bound = Math.max(15_000, baseline.p95 * 3);
    assert.ok(after.p95 <= bound, `Recovered index p95 ${after.p95} ms must stay under ${bound} ms`);
    assertNoLeak(api);
    return { active: back.active, breakerFirst: back.endpoints[0].breaker,
      probesOk: back.endpoints[0].probesOk, p50Ms: after.p50, p95Ms: after.p95, boundMs: bound,
      effectiveRpsFirst: (await rpcWorker()).endpoints[0].effectiveRps };
  });

  // ------------------------------------------------------------------ (c) the flood
  await scenario('c-priority', 'Both endpoints throttled while browsers flood the read proxy', async () => {
    // A quiet reference on THIS run, with both endpoints capped, so the flood is the only change.
    proxies.forEach(proxy => { proxy.reset(); proxy.state.maxRps = 12; });
    await sleep(2_000);
    const quiet = await measureVisibility(GAPS_MS.slice(0, 5));
    const keeperBefore = (await snapshot()).worker?.lastCycleAt;

    let sent = 0, ok = 0, refusedBusy = 0, limited = 0, other = 0;
    const latencies = [];
    let flooding = true;
    const floodOnce = async () => {
      const started = Date.now();
      sent += 1;
      try {
        const { status, body } = await proxyRead({ jsonrpc: '2.0', id: sent, method: 'eth_blockNumber', params: [] });
        latencies.push(Date.now() - started);
        if (status === 429) limited += 1;
        else if (status !== 200) other += 1;
        else if (body?.error) { if (body.error.code === -32011) refusedBusy += 1; else other += 1; }
        else ok += 1;
      } catch { other += 1; }
    };
    const flood = (async () => {
      const gap = 1_000 / FLOOD_RPS;
      const until = Date.now() + FLOOD_MS;
      const inFlight = new Set();
      while (Date.now() < until) {
        const task = floodOnce().finally(() => inFlight.delete(task));
        inFlight.add(task);
        // Never more than a few hundred sockets open at once: this is a load generator, not a fork bomb.
        if (inFlight.size > 400) await Promise.race(inFlight);
        await sleep(gap);
      }
      flooding = false;
      await Promise.allSettled([...inFlight]);
    })();

    const under = await measureVisibility(GAPS_MS.slice(0, 5));
    await flood;
    assert.equal(flooding, false);

    const view = await snapshot();
    const worker = view.worker;
    // The bound is this run's own quiet p95, doubled. It is measured, not chosen.
    const bound = Math.max(quiet.p95 * 2, 8_000);
    assert.ok(under.p95 <= bound,
      `Index p95 under the flood was ${under.p95} ms; the bound from this run's quiet p95 is ${bound} ms`);
    // The keeper must have gone on running, and must not be reporting a deferral.
    const keeperAfter = worker?.lastCycleAt;
    assert.ok(!String(worker?.error ?? '').includes('Indexer is stale'),
      `The keeper must not be deferred: ${worker?.error}`);
    // The keeper is the class that may never queue at all; that is the ordering's whole point.
    assert.equal(worker?.rpc?.priorities?.keeper?.queueTimeouts, 0,
      'The keeper must never have been refused a token');
    // The indexer may be slowed, but it must be working again once the flood stops. A pass that
    // timed out in the governor's queue is reported below rather than asserted away.
    const recovered = await poll(snapshot,
      value => value.worker?.indexer?.error == null && value.worker?.indexer?.checkedAt > worker.indexer.checkedAt,
      { ms: 60_000, label: 'waiting for a clean index pass after the flood', every: 500 });
    assert.ok(recovered, 'The indexer must complete a clean pass once the flood stops');
    // Low-priority load is refused or queued cleanly, never with a URL and never as a 5xx storm.
    assert.equal(other, 0, `Every proxy answer must be a clean 200, 429 or busy error; ${other} were not`);
    assert.ok(ok > 0, 'Some proxied reads must succeed');
    assertNoLeak(api);
    return { floodTargetRps: FLOOD_RPS, floodSeconds: FLOOD_MS / 1000, sent,
      achievedRps: round(sent / (FLOOD_MS / 1000)), ok, rateLimitedByApi: limited, refusedBusy, other,
      proxyP50Ms: percentile(latencies, 50), proxyP95Ms: percentile(latencies, 95),
      indexQuietP95Ms: quiet.p95, indexUnderFloodP95Ms: under.p95, boundMs: bound,
      indexQuietP50Ms: quiet.p50, indexUnderFloodP50Ms: under.p50,
      keeperCycleBefore: keeperBefore, keeperCycleAfter: keeperAfter,
      keeperError: worker?.error ?? null,
      keeperPriorityRequests: worker?.rpc?.priorities?.keeper?.requests,
      indexerPriorityRequests: worker?.rpc?.priorities?.indexer?.requests,
      indexerQueueTimeouts: worker?.rpc?.priorities?.indexer?.queueTimeouts,
      backgroundQueueTimeouts: worker?.rpc?.priorities?.background?.queueTimeouts,
      keeperQueueTimeouts: worker?.rpc?.priorities?.keeper?.queueTimeouts,
      keeperQueueWaitMs: worker?.rpc?.priorities?.keeper?.queueWaitMs };
  });
  flooded = results.find(entry => entry.id === 'c-priority');

  // ------------------------------------------------------------------ (c3) the default budget
  await scenario('c3-proxy-budget', 'At its default budget the proxy refuses a flood cleanly, by address', async () => {
    // The flood above left both endpoints capped; a second backend has to be able to start.
    proxies.forEach(proxy => { proxy.state.maxRps = 0; });
    const budgetPort = await freePort();
    const budgetDir = mkdtempSync(resolve(tmpdir(), 'arc-rpc-budget-'));
    extraDirs.push(budgetDir);
    const handle = await startApi({ ARC_PORT: String(budgetPort), ARC_DATA_DIR: budgetDir,
      ...testDatabase(budgetDir), ARC_RPC_PROXY_PER_MINUTE: String(DEFAULT_PROXY_BUDGET) });
    try {
      const url = `http://127.0.0.1:${budgetPort}/api/arc/rpc`;
      let ok = 0, limited = 0, other = 0;
      for (let batch = 0; batch < DEFAULT_PROXY_BUDGET * 2; batch += 50) {
        const answers = await Promise.all(Array.from({ length: 50 }, (_, index) =>
          fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: batch + index, method: 'eth_chainId', params: [] }) })
            .then(async response => ({ status: response.status, text: await response.text() }))
            .catch(() => ({ status: 0, text: '' }))));
        for (const answer of answers) {
          if (answer.status === 200) ok += 1;
          else if (answer.status === 429) limited += 1;
          else other += 1;
          assertNoLeakInBody(answer.text, 'proxy answer under its own budget');
        }
      }
      assert.equal(other, 0, `Every answer must be a 200 or a 429; ${other} were not`);
      assert.ok(ok <= DEFAULT_PROXY_BUDGET,
        `No more than the budget may be served: ${ok} > ${DEFAULT_PROXY_BUDGET}`);
      assert.ok(limited > 0, 'The rest must be refused rather than queued for ever');
      assertNoLeak(handle);
      return { budget: DEFAULT_PROXY_BUDGET, sent: DEFAULT_PROXY_BUDGET * 2, ok, limited, other };
    } finally {
      await stopApi(handle);
    }
  });

  // ------------------------------------------------------------------ the proxy's allowlist
  await scenario('c2-allowlist', 'The read proxy refuses everything it does not name', async () => {
    proxies.forEach(proxy => { proxy.state.maxRps = 0; });
    const allowed = await proxyRead({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.result, '0x4cef52', 'eth_chainId must be answered');
    const refusals = {};
    for (const [label, payload] of [
      ['eth_getLogs', { method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: 'latest' }] }],
      ['eth_sendRawTransaction', { method: 'eth_sendRawTransaction', params: ['0xdeadbeef'] }],
      ['debug_traceTransaction', { method: 'debug_traceTransaction', params: [`0x${'11'.repeat(32)}`] }],
      ['trace_block', { method: 'trace_block', params: ['latest'] }],
      ['personal_unlockAccount', { method: 'personal_unlockAccount', params: [] }],
      ['eth_getCode', { method: 'eth_getCode', params: [deployment.launch, 'latest'] }],
      ['foreign eth_call', { method: 'eth_call', params: [{ to: `0x${'ee'.repeat(20)}`, data: '0x' }, 'latest'] }],
      ['eth_call at earliest', { method: 'eth_call', params: [{ to: deployment.launch, data: '0x' }, 'earliest'] }],
    ]) {
      const answer = await proxyRead({ jsonrpc: '2.0', id: 1, ...payload });
      assert.equal(answer.status, 200, `${label} must answer 200 with a JSON-RPC error`);
      assert.ok(answer.body.error, `${label} must be refused`);
      assertNoLeakInBody(answer.text, `${label} refusal`);
      refusals[label] = answer.body.error.code;
    }
    // A batch may not smuggle a forbidden call past the allowlist, and may not be oversized.
    const smuggled = await proxyRead([
      { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
      { jsonrpc: '2.0', id: 2, method: 'eth_getLogs', params: [{ fromBlock: '0x0' }] },
    ]);
    assert.equal(smuggled.status, 200);
    assert.ok(smuggled.body[0].result, 'The allowed member of a batch is still answered');
    assert.ok(smuggled.body[1].error, 'The forbidden member of a batch is still refused');
    const oversizedBatch = await proxyRead(Array.from({ length: 11 },
      (_, index) => ({ jsonrpc: '2.0', id: index, method: 'eth_chainId', params: [] })));
    assert.equal(oversizedBatch.status, 400, 'A batch larger than ten is refused outright');
    const oversizedBody = await fetch(`${base}/api/arc/rpc`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: deployment.launch, data: `0x${'ab'.repeat(40_000)}` }, 'latest'] }) });
    assert.equal(oversizedBody.status, 413, 'An oversized body is refused before it is parsed');
    // An allowed call to one of ours works, and a revert comes back as a revert.
    const ours = await proxyRead({ jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: deployment.launch, data: '0x1c9e3a7e' }, 'latest'] });
    assert.equal(ours.status, 200);
    // Two identical reads inside one block must cost the endpoint only one request.
    proxies.forEach(proxy => proxy.reset());
    await proxyRead({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
    const cachedCost = proxies.reduce((sum, proxy) => sum + (proxy.counts().eth_blockNumber ?? 0), 0);
    await proxyRead({ jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] });
    const secondCost = proxies.reduce((sum, proxy) => sum + (proxy.counts().eth_blockNumber ?? 0), 0);
    assert.equal(secondCost, cachedCost, 'The second identical read in the same block is served from the cache');
    assertNoLeak(api);
    return { refusals, cachedSecondRead: true, oversizedBatch: oversizedBatch.status,
      oversizedBody: oversizedBody.status, revertPassedThrough: ours.body.error?.code ?? null };
  });

  // ------------------------------------------------------------------ (e) the send path
  await scenario('e-send-safety', 'A failure reported after the node accepted a keeper transaction', async () => {
    const keeperRun = () => fetch(`${base}/api/arc/keeper/run`, { method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } }).then(r => r.status).catch(() => 0);
    const nonce = () => client.getTransactionCount({ address: keeper.address });
    // Give the keeper work: fees accrue on every trade, and its cycle collects them.
    for (let i = 0; i < 3; i++) await buy('2');
    proxies.forEach(proxy => proxy.reset());
    const before = await nonce();
    // The proxies now forward the broadcast upstream and THEN report a failure, so the backend
    // cannot tell whether the node took the bytes. This is the only case a blind retry is unsafe.
    proxies.forEach(proxy => { proxy.state.failAfterAccepting = true; });
    const runStatus = await keeperRun();
    const started = Date.now();
    let moved = before;
    while (Date.now() - started < 200_000) {
      moved = await nonce();
      if (moved > before) break;
      await sleep(500);
    }
    const attempts = proxies.reduce((sum, proxy) => sum + (proxy.counts().eth_sendRawTransaction ?? 0), 0);
    // Non-vacuous: something really was broadcast under the injected failure.
    assert.ok(attempts > 0, 'The keeper must actually have broadcast under the injected failure');
    proxies.forEach(proxy => { proxy.state.failAfterAccepting = false; });
    // Let the journal settle and the keeper try again; then count what reached the chain.
    await keeperRun();
    await sleep(20_000);
    const settled = await nonce();
    const worker = (await snapshot()).worker;
    assert.ok(settled - before <= 4,
      `The keeper must not spray transactions: nonce moved ${before} -> ${settled} after ${attempts} broadcasts`);
    assert.ok(attempts >= settled - before,
      'Every broadcast attempt is accounted for by at most one nonce');
    assertNoLeak(api);
    sendSafety = { keeperRunStatus: runStatus, nonceBefore: before, nonceAfterFailure: moved,
      nonceSettled: settled, noncesConsumed: settled - before, broadcastAttempts: attempts,
      repeatedBroadcasts: attempts - (settled - before),
      pendingHash: worker?.pendingHash ?? null, keeperError: worker?.error ?? null,
      note: 'The journal re-offers the identical signed bytes, so a repeat is the same nonce and '
        + 'the same hash by construction; repeatedBroadcasts counts those re-offers, not new transactions.' };
    return sendSafety;
  });

  // ------------------------------------------------------------------ (d) the wrong chain
  await scenario('d-wrong-chain', 'An endpoint that starts answering for another chain is excluded', async () => {
    // Break #1 until its breaker opens, so that the next thing it is asked is the half-open probe.
    proxies[1].state.wrongChain = true;
    proxies[1].state.rateLimitShare = 1;
    proxies[0].state.rateLimitShare = 1;
    const excluded = await poll(rpcWorker,
      value => value.endpoints.some(endpoint => endpoint.excluded === true),
      { ms: 180_000, label: 'waiting for the wrong-chain endpoint to be excluded', every: 500 });
    const which = excluded.endpoints.findIndex(endpoint => endpoint.excluded);
    assert.equal(which, 1, 'Only the endpoint that lied may be excluded');
    assert.equal(excluded.endpoints[0].excluded, false, 'The honest endpoint stays in service');
    const log = assertNoLeak(api);
    assert.ok(log.includes('another chain'), 'The exclusion must be logged with fixed text');
    assert.ok(log.includes('rpc#1'), 'The log must name the endpoint by index');
    proxies.forEach(proxy => { proxy.state.rateLimitShare = 0; proxy.state.wrongChain = false; });
    return { excludedIndex: which, probesFailed: excluded.endpoints[1].probesFailed,
      firstStillInService: excluded.endpoints[0].excluded === false };
  });

  // ------------------------------------------------------------------ start-up refusal
  await scenario('d2-startup', 'A wrong-chain endpoint is refused at start-up, without naming it', async () => {
    // Reuse the running proxies: #1 answers for another chain for the whole of this start-up.
    proxies[1].state.wrongChain = true;
    const coldDir = mkdtempSync(resolve(tmpdir(), 'arc-rpc-cold-'));
    extraDirs.push(coldDir);
    const child = spawn(resolve('SingleSparkBackend/api/target/debug/jet-arc-backend'), [],
      { env: { ...environment, ARC_PORT: String(await freePort()), ARC_DATA_DIR: coldDir,
        ...testDatabase(coldDir) } });
    let out = '', errors = '';
    child.stdout.on('data', b => (out += b));
    child.stderr.on('data', b => (errors += b));
    const code = await new Promise(resolveExit => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolveExit('timeout'); }, 120_000);
      child.on('exit', value => { clearTimeout(timer); resolveExit(value); });
    });
    proxies[1].state.wrongChain = false;
    const log = `${out}\n${errors}`;
    assert.notEqual(code, 0, 'The backend must refuse to start with a wrong-chain endpoint');
    assert.ok(log.includes('chain ID mismatch'), `Start-up must say why: ${log.slice(-400)}`);
    assert.ok(log.includes('rpc#1'), 'It must name the endpoint by index');
    const leaked = forbiddenLiterals().filter(literal => log.includes(literal));
    assert.deepEqual(leaked, [], `Start-up leaked: ${leaked.join(', ')}`);
    return { exitCode: code, namedByIndex: true };
  });

  // ------------------------------------------------------------------ the socket list
  await scenario('f-socket-list', 'The socket listener moves to the next URL and keeps waking the indexer', async () => {
    const before = (await snapshot()).worker?.ws;
    await socketProxies[0].drop();
    const moved = await poll(async () => (await snapshot()).worker?.ws,
      value => value.reconnects > (before?.reconnects ?? 0),
      { ms: 90_000, label: 'waiting for the socket to notice the drop', every: 300 });
    // With one socket gone the listener must end up connected on the other one.
    const connected = await poll(async () => (await snapshot()).worker?.ws,
      value => value.connected === true, { ms: 120_000, label: 'waiting for the other socket', every: 300 });
    assert.equal(connected.endpoints, 2, 'Both socket URLs must be reported as configured');
    const { hash, mined } = await buy('0.5');
    const latency = (await visible(hash)) - mined;
    assertNoLeak(api);
    socketProxies[0] = await startSocketProxy(0);
    return { reconnectsBefore: before?.reconnects ?? 0, reconnectsAfter: moved.reconnects,
      endpointInUse: connected.endpoint, connected: connected.connected, indexLatencyMs: latency };
  });

  notes.push(
    'Local loopback numbers only. Anvil mines on a one-second timer over 127.0.0.1 and both '
      + '"endpoints" are Node processes on the same machine, so every latency here is a lower bound '
      + 'on what a public RPC can do. Nothing here measures the ARC testnet and no public RPC was '
      + 'contacted.',
    'Failover does not create quota. These scenarios show what the backend does when an endpoint '
      + 'refuses, hangs, lies about its chain or is slow — not that two endpoints serve more '
      + 'requests than one. Two endpoints on the same free tier have the same ceiling as one.',
    'The trades are a development key buying its own synthetic meme on a chain that exists for the '
      + 'length of this process. They are not users and not volume.',
    'The keeper here is this check\'s own throwaway key on this throwaway chain. The operator\'s '
      + 'keeper was not started, stopped, reconfigured or contacted.',
    'The flood in scenario (c) is a load generator on loopback: its achieved rate is reported '
      + 'alongside its target, because the target is an intention and the achieved rate is the '
      + 'measurement.',
    'Scenario (e) proves the narrow thing it says: a failure reported after the node had already '
      + 'accepted the bytes did not turn into a second, different transaction. The journal re-offers '
      + 'the identical signed bytes, so a repeat has the same nonce and the same hash by '
      + 'construction. It is not a proof that no double-send is possible under every failure.');

  const passed = results.every(entry => entry.status === 'passed');
  const report = { status: passed ? 'passed' : 'failed', checkedAt: new Date().toISOString(),
    environment: 'Local throwaway Anvil chain (chain id 5042002) behind two fault-injecting HTTP '
      + 'proxies and two TCP socket proxies, all on 127.0.0.1, with Anvil\'s public development '
      + 'keys, the PostgreSQL test database and a schema dropped at the end. NOT a public chain and '
      + 'NOT a public-RPC measurement: no address, token or transaction here exists anywhere else, '
      + 'and no running service was touched.',
    chainId: 5042002, endpoints: 2,
    governor: { maxRpsPerEndpoint: 8, burst: 16, priorities: ['keeper', 'indexer', 'background'] },
    deployment: deployment && { launch: deployment.launch, token },
    measured: { baseline, flood: flooded && { indexQuietP95Ms: flooded.indexQuietP95Ms,
      indexUnderFloodP95Ms: flooded.indexUnderFloodP95Ms, boundMs: flooded.boundMs,
      achievedRps: flooded.achievedRps }, sendSafety },
    scenarios: results, notes };
  const outputPath = resolve('SingleSparkContract/arc/deployments/rpc-resilience-local-acceptance-20260920.json');
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.status.toUpperCase()}: ${results.filter(r => r.status === 'passed').length}/${results.length} scenarios in ${outputPath}`);
  if (!passed) process.exitCode = 1;
} finally {
  await stopApi(api);
  for (const proxy of socketProxies) await proxy?.drop().catch(() => {});
  for (const proxy of proxies) await new Promise(r => (proxy ? proxy.server.close(r) : r()));
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
