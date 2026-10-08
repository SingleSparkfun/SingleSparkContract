// 100-wallet concurrency test against the ARC public testnet.
// Controlled synthetic wallets only. Synthetic wallets are not users and their trades are not
// organic volume. Every transaction is signed once, journaled to disk and only ever re-broadcast
// as the identical signed bytes; reads use bounded jittered retries, sends never do.
// Sub-commands: --preflight --fund --launch --run --verify --sample-index --sample-api
//               --sample-proc --sample-keeper --stop --self-check
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync, statSync } from 'node:fs';
import { randomInt, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { createPublicClient, defineChain, http, custom, erc20Abi, parseEther, formatEther,
  encodeFunctionData, decodeFunctionData, parseEventLogs, parseTransaction, recoverTransactionAddress,
  keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { artifact } from './deploy.mjs';
import { persist, stringify } from './runtime.mjs';

// FeesAllocated keeps five fields. SPARK's two buyback fields sum to 90% on archived deployments
// or 94% on new deployments without a platform project treasury.
const MEME_SPLIT = [83n, 7n, 5n, 4n, 1n];
const PLATFORM_SPLIT = MEME_SPLIT;
const split = (native, weights) => {
  const parts = weights.slice(0, 4).map(w => native * w / 100n);
  return [...parts, native - parts.reduce((a, b) => a + b, 0n)];
};
const quantiles = (values, ps) => {
  if (!values.length) return ps.map(() => null);
  const sorted = [...values].sort((a, b) => a - b);
  return ps.map(p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]);
};
const rateLimited = detail => /rate limit|limit exceeded|-32005|429|too many/i.test(detail);
const transient = detail => rateLimited(detail) || /timeout|timed out|fetch failed|ECONNRESET|socket|terminated|503|502|504/i.test(detail);

if (process.argv.includes('--self-check')) {
  for (const n of [0n, 1n, 99n, 100n, parseEther('0.123456789')]) {
    assert.equal(split(n, MEME_SPLIT).reduce((a, b) => a + b), n);
    assert.equal(split(n, PLATFORM_SPLIT).reduce((a, b) => a + b), n);
  }
  assert.deepEqual(split(1000n, MEME_SPLIT), [830n, 70n, 50n, 40n, 10n]);
  // The platform token's two buyback legs both buy SPARK: 830 + 70 = 900 = the documented 90 %.
  assert.equal(split(1000n, PLATFORM_SPLIT)[0] + split(1000n, PLATFORM_SPLIT)[1], 900n);
  const noCommunity = split(1000n, MEME_SPLIT);
  noCommunity[1] += noCommunity[3]; noCommunity[3] = 0n;
  assert.deepEqual(noCommunity, [830n, 110n, 50n, 0n, 10n]);
  assert.deepEqual(quantiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [0.5, 0.9, 0.99]), [6, 10, 10]);
  assert.equal(rateLimited('server error -32005 rate limit'), true);
  assert.equal(rateLimited('execution reverted'), false);
  assert.equal(transient('UND_ERR_SOCKET terminated'), true);
  console.log('PASS: integer allocations for both splits, quantiles, error classification');
  process.exit(0);
}

process.loadEnvFile('SingleSparkContract/arc/.env.testnet.local');
process.loadEnvFile('SingleSparkContract/arc/.env.postgres.local');
const record = JSON.parse(readFileSync('SingleSparkContract/arc/deployments/arc-current-testnet.json'));
const deployment = record.deployment;
const schema = record.runtime.databaseSchema;
assert(/^[a-z0-9_]+$/.test(schema));
const API = record.runtime.api;
const RPC_URL = 'https://rpc.testnet.arc.network';
const batchDir = 'SingleSparkContract/arc/data/spark-test-wallets-20260917-gpEgqt';
const dir = `${batchDir}/stress-${deployment.launch.slice(2, 10)}`;
mkdirSync(dir, { recursive: true, mode: 0o700 });

const arg = (name, fallback) => {
  const hit = process.argv.find(s => s.startsWith(`--${name}=`));
  if (hit) return hit.split('=')[1];
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1] : fallback;
};
const has = name => process.argv.includes(`--${name}`);

const abi = artifact('ArcLaunchV2').abi;
const pmAbi = artifact('PoolManager').abi;
const quoterAbi = artifact('V4Quoter').abi;
const positionAbi = artifact('PositionManager').abi;
const executorAbi = artifact('ArcKeeperExecutor').abi;

const chain = defineChain({ id: 5042002, name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
const base = http(RPC_URL, { timeout: 20000, retryCount: 0 })({ chain });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One paced queue for the whole process. The pace is a client-side choice and is reported with the
// results: observed throughput is bounded by it unless the rate-limit counters dominate.
const pace = Number(arg('interval', '40'));
assert(Number.isInteger(pace) && pace >= 20 && pace <= 1000, 'RPC pacing must be 20-1000 ms');
const rpcStats = { requests: 0, errors: 0, rateLimited: 0, byMethod: {}, rateLimitedByMethod: {},
  peakInFlight: 0, sendRejectedByRateLimit: 0, sendRebroadcasts: 0 };
let queue = Promise.resolve(), nextAt = 0, inFlight = 0;
const SEND_METHODS = new Set(['eth_sendRawTransaction']);
const transport = custom({ request: async args => {
  const retries = SEND_METHODS.has(args.method) ? 0 : 3;
  for (let attempt = 0; ; attempt++) {
    const turn = queue.then(async () => { await sleep(Math.max(0, nextAt - Date.now())); nextAt = Date.now() + pace; });
    queue = turn.catch(() => {}); await turn;
    rpcStats.requests++; rpcStats.byMethod[args.method] = (rpcStats.byMethod[args.method] || 0) + 1;
    inFlight++; rpcStats.peakInFlight = Math.max(rpcStats.peakInFlight, inFlight);
    try { return await base.request(args); }
    catch (error) {
      rpcStats.errors++;
      const detail = String(error.details || error.shortMessage || error.message)
        .replace(/0x[0-9a-fA-F]{130,}/g, '[redacted]').slice(0, 240);
      if (rateLimited(detail)) {
        rpcStats.rateLimited++;
        rpcStats.rateLimitedByMethod[args.method] = (rpcStats.rateLimitedByMethod[args.method] || 0) + 1;
      }
      appendFileSync(`${dir}/rpc-errors.jsonl`,
        stringify({ at: new Date().toISOString(), method: args.method, detail, attempt }) + '\n', { mode: 0o600 });
      if (attempt >= retries || !transient(detail)) throw error;
      // Bounded jittered backoff for reads only; a send is never blindly repeated.
      nextAt = Math.max(nextAt, Date.now() + 400 * (attempt + 1) + randomInt(0, 400));
    } finally { inFlight--; }
  }
} }, { retryCount: 0 });
const client = createPublicClient({ chain, transport, cacheTime: 0 });
const read = (address, contractAbi, functionName, args = [], blockNumber) =>
  client.readContract({ address, abi: contractAbi, functionName, args, blockNumber });
const factory = (name, args = [], block) => read(deployment.launch, abi, name, args, block);
const same = (a, b, what = '') => assert.equal(String(a).toLowerCase(), String(b).toLowerCase(), what);
const safe = e => String(e.shortMessage || e.message || e).replace(/0x[0-9a-fA-F]{130,}/g, '[redacted]').slice(0, 220);

const api = async (path, body, token) => {
  const response = await fetch(API + path, { method: body == null ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body == null ? {} : { body: stringify(body) }), signal: AbortSignal.timeout(20000) });
  assert(response.ok, `API ${path}: ${response.status}`);
  return response.json();
};

const plan = JSON.parse(readFileSync(`${batchDir}/wallets.json`));
assert(plan.synthetic && plan.chainId === chain.id && plan.wallets.length === 100, 'wallet batch mismatch');
assert.equal(new Set(plan.wallets.map(w => w.address.toLowerCase())).size, 100);
const funder = privateKeyToAccount(process.env.ARC_DEPLOYER_PRIVATE_KEY);
same(funder.address, plan.fundingAddress, 'funder');
same(funder.address, '0x0CA76906cef08981717F81dFA1519b5A3Cecca57', 'authorised funder');

const RESERVE = parseEther('50');      // the funder must never drop below this
const BUDGET = parseEther('41');       // total authorised spend including gas
const PER_WALLET = parseEther('0.4');
const MAX_TX_GAS_COST = parseEther('0.2');

const statePath = `${dir}/run-state.json`;
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath)) : {
  synthetic: true, note: 'Controlled test wallets. Not users; these trades are not organic volume.',
  chainId: chain.id, launch: deployment.launch, createdAt: new Date().toISOString(), tokens: [], phases: {},
};
same(state.launch, deployment.launch, 'run state belongs to another factory');
const saveState = () => persist(statePath, state);

