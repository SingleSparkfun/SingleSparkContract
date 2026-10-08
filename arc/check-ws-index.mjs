// WebSocket-triggered indexing, end to end on a local chain: node SingleSparkContract/arc/check-ws-index.mjs
//
// A throwaway Anvil chain (which serves JSON-RPC over HTTP and WebSocket on the same port),
// Anvil's public development keys, the PostgreSQL *test* database and an isolated schema that is
// dropped again at the end. Nothing here reaches a public chain and no running service is touched:
// every port is asked for from the kernel, never 8090 or 5176.
//
// EVERY NUMBER BELOW IS A LOCAL ANVIL NUMBER. Anvil mines instantly on a loopback socket, so the
// latencies measured here are a lower bound on what a public RPC can do; they are not a
// measurement of the ARC testnet and are not presented as one.
//
// Two small servers sit between the backend and Anvil so the check can see what the backend does:
//   * a counting HTTP proxy, which the backend uses as ARC_RPC_URL and which tallies every
//     JSON-RPC method name it forwards;
//   * a plain TCP proxy in front of Anvil's WebSocket, so the socket can be dropped mid-run and
//     brought back without restarting the chain.
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

/** A fake key in the bogus socket URL. It must never appear in the backend's output. */
const SECRET = 'SECRET123';
/** Trades measured for latency, spaced irregularly so no result is an artefact of one rhythm. */
const GAPS_MS = [250, 1_700, 400, 3_100, 900, 150, 2_400, 600, 1_200, 350, 2_000, 800];
/** How long each quiet window runs while a block a second is mined and nothing else happens. */
const QUIET_MS = 30_000;
/** The assertion bound for the socket path, chosen with margin under the five-second poll. */
const P95_BOUND_MS = 2_000;

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

const key = index => `0x${['ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'][index]}`;

const rpcPort = await freePort();
const countingPort = await freePort();
const socketProxyPort = await freePort();
const closedPort = await freePort();     // reserved, then left unbound: nothing ever listens here
const apiPort = await freePort();
const anvilUrl = `http://127.0.0.1:${rpcPort}`;
const countingUrl = `http://127.0.0.1:${countingPort}`;
const base = `http://127.0.0.1:${apiPort}`;

const anvil = spawn('anvil', ['--port', String(rpcPort), '--chain-id', '5042002', '--silent']);
let api, counting, socketProxy, schemaCreated = false, mining = null;

const account = privateKeyToAccount(key(0));
const keeperAddress = privateKeyToAccount(key(2)).address;
const operations = privateKeyToAccount(key(3)).address;
const platformCommunity = privateKeyToAccount(key(4)).address;

const chain = defineChain({ id: 5042002, name: 'Arc Local',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [anvilUrl] } } });
// The check talks to Anvil directly, so nothing it does is counted against the backend's RPC use.
const client = createPublicClient({ chain, transport: http(anvilUrl, { retryCount: 0 }),
  cacheTime: 0, pollingInterval: 50 });
const wallet = createWalletClient({ account, chain, transport: http(anvilUrl) });
const dir = mkdtempSync(resolve(tmpdir(), 'arc-ws-'));
const database = testDatabase(dir);

const results = [];
const notes = [];
let deployment, environment, token;

const scenario = async (id, title, body) => {
  const started = Date.now();
  try {
    const detail = (await body()) || {};
    results.push({ id, title, status: 'passed', seconds: Number(((Date.now() - started) / 1000).toFixed(1)), ...detail });
    console.log(`PASS ${id} :: ${title} :: ${JSON.stringify(detail)}`);
    return true;
  } catch (error) {
    results.push({ id, title, status: 'failed', seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
      expectedVsActual: error.message, stack: error.stack?.split('\n').slice(0, 8).join('\n') });
    console.error(`FAIL ${id} :: ${title} :: ${error.message}`);
    return false;
  }
};

// ---- the two proxies ------------------------------------------------------------------------
/** Forwards JSON-RPC to Anvil and tallies the method names, so "how much does the backend poll"
 *  is a measurement rather than a guess. */
