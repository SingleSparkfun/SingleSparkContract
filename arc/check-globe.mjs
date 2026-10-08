// Spark Globe end to end on a local chain: node SingleSparkContract/arc/check-globe.mjs [--ui]
//
// A throwaway Anvil chain, Anvil's public development keys, the PostgreSQL *test* database and an
// isolated schema that is dropped again at the end. Nothing here reaches a public chain and no
// running service is touched. Every meme launched below is SYNTHETIC: a development key launching a
// token on a chain that exists for the length of this process. None of it is a user, and the city a
// meme is shown in comes from a fixed test table, not from anybody's real network location.
//
// The geo lookup is driven by two local-mode-only hooks (see SingleSparkBackend/api/src/geo.rs):
//   * `ARC_GEO_TEST_MAP`, a fixed {"<ip>":[lat,lon,"CC"]} table that replaces the offline database;
//   * the `X-Arc-Dev-Ip` request header, which names the address to look up for one request.
// The addresses below are out of 4000::/3, which IANA has never allocated: no subscriber anywhere
// holds one, and `is_public` still classifies them as locatable, which is what this check needs.
//
// With `--ui` the stack stays up afterwards and `vite --mode arc` is started on a temporary port so
// that `check-globe-ui.mjs` can drive the real page against this temporary backend.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, parseEther, formatEther,
  parseEventLogs, zeroAddress, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deployArc, artifact } from './deploy.mjs';
import { testDatabase, testRows, testSql, sqlString, localApiLimits } from './test-database.mjs';
import { arcAbi } from '../../SingleSparkFront/front/web3/arcAbi.ts';
import { arcPrice } from '../../SingleSparkFront/front/utils/arcAnalytics.ts';

const SHANGHAI_IP = '4000:1::1';
const PARIS_IP = '4000:2::1';
const UNMAPPED_IP = '4000:3::1';
const TEST_IPS = [SHANGHAI_IP, PARIS_IP, UNMAPPED_IP];
// Shanghai and Paris as the committed city table spells them (SingleSparkBackend/api/geo/cities100k.tsv).
const GEO_TEST_MAP = JSON.stringify({
  [SHANGHAI_IP]: [31.22222, 121.45806, 'CN'],
  [PARIS_IP]: [48.85341, 2.3488, 'FR'],
});

/** Twelve from Shanghai, two from Paris, one with the switch off. Distinct buy sizes give distinct
 *  market caps, so the order the city panel ranks them in is observable rather than a tie-break. */
const MEMES = [
  { id: 'sh01', name: 'Shanghai Ember Cat', symbol: 'SHEMBER', from: 'shanghai', buy: '60', image: 'ember-cat' },
  { id: 'sh02', name: 'Bund Moon Frog', symbol: 'BUNDFROG', from: 'shanghai', buy: '48', image: 'moon-frog' },
  { id: 'sh03', name: 'Pudong Spark Cat', symbol: 'PUDCAT', from: 'shanghai', buy: '40', image: 'ember-cat' },
  { id: 'sh04', name: 'Huangpu Frog', symbol: 'HUANGFROG', from: 'shanghai', buy: '33', image: 'moon-frog' },
  { id: 'sh05', name: 'Jing An Cat', symbol: 'JINGCAT', from: 'shanghai', buy: '27', image: 'ember-cat' },
  { id: 'sh06', name: 'Lujiazui Frog', symbol: 'LUJIFROG', from: 'shanghai', buy: '22', image: 'moon-frog' },
  { id: 'sh07', name: 'Xujiahui Cat', symbol: 'XUJICAT', from: 'shanghai', buy: '18', image: 'ember-cat' },
  { id: 'sh08', name: 'Hongkou Frog', symbol: 'HONGFROG', from: 'shanghai', buy: '15', image: 'moon-frog' },
  { id: 'sh09', name: 'Yangpu Cat', symbol: 'YANGCAT', from: 'shanghai', buy: '12', image: 'ember-cat' },
  { id: 'sh10', name: 'Minhang Frog', symbol: 'MINHFROG', from: 'shanghai', buy: '9', image: 'moon-frog' },
  { id: 'sh11', name: 'Baoshan Cat', symbol: 'BAOSCAT', from: 'shanghai', buy: '6', image: 'ember-cat' },
  { id: 'sh12', name: 'Songjiang Frog', symbol: 'SONGFROG', from: 'shanghai', buy: '3', image: 'moon-frog' },
  { id: 'pa01', name: 'Seine Ember Cat', symbol: 'SEINECAT', from: 'paris', buy: '50', image: 'ember-cat' },
  { id: 'pa02', name: 'Montmartre Frog', symbol: 'MONTFROG', from: 'paris', buy: '25', image: 'moon-frog' },
  { id: 'hid1', name: 'Quiet Ember Cat', symbol: 'QUIETCAT', from: 'hidden', buy: '7', image: 'ember-cat' },
];
/** The draft whose switch is toggled before it launches; the last submission must win. */
const TOGGLED = 'sh12';