// ---------------------------------------------------------------- journaled sending
const walletPath = i => `${dir}/wallet-${i}.json`;
const loadWallet = (i, account) => {
  const path = walletPath(i);
  const value = existsSync(path) ? JSON.parse(readFileSync(path)) : {
    address: account.address, index: i, sends: 0, trades: 0, ok: 0, failed: 0, skipped: 0,
    gasSpent: '0', status: 'ready', approved: {},
  };
  same(value.address, account.address, 'wallet state mismatch');
  return { index: i, account, state: value, path };
};
const saveWallet = c => persist(c.path, c.state);

let feeCache = null, feeAt = 0, blockCache = null, blockAt = 0;
const headBlock = () => {
  if (!blockCache || Date.now() - blockAt > 3000) { blockAt = Date.now(); blockCache = client.getBlock(); }
  return blockCache;
};
const fees = () => {
  if (!feeCache || Date.now() - feeAt > 6000) {
    feeAt = Date.now();
    feeCache = headBlock().then(block => client.estimateFeesPerGas({ block }));
  }
  return feeCache;
};

// The public RPC answers eth_sendRawTransaction with -32005 "rate limit exceeded" under load. A rejected
// send never entered a mempool, so offering the SAME journaled bytes again is not a second transaction:
// same hash, same nonce. The receipt is re-checked before every offer, and the attempts are bounded.
async function broadcast(p) {
  for (let attempt = 0; ; attempt++) {
    try {
      same(await client.sendRawTransaction({ serializedTransaction: p.raw }), p.hash, 'hash');
      if (attempt) rpcStats.sendRebroadcasts++;
      return;
    } catch (error) {
      const message = String(error.details || error.shortMessage || error.message);
      if (/already known|nonce too low|already exists/i.test(message)) return;
      if (rateLimited(message)) rpcStats.sendRejectedByRateLimit++;
      if (attempt >= 5 || !transient(message)) throw error;
      await sleep(1500 * (attempt + 1) + randomInt(0, 1200));
      try { await client.getTransactionReceipt({ hash: p.hash }); return; }
      catch (e) { if (e.name !== 'TransactionReceiptNotFoundError') throw e; }
    }
  }
}

// Re-broadcasting the identical journaled bytes is idempotent: same hash, same nonce, no double spend.
async function settle(c, row) {
  const p = c.state.pending;
  assert(p && keccak256(p.raw) === p.hash, 'journal hash mismatch');
  const tx = parseTransaction(p.raw);
  assert.equal(tx.chainId, chain.id);
  same(await recoverTransactionAddress({ serializedTransaction: p.raw }), c.account.address, 'journal signer');
  assert(BigInt(tx.gas) * tx.maxFeePerGas <= MAX_TX_GAS_COST, 'per-transaction gas budget exceeded');
  let receipt = null;
  try { receipt = await client.getTransactionReceipt({ hash: p.hash }); }
  catch (e) { if (e.name !== 'TransactionReceiptNotFoundError') throw e; }
  const sentAt = Date.now();
  if (!receipt) {
    await broadcast(p);
    const until = Date.now() + 240000;
    while (!receipt) {
      // One receipt poll per wallet costs a slot in the shared RPC pace. With 100 wallets waiting at
      // once, polling faster than this starves the quote and estimate calls that start new trades.
      await sleep(4000 + randomInt(0, 2000));
      try { receipt = await client.getTransactionReceipt({ hash: p.hash }); }
      catch (e) { if (e.name !== 'TransactionReceiptNotFoundError') throw e; }
      if (!receipt && Date.now() > until) throw new Error('receipt timeout; signed bytes kept for reconciliation');
    }
  }
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (row) Object.assign(row, {
    sendMs: sentAt - row.signedAtMs, hash: p.hash, block: String(receipt.blockNumber),
    blockTimestamp: String(block.timestamp), gasUsed: String(receipt.gasUsed),
    gasCost: String(receipt.gasUsed * receipt.effectiveGasPrice), status: receipt.status,
    minedAt: new Date().toISOString(), wallMs: Date.now() - row.startedAtMs,
    wouldFailWithoutHeadroom: receipt.gasUsed > BigInt(row.estimate),
  });
  c.state.gasSpent = String(BigInt(c.state.gasSpent) + receipt.gasUsed * receipt.effectiveGasPrice);
  c.state.nonce = tx.nonce + 1;
  c.state.pending = null;
  c.state.sends++;
  saveWallet(c);
  return receipt;
}

async function submit(c, kind, to, contractAbi, functionName, args, value, row) {
  if (c.state.pending) return settle(c, null);
  const data = encodeFunctionData({ abi: contractAbi, functionName, args });
  const quoteStart = performance.now();
  const [estimated, f, balance] = await Promise.all([
    client.estimateGas({ account: c.account.address, prepare: false, to, data, value }),
    fees(), client.getBalance({ address: c.account.address }),
  ]);
  if (row) { row.estimate = String(estimated); row.estimateMs = +(performance.now() - quoteStart).toFixed(1); }
  const gas = estimated * 120n / 100n;   // 20% headroom: a keeper tx in the same block makes trades dearer
  assert(gas * f.maxFeePerGas <= MAX_TX_GAS_COST, 'per-transaction gas budget exceeded');
  if (value + gas * f.maxFeePerGas > balance) return null;
  if (c.state.nonce == null) {
    const [latest, pending] = await Promise.all(['latest', 'pending']
      .map(blockTag => client.getTransactionCount({ address: c.account.address, blockTag })));
    assert.equal(latest, pending, 'untracked pending transaction for this wallet');
    c.state.nonce = latest;
  }
  const raw = await c.account.signTransaction({ chainId: chain.id, to, data, value,
    nonce: c.state.nonce, gas, ...f, type: 'eip1559' });
  if (row) { row.gasLimit = String(gas); row.signedAtMs = Date.now(); }
  c.state.pending = { raw, hash: keccak256(raw), kind, to, createdAt: new Date().toISOString() };
  saveWallet(c);
  return settle(c, row);
}