const startCountingProxy = async () => {
  const counts = new Map();
  const server = createHttpServer((request, response) => {
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        for (const call of Array.isArray(parsed) ? parsed : [parsed]) {
          counts.set(call.method, (counts.get(call.method) ?? 0) + 1);
        }
      } catch { /* Not JSON: forwarded unchanged, just not counted. */ }
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
  await new Promise(r => server.listen(countingPort, '127.0.0.1', r));
  return { server, snapshot: () => Object.fromEntries([...counts].sort()) };
};
/** The difference between two method tallies. */
const since = (before, after) => {
  const delta = {};
  for (const [method, count] of Object.entries(after)) {
    const grew = count - (before[method] ?? 0);
    if (grew > 0) delta[method] = grew;
  }
  return delta;
};
const total = counts => Object.values(counts).reduce((sum, value) => sum + value, 0);

/** A TCP pipe to Anvil's WebSocket that the check can cut and re-open. */
const startSocketProxy = async () => {
  const live = new Set();
  const server = createTcpServer(downstream => {
    const upstream = tcpConnect(rpcPort, '127.0.0.1');
    live.add(downstream);
    live.add(upstream);
    const close = () => {
      for (const socket of [downstream, upstream]) {
        socket.destroy();
        live.delete(socket);
      }
    };
    downstream.on('error', close).on('close', close);
    upstream.on('error', close).on('close', close);
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });
  await new Promise(r => server.listen(socketProxyPort, '127.0.0.1', r));
  return {
    server,
    // The live sockets are destroyed FIRST: `server.close` waits for every connection to end, and
    // a WebSocket never ends on its own, so closing first would simply hang.
    drop: async () => {
      for (const socket of live) socket.destroy();
      live.clear();
      await new Promise(r => server.close(r));
    },
  };
};

// ---- chain helpers --------------------------------------------------------------------------
const call = async (address, abi, functionName, args = [], value = 0n) => {
  const hash = await wallet.writeContract({ address, abi, functionName, args, value });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', `${functionName} reverted`);
  return receipt;
};
const blockTime = async () => Number((await client.getBlock()).timestamp);
const deadline = async () => BigInt(await blockTime()) + 100n;
/** Anvil mines on submission, so the transaction is on chain by the time this resolves. */
const buy = async amount => {
  const hash = await wallet.writeContract({ address: deployment.launch, abi: arcAbi,
    functionName: 'trade', args: [token, true, parseEther(amount), 1n, await deadline()],
    value: parseEther(amount) });
  const mined = Date.now();
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', 'trade reverted');
  return { hash: hash.toLowerCase(), mined };
};
/** A block a second with nothing in it, the way a real chain keeps producing heads while idle. */
const startMining = () => {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      await client.request({ method: 'anvil_mine', params: ['0x1', '0x0'] }).catch(() => {});
      await sleep(1_000);
    }
  })();
  return async () => { stopped = true; await loop; };
};

// ---- API helpers ----------------------------------------------------------------------------
const snapshot = async () => {
  const response = await fetch(`${base}/api/arc/snapshot`);
  assert.equal(response.status, 200, 'snapshot must be 200');
  return response.json();
};
const poll = async (produce, predicate, { ms = 120_000, label = '', every = 100 } = {}) => {
  const until = Date.now() + ms;
  for (;;) {
    const last = await produce().catch(() => null);
    if (last && (await predicate(last))) return last;
    if (Date.now() > until) throw new Error(`Timed out ${label}; last: ${JSON.stringify(last).slice(0, 500)}`);
    await sleep(every);
  }
};
/** Mined -> visible in the public snapshot, sampled every 100 ms. */
const visible = async (hash, { ms = 60_000 } = {}) => {
  const view = await poll(snapshot,
    value => (value.trades ?? []).some(trade => trade.transactionHash?.toLowerCase() === hash),
    { ms, label: `waiting for trade ${hash.slice(0, 10)}` });
  return { at: Date.now(), trigger: view.worker?.indexer?.trigger, ws: view.worker?.ws };
};