const freePort = async () => {
  const reserve = createServer();
  await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const { port } = reserve.address();
  await new Promise(r => reserve.close(r));
  return port;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const key = index => `0x${['ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'][index]}`;

const checkUI = process.argv.includes('--ui');
const rpcPort = await freePort();
// The media base has to be known before the backend starts, so its port is reserved rather than
// chosen by the kernel. Never 5176 or 8090: those belong to the developer's own stack.
const apiPort = await freePort();
const sitePort = checkUI ? await freePort() : null;
const url = `http://127.0.0.1:${rpcPort}`;
const base = `http://127.0.0.1:${apiPort}`;
const site = checkUI ? `http://127.0.0.1:${sitePort}` : null;
const anvil = spawn('anvil', ['--port', String(rpcPort), '--chain-id', '5042002', '--silent']);
let api, vite, schemaCreated = false;

const account = privateKeyToAccount(key(0));       // the launcher, and the SIWE session
const stranger = privateKeyToAccount(key(1));      // the impostor: a different account entirely
const keeperAddress = privateKeyToAccount(key(2)).address;
const operations = privateKeyToAccount(key(3)).address;
const platformCommunity = privateKeyToAccount(key(4)).address;
const adminToken = 'cd'.repeat(32);

const chain = defineChain({ id: 5042002, name: 'Arc Local',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
const client = createPublicClient({ chain, transport: http(url, { retryCount: 0 }), cacheTime: 0 });
const wallet = createWalletClient({ account, chain, transport: http(url) });
const walletOf = signer => createWalletClient({ account: signer, chain, transport: http(url) });
const dir = mkdtempSync(resolve(tmpdir(), 'arc-globe-'));
const database = testDatabase(dir);

const results = [];
const notes = [];
let deployment, environment, session, globeFixture;

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

// ---- chain helpers -------------------------------------------------------------------------
const call = async (address, abi, functionName, args = [], value = 0n, signer = account) => {
  const hash = await walletOf(signer).writeContract({ address, abi, functionName, args, value });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', `${functionName} reverted`);
  return receipt;
};
const blockTime = async () => Number((await client.getBlock()).timestamp);
const setChainTime = async seconds => {
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [seconds] });
  await client.request({ method: 'evm_mine', params: [] });
};
const deadline = async () => BigInt(await blockTime()) + 100n;
// The backend only trusts the `finalized` tag; Anvil reports finalized = latest - 64.
const finalize = () => client.request({ method: 'anvil_mine', params: ['0x40', '0x0'] });
const launch = async ({ name, symbol, metadataURI, community, signer = account }) => {
  const receipt = await call(deployment.launch, arcAbi, 'launch',
    [name, symbol, metadataURI, 0, 0, community], 0n, signer);
  return parseEventLogs({ abi: arcAbi, eventName: 'Launched', logs: receipt.logs })[0].args.token;
};
const buy = async (token, amount) => call(deployment.launch, arcAbi, 'trade',
  [token, true, parseEther(amount), 1n, await deadline()], parseEther(amount));

// ---- API helpers ---------------------------------------------------------------------------
// The backend's per-client budgets are opened wide for this check (localApiLimits); the calls are
// still paced, as they always were, so the scenario's timing does not change.
const recent = [];
const paced = async () => {
  for (;;) {
    const now = Date.now();
    while (recent.length && now - recent[0] > 60_000) recent.shift();
    if (recent.length < 50) { recent.push(now); return; }
    await sleep(Math.max(250, 60_500 - (now - recent[0])));
  }
};
const request = async (path, { limited = true, ...init } = {}) => {
  if (limited) await paced();
  return fetch(`${base}${path}`, init);
};
const getJson = async (path, init) => {
  const response = await request(path, init);
  assert.equal(response.status, 200, `${path} must be 200, got ${response.status}`);
  return response.json();
};
// Polled outside the pacing above: it is the read budget, opened wide for this check.
const snapshot = async () => {
  const response = await fetch(`${base}/api/arc/snapshot`);
  assert.equal(response.status, 200, 'snapshot must be 200');
  return response.json();
};
const admin = (path, init = {}) => request(path,
  { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${adminToken}` } });
const poll = async (produce, predicate, { ms = 120_000, label = '', every = 1000 } = {}) => {
  const until = Date.now() + ms;
  for (;;) {
    const last = await produce();
    if (await predicate(last)) return last;
    if (Date.now() > until) throw new Error(`Timed out ${label}; last: ${JSON.stringify(last).slice(0, 700)}`);
    await sleep(every);
  }
};

const startApi = async (overrides = {}) => {
  const child = spawn(resolve('SingleSparkBackend/api/target/debug/jet-arc-backend'), [],
    { env: { ...environment, ...overrides } });
  let out = '', errors = '';
  child.stdout.on('data', b => (out += b));
  child.stderr.on('data', b => (errors += b));
  for (let i = 0; i < 600; i++) {
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

const login = async signer => {
  const challenge = await getJson(`/api/auth/nonce?address=${signer.address}&chainId=5042002`);
  const signature = await signer.signMessage({ message: challenge.message });
  const response = await request('/api/auth/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: challenge.message, chainId: 5042002, signature }) });
  assert.equal(response.status, 200, 'SIWE login must succeed');
  return (await response.json()).token;
};
const authorized = (devIp) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${session}`,
  ...(devIp ? { 'X-Arc-Dev-Ip': devIp } : {}) });
/** Exactly what the launch page sends: one POST carrying the draft id and the switch. */
const reserveTreasury = async (requestId, showLocation, devIp) => {
  const response = await request('/api/arc/treasury', { method: 'POST',
    headers: authorized(devIp), body: JSON.stringify({ requestId, showLocation }) });
  assert.equal(response.status, 200, `treasury ${requestId}: ${response.status}`);
  return (await response.json()).address;
};
const uploadImage = async name => {
  const response = await request('/api/arc/media', { method: 'POST',
    headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${session}` },
    body: readFileSync(resolve(`SingleSparkFront/front/static/assets/tokens/${name}.png`)) });
  assert.equal(response.status, 201, `media ${name}: ${response.status}`);
  return (await response.json()).publicUrl;
};
const createMetadata = async (name, symbol, image) => {
  const response = await request('/api/arc/metadata', { method: 'POST', headers: authorized(),
    body: JSON.stringify({ name, symbol, image }) });
  assert.equal(response.status, 201, `metadata ${symbol}: ${response.status}`);
  return (await response.json()).metadataURI;
};
const globe = () => getJson('/api/arc/globe');
/** The globe is cached in the process for a minute per published snapshot, so "nothing changed"
 *  is only worth asserting on an answer that was assembled after the write it is checking. */
const freshGlobe = async () => {
  const before = (await snapshot()).syncedAt;
  await poll(snapshot, value => value.syncedAt !== before,
    { ms: 90_000, label: 'waiting for the next published snapshot' });
  return globe();
};
const cityOf = (view, token) => {
  const id = view.tokens[token.toLowerCase()];
  if (id == null) return null;
  const place = view.places.find(item => item.id === id);
  return place?.city ?? place?.country ?? null;
};
const inCity = (view, city) => Object.entries(view.tokens)
  .filter(([, id]) => (view.places.find(place => place.id === id)?.city ?? null) === city)
  .map(([token]) => token);

try {
  for (let i = 0; ; i++) {
    try { await client.getChainId(); break; } catch (error) { if (i > 50) throw error; await sleep(100); }
  }
  await client.request({ method: 'anvil_setBlockTimestampInterval', params: [0] });
  const deployContract = async (name, args) => {
    const compiled = artifact(name);
    const hash = await wallet.deployContract({ abi: compiled.abi, bytecode: compiled.bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    return receipt.contractAddress;
  };

  // ---------------------------------------------------------------- Step 1: the stack
  await scenario('step1-stack', 'Deploy the factory and start the backend with the local geo test table', async () => {
    const pool = await deployContract('PoolManager', [account.address]);
    const positionManager = await deployContract('PositionManager', [pool, zeroAddress, 100000, zeroAddress, zeroAddress]);
    deployment = await deployArc(client, wallet, { positionManager, keeper: keeperAddress, operations,
      community: platformCommunity, platformName: 'SingleSpark', platformSymbol: 'SPARK',
      minBuyback: '0.001', journalPath: resolve(dir, 'deployment.json') });
    environment = { ...process.env, ...database, ...localApiLimits, ARC_CHAIN_ID: '5042002', ARC_RPC_URL: url,
      ARC_PUBLIC_RPC_URL: url, ARC_EXPLORER_URL: 'https://testnet.arcscan.app',
      ARC_WEB_ORIGIN: site ?? 'http://127.0.0.1:5176', ARC_HOST: '127.0.0.1', ARC_PORT: String(apiPort),
      ARC_DATA_DIR: dir, ARC_MEDIA_PUBLIC_BASE: `${base}/api/arc/media`,
      ARC_LAUNCH_ADDRESS: deployment.launch, ARC_QUOTER_ADDRESS: deployment.quoter,
      ARC_FROM_BLOCK: deployment.fromBlock, ARC_CONFIG_SIGNING_KEY: key(0),
      ARC_TREASURY_ENCRYPTION_KEY: '09'.repeat(32), ARC_CONFIG_KEY_ID: 'arc-local',
      ARC_GAS_RESERVE_USDC: '1', ARC_SLIPPAGE_BPS: '300', ARC_KEEPER_ADMIN_TOKEN: adminToken,
      ARC_KEEPER_BATCH_SIZE: '20', ARC_MAX_GAS_PER_TX: '5000000',
      // No keeper: this check is about locations, and a signer here would be a second keeper process.
      ARC_KEEPER_PRIVATE_KEY: '', ARC_REWARDS_ADDRESS: '', ARC_REWARDS_FROM_BLOCK: '',
      ARC_SATISFACTION_ADDRESS: '', ARC_SATISFACTION_FROM_BLOCK: '',
      ARC_GEO_TEST_MAP: GEO_TEST_MAP };
    schemaCreated = true;
    api = await startApi();
    await poll(() => fetch(`${base}/api/arc/snapshot`).then(r => r.ok).catch(() => false), ok => ok,
      { ms: 60_000, label: 'waiting for the first snapshot' });
    const view = await snapshot();
    assert.equal(view.keeperEnabled, false, 'This check runs without a keeper');
    session = await login(account);
    return { launch: deployment.launch, platformToken: deployment.platformToken,
      schema: database.ARC_DATABASE_SCHEMA, keeper: 'disabled' };
  });

  // ---------------------------------------------------------------- Step 2: the launches
  const launched = new Map();   // id -> { token, community, ... }
  let directToken, impostorToken, impostorCommunity;
  await scenario('step2-launches', 'Fifteen launches through the site, one direct launch and one impostor', async () => {
    const images = { 'ember-cat': await uploadImage('ember-cat'), 'moon-frog': await uploadImage('moon-frog') };
    for (const meme of MEMES) {
      const metadataURI = await createMetadata(meme.name, meme.symbol, images[meme.image]);
      const requestId = `globe-${meme.id}`;
      const devIp = meme.from === 'paris' ? PARIS_IP : SHANGHAI_IP;
      // One draft is submitted on, then off, and then on again by the loop below: the last
      // submission before the launch is what the globe must show. The hidden one goes the other
      // way — on, then off — so the same rule is proved in both directions.
      if (meme.id === TOGGLED) {
        await reserveTreasury(requestId, true, devIp);
        await reserveTreasury(requestId, false, devIp);
      } else if (meme.from === 'hidden') {
        await reserveTreasury(requestId, true, devIp);
      }
      const community = await reserveTreasury(requestId, meme.from !== 'hidden', devIp);
      const token = await launch({ ...meme, metadataURI, community });
      launched.set(meme.id, { ...meme, token, community, metadataURI });
    }
    // A launch that never went through the site: a community address nothing reserved.
    directToken = await launch({ name: 'Offsite Ember Cat', symbol: 'OFFCAT', metadataURI: '',
      community: privateKeyToAccount(`0x${'d1'.repeat(32)}`).address });
    // The impostor: a different account passing a Shanghai meme's public treasury to the factory.
    impostorCommunity = launched.get('sh01').community;
    await client.request({ method: 'anvil_setBalance', params: [stranger.address, toHex(parseEther('1000'))] });
    impostorToken = await launch({ name: 'Copycat Ember Cat', symbol: 'COPYCAT', metadataURI: '',
      community: impostorCommunity, signer: stranger });
    assert.notEqual(impostorToken.toLowerCase(), launched.get('sh01').token.toLowerCase());
    return { throughTheSite: launched.size, direct: directToken, impostor: impostorToken,
      impostorReused: impostorCommunity };
  });

  // ---------------------------------------------------------------- Step 3: distinct market caps
  await scenario('step3-market-caps', 'Different buy sizes give the city panel an observable order', async () => {
    await setChainTime(await blockTime() + 10); // Clear the three-second opening window.
    for (const meme of MEMES) await buy(launched.get(meme.id).token, meme.buy);
    await finalize();
    const sizes = MEMES.map(meme => Number(meme.buy));
    return { buys: MEMES.length, largest: `${Math.max(...sizes)} USDC`, smallest: `${Math.min(...sizes)} USDC`,
      distinct: new Set(sizes).size };
  });

  // ---------------------------------------------------------------- Step 4: the globe
  let view;
  await scenario('step4-globe', 'Shanghai 12, Paris 2, one hidden, and the impostor nowhere', async () => {
    const expected = MEMES.length + 3; // the memes, the direct launch, the impostor and SPARK
    await poll(snapshot, value => (value.tokens ?? []).length >= expected,
      { ms: 180_000, label: `waiting for ${expected} indexed tokens` , every: 2000 });
    view = await poll(globe, value => Object.keys(value.tokens).length >= 14,
      { ms: 120_000, label: 'waiting for the globe to place the launches', every: 3000 });

    const shanghai = inCity(view, 'Shanghai');
    const paris = inCity(view, 'Paris');
    assert.equal(shanghai.length, 12, `Shanghai holds ${shanghai.length} memes`);
    assert.equal(paris.length, 2, `Paris holds ${paris.length} memes`);
    for (const meme of MEMES) {
      const { token } = launched.get(meme.id);
      const city = cityOf(view, token);
      const wanted = { shanghai: 'Shanghai', paris: 'Paris', hidden: null }[meme.from];
      assert.equal(city, wanted, `${meme.symbol} is in ${city}, not ${wanted}`);
    }
    assert.equal(view.hidden, 1, `hidden is ${view.hidden}`);
    // The direct launch, the impostor and the platform token are the three unknowns.
    assert.equal(view.unknown, 3, `unknown is ${view.unknown}`);
    for (const [label, token] of [['the direct launch', directToken], ['the impostor', impostorToken],
      ['the platform token', deployment.platformToken]]) {
      assert.equal(cityOf(view, token), null, `${label} must have no place`);
    }
    assert.equal(cityOf(view, launched.get('sh01').token), 'Shanghai',
      'The impostor must not take the treasury it copied away from the first launch');
    assert.equal(view.places.length, 2, 'Only the places actually used are published');
    assert.deepEqual(view.attribution.map(item => item.name), ['DB-IP', 'GeoNames']);
    globeFixture = { shanghaiPlaceId: view.places.find(place => place.city === 'Shanghai').id,
      parisPlaceId: view.places.find(place => place.city === 'Paris').id };
    return { shanghai: shanghai.length, paris: paris.length, hidden: view.hidden, unknown: view.unknown,
      toggledDraft: `${TOGGLED} submitted on, off, on before launching: shown in ${cityOf(view, launched.get(TOGGLED).token)}`,
      places: view.places.map(place => `${place.city}, ${place.country}`) };
  });

  // ---------------------------------------------------------------- Step 5: frozen after launch
  await scenario('step5-frozen', 'A submission after the token exists changes nothing', async () => {
    const meme = launched.get(TOGGLED);
    const before = cityOf(view, meme.token);
    // Same draft, same treasury, the switch now off and the address now Paris: all ignored.
    const again = await reserveTreasury(`globe-${TOGGLED}`, false, PARIS_IP);
    assert.equal(again.toLowerCase(), meme.community.toLowerCase(), 'The treasury itself is idempotent');
    const third = await reserveTreasury(`globe-${TOGGLED}`, true, PARIS_IP);
    assert.equal(third.toLowerCase(), meme.community.toLowerCase());
    const after = await freshGlobe();
    assert.equal(cityOf(after, meme.token), before, `${TOGGLED} moved from ${before} to ${cityOf(after, meme.token)}`);
    assert.equal(after.hidden, 1, 'A post-launch submission cannot hide a token either');
    const row = testRows(dir, `SELECT hidden, place_id FROM launch_locations WHERE community=${sqlString(meme.community.toLowerCase())}`);
    assert.equal(row.length, 1);
    assert.equal(row[0].hidden, false);
    assert.equal(row[0].place_id, globeFixture.shanghaiPlaceId);
    return { draft: TOGGLED, stillIn: before, storedPlaceId: row[0].place_id };
  });

  // ---------------------------------------------------------------- Step 6: the administrator
  await scenario('step6-hide', 'The admin endpoint moves one meme into the hidden count', async () => {
    const victim = launched.get('pa02');
    assert.equal((await request('/api/arc/keeper/globe/hide', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ community: victim.community }) })).status, 401, 'The admin token is required');
    const response = await admin('/api/arc/keeper/globe/hide', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ community: victim.community }) });
    assert.equal(response.status, 200, `hide: ${response.status}`);
    // A treasury with no record of its own is a 404, not a row invented on the spot.
    assert.equal((await admin('/api/arc/keeper/globe/hide', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ community: privateKeyToAccount(`0x${'d2'.repeat(32)}`).address }) })).status, 404);
    const after = await poll(globe, value => value.hidden === 2,
      { ms: 90_000, label: 'waiting for the hidden count to grow', every: 3000 });
    assert.equal(cityOf(after, victim.token), null, 'A hidden meme has no place');
    assert.equal(inCity(after, 'Paris').length, 1, 'The other Paris meme stays');
    assert.equal(inCity(after, 'Shanghai').length, 12, 'Shanghai is untouched');
    view = after;
    return { hiddenMeme: victim.symbol, hidden: after.hidden, paris: inCity(after, 'Paris').length };
  });

  // ---------------------------------------------------------------- Step 7: /geo/me
  await scenario('step7-geo-me', 'The launch page lookup answers for a dev address and refuses loopback', async () => {
    const paris = await getJson('/api/arc/geo/me', { headers: { 'X-Arc-Dev-Ip': PARIS_IP } });
    assert.deepEqual(paris, { available: true, city: 'Paris', country: 'France', countryCode: 'FR' });
    const shanghai = await getJson('/api/arc/geo/me', { headers: { 'X-Arc-Dev-Ip': SHANGHAI_IP } });
    assert.equal(shanghai.city, 'Shanghai');
    // No override: the request really comes from loopback, which is nobody's location.
    assert.deepEqual(await getJson('/api/arc/geo/me'), { available: false });
    // An address the test table does not list is a lookup miss, not a guess.
    assert.deepEqual(await getJson('/api/arc/geo/me', { headers: { 'X-Arc-Dev-Ip': UNMAPPED_IP } }), { available: false });
    return { paris: paris.city, shanghai: shanghai.city, loopback: 'available:false' };
  });

  // ---------------------------------------------------------------- Step 8: nothing stores an address
  await scenario('step8-no-addresses', 'No response, no table column and no log line carries a test address', async () => {
    const bodies = { globe: JSON.stringify(view),
      snapshot: JSON.stringify(await snapshot()),
      me: JSON.stringify(await getJson('/api/arc/geo/me', { headers: { 'X-Arc-Dev-Ip': SHANGHAI_IP } })) };
    const found = [];
    for (const [name, body] of Object.entries(bodies)) {
      for (const literal of [...TEST_IPS, '4000:']) if (body.includes(literal)) found.push(`${name}: ${literal}`);
    }
    // The five columns of launch_locations, spelled out.
    const columns = testRows(dir, `SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='launch_locations' ORDER BY column_name`);
    assert.deepEqual(columns.map(row => row.column_name).sort(),
      ['chain_id', 'community', 'hidden', 'place_id', 'updated_at']);
    const rows = testRows(dir, 'SELECT * FROM launch_locations');
    assert.equal(rows.length, MEMES.length, `launch_locations holds ${rows.length} rows`);
    for (const literal of [...TEST_IPS, '4000:']) {
      if (JSON.stringify(rows).includes(literal)) found.push(`launch_locations: ${literal}`);
    }
    // Every text-shaped column of every table in this schema, not just the one the feature writes.
    const textColumns = testRows(dir, `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND data_type IN
        ('text','character varying','character','json','jsonb') ORDER BY table_name, column_name`);
    for (const { table_name, column_name } of textColumns) {
      const predicate = [...TEST_IPS, '4000:']
        .map(literal => `"${column_name}"::text LIKE ${sqlString(`%${literal}%`)}`).join(' OR ');
      const count = testSql(dir, `SELECT count(*) FROM "${table_name}" WHERE ${predicate}`);
      if (count !== '0') found.push(`${table_name}.${column_name}: ${count} rows`);
    }
    const log = `${api.out()}\n${api.errors()}`;
    for (const literal of [...TEST_IPS, '4000:']) if (log.includes(literal)) found.push(`backend log: ${literal}`);
    assert.deepEqual(found, [], `A test address escaped: ${found.join('; ')}`);
    return { scannedColumns: textColumns.length, locationRows: rows.length,
      logBytes: log.length, scannedFor: [...TEST_IPS, '4000:'].join(' ') };
  });

  // ---------------------------------------------------------------- The page, with --ui
  if (checkUI) {
    const shanghai = inCity(view, 'Shanghai').map(token => token.toLowerCase());
    // The order the page must show: the real market cap of the published snapshot, computed the way
    // the page computes it (latest pool price times the remaining supply), highest first.
    const current = await snapshot();
    // The snapshot's `prices` list was removed on 2026-09-21; each token's `market.latest` is the
    // same newest indexed pool price the page now reads.
    const marketCap = address => {
      const token = current.tokens.find(item => item.token.toLowerCase() === address);
      assert(token?.market?.latest?.sqrtPriceX96, `${address} must have an indexed latest price`);
      return arcPrice(token.market.latest.sqrtPriceX96) * Number(token.totalSupply) / 1e18;
    };
    const order = shanghai.map(token => ({ token, cap: marketCap(token),
      name: current.tokens.find(item => item.token.toLowerCase() === token).name }))
      .sort((a, b) => b.cap - a.cap);
    assert.equal(new Set(order.map(item => item.cap)).size, order.length,
      'Every Shanghai meme must have its own market cap, or the rendered order would be a tie-break');
    // The buys were made in that order too, which is the only reason the check could predict it.
    assert.deepEqual(order.map(item => item.name),
      MEMES.filter(meme => meme.from === 'shanghai').sort((a, b) => Number(b.buy) - Number(a.buy)).map(meme => meme.name));
    globeFixture = { ...globeFixture, api: base, shanghaiCount: 12, markerCount: 2,
      order: order.map(item => item.name), hidden: view.hidden, devIp: PARIS_IP, devCity: 'Paris' };
    vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'arc', '--host', '127.0.0.1',
      '--port', String(sitePort), '--strictPort'], { stdio: 'ignore', env: { ...process.env,
        VITE_API_BASE: base, VITE_ARC_LAUNCH_ENABLED: 'true', VITE_ARC_CHAIN_ID: '5042002',
        VITE_CHAIN_CONFIG_SIGNERS: JSON.stringify({ 'arc-local': account.address }) } });
    for (let i = 0; ; i++) {
      try { if ((await fetch(site)).ok) break; } catch { /* Vite is still booting. */ }
      assert(i < 600 && vite.exitCode === null, 'Vite must start on the temporary port');
      await sleep(100);
    }
    execFileSync(process.execPath, [resolve('SingleSparkContract/arc/check-globe-ui.mjs'), site], { stdio: 'inherit',
      env: { ...process.env, GLOBE_UI_FIXTURE: JSON.stringify(globeFixture) } });
    notes.push('--ui run: the page check drove this same backend through a temporary Vite dev server; '
      + 'its screenshots are in SingleSparkContract/arc/data/globe-ui-check.');
  }

  notes.push(
    'Every launch here is synthetic: Anvil development keys launching tokens on a throwaway chain. '
      + 'They are not users, and the cities come from ARC_GEO_TEST_MAP, a fixed local-only table — '
      + 'not from anybody\'s network location.',
    'The addresses the check pretends to launch from are out of 4000::/3, which IANA has never '
      + 'allocated, so no literal in this file belongs to a real subscriber. They are public enough '
      + 'for the backend to attempt a lookup, which is what the hooks have to be exercised with.',
    'The backend ran with no keeper signing key configured at all, so it started no keeper loop: '
      + 'this check is about launch locations, and a second keeper is never wanted.',
    'Buy and sell fees are 0% on every meme, so no fee, burn or distribution path is exercised here '
      + 'and none is claimed. The buys exist only to give the memes different market caps.',
    'The per-client API budgets were opened wide for this check (they are unit-tested in '
      + 'SingleSparkBackend/api/src/limits.rs); the check still paces its own calls and polls the snapshot freely.');

  const passed = results.every(entry => entry.status === 'passed');
  const report = { status: passed ? 'passed' : 'failed', checkedAt: new Date().toISOString(),
    environment: 'Local throwaway Anvil chain (chain id 5042002) with Anvil\'s public development '
      + 'keys, the PostgreSQL test database and a schema dropped at the end. NOT a public chain: no '
      + 'address, token or transaction recorded here exists anywhere else, and no running service '
      + 'was touched. Every meme is synthetic and every city comes from a fixed local test table.',
    chainId: 5042002, deployment, scenarios: results, notes };
  const outputPath = resolve(process.env.ARC_GLOBE_REPORT || 'SingleSparkContract/arc/deployments/globe-local-acceptance-20260919.json');
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.status.toUpperCase()}: ${results.filter(r => r.status === 'passed').length}/${results.length} scenarios in ${outputPath}`);
  if (!passed) process.exitCode = 1;
} finally {
  vite?.kill('SIGTERM');
  await stopApi(api);
  anvil.kill('SIGTERM');
  if (schemaCreated) {
    try { testSql(dir, `DROP SCHEMA IF EXISTS "${database.ARC_DATABASE_SCHEMA}" CASCADE`); }
    catch (error) { console.error(`Could not drop the test schema: ${error.message}`); }
  }
}