// ---------------------------------------------------------------- phases
async function health() {
  const t0 = performance.now();
  const chainId = await client.getChainId();
  const rpcMs = performance.now() - t0;
  assert.equal(chainId, chain.id);
  assert.equal(keccak256(await client.getCode({ address: deployment.launch })), deployment.launchCodeHash,
    'factory code hash differs from the deployment record');
  const t1 = performance.now();
  const snapshot = await api('/api/arc/snapshot');
  const apiMs = performance.now() - t1;
  same(snapshot.launch, deployment.launch, 'backend serves another factory');
  return { chainId, rpcMs: +rpcMs.toFixed(1), apiMs: +apiMs.toFixed(1), snapshot };
}

async function preflight() {
  const { rpcMs, apiMs, snapshot } = await health();
  const funderBalance = await client.getBalance({ address: funder.address });
  const balances = [];
  for (const w of plan.wallets) balances.push(await client.getBalance({ address: w.address }));
  const held = balances.reduce((a, b) => a + b, 0n);
  const need = PER_WALLET * BigInt(plan.wallets.length);
  const result = {
    at: new Date().toISOString(), synthetic: true, rpcUrl: RPC_URL, api: API,
    rpcMs, apiMs, block: snapshot.blockNumber,
    worker: snapshot.worker, keeperErrors: snapshot.keeperErrors, tokenErrors: snapshot.tokenErrors,
    preflightSummary: snapshot.preflight,
    tokens: snapshot.tokens.map(t => ({ token: t.token, symbol: t.symbol, buyFee: t.buyFee, sellFee: t.sellFee })),
    funder: { address: funder.address, balance: formatEther(funderBalance) },
    wallets: { count: plan.wallets.length, held: formatEther(held),
      min: formatEther(balances.reduce((a, b) => a < b ? a : b)),
      max: formatEther(balances.reduce((a, b) => a > b ? a : b)) },
    plan: { perWallet: formatEther(PER_WALLET), fundingTotal: formatEther(need),
      budget: formatEther(BUDGET), reserve: formatEther(RESERVE),
      affordable: funderBalance - need > RESERVE && need < BUDGET },
  };
  state.phases.preflight = result;
  saveState();
  console.log(stringify(result));
  assert(result.plan.affordable, 'funding would break the reserve or the budget');
}

async function fund() {
  const journalPath = `${batchDir}/funding-journal-round2.json`;
  const reportPath = `${batchDir}/funding-report-round2.json`;
  const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath)) : { round: 2, chainId: chain.id, entries: {} };
  assert.equal(journal.chainId, chain.id);
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath)) : {
    round: 2, synthetic: true, chainId: chain.id, amountEach: formatEther(PER_WALLET),
    startedAt: new Date().toISOString(), funder: funder.address, rows: [],
  };
  const before = await client.getBalance({ address: funder.address });
  report.funderBefore = formatEther(before);
  let spent = 0n;
  let nonce = await client.getTransactionCount({ address: funder.address, blockTag: 'latest' });
  const pendingNonce = await client.getTransactionCount({ address: funder.address, blockTag: 'pending' });
  assert.equal(nonce, pendingNonce, 'funder has an untracked pending transaction');
  const f = await fees();
  for (const w of plan.wallets) {
    const key = w.address.toLowerCase();
    let entry = journal.entries[key];
    if (!entry) {
      const gas = 21000n;
      const cost = PER_WALLET + gas * f.maxFeePerGas;
      assert(gas * f.maxFeePerGas <= MAX_TX_GAS_COST);
      const balance = await client.getBalance({ address: funder.address });
      assert(balance - cost > RESERVE, 'funding would break the 50 USDC reserve');
      assert(spent + cost <= BUDGET, 'funding would break the 41 USDC budget');
      const raw = await funder.signTransaction({ chainId: chain.id, to: w.address, value: PER_WALLET,
        nonce, gas, ...f, type: 'eip1559' });
      entry = { hash: keccak256(raw), raw, nonce, at: new Date().toISOString() };
      journal.entries[key] = entry;
      persist(journalPath, journal);
    }
    let receipt = null;
    try { receipt = await client.getTransactionReceipt({ hash: entry.hash }); }
    catch (e) { if (e.name !== 'TransactionReceiptNotFoundError') throw e; }
    if (!receipt) {
      await broadcast(entry);
      const until = Date.now() + 120000;
      while (!receipt) {
        await sleep(1200);
        try { receipt = await client.getTransactionReceipt({ hash: entry.hash }); }
        catch (e) { if (e.name !== 'TransactionReceiptNotFoundError') throw e; }
        assert(receipt || Date.now() < until, 'funding receipt timeout');
      }
    }
    assert.equal(receipt.status, 'success', `funding ${w.address} reverted`);
    nonce = entry.nonce + 1;
    spent += PER_WALLET + receipt.gasUsed * receipt.effectiveGasPrice;
    const atBlock = await client.getBalance({ address: w.address, blockNumber: receipt.blockNumber });
    const row = { address: w.address, hash: entry.hash, block: String(receipt.blockNumber),
      gasCost: formatEther(receipt.gasUsed * receipt.effectiveGasPrice), balanceAtBlock: formatEther(atBlock) };
    assert(atBlock >= PER_WALLET, `balance at receipt block below the funded amount for ${w.address}`);
    const existing = report.rows.findIndex(r => r.address.toLowerCase() === key);
    if (existing >= 0) report.rows[existing] = row; else report.rows.push(row);
    persist(reportPath, report);
    if (report.rows.length % 20 === 0) console.log(stringify({ funded: report.rows.length }));
  }
  const after = await client.getBalance({ address: funder.address });
  report.funderAfter = formatEther(after);
  report.spent = formatEther(before - after);
  report.finishedAt = new Date().toISOString();
  report.status = 'complete';
  assert(after > RESERVE, 'funder dropped below the reserve');
  assert(before - after <= BUDGET, 'funding exceeded the authorised budget');
  persist(reportPath, report);
  state.phases.funding = { funderBefore: report.funderBefore, funderAfter: report.funderAfter,
    spent: report.spent, wallets: report.rows.length, report: reportPath };
  saveState();
  console.log(stringify(state.phases.funding));
}

const PLANS = [
  { name: 'Load Test A', symbol: 'LTA', buyFee: 20000, sellFee: 40000, image: 'SingleSparkFront/front/static/assets/tokens/ember-cat.png' },
  { name: 'Load Test B', symbol: 'LTB', buyFee: 50000, sellFee: 10000, image: 'SingleSparkFront/front/static/assets/tokens/moon-frog.png' },
];

