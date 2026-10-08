import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { openSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAddress, isAddress, parseUnits, verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { createRuntime, stringify } from './runtime.mjs';

const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  : JSON.stringify(value);

export function environment(env = process.env) {
  const required = key => { if (!env[key]) throw new Error(`Missing ${key}`); return env[key]; };
  const address = key => { const v = required(key); if (!isAddress(v)) throw new Error(`Invalid ${key}`); return getAddress(v); };
  const integer = (key, fallback, min, max) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
    return n;
  };
  const chainId = integer('ARC_CHAIN_ID', 5042002, 1, 10_000_000);
  if (![5042, 5042002].includes(chainId)) throw new Error('Only Arc is supported');
  const origin = new URL(required('ARC_WEB_ORIGIN')).origin;
  const rpcUrl = required('ARC_RPC_URL');
  if (!/^https?:\/\//.test(rpcUrl)) throw new Error('Invalid ARC_RPC_URL');
  return { chainId, launch: address('ARC_LAUNCH_ADDRESS'), quoter: address('ARC_QUOTER_ADDRESS'),
    fromBlock: integer('ARC_FROM_BLOCK', 0, 0, Number.MAX_SAFE_INTEGER), rpcUrl,
    publicRpcUrl: env.ARC_PUBLIC_RPC_URL || rpcUrl, explorer: required('ARC_EXPLORER_URL').replace(/\/$/, ''),
    origin, port: integer('ARC_PORT', 8088, 1, 65535), host: env.ARC_HOST || '127.0.0.1',
    dataDir: resolve(env.ARC_DATA_DIR || 'SingleSparkContract/arc/data'),
    keeperKey: env.ARC_KEEPER_PRIVATE_KEY || null, signingKey: required('ARC_CONFIG_SIGNING_KEY'),
    keyId: env.ARC_CONFIG_KEY_ID || 'arc-v1',
    slippageBps: integer('ARC_SLIPPAGE_BPS', 300, 1, 500),
    gasReserve: parseUnits(env.ARC_GAS_RESERVE_USDC || '1', 18) };
}

export async function startServer(config, { schedule = true } = {}) {
  const runtime = await createRuntime(config);
  const signer = privateKeyToAccount(config.signingKey);
  const lockPath = resolve(config.dataDir, 'keeper.lock');
  // A failed exclusive open prevents two processes from sharing a nonce journal.
  // After an unclean exit, verify the recorded PID is stopped before removing this lock.
  const lock = openSync(lockPath, 'wx', 0o600);
  writeFileSync(lock, String(process.pid));
  const challenges = new Map();
  const rateLimits = new Map();
  let timer;
  let stopped = false;
  let busy = false;
  let cycleError = null;
  let lastCycleAt = null;
  const directory = { chainId: config.chainId, name: runtime.chain.name, icon: '/assets/chains/default.svg', testnet: config.chainId !== 5042 };
  const profile = { chainId: config.chainId, name: runtime.chain.name, nativeCurrency: runtime.chain.nativeCurrency,
    rpcUrls: [config.publicRpcUrl], blockExplorerUrls: [config.explorer] };

  async function body(req) {
    let text = '';
    for await (const chunk of req) {
      text += chunk;
      if (Buffer.byteLength(text) > 16_384) throw new Error('Request body too large');
    }
    return JSON.parse(text || '{}');
  }
  function rateLimit(req) {
    const now = Date.now();
    for (const [key, value] of rateLimits) if (value.until <= now) rateLimits.delete(key);
    const key = req.socket.remoteAddress;
    const value = rateLimits.get(key) || { count: 0, until: now + 60_000 };
    if (++value.count > 60 || rateLimits.size > 10_000) throw new Error('Too many requests');
    rateLimits.set(key, value);
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin');
    if (req.headers.origin && req.headers.origin !== config.origin) { res.writeHead(403); res.end('{}'); return; }
    res.setHeader('Access-Control-Allow-Origin', config.origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept-Language, If-None-Match');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const reply = data => res.end(stringify(data));
    try {
      const url = new URL(req.url, 'http://localhost');
      if (runtime.chain.name === 'Arc Local' && req.method === 'GET' && /^\/tx\/0x[\da-fA-F]{64}$/.test(url.pathname)) {
        reply({ network: 'Arc Local', receipt: await runtime.client.getTransactionReceipt({ hash: url.pathname.slice(4) }) }); return;
      }
      if (runtime.chain.name === 'Arc Local' && req.method === 'GET' && /^\/address\/0x[\da-fA-F]{40}$/.test(url.pathname)) {
        const address = url.pathname.slice(9);
        reply({ network: 'Arc Local', address, nativeUsdcRaw: await runtime.client.getBalance({ address }), decimals: 18 }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/v2/chains') { reply([directory]); return; }
      if (req.method === 'GET' && url.pathname === `/api/v2/chains/${config.chainId}/wallet-profile`) { reply(profile); return; }
      if (req.method === 'GET' && url.pathname === '/api/v2/chain-config') {
        const envelope = { schemaVersion: 1, configVersion: 1, keyId: config.keyId, issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 300_000).toISOString(), audience: config.origin, method: 'GET', path: url.pathname,
          payload: { chains: [{ ...directory, walletProfile: profile,
            contracts: { arcLaunch: config.launch.toLowerCase(), arcQuoter: config.quoter.toLowerCase() } }] } };
        reply({ ...envelope, signature: await signer.signMessage({ message: canonical(envelope) }) }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/arc/snapshot') {
        if (!runtime.snapshot) { res.writeHead(503); reply({ message: 'ARC index is not ready' }); return; }
        reply({ ...runtime.snapshot, worker: { busy, lastCycleAt, error: cycleError || runtime.error, pendingHash: runtime.pendingHash } }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/arc/quote') {
        rateLimit(req);
        const token = url.searchParams.get('token');
        const buy = url.searchParams.get('buy');
        const amount = url.searchParams.get('amount');
        if (!isAddress(token) || !['true', 'false'].includes(buy) || !/^[1-9]\d{0,38}$/.test(amount)) throw new Error('Invalid quote');
        reply({ chainId: config.chainId, token, buy: buy === 'true', amountIn: amount,
          amountOut: await runtime.quote(token, buy === 'true', BigInt(amount)), quotedAt: Date.now() }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/nonce') {
        rateLimit(req);
        const address = url.searchParams.get('address');
        if (!isAddress(address) || Number(url.searchParams.get('chainId')) !== config.chainId) throw new Error('Invalid SIWE request');
        for (const [nonce, challenge] of challenges) if (challenge.expires <= Date.now()) challenges.delete(nonce);
        if (challenges.size >= 10_000) throw new Error('Too many challenges');
        const nonce = randomBytes(16).toString('hex');
        const issuedAt = new Date();
        const expirationTime = new Date(Date.now() + 300_000);
        const message = createSiweMessage({ address: getAddress(address), chainId: config.chainId, domain: new URL(config.origin).host,
          uri: config.origin, version: '1', nonce, issuedAt, expirationTime, statement: 'Sign in to SingleSpark on ARC.' });
        challenges.set(message, { address: getAddress(address), expires: expirationTime.getTime() });
        reply({ nonce, message, chainId: config.chainId, issuedAt, expirationTime }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        rateLimit(req);
        const request = await body(req);
        const challenge = challenges.get(request.message);
        if (!challenge || challenge.expires <= Date.now() || request.chainId !== config.chainId
          || typeof request.signature !== 'string') throw new Error('Invalid or expired challenge');
        // Consume before awaiting verification so concurrent replays cannot both succeed.
        challenges.delete(request.message);
        if (!await verifyMessage({ address: challenge.address, message: request.message, signature: request.signature })) throw new Error('Invalid signature');
        // There are no privileged HTTP writes: launch/trade authorization is on-chain.
        reply({ address: challenge.address.toLowerCase(), chainId: config.chainId, refCode: challenge.address.slice(2, 14).toLowerCase(), token: randomBytes(32).toString('hex') }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') { reply({ ok: true }); return; }
      if (req.method === 'POST' && url.pathname === '/api/analytics/events') { await body(req); reply({ ok: true }); return; }
      res.writeHead(404); reply({ message: 'Not found' });
    } catch (error) {
      res.writeHead(400); reply({ message: 'Request failed. Check the network, parameters or signature.' });
      console.error('ARC API:', error.shortMessage || error.message);
    }
  });
  let nextCycle = 0;
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  async function tick() {
    if (stopped) return;
    busy = true;
    try {
      if (Date.now() >= nextCycle) {
        nextCycle = Date.now() + 180_000;
        await runtime.cycle();
        lastCycleAt = new Date().toISOString();
        cycleError = null;
      } else await runtime.index();
    } catch (error) {
      cycleError = error.shortMessage || error.message;
      console.error('ARC worker:', cycleError);
    } finally {
      busy = false;
      if (!stopped) timer = setTimeout(tick, 10_000);
    }
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
    if (runtime.chain.name === 'Arc Local') profile.blockExplorerUrls = [`http://${config.host}:${server.address().port}`];
    if (schedule) void tick();
  } catch (error) { closeSync(lock); unlinkSync(lockPath); throw error; }
  const close = async () => {
    stopped = true;
    clearTimeout(timer);
    // Let the journaled transaction finish before another keeper can acquire the data directory.
    while (busy) await new Promise(resolve => setTimeout(resolve, 100));
    await new Promise(resolve => server.close(resolve));
    closeSync(lock); unlinkSync(lockPath);
  };
  return { server, runtime, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await startServer(environment());
  console.log(`ARC API listening on ${JSON.stringify(app.server.address())}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void app.close().then(() => process.exit(0)));
}