const startApi = async (overrides = {}) => {
  const child = spawn(resolve('SingleSparkBackend/api/target/debug/jet-arc-backend'), [],
    { env: { ...environment, ...overrides } });
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
const assertNoLeak = (handle, forbidden) => {
  const log = `${handle.out()}\n${handle.errors()}`;
  const found = forbidden.filter(literal => log.includes(literal));
  assert.deepEqual(found, [], `The backend log leaked: ${found.join(', ')}`);
  return log;
};

let withSocket = {}, withoutSocket = {};

try {
  for (let i = 0; ; i++) {
    try { await client.getChainId(); break; } catch (error) { if (i > 50) throw error; await sleep(100); }
  }
  counting = await startCountingProxy();
  socketProxy = await startSocketProxy();
  await client.request({ method: 'anvil_setBlockTimestampInterval', params: [0] });

  const deployContract = async (name, args) => {
    const compiled = artifact(name);
    const hash = await wallet.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    return receipt.contractAddress;
  };

  // ------------------------------------------------------------------ Step 1: the stack
  await scenario('step1-stack', 'Deploy the factory and launch one meme to watch', async () => {
    const pool = await deployContract('PoolManager', [account.address]);
    const positionManager = await deployContract('PositionManager', [pool, zeroAddress, 100000, zeroAddress, zeroAddress]);
    deployment = await deployArc(client, wallet, { positionManager, keeper: keeperAddress, operations,
      community: platformCommunity, platformName: 'SingleSpark', platformSymbol: 'SPARK',
      minBuyback: '0.001', journalPath: resolve(dir, 'deployment.json') });
    environment = { ...process.env, ...database, ...localApiLimits, ARC_CHAIN_ID: '5042002',
      // Every backend RPC call goes through the counting proxy; the public URL stays direct.
      ARC_RPC_URL: countingUrl, ARC_PUBLIC_RPC_URL: anvilUrl,
      ARC_EXPLORER_URL: 'https://testnet.arcscan.app', ARC_WEB_ORIGIN: 'http://127.0.0.1:5176',
      ARC_HOST: '127.0.0.1', ARC_PORT: String(apiPort), ARC_DATA_DIR: dir,
      ARC_LAUNCH_ADDRESS: deployment.launch, ARC_QUOTER_ADDRESS: deployment.quoter,
      ARC_FROM_BLOCK: deployment.fromBlock, ARC_CONFIG_SIGNING_KEY: key(0),
      ARC_TREASURY_ENCRYPTION_KEY: '09'.repeat(32), ARC_CONFIG_KEY_ID: 'arc-local',
      ARC_GAS_RESERVE_USDC: '1', ARC_SLIPPAGE_BPS: '300',
      ARC_KEEPER_BATCH_SIZE: '20', ARC_MAX_GAS_PER_TX: '5000000',
      // No keeper key at all: this check is about index latency, and a second keeper is never wanted.
      ARC_KEEPER_PRIVATE_KEY: '', ARC_REWARDS_ADDRESS: '', ARC_REWARDS_FROM_BLOCK: '',
      ARC_SATISFACTION_ADDRESS: '', ARC_SATISFACTION_FROM_BLOCK: '',
      ARC_WS_URL: '', ARC_INDEX_IDLE_SECONDS: '15', ARC_INDEX_MIN_GAP_MS: '750' };
    schemaCreated = true;
    const receipt = await call(deployment.launch, arcAbi, 'launch',
      ['Socket Ember Cat', 'SOCKCAT', '', 0, 0, privateKeyToAccount(`0x${'d1'.repeat(32)}`).address]);
    token = parseEventLogs({ abi: arcAbi, eventName: 'Launched', logs: receipt.logs })[0].args.token;
    // Clear the three-second opening window before any measured trade.
    await client.request({ method: 'evm_setNextBlockTimestamp', params: [(await blockTime()) + 10] });
    await client.request({ method: 'evm_mine', params: [] });
    return { launch: deployment.launch, token, schema: database.ARC_DATABASE_SCHEMA, keeper: 'disabled' };
  });

  // ------------------------------------------------------------------ Step 2: with the socket
  await scenario('step2-socket', `${GAPS_MS.length} trades with ARC_WS_URL set: mined to visible`, async () => {
    api = await startApi({ ARC_WS_URL: `ws://127.0.0.1:${rpcPort}` });
    await poll(snapshot, value => (value.tokens ?? []).length >= 2,
      { ms: 90_000, label: 'waiting for the first snapshot', every: 200 });
    const connected = await poll(snapshot, value => value.worker?.ws?.connected === true,
      { ms: 30_000, label: 'waiting for the socket to connect', every: 100 });
    assert.equal(connected.worker.ws.configured, true, 'The socket must be reported as configured');

    const samples = [];
    for (const gap of GAPS_MS) {
      const { hash, mined } = await buy('0.5');
      const seen = await visible(hash);
      samples.push({ hash, latencyMs: seen.at - mined, trigger: seen.trigger,
        connected: seen.ws?.connected, headAgeMs: seen.ws?.lastHeadAgeMs });
      await sleep(gap);
    }
    const latencies = samples.map(sample => sample.latencyMs);
    const triggers = samples.map(sample => sample.trigger);
    assert.deepEqual([...new Set(samples.map(s => s.connected))], [true],
      'The socket must stay connected for every measured trade');
    // A trade mined while a safety poll is already in flight is picked up by that poll, which is
    // correct but not socket-triggered. It is rare (a pass takes tens of milliseconds out of
    // fifteen seconds), so one is tolerated and reported rather than asserted away.
    const wsRuns = triggers.filter(trigger => trigger === 'ws').length;
    assert.ok(wsRuns >= triggers.length - 1,
      `Socket-triggered runs must index these trades, got ${JSON.stringify(triggers)}`);
    const p95 = percentile(latencies, 95);
    assert.ok(p95 < P95_BOUND_MS, `p95 ${p95} ms must stay under ${P95_BOUND_MS} ms`);
    assert.ok(Math.max(...latencies) < 5_000,
      `No measured trade may take as long as the poll it replaces (worst ${Math.max(...latencies)} ms)`);
    withSocket = { trades: samples.length, latencies,
      minMs: Math.min(...latencies), medianMs: percentile(latencies, 50), p95Ms: p95,
      maxMs: Math.max(...latencies), socketTriggeredRuns: `${wsRuns}/${triggers.length}`, triggers };
    return withSocket;
  });

  // ------------------------------------------------------------------ Step 3: idle RPC cost
  await scenario('step3-idle-socket', 'A quiet half-minute with a healthy socket', async () => {
    mining = startMining();
    const before = counting.snapshot();
    await sleep(QUIET_MS);
    const delta = since(before, counting.snapshot());
    const view = await snapshot();
    assert.equal(view.worker.ws.connected, true, 'The socket must still be up');
    assert.ok(view.worker.ws.lastHeadAgeMs < 30_000, 'Heads must keep arriving while idle');
    withSocket.idle = { windowMs: QUIET_MS, methods: delta, totalCalls: total(delta) };
    return withSocket.idle;
  });

  // ------------------------------------------------------------------ Step 4: the bogus URL
  await scenario('step4-bogus', 'A socket URL nothing listens on: polling, no leak, growing counter', async () => {
    await stopApi(api);
    const bogus = `ws://127.0.0.1:${closedPort}/?apikey=${SECRET}`;
    api = await startApi({ ARC_WS_URL: bogus });
    await poll(snapshot, value => value.worker?.ws?.configured === true,
      { ms: 90_000, label: 'waiting for the first snapshot', every: 200 });
    // Long enough for several failed attempts at the one-second end of the back-off schedule.
    await sleep(8_000);
    const view = await snapshot();
    assert.equal(view.worker.ws.connected, false, 'A closed port cannot be connected');
    assert.equal(view.worker.ws.lastHeadAgeMs, null, 'No head can have arrived');
    assert.ok(view.worker.ws.reconnects >= 3,
      `The reconnect counter must grow, got ${view.worker.ws.reconnects}`);

    const idleBefore = counting.snapshot();
    const { hash, mined } = await buy('0.5');
    const seen = await visible(hash, { ms: 30_000 });
    const latency = seen.at - mined;
    assert.equal(seen.trigger, 'poll', 'With no socket the run is a poll');
    assert.ok(latency < 12_000, `Polling must stay within today's bounds, got ${latency} ms`);
    await sleep(QUIET_MS);
    const delta = since(idleBefore, counting.snapshot());

    const growing = (await snapshot()).worker.ws.reconnects;
    assert.ok(growing > view.worker.ws.reconnects, 'The counter must keep growing while it cannot connect');
    // Nothing about the URL, its port or its key may appear anywhere in the process output.
    // A bare port number would be a false positive (it can appear inside a block number), so the
    // literals checked are the URL, its host:port, its query and the key itself.
    const log = assertNoLeak(api, [SECRET, 'apikey', bogus, `127.0.0.1:${closedPort}`]);
    assert.ok(/ARC ws: could not connect; retrying/.test(log),
      'The fixed failure line must be printed at least once');
    assert.ok((log.match(/ARC ws: could not connect; retrying/g) ?? []).length <= 5,
      'A socket that can never connect must not flood the log');
    withoutSocket = { reconnects: growing, latencyMs: latency, trigger: seen.trigger,
      idle: { windowMs: QUIET_MS, methods: delta, totalCalls: total(delta) },
      failureLines: (log.match(/ARC ws: could not connect; retrying/g) ?? []).length };
    return withoutSocket;
  });

  // ------------------------------------------------------------------ Step 5: cut and restored
  await scenario('step5-cut', 'The socket dies mid-run: fall back, index anyway, then recover', async () => {
    await stopApi(api);
    api = await startApi({ ARC_WS_URL: `ws://127.0.0.1:${socketProxyPort}` });
    await poll(snapshot, value => value.worker?.ws?.connected === true,
      { ms: 90_000, label: 'waiting for the proxied socket', every: 100 });
    const before = (await snapshot()).worker.ws.reconnects;

    await socketProxy.drop();
    const down = await poll(snapshot, value => value.worker?.ws?.connected === false,
      { ms: 30_000, label: 'waiting for the backend to notice the cut', every: 100 });
    assert.equal(down.worker.ws.connected, false);

    // A trade made while the socket is down must still be indexed, within today's bounds. The
    // trigger label is recorded rather than asserted: a wake queued in the instant before the
    // socket died is still owed one follow-up run, and that run is honestly attributed to the
    // socket even though the socket is already gone. What matters is the two facts below.
    const { hash, mined } = await buy('0.5');
    const seen = await visible(hash, { ms: 30_000 });
    const downLatency = seen.at - mined;
    assert.equal(seen.ws?.connected, false, 'The socket must still be down when this is indexed');
    assert.ok(downLatency < 12_000, `The fallback must stay within today's bounds, got ${downLatency} ms`);

    socketProxy = await startSocketProxy();
    const back = await poll(snapshot, value => value.worker?.ws?.connected === true,
      { ms: 60_000, label: 'waiting for the socket to come back', every: 200 });
    assert.ok(back.worker.ws.reconnects > before,
      `The reconnect counter must record the outage, ${back.worker.ws.reconnects} vs ${before}`);
    // And the socket is doing its job again.
    const after = await buy('0.5');
    const recovered = await visible(after.hash, { ms: 30_000 });
    const backLatency = recovered.at - after.mined;
    assert.equal(recovered.trigger, 'ws', 'After recovery the run is socket-triggered again');
    assert.ok(backLatency < P95_BOUND_MS, `Recovered latency ${backLatency} ms`);
    assertNoLeak(api, [SECRET, `127.0.0.1:${socketProxyPort}`]);
    return { reconnectsBefore: before, reconnectsAfter: back.worker.ws.reconnects,
      whileDownMs: downLatency, whileDownTrigger: seen.trigger,
      afterRecoveryMs: backLatency, afterRecoveryTrigger: recovered.trigger };
  });

  notes.push(
    'Local Anvil numbers only. Anvil mines instantly over loopback, so these latencies are a lower '
      + 'bound on what any public RPC can do; nothing here measures the ARC testnet and no public '
      + 'RPC was contacted.',
    'The backend ran with no keeper signing key at all, so it started no keeper loop and signed '
      + 'nothing. This check is about index latency.',
    'Idle RPC cost is counted by a proxy the backend uses as ARC_RPC_URL, while a block a second is '
      + 'mined with no transactions in it — the way a real chain keeps producing heads while quiet. '
      + 'With a healthy socket the indexer runs its safety poll every 15 s; without one it runs '
      + 'every 5 s, and the tallies below are that difference, not a claim about any other cost.',
    'The trades are a development key buying its own synthetic meme on a chain that exists for the '
      + 'length of this process. They are not users and not volume.',
    'The socket is only an alarm clock: every read and write in these runs went through the same '
      + 'incremental eth_getLogs path from the persisted checkpoint that the five-second poll uses.');

  const passed = results.every(entry => entry.status === 'passed');
  const report = { status: passed ? 'passed' : 'failed', checkedAt: new Date().toISOString(),
    environment: 'Local throwaway Anvil chain (chain id 5042002) serving HTTP and WebSocket on one '
      + 'kernel-assigned port, with Anvil\'s public development keys, the PostgreSQL test database '
      + 'and a schema dropped at the end. NOT a public chain and NOT a public-RPC measurement: no '
      + 'address, token or transaction here exists anywhere else, and no running service was touched.',
    chainId: 5042002,
    measured: { withSocket, withoutSocket,
      idleCallReduction: withSocket.idle && withoutSocket.idle
        ? { windowMs: QUIET_MS, withSocket: withSocket.idle.totalCalls,
            withoutSocket: withoutSocket.idle.totalCalls,
            ratio: Number((withoutSocket.idle.totalCalls / Math.max(1, withSocket.idle.totalCalls)).toFixed(2)) }
        : null },
    deployment, scenarios: results, notes };
  const outputPath = resolve('SingleSparkContract/arc/deployments/ws-index-local-acceptance-20260920.json');
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.status.toUpperCase()}: ${results.filter(r => r.status === 'passed').length}/${results.length} scenarios in ${outputPath}`);
  if (!passed) process.exitCode = 1;
} finally {
  if (mining) await mining();
  await stopApi(api);
  await socketProxy?.drop().catch(() => {});
  await new Promise(r => (counting ? counting.server.close(r) : r()));
  anvil.kill('SIGTERM');
  if (schemaCreated) {
    try { testSql(dir, `DROP SCHEMA IF EXISTS "${database.ARC_DATABASE_SCHEMA}" CASCADE`); }
    catch (error) { console.error(`Could not drop the test schema: ${error.message}`); }
  }
}