async function launch() {
  const c = loadWallet(0, funder);
  const challenge = await api(`/api/auth/nonce?address=${funder.address}&chainId=${chain.id}`);
  const session = await api('/api/auth/login',
    { message: challenge.message, signature: await funder.signMessage({ message: challenge.message }), chainId: chain.id });
  state.launched = state.launched || [];
  for (const p of PLANS) {
    let entry = state.launched.find(e => e.symbol === p.symbol);
    if (!entry) { entry = { symbol: p.symbol, name: p.name, buyFee: p.buyFee, sellFee: p.sellFee }; state.launched.push(entry); saveState(); }
    if (!entry.community) {
      const treasury = await api('/api/arc/treasury',
        { requestId: `concurrency-${deployment.launch}-${p.symbol}` }, session.token);
      entry.community = treasury.address; saveState();
    }
    if (!entry.metadataURI) {
      const bytes = readFileSync(p.image);
      const upload = await fetch(`${API}/api/arc/media`, { method: 'POST',
        headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${session.token}` },
        body: bytes, signal: AbortSignal.timeout(20000) });
      assert(upload.ok, `media upload: ${upload.status}`);
      const { publicUrl } = await upload.json();
      const meta = await api('/api/arc/metadata',
        { name: p.name, symbol: p.symbol, image: publicUrl, channels: {} }, session.token);
      entry.imageUrl = publicUrl; entry.metadataURI = meta.metadataURI; saveState();
    }
    if (!entry.token) {
      const receipt = await submit(c, 'launch', deployment.launch, abi, 'launch',
        [p.name, p.symbol, entry.metadataURI, p.buyFee, p.sellFee, entry.community], 0n, null);
      assert(receipt && receipt.status === 'success', 'launch reverted');
      const [event] = parseEventLogs({ abi, eventName: 'Launched', logs: receipt.logs })
        .filter(e => e.address.toLowerCase() === deployment.launch.toLowerCase());
      assert.equal(event.args.symbol, p.symbol);
      entry.token = event.args.token;
      entry.launchHash = receipt.transactionHash;
      entry.launchBlock = String(receipt.blockNumber);
      entry.launchedAt = new Date().toISOString();
      saveState();
      console.log(stringify({ launched: p.symbol, token: entry.token, hash: entry.launchHash }));
    }
    const fees2 = await factory('tradeFees', [entry.token]);
    assert.deepEqual(fees2, [p.buyFee, p.sellFee], 'on-chain fees differ from the requested ones');
  }
  // Opening-tax protection charges 99 / 24.75 / 6.1875 % in seconds 0 / 1 / 2 of a token's life.
  const newest = state.launched.map(e => Date.parse(e.launchedAt)).reduce((a, b) => Math.max(a, b));
  const wait = Math.max(0, newest + 5000 - Date.now());
  if (wait) await sleep(wait);
  // Wait for the backend to index both tokens before trading against them.
  for (let i = 0; i < 40; i++) {
    const snapshot = await api('/api/arc/snapshot');
    const known = new Set(snapshot.tokens.map(t => t.token.toLowerCase()));
    if (state.launched.every(e => known.has(e.token.toLowerCase()))) {
      state.phases.launch = { at: new Date().toISOString(), tokens: state.launched,
        indexedAfterSeconds: i, launchGasUSDC: formatEther(BigInt(c.state.gasSpent)) };
      saveState(); console.log(stringify(state.phases.launch)); return;
    }
    await sleep(3000);
  }
  throw new Error('launched tokens were not indexed within 120 s');
}

async function tokenSet() {
  const snapshot = await api('/api/arc/snapshot');
  const tokens = [];
  for (const t of snapshot.tokens) {
    const positionId = BigInt((await factory('tokens', [t.token]))[0]);
    const [poolKey] = await read(deployment.positionManager, positionAbi, 'getPoolAndPositionInfo', [positionId]);
    same(poolKey.hooks, deployment.strategy, 'pool hook');
    tokens.push({ token: t.token, symbol: t.symbol, buyFee: t.buyFee, sellFee: t.sellFee,
      positionId: String(positionId), poolKey, platform: t.token.toLowerCase() === deployment.platformToken.toLowerCase() });
  }
  return tokens;
}

const quote = (t, buy, amount) => client.simulateContract({ address: deployment.quoter, abi: quoterAbi,
  functionName: 'quoteExactInputSingle', args: [{ poolKey: t.poolKey, zeroForOne: buy, exactAmount: amount, hookData: '0x' }] })
  .then(r => r.result[0]);

async function run() {
  const minutes = Number(arg('minutes', '30'));
  const concurrency = Number(arg('concurrency', '100'));
  assert(minutes > 0 && minutes <= 60 && concurrency >= 1 && concurrency <= 100);
  if (existsSync(`${dir}/run.lock`)) {
    const pid = Number(readFileSync(`${dir}/run.lock`, 'utf8').trim());
    // A graceful stop blanks the lock. Only a real, live pid blocks a restart.
    if (Number.isInteger(pid) && pid > 1) {
      let alive = true;
      try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
      assert(!alive, `another run is active (pid ${pid})`);
    }
  }
  writeFileSync(`${dir}/run.lock`, String(process.pid), { mode: 0o600 });
  const tokens = await tokenSet();
  assert(tokens.length >= 3, 'not enough tokens to spread the load over');
  const deadline = Date.now() + minutes * 60000;
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  state.phases.run = { startedAt: new Date().toISOString(), minutes, concurrency, pace,
    rpcUrl: RPC_URL, tokens: tokens.map(t => ({ token: t.token, symbol: t.symbol, buyFee: t.buyFee, sellFee: t.sellFee })) };
  saveState();

  const contexts = plan.wallets.slice(0, concurrency).map(w => {
    const c = loadWallet(w.index, privateKeyToAccount(w.privateKey));
    // Each wallet works a primary token and occasionally its neighbour, so approvals stay cheap.
    c.tokens = [tokens[w.index % tokens.length], tokens[(w.index + 1) % tokens.length]];
    return c;
  });
  const counters = { attempted: 0, mined: 0, failed: 0, skipped: 0, errors: 0, approvals: 0 };
  const logTrade = row => appendFileSync(`${dir}/trades.jsonl`, stringify(row) + '\n', { mode: 0o600 });

  async function worker(c) {
    c.state.status = 'running'; saveWallet(c);
    let consecutive = 0;
    while (!stopped && Date.now() < deadline) {
      try {
        if (c.state.pending) { await settle(c, null); continue; }
        const t = c.tokens[randomInt(0, 2)];
        const [native, held, f] = await Promise.all([
          client.getBalance({ address: c.account.address }),
          read(t.token, erc20Abi, 'balanceOf', [c.account.address]), fees(),
        ]);
        const reserve = 600000n * f.maxFeePerGas;   // keep enough for a buy and a sell
        if (native < 40000n * f.maxFeePerGas) {
          c.state.status = 'exhausted'; c.state.stopReason = 'below minimum transaction gas'; saveWallet(c); break;
        }
        let buy = randomInt(0, 2) === 1;
        if (held === 0n) buy = true;
        if (buy && native <= reserve * 2n) buy = false;
        if (!buy && held === 0n) { c.state.skipped++; counters.skipped++; await sleep(1000); continue; }
        if (!buy && !c.state.approved[t.token.toLowerCase()]) {
          const allowance = await read(t.token, erc20Abi, 'allowance', [c.account.address, deployment.launch]);
          if (allowance < parseEther('100000000')) {
            const receipt = await submit(c, 'approve', t.token, erc20Abi, 'approve',
              [deployment.launch, parseEther('1000000000')], 0n, null);
            if (!receipt) { c.state.status = 'exhausted'; c.state.stopReason = 'cannot afford an approval'; saveWallet(c); break; }
            counters.approvals++;
          }
          c.state.approved[t.token.toLowerCase()] = true; saveWallet(c);
        }
        const amount = buy
          ? (native - reserve * 2n) * BigInt(randomInt(10, 41)) / 100n
          : held * BigInt(randomInt(20, 61)) / 100n;
        if (amount <= 0n) { c.state.skipped++; counters.skipped++; await sleep(1000); continue; }
        const row = { wallet: c.index, address: c.account.address, token: t.token, symbol: t.symbol,
          side: buy ? 'buy' : 'sell', amountIn: String(amount), startedAtMs: Date.now(),
          startedAt: new Date().toISOString(), rateLimitedBefore: rpcStats.rateLimited };
        const q0 = performance.now();
        const [minOut, block] = await Promise.all([quote(t, buy, amount), headBlock()]);
        row.quoteMs = +(performance.now() - q0).toFixed(1);
        row.quotedOut = String(minOut);
        assert(minOut > 0n, 'quoter returned zero');
        counters.attempted++;
        const receipt = await submit(c, 'trade', deployment.launch, abi, 'trade',
          [t.token, buy, amount, minOut * 97n / 100n, block.timestamp + 115n], buy ? amount : 0n, row);
        if (!receipt) {
          row.status = 'unaffordable'; row.wallMs = Date.now() - row.startedAtMs;
          row.rateLimitHits = rpcStats.rateLimited - row.rateLimitedBefore;
          logTrade(row); c.state.skipped++; counters.skipped++; counters.attempted--;
          await sleep(1500); continue;
        }
        row.rateLimitHits = rpcStats.rateLimited - row.rateLimitedBefore;
        if (receipt.status === 'success') {
          const [event] = parseEventLogs({ abi, eventName: 'Traded', logs: receipt.logs })
            .filter(e => e.address.toLowerCase() === deployment.launch.toLowerCase());
          assert(event, 'successful trade without a Traded event');
          row.amountOut = String(event.args.amountOut);
          const [swap] = parseEventLogs({ abi: pmAbi, eventName: 'Swap', logs: receipt.logs })
            .filter(e => e.address.toLowerCase() === deployment.poolManager.toLowerCase());
          row.appliedFee = swap ? Number(swap.args.fee) : null;
          c.state.ok++; counters.mined++;
        } else {
          row.revertClass = 'reverted';
          c.state.failed++; counters.failed++;
        }
        c.state.trades++;
        logTrade(row);
        consecutive = 0; c.state.error = null; saveWallet(c);
        await sleep(1000 + randomInt(0, 7000));   // think time 1-8 s
      } catch (error) {
        const message = safe(error);
        counters.errors++; consecutive++;
        c.state.error = message; saveWallet(c);
        appendFileSync(`${dir}/worker-errors.jsonl`,
          stringify({ at: new Date().toISOString(), wallet: c.index, message }) + '\n', { mode: 0o600 });
        if (/insufficient funds/i.test(message) && !c.state.pending) {
          c.state.status = 'exhausted'; c.state.stopReason = 'cannot afford the estimated cost'; saveWallet(c); break;
        }
        if (error.code === 'ERR_ASSERTION' && !/quoter returned zero/.test(message)) {
          c.state.status = 'halted'; saveWallet(c); break;
        }
        await sleep(Math.min(15000, consecutive * 1500 + randomInt(0, 1000)));
      }
    }
    if (c.state.status === 'running') { c.state.status = stopped ? 'stopped' : 'time-box'; saveWallet(c); }
  }

  const heartbeat = setInterval(() => {
    const active = contexts.filter(c => !['exhausted', 'halted'].includes(c.state.status)).length;
    const line = { at: new Date().toISOString(), remainingSec: Math.max(0, Math.round((deadline - Date.now()) / 1000)),
      ...counters, active, rpc: { ...rpcStats, byMethod: undefined, rateLimitedByMethod: undefined } };
    appendFileSync(`${dir}/heartbeat.jsonl`, stringify(line) + '\n', { mode: 0o600 });
    console.log(stringify(line));
    // Stop early once almost every wallet is out of gas.
    if (contexts.filter(c => c.state.status === 'exhausted').length >= 90) stopped = true;
  }, 30000);

  await Promise.all(contexts.map(worker));
  clearInterval(heartbeat);
  state.phases.run.finishedAt = new Date().toISOString();
  state.phases.run.counters = counters;
  state.phases.run.rpc = rpcStats;
  state.phases.run.wallets = contexts.map(c => ({ index: c.index, address: c.account.address,
    status: c.state.status, stopReason: c.state.stopReason, trades: c.state.trades, ok: c.state.ok,
    failed: c.state.failed, skipped: c.state.skipped, gasUSDC: formatEther(BigInt(c.state.gasSpent)) }));
  saveState();
  try { writeFileSync(`${dir}/run.lock`, '', { mode: 0o600 }); } catch {}
  console.log(stringify({ done: true, ...counters, rpc: rpcStats }));
}

// ---------------------------------------------------------------- samplers
const nd = (file, row) => appendFileSync(`${dir}/${file}`, stringify(row) + '\n', { mode: 0o600 });
const untilArg = () => Date.now() + Number(arg('seconds', '600')) * 1000;

async function sampleIndex() {
  const end = untilArg();
  const seen = new Set();
  let stopped = false;
  process.on('SIGTERM', () => { stopped = true; });
  while (!stopped && Date.now() < end) {
    const t0 = Date.now();
    try {
      const response = await fetch(`${API}/api/arc/snapshot`, { signal: AbortSignal.timeout(10000) });
      if (response.ok) {
        const snapshot = await response.json();
        const now = Date.now();
        for (const trade of snapshot.trades || []) {
          const hash = trade.transactionHash.toLowerCase();
          if (seen.has(hash)) continue;
          seen.add(hash);
          nd('index-visibility.jsonl', { hash, block: trade.blockNumber, token: trade.token,
            blockTimestamp: trade.timestamp, firstSeenAtMs: now, firstSeenAt: new Date(now).toISOString(),
            trigger: snapshot.worker?.indexer?.trigger, indexerCheckedAt: snapshot.worker?.indexer?.checkedAt,
            indexerDurationMs: snapshot.worker?.indexer?.durationMs,
            ws: snapshot.worker?.ws });
        }
        nd('index-poll.jsonl', { at: new Date(now).toISOString(), trades: (snapshot.trades || []).length,
          block: snapshot.blockNumber, trigger: snapshot.worker?.indexer?.trigger,
          wsConnected: snapshot.worker?.ws?.connected, wsReconnects: snapshot.worker?.ws?.reconnects,
          busy: snapshot.worker?.busy });
      } else nd('index-poll.jsonl', { at: new Date().toISOString(), httpStatus: response.status });
    } catch (error) { nd('index-poll.jsonl', { at: new Date().toISOString(), error: safe(error) }); }
    await sleep(Math.max(0, 250 - (Date.now() - t0)));
  }
}

async function sampleApi() {
  const seconds = Number(arg('seconds', '60'));
  const readers = Number(arg('readers', '100'));
  const label = arg('label', 'api');
  const paths = ['/api/arc/snapshot', '/api/arc/satisfaction', '/api/arc/globe', '/api/arc/satisfaction/votes?round=8'];
  const end = Date.now() + seconds * 1000;
  const rows = [];
  const reader = async id => {
    while (Date.now() < end) {
      const path = paths[randomInt(0, paths.length)];
      const t0 = performance.now();
      try {
        const response = await fetch(API + path, { signal: AbortSignal.timeout(25000) });
        const body = await response.arrayBuffer();
        rows.push({ reader: id, path, ms: +(performance.now() - t0).toFixed(1),
          status: response.status, bytes: body.byteLength,
          connection: response.headers.get('connection') });
      } catch (error) {
        rows.push({ reader: id, path, ms: +(performance.now() - t0).toFixed(1), status: 0,
          errorClass: error.cause?.code || error.name || 'unknown', error: safe(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: readers }, (_, i) => reader(i)));
  const ok = rows.filter(r => r.status === 200).map(r => r.ms);
  const [p50, p95, p99] = quantiles(ok, [0.5, 0.95, 0.99]);
  const classes = {};
  for (const r of rows) {
    const key = r.status === 200 ? 'ok' : r.status ? `http_${r.status}` : r.errorClass;
    classes[key] = (classes[key] || 0) + 1;
  }
  const perPath = {};
  for (const r of rows) {
    const p = (perPath[r.path] ||= { total: 0, ok: 0, bytes: 0, classes: {} });
    p.total++;
    const key = r.status === 200 ? 'ok' : r.status ? `http_${r.status}` : r.errorClass;
    p.classes[key] = (p.classes[key] || 0) + 1;
    if (r.status === 200) { p.ok++; p.bytes = Math.max(p.bytes, r.bytes); }
  }
  const summary = { label, at: new Date().toISOString(), seconds, readers, requests: rows.length,
    ok: ok.length, p50, p95, p99, max: ok.length ? ok.reduce((a, b) => a > b ? a : b) : null, classes, perPath,
    failures: rows.filter(r => r.status !== 200 && !r.status).slice(0, 20) };
  nd('api-load.jsonl', summary);
  console.log(stringify(summary));
}

const exec = promisify(execFile);
async function sampleProc() {
  const end = untilArg();
  const pidPath = 'SingleSparkContract/arc/data/spark-satisfaction-testnet-20260919/backend.pid';
  const logPath = 'SingleSparkContract/arc/data/spark-satisfaction-testnet-20260919/backend.log';
  const pid = readFileSync(pidPath, 'utf8').trim().split(/\s+/)[0];
  assert(/^\d+$/.test(pid));
  const dbUrl = new URL(process.env.ARC_DATABASE_URL);
  const pgEnv = { ...process.env, PGHOST: dbUrl.hostname, PGPORT: dbUrl.port || '5432',
    PGUSER: decodeURIComponent(dbUrl.username), PGPASSWORD: decodeURIComponent(dbUrl.password),
    PGDATABASE: dbUrl.pathname.slice(1), PGOPTIONS: '-c statement_timeout=8000' };
  const sql = async query => (await exec('psql', ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', query],
    { env: pgEnv, timeout: 12000, maxBuffer: 20_000_000 })).stdout.trim();
  const logStart = existsSync(logPath) ? statSync(logPath).size : 0;
  nd('proc.jsonl', { at: new Date().toISOString(), logStartBytes: logStart, pid: Number(pid) });
  while (Date.now() < end) {
    const row = { at: new Date().toISOString() };
    try {
      const ps = await exec('ps', ['-o', 'rss=,%cpu=,etime=', '-p', pid]);
      const [rss, cpu, etime] = ps.stdout.trim().split(/\s+/);
      row.rssKb = Number(rss); row.cpuPercent = Number(cpu); row.elapsed = etime;
    } catch (e) { row.psError = safe(e); }
    try { row.threads = Number((await exec('ps', ['-M', '-p', pid])).stdout.trim().split('\n').length - 1); } catch {}
    try { row.openFds = (await exec('lsof', ['-p', pid])).stdout.trim().split('\n').length - 1; } catch (e) { row.lsofError = 'unavailable'; }
    try {
      const response = await fetch(`${API}/api/arc/snapshot`, { signal: AbortSignal.timeout(15000) });
      const body = Buffer.from(await response.arrayBuffer());
      row.snapshotBytes = body.length; row.snapshotGzipBytes = gzipSync(body).length;
      const snapshot = JSON.parse(body.toString());
      row.trades = (snapshot.trades || []).length;
      row.priceSeries = Object.keys(snapshot.prices || {}).length;
      row.wsConnected = snapshot.worker?.ws?.connected;
      row.wsReconnects = snapshot.worker?.ws?.reconnects;
      row.keeperErrors = (snapshot.keeperErrors || []).length;
    } catch (e) { row.snapshotError = safe(e); }
    try {
      row.schemaBytes = Number(await sql(
        `SELECT coalesce(sum(pg_total_relation_size(c.oid)),0)::bigint FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${schema}'`));
      row.marketHistoryRows = Number(await sql(`SELECT count(*) FROM "${schema}".market_history`).catch(() => '0'));
    } catch (e) { row.sqlError = 'unavailable'; }
    if (existsSync(logPath)) {
      const size = statSync(logPath).size;
      row.logBytes = size;
      if (size > logStart) {
        try {
          const text = readFileSync(logPath, 'utf8').slice(logStart);
          row.logCounts = {
            rpcRateLimited: (text.match(/-32005/g) || []).length,
            sendError: (text.match(/error sending request/g) || []).length,
            indexerStale: (text.match(/Indexer is stale; keeper execution deferred/g) || []).length,
            ws: (text.match(/ARC ws:/g) || []).length,
          };
        } catch {}
      }
    }
    nd('proc.jsonl', row);
    await sleep(10000);
  }
}

async function sampleKeeper() {
  const end = untilArg();
  const executor = deployment.keeperExecutor;
  const seen = new Set();
  let cursor = await client.getBlockNumber();
  while (Date.now() < end) {
    const row = { at: new Date().toISOString() };
    try {
      const snapshot = await api('/api/arc/snapshot');
      row.worker = snapshot.worker;
      row.keeperErrors = snapshot.keeperErrors;
      row.tokenErrors = (snapshot.tokenErrors || []).length;
      row.remainingInRound = snapshot.remainingInRound;
      row.pending = (snapshot.tokens || []).map(t => ({ symbol: t.symbol, pendingNative: t.pendingNative,
        cycles: t.cycles, totalBurned: t.totalBurned }));
    } catch (e) { row.apiError = safe(e); }
    try {
      const [head, gasAvailable, operatorBalance] = await Promise.all([
        client.getBlockNumber(), factory('keeperGasAvailable'),
        client.getBalance({ address: record.runtime.keeperOperator }),
      ]);
      row.head = String(head);
      row.keeperGasAvailable = formatEther(gasAvailable);
      row.operatorBalance = formatEther(operatorBalance);
      if (head > cursor) {
        const logs = await client.getLogs({ address: executor, fromBlock: cursor + 1n, toBlock: head });
        const parsed = parseEventLogs({ abi: executorAbi, eventName: 'Executed', logs });
        row.executed = parsed.map(e => ({ selector: e.args.selector, target: e.args.target,
          block: String(e.blockNumber), hash: e.transactionHash }));
        for (const e of row.executed) if (!seen.has(e.hash + e.selector)) seen.add(e.hash + e.selector);
        cursor = head;
      }
    } catch (e) { row.chainError = safe(e); }
    nd('keeper.jsonl', row);
    await sleep(15000);
  }
}

// ---------------------------------------------------------------- verification
const SELECTORS = Object.fromEntries(['collectFees', 'executeBurn', 'claimCommunity', 'claimOperations',
  'topUpKeeper'].map(name => {
  const entry = abi.find(e => e.type === 'function' && e.name === name);
  return [keccak256(Buffer.from(`${name}(${entry.inputs.map(i => i.type).join(',')})`)).slice(0, 10), name];
}));

async function verify() {
  const block = await client.getBlock({ blockTag: 'finalized' });
  const end = block.number;
  const rows = existsSync(`${dir}/trades.jsonl`)
    ? readFileSync(`${dir}/trades.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
  const mined = rows.filter(r => r.hash && r.block && BigInt(r.block) <= end);
  const ok = mined.filter(r => r.status === 'success');
  const fromBlock = BigInt(state.phases.launch?.tokens?.[0]?.launchBlock || state.phases.run?.fromBlock
    || (mined.length ? mined.reduce((a, r) => BigInt(r.block) < a ? BigInt(r.block) : a, BigInt(mined[0].block)) : end));
  const items = [];
  const item = (name, status, evidence) => { items.push({ name, status, evidence }); return status; };

  // Collect the factory's own events over the run window.
  const wanted = abi.filter(e => e.type === 'event' && ['Traded', 'FeesAllocated', 'Burned', 'FeesCollected'].includes(e.name));
  const logs = [];
  for (let from = fromBlock; from <= end; from += 2000n) {
    logs.push(...await client.getLogs({ address: deployment.launch, events: wanted,
      fromBlock: from, toBlock: from + 1999n > end ? end : from + 1999n }));
    await sleep(120);
  }
  const parsed = parseEventLogs({ abi, logs });
  const ours = new Set(plan.wallets.map(w => w.address.toLowerCase()));
  const chainTrades = parsed.filter(e => e.eventName === 'Traded' && ours.has(e.args.trader.toLowerCase()));

  // 1. index equality: our mined successful trades == chain Traded events == backend indexed trades.
  const chainHashes = chainTrades.map(e => e.transactionHash.toLowerCase());
  const localHashes = ok.map(r => r.hash.toLowerCase());
  const dupChain = chainHashes.length - new Set(chainHashes).size;
  const snapshot = await api('/api/arc/snapshot');
  const indexed = (snapshot.trades || []).map(t => t.transactionHash.toLowerCase());
  const indexedSet = new Set(indexed);
  const chainSet = new Set(chainHashes);
  const missingFromChain = localHashes.filter(h => !chainSet.has(h));
  const missingFromIndex = chainHashes.filter(h => !indexedSet.has(h));
  const extraInIndex = indexed.filter(h => !chainSet.has(h) && localHashes.includes(h));
  item('trade_index_equality',
    missingFromChain.length === 0 && missingFromIndex.length === 0 && dupChain === 0 && extraInIndex.length === 0
      ? 'passed' : 'failed',
    { localSuccessful: localHashes.length, chainTraded: chainHashes.length, duplicatesOnChain: dupChain,
      snapshotTrades: indexed.length, missingFromChain: missingFromChain.slice(0, 10),
      missingFromIndex: missingFromIndex.slice(0, 10), extraInIndex: extraInIndex.slice(0, 10),
      note: 'The snapshot keeps a bounded recent-trade window, so a hash missing from it may simply have scrolled out.' });

  // 2. per-token tax conservation for economics v3.
  const allocations = parsed.filter(e => e.eventName === 'FeesAllocated');
  const perToken = {};
  let allocationsOk = true;
  for (const e of allocations) {
    const a = e.args;
    const key = a.token.toLowerCase();
    const isPlatform = key === deployment.platformToken.toLowerCase();
    const noPlatformCommunity = /^0x0{40}$/i.test(deployment.platformCommunity ?? '');
    const expected = split(a.nativeAmount, isPlatform ? PLATFORM_SPLIT : MEME_SPLIT);
    if (isPlatform && noPlatformCommunity) { expected[1] += expected[3]; expected[3] = 0n; }
    const actual = [a.ownBuyback, a.jetBuyback, a.distributions, a.community, a.platform];
    const match = expected.every((v, i) => v === actual[i]);
    if (!match) allocationsOk = false;
    const p = (perToken[key] ||= { allocations: 0, native: 0n, mismatches: [], split: isPlatform ? (noPlatformCommunity ? '94/5/1' : '90/5/4/1') : '83/7/5/4/1' });
    p.allocations++; p.native += a.nativeAmount;
    if (!match) p.mismatches.push({ hash: e.transactionHash, expected: expected.map(String), actual: actual.map(String) });
  }
  item('fee_split_conservation', allocations.length === 0 ? 'not_observed' : allocationsOk ? 'passed' : 'failed',
    { allocationEvents: allocations.length,
      perToken: Object.fromEntries(Object.entries(perToken).map(([k, v]) =>
        [k, { allocations: v.allocations, nativeUSDC: formatEther(v.native), split: v.split, mismatches: v.mismatches.slice(0, 5) }])),
      reason: allocations.length === 0 ? 'the keeper collected no fees inside the observed window' : undefined });

  // 3. tax actually taken vs. the trades we made (v3 takes the tax in native USDC).
  const taxByToken = {};
  for (const r of ok) {
    const key = r.token.toLowerCase();
    const fee = BigInt(r.appliedFee ?? 0);
    const t = (taxByToken[key] ||= { buys: 0, sells: 0, buyIn: 0n, sellOut: 0n, expectedTax: 0n, symbol: r.symbol });
    if (r.side === 'buy') { t.buys++; t.buyIn += BigInt(r.amountIn); t.expectedTax += BigInt(r.amountIn) * fee / 1000000n; }
    else { t.sells++; t.sellOut += BigInt(r.amountOut || 0); }
  }
  const tokenStates = {};
  for (const key of Object.keys(taxByToken)) {
    const s = await factory('tokens', [key], end);
    tokenStates[key] = { pendingNative: formatEther(s[1]), pendingTokens: formatEther(s[2]),
      totalBuyback: formatEther(s[4]), totalBurned: formatEther(s[5]), cycles: String(s[6]) };
  }
  item('tax_taken_in_native_usdc', Object.keys(taxByToken).length ? 'passed' : 'not_observed',
    { note: 'v3 charges both sides in native USDC; buy tax is a share of the USDC sent in. Pending native plus '
        + 'anything the keeper already allocated should track the fee charged on our trades, but other traders and '
        + 'earlier balances share these counters, so this is a magnitude check, not an equality.',
      perToken: Object.fromEntries(Object.entries(taxByToken).map(([k, v]) => [k, { symbol: v.symbol, buys: v.buys,
        sells: v.sells, buyInUSDC: formatEther(v.buyIn), expectedBuyTaxUSDC: formatEther(v.expectedTax),
        onChain: tokenStates[k] }])) });

  // 4. credits and keeper reserve.
  const tokenList = Object.keys(taxByToken);
  const credits = {};
  for (const key of tokenList) credits[key] = formatEther(await factory('communityCredit', [key], end));
  const [operationsCredit, keeperGas, vaultBalance, sparkSupply] = await Promise.all([
    factory('operationsCredit', [], end), factory('keeperGasAvailable', [], end),
    client.getBalance({ address: deployment.satisfaction, blockNumber: end }),
    read(deployment.platformToken, erc20Abi, 'totalSupply', [], end),
  ]);
  item('credits_and_reserves', 'passed',
    { communityCreditUSDC: credits, operationsCreditUSDC: formatEther(operationsCredit),
      satisfactionVault: deployment.satisfaction, satisfactionVaultBalanceUSDC: formatEther(vaultBalance),
      keeperGasAvailableUSDC: formatEther(keeperGas), sparkTotalSupply: formatEther(sparkSupply),
      note: 'operations credit is the satisfaction vault: the factory holds it until claimOperations moves it.' });

  // 5. burns executed during the window.
  const burns = parsed.filter(e => e.eventName === 'Burned');
  item('burns_executed', burns.length ? 'passed' : 'not_observed',
    { burns: burns.map(e => ({ token: e.args.token, nativeUSDC: formatEther(e.args.nativeAmount),
      burned: formatEther(e.args.bought), hash: e.transactionHash, block: String(e.blockNumber) })),
      reason: burns.length ? undefined : `no buyback reached the ${deployment.minBuyback} USDC minimum in the window` });

  // 6. wallet native balance delta == principal spent + gas.
  const perWallet = {};
  for (const r of mined) {
    const w = (perWallet[r.wallet] ||= { gas: 0n, buyIn: 0n, sellOut: 0n });
    w.gas += BigInt(r.gasCost || 0);
    if (r.status === 'success') { if (r.side === 'buy') w.buyIn += BigInt(r.amountIn); else w.sellOut += BigInt(r.amountOut || 0); }
  }
  // Built from the chain, not from this process's own log: restarting the pacer left some journaled
  // sends settled without a client-observed receipt, so the local log is not a complete ledger.
  // Start from the balance the funding receipt block actually showed, apply the chain's own Traded
  // events, and require the remaining shortfall to be gas: positive, and small enough to be gas.
  const fundingReport = existsSync(`${batchDir}/funding-report-round2.json`)
    ? JSON.parse(readFileSync(`${batchDir}/funding-report-round2.json`)) : { rows: [] };
  const startBalance = new Map(fundingReport.rows.map(r => [r.address.toLowerCase(), parseEther(r.balanceAtBlock)]));
  const chainByWallet = {};
  for (const e of chainTrades) {
    const key = e.args.trader.toLowerCase();
    const w = (chainByWallet[key] ||= { buyIn: 0n, sellOut: 0n, trades: 0 });
    w.trades++;
    if (e.args.buy) w.buyIn += e.args.amountIn; else w.sellOut += e.args.amountOut;
  }
  const balanceRows = [];
  let balanceOk = true;
  for (const w of plan.wallets.slice(0, 12)) {
    const key = w.address.toLowerCase();
    const start = startBalance.get(key);
    if (start == null) continue;
    const now = await client.getBalance({ address: w.address, blockNumber: end });
    const p = chainByWallet[key] || { buyIn: 0n, sellOut: 0n, trades: 0 };
    const modelled = start + p.sellOut - p.buyIn;
    const shortfall = modelled - now;            // everything unaccounted for is gas
    const plausible = shortfall > 0n && shortfall <= parseEther('0.05');
    if (!plausible) balanceOk = false;
    balanceRows.push({ wallet: w.index, chainTrades: p.trades,
      startAtFundingBlockUSDC: formatEther(start), spentOnBuysUSDC: formatEther(p.buyIn),
      receivedFromSellsUSDC: formatEther(p.sellOut), balanceNowUSDC: formatEther(now),
      modelledBeforeGasUSDC: formatEther(modelled), impliedGasUSDC: formatEther(shortfall),
      plausible });
  }
  item('wallet_balance_conservation', balanceRows.length ? (balanceOk ? 'passed' : 'failed') : 'not_observed',
    { sampled: balanceRows.length,
      note: 'balance at the finalized block == balance at the funding receipt block + sell proceeds '
        + '- buy principal - gas. The implied gas must be positive and no larger than 0.05 USDC.',
      rows: balanceRows });

  // 7. keeper executor activity over the window.
  const executorLogs = [];
  for (let from = fromBlock; from <= end; from += 2000n) {
    executorLogs.push(...await client.getLogs({ address: deployment.keeperExecutor,
      fromBlock: from, toBlock: from + 1999n > end ? end : from + 1999n }));
    await sleep(120);
  }
  const executed = parseEventLogs({ abi: executorAbi, eventName: 'Executed', logs: executorLogs });
  const bySelector = {};
  for (const e of executed) {
    const key = SELECTORS[e.args.selector] || e.args.selector;
    bySelector[key] = (bySelector[key] || 0) + 1;
  }
  item('keeper_executed', executed.length ? 'passed' : 'not_observed',
    { executions: executed.length, bySelector,
      blocks: executed.slice(0, 20).map(e => String(e.blockNumber)) });

  // 8. gas-estimation headroom: how often the padding saved a trade.
  const headroom = ok.filter(r => r.wouldFailWithoutHeadroom);
  const keeperBlocks = new Set(executed.map(e => String(e.blockNumber)));
  item('gas_estimate_headroom', ok.length ? 'passed' : 'not_observed',
    { minedTrades: ok.length, wouldHaveRunOutOfGasWithoutPadding: headroom.length,
      share: ok.length ? +(headroom.length / ok.length).toFixed(4) : null,
      sharingABlockWithTheKeeper: ok.filter(r => keeperBlocks.has(r.block)).length,
      examples: headroom.slice(0, 5).map(r => ({ hash: r.hash, block: r.block, estimate: r.estimate, gasUsed: r.gasUsed })),
      note: 'a real user\'s wallet does not add 20 % headroom; these trades would have reverted out of gas for them.' });

  const result = { synthetic: true, at: new Date().toISOString(), finalizedBlock: String(end),
    fromBlock: String(fromBlock), items,
    status: items.some(i => i.status === 'failed') ? 'failed'
      : items.some(i => i.status === 'not_observed') ? 'partly_passed' : 'passed' };
  persist(`${dir}/verification.json`, result);
  console.log(stringify(result));
  return result;
}

async function stop() {
  const pid = Number(readFileSync(`${dir}/run.lock`, 'utf8').trim());
  assert(Number.isInteger(pid) && pid > 1);
  process.kill(pid, 'SIGTERM');
  console.log('Sent SIGTERM; journaled transactions stay recoverable.');
}

const commands = { preflight, fund, launch, run, verify, stop,
  'sample-index': sampleIndex, 'sample-api': sampleApi, 'sample-proc': sampleProc, 'sample-keeper': sampleKeeper };
const chosen = Object.keys(commands).find(has);
assert(chosen, `pick one of: ${Object.keys(commands).map(c => '--' + c).join(' ')}`);
await commands[chosen]();
