// Local end-to-end acceptance of the satisfaction vault, the keeper executor and the real Rust
// backend. A throwaway Anvil chain, Anvil's public development keys and the PostgreSQL *test*
// database only: nothing here reaches a public chain, and no running service is touched.
//
// The vault and the factory use BLOCK time; the opinion endpoint decides the round from the SERVER
// WALL CLOCK. Anvil therefore starts at `now - (roundDuration - votingDuration - 90)` so that round
// 0's voting window opens 90 real seconds from the start: the wall-clock-sensitive opinion calls run
// first, inside that window, and only afterwards is chain time jumped for the remaining rounds.
//
// With `--ui` the stack stays up after the scenarios: a fresh round is opened in its voting window,
// Yes and No votes are cast on chain, and `vite --mode arc` is started on a temporary port against
// this temporary backend so that `check-satisfaction-ui.mjs` can drive the real page. New opinions
// cannot be posted by then — chain time is hours ahead of the wall clock the opinion endpoint uses —
// so the three opinions the page check needs are submitted in round 0, while the two clocks agree.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, parseEther, formatEther, erc20Abi,
  parseEventLogs, zeroAddress, keccak256, toHex, encodeFunctionData, toFunctionSelector, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deployArc, artifact } from './deploy.mjs';
import { testDatabase, testSql, sqlString, localApiLimits } from './test-database.mjs';
import { arcAbi } from '../../SingleSparkFront/front/web3/arcAbi.ts';

const launchAbi = artifact('ArcLaunchV2').abi;
const vaultAbi = artifact('ArcSatisfaction').abi;
const executorAbi = artifact('ArcKeeperExecutor').abi;
const rewardsAbi = artifact('ArcRewards').abi;

const ROUND_SECONDS = 1800;
const VOTING_SECONDS = 600;
const QUORUM = '1000';
const WEIGHT_QUORUM = parseEther(QUORUM) * BigInt(VOTING_SECONDS) / 2n;
// Wall clock at start sits this far into round 0, so voting opens 90 real seconds from now.
const GENESIS_OFFSET = ROUND_SECONDS - VOTING_SECONDS - 90;

const freePort = async () => {
  const reserve = createServer();
  await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const { port } = reserve.address();
  await new Promise(r => reserve.close(r));
  return port;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wallClock = () => Math.floor(Date.now() / 1000);

const key = index => `0x${['ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  'dbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
  '2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6'][index]}`;

const checkUI = process.argv.includes('--ui');
const port = await freePort();
const url = `http://127.0.0.1:${port}`;
// Reserved before the backend starts: the API refuses any Origin other than ARC_WEB_ORIGIN, so the
// temporary site's port has to be known while the environment is built. Never 5176 or 8090.
const sitePort = checkUI ? await freePort() : null;
const site = checkUI ? `http://127.0.0.1:${sitePort}` : null;
const anvilTimestamp = wallClock() - GENESIS_OFFSET;
const anvil = spawn('anvil', ['--port', String(port), '--chain-id', '5042002',
  '--timestamp', String(anvilTimestamp), '--silent']);
let api, vite;

const deployerKey = key(0);
const operatorKey = key(1);
const nextOperatorKey = key(9);
const thirdOperatorKey = key(4);
const account = privateKeyToAccount(deployerKey);
const operator = privateKeyToAccount(operatorKey);
const nextOperator = privateKeyToAccount(nextOperatorKey);
const thirdOperator = privateKeyToAccount(thirdOperatorKey);
const owner = privateKeyToAccount(key(2));
const team = privateKeyToAccount(key(3));
const voters = { yes: privateKeyToAccount(key(5)), sniper: privateKeyToAccount(key(6)),
  noEarly: privateKeyToAccount(key(7)), noLate: privateKeyToAccount(key(8)) };
const community = privateKeyToAccount(`0x${'2'.padStart(64, '0')}`).address;
const adminToken = 'ab'.repeat(32);
const RICH = parseEther('10000');

const chain = defineChain({ id: 5042002, name: 'Arc Local',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
const client = createPublicClient({ chain, transport: http(url, { retryCount: 0 }), cacheTime: 0 });
const wallet = createWalletClient({ account, chain, transport: http(url) });
const walletOf = signer => createWalletClient({ account: signer, chain, transport: http(url) });
const dir = mkdtempSync(resolve(tmpdir(), 'arc-satisfaction-'));

const results = [];
const notes = [];
const deviations = [];
let base, deployment, environment, project, genesis, measuredDistribution;

const call = async (address, abi, functionName, args = [], value = 0n, signer = account) => {
  const hash = await walletOf(signer).writeContract({ address, abi, functionName, args, value });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', `${functionName} reverted`);
  return receipt;
};
const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
const vault = (functionName, args = []) => read(deployment.satisfaction, vaultAbi, functionName, args);
const factory = (functionName, args = []) => read(deployment.launch, launchAbi, functionName, args);
const supplyOf = token => read(token, erc20Abi, 'totalSupply');
const balanceOf = (token, holder) => read(token, erc20Abi, 'balanceOf', [holder]);
const blockTime = async () => Number((await client.getBlock()).timestamp);
// Anvil keeps block time frozen (interval 0), so chain time only moves where a scenario moves it.
const setChainTime = async seconds => {
  const now = await blockTime();
  assert(seconds >= now, `Chain time cannot move backwards: ${now} -> ${seconds}`);
  if (seconds === now) return now;
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [seconds] });
  await client.request({ method: 'evm_mine', params: [] });
  return seconds;
};
// The factory refuses a deadline more than 120 seconds ahead of the block it is mined in.
const deadline = async () => BigInt(await blockTime()) + 100n;
// The backend only trusts the `finalized` tag; Anvil reports finalized = latest - 64.
const finalize = () => client.request({ method: 'anvil_mine', params: ['0x40', '0x0'] });
const setBalance = (address, value) =>
  client.request({ method: 'anvil_setBalance', params: [address, toHex(value)] });

const scenario = async (id, title, body) => {
  const started = Date.now();
  try {
    const detail = (await body()) || {};
    const entry = { id, title, status: 'passed', seconds: Number(((Date.now() - started) / 1000).toFixed(1)), ...detail };
    results.push(entry);
    console.log(`PASS ${id} :: ${title} :: ${JSON.stringify(detail)}`);
    return entry;
  } catch (error) {
    const entry = { id, title, status: 'failed', seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
      expectedVsActual: error.message, stack: error.stack?.split('\n').slice(0, 8).join('\n') };
    results.push(entry);
    console.error(`FAIL ${id} :: ${title} :: ${error.message}`);
    return entry;
  }
};

const startApi = async (overrides = {}, { expectExit = false } = {}) => {
  const child = spawn(resolve('SingleSparkBackend/api/target/debug/jet-arc-backend'), [],
    { env: { ...environment, ...overrides } });
  let out = '', errors = '';
  child.stdout.on('data', b => (out += b));
  child.stderr.on('data', b => (errors += b));
  for (let i = 0; i < 600; i++) {
    const match = out.match(/listening on (127\.0\.0\.1:\d+)/);
    if (match) return { child, base: `http://${match[1]}`, out: () => out, errors: () => errors };
    if (child.exitCode !== null) {
      if (expectExit) return { child, base: null, out: () => out, errors: () => errors };
      throw new Error(`Backend exited (${child.exitCode}): ${errors.slice(-900)}`);
    }
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
const serveApi = async (overrides = {}) => {
  api = await startApi(overrides);
  base = api.base;
  for (let i = 0; i < 600; i++) {
    if ((await fetch(`${base}/api/arc/snapshot`)).ok) return api;
    assert(i < 599 && api.child.exitCode === null, `API must serve a snapshot: ${api.errors().slice(-600)}`);
    await sleep(100);
  }
};

const snapshot = async () => {
  const response = await fetch(`${base}/api/arc/snapshot`);
  assert.equal(response.status, 200, 'snapshot must be 200');
  return response.json();
};
const admin = (path, init = {}) => fetch(`${base}${path}`,
  { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${adminToken}` } });
const getJson = async path => {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 200, `${path} must be 200`);
  return response.json();
};
const poll = async (produce, predicate, { ms = 90_000, label = '' } = {}) => {
  const until = Date.now() + ms;
  let last;
  for (;;) {
    last = await produce();
    if (await predicate(last)) return last;
    if (Date.now() > until) throw new Error(`Timed out ${label}; last: ${JSON.stringify(last).slice(0, 700)}`);
    await sleep(500);
  }
};
// A keeper cycle on demand: the worker loop picks the request up within five seconds.
const runKeeper = async (label = '') => {
  const before = await snapshot();
  const response = await admin('/api/arc/keeper/run', { method: 'POST' });
  assert.equal(response.status, 202, 'A keeper run must be accepted');
  return poll(snapshot, view => view.worker?.busy === false
    && (view.worker?.lastCycleAt !== before.worker?.lastCycleAt
      || JSON.stringify(view.worker?.error) !== JSON.stringify(before.worker?.error)),
  { ms: 120_000, label: `waiting for a keeper cycle ${label}` });
};
const login = async signer => {
  const challenge = await getJson(`/api/auth/nonce?address=${signer.address}&chainId=5042002`);
  const signature = await signer.signMessage({ message: challenge.message });
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: challenge.message, chainId: 5042002, signature }) });
  assert.equal(response.status, 200, 'SIWE login must succeed');
  return (await response.json()).token;
};
const postOpinion = (token, text) => fetch(`${base}/api/arc/satisfaction/opinions`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ text }) });

const trade = async (token, buy, amount, signer = account) =>
  buy ? call(deployment.launch, arcAbi, 'trade', [token, true, amount, 1n, await deadline()], amount, signer)
    : (await call(token, erc20Abi, 'approve', [deployment.launch, amount], 0n, signer),
      call(deployment.launch, arcAbi, 'trade', [token, false, amount, 1n, await deadline()], 0n, signer));
const buySpark = async (signer, target) => {
  for (let spend = parseEther('1'); ; spend *= 3n) {
    await trade(deployment.platformToken, true, spend, signer);
    if (await balanceOf(deployment.platformToken, signer.address) >= target) return;
    assert(spend < parseEther('300'), `Could not buy ${formatEther(target)} SPARK`);
  }
};
// The keeper signs with the estimate plus a fifth (chain.rs estimate_gas). A bare eth_estimateGas
// limit is self-fulfilling here: the executor's receive() skips forwarding below 20,000 gas left, so
// the minimal successful limit is exactly the one at which the reserve is not forwarded.
const fundKeeperGas = async value => {
  const gas = await client.estimateContractGas({ address: deployment.launch, abi: launchAbi,
    functionName: 'fundKeeperGas', value, account });
  const hash = await wallet.writeContract({ address: deployment.launch, abi: launchAbi,
    functionName: 'fundKeeperGas', value, gas: gas * 12n / 10n });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', 'fundKeeperGas reverted');
  return receipt;
};
const voteWith = async (signer, support, amount, reasonHash) => {
  await call(deployment.platformToken, erc20Abi, 'approve', [deployment.satisfaction, amount], 0n, signer);
  return call(deployment.satisfaction, vaultAbi, 'vote', [support, amount, reasonHash], 0n, signer);
};
const roundOf = async index => {
  const [pot, yes, no, yesStake, noStake, opened, settled, outcome] = await vault('rounds', [BigInt(index)]);
  return { pot, yes, no, yesStake, noStake, opened, settled, outcome };
};
const executedEvents = () => client.getContractEvents({ address: deployment.keeperExecutor, abi: executorAbi,
  eventName: 'Executed', fromBlock: BigInt(deployment.fromBlock) });

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

  // ---------------------------------------------------------------- Step 1
  await scenario('step1-deploy', 'Deploy the vault, the executor and the factory; verify read-only', async () => {
    const pool = await deployContract('PoolManager', [account.address]);
    const positionManager = await deployContract('PositionManager', [pool, zeroAddress, 100000, zeroAddress, zeroAddress]);
    const options = { positionManager, community, platformName: 'SingleSpark', platformSymbol: 'SPARK',
      minBuyback: '0.001', journalPath: resolve(dir, 'deployment.json'),
      satisfaction: { team: team.address, roundDuration: ROUND_SECONDS, votingDuration: VOTING_SECONDS, quorum: QUORUM },
      executor: { owner: owner.address, operator: operator.address } };
    deployment = await deployArc(client, wallet, options);
    assert.deepEqual(await deployArc(client, wallet, options), deployment, 'A rerun must resume, not redeploy');
    assert.equal(deployment.keeper.toLowerCase(), deployment.keeperExecutor.toLowerCase());
    assert.equal(deployment.operations.toLowerCase(), deployment.satisfaction.toLowerCase());
    const record = resolve(dir, 'verification-input.json');
    writeFileSync(record, JSON.stringify(deployment));
    const output = resolve(dir, 'verification.json');
    execFileSync(process.execPath, [resolve('SingleSparkContract/arc/verify-satisfaction-deployment.mjs'), record, output],
      { env: { ...process.env, ARC_RPC_URL: url }, stdio: 'pipe' });
    const verification = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(verification.status, 'passed', `verifier: ${JSON.stringify(verification.failedChecks)}`);
    genesis = Number(await vault('genesis'));
    assert.equal(genesis, anvilTimestamp, 'Frozen block time must make genesis the Anvil start timestamp');
    return { launch: deployment.launch, satisfaction: deployment.satisfaction,
      keeperExecutor: deployment.keeperExecutor, platformToken: deployment.platformToken,
      genesis, readOnlyChecks: verification.checks.length };
  });

  environment = { ...process.env, ...testDatabase(dir), ...localApiLimits, ARC_CHAIN_ID: '5042002', ARC_RPC_URL: url,
    ARC_PUBLIC_RPC_URL: url, ARC_EXPLORER_URL: 'https://testnet.arcscan.app',
    ARC_WEB_ORIGIN: site ?? 'http://127.0.0.1:5176', ARC_HOST: '127.0.0.1', ARC_PORT: '0', ARC_DATA_DIR: dir,
    ARC_LAUNCH_ADDRESS: deployment.launch, ARC_QUOTER_ADDRESS: deployment.quoter,
    ARC_FROM_BLOCK: deployment.fromBlock, ARC_KEEPER_PRIVATE_KEY: operatorKey, ARC_CONFIG_SIGNING_KEY: deployerKey,
    ARC_TREASURY_ENCRYPTION_KEY: '07'.repeat(32), ARC_CONFIG_KEY_ID: 'arc-local', ARC_GAS_RESERVE_USDC: '1',
    ARC_SLIPPAGE_BPS: '300', ARC_KEEPER_ADMIN_TOKEN: adminToken, ARC_KEEPER_BATCH_SIZE: '20',
    ARC_MAX_GAS_PER_TX: '5000000', ARC_REWARDS_ADDRESS: '', ARC_REWARDS_FROM_BLOCK: '',
    ARC_SATISFACTION_ADDRESS: deployment.satisfaction, ARC_SATISFACTION_FROM_BLOCK: deployment.fromBlock };

  // ---------------------------------------------------------------- Step 2
  await scenario('step2-executor-mode', 'The backend starts in executor mode and refuses a non-operator key', async () => {
    const wrongDir = resolve(dir, 'wrong-operator');
    const wrong = await startApi({ ...testDatabase(wrongDir), ARC_DATA_DIR: wrongDir,
      ARC_KEEPER_PRIVATE_KEY: key(2) }, { expectExit: true });
    for (let i = 0; i < 600 && wrong.child.exitCode === null; i++) await sleep(100);
    await stopApi(wrong);
    assert.notEqual(wrong.child.exitCode, 0, 'The executor owner is not the operator and must not start');
    assert.match(wrong.errors(), /does not match/, `stderr: ${wrong.errors().slice(-500)}`);
    await serveApi();
    const view = await snapshot();
    assert.equal(view.keeper.toLowerCase(), deployment.keeperExecutor.toLowerCase());
    assert.equal(view.keeperExecutor, true);
    assert.equal(view.keeperOperator.toLowerCase(), operator.address.toLowerCase());
    assert.equal(view.keeperPaused, false);
    assert.equal(view.keeperEnabled, true);
    return { keeper: view.keeper, keeperOperator: view.keeperOperator, refusedKey: 'the executor owner' };
  });

  // -------------------------------------------- Step 6a: wall-clock guarded opinion refusals
  const votingStart = genesis + ROUND_SECONDS - VOTING_SECONDS;
  const roundEnd = genesis + ROUND_SECONDS;
  let sessions = {};
  await scenario('step6a-opinions-refused', 'Opinions: 401 without a session, 413 too large, 409 outside the window', async () => {
    assert(wallClock() < votingStart - 30,
      `This check must run in the accumulating phase; ${votingStart - 30 - wallClock()}s of budget left`);
    assert.equal((await postOpinion(null, 'no session')).status, 401);
    sessions = { yes: await login(voters.yes), sniper: await login(voters.sniper), noLate: await login(voters.noLate) };
    sessions.noEarly = await login(voters.noEarly);
    assert.equal((await postOpinion(sessions.yes, 'x'.repeat(5000))).status, 413);
    const refused = await postOpinion(sessions.yes, 'Too early: the round is still accumulating.');
    assert.equal(refused.status, 409, 'The accumulating phase must refuse opinions');
    return { accumulatingSecondsLeft: votingStart - 30 - wallClock(), statuses: '401/413/409' };
  });

  // -------- Step 3, gas half: run before any keeper work so the factory's daily allowance is intact.
  await scenario('step3a-keeper-gas', 'The factory feeds the operator through the executor and stops at the target', async () => {
    try {
      await setBalance(operator.address, parseEther('0.5'));
      await fundKeeperGas(parseEther('1'));
      const forwarded = await client.getBalance({ address: operator.address });
      assert(forwarded > parseEther('0.5'), `A starved operator must be topped up, got ${formatEther(forwarded)}`);
      assert.equal(await client.getBalance({ address: deployment.keeperExecutor }), 0n,
        'Nothing may be held back while the operator is below the target');
      await setBalance(operator.address, parseEther('3'));
      await fundKeeperGas(parseEther('1'));
      const held = await client.getBalance({ address: deployment.keeperExecutor });
      assert(held > 0n, 'The reserve must stay in the executor while the operator is funded');
      assert.equal(await client.getBalance({ address: operator.address }), parseEther('3'),
        'An operator at or above the two-USDC target receives nothing');
      await setBalance(deployment.keeperExecutor, parseEther('2'));
      assert.equal(await factory('keeperGasAvailable'), 0n, 'A two-USDC executor needs no top-up');
      await setBalance(deployment.keeperExecutor, held);
      return { forwardedToStarvedOperator: formatEther(forwarded - parseEther('0.5')),
        heldForFundedOperator: formatEther(held),
        gasHeadroom: 'estimate + 20%, the margin the keeper itself signs with' };
    } finally { await setBalance(operator.address, RICH); }
  });

  // ------------------------------------------------------------- On-chain fixture
  const launched = await call(deployment.launch, arcAbi, 'launch', ['Meme Fixture', 'MEME', '', 30_000, 30_000, community]);
  project = parseEventLogs({ abi: arcAbi, eventName: 'Launched', logs: launched.logs })[0].args.token;
  const [, , projectRewards] = await factory('terms', [project]);
  await setChainTime(genesis + 10); // Clear the three-second opening protection.
  for (let i = 0; i < 3; i++) {
    await trade(project, true, parseEther('1000'));
    await trade(project, false, (await balanceOf(project, account.address)) / 20n);
  }
  await buySpark(voters.yes, parseEther('3000'));
  await buySpark(voters.sniper, parseEther('100000'));
  await buySpark(voters.noEarly, parseEther('2000'));
  await buySpark(voters.noLate, parseEther('3000'));
  await fundKeeperGas(parseEther('2'));
  await finalize();
  console.log(`Fixture ready: project ${project}, chain time ${await blockTime()}, wall clock ${wallClock()}, data ${dir}.`);

  // ---------------------------------------- Step 6b: opinions accepted inside the wall-clock window
  const opinions = { yes: 'The buyback cadence finally makes the burn visible on the chart.',
    sniper: 'Late No vote: the treasury should hold this round instead.',
    // Stored and rendered as text everywhere; the page check asserts it never becomes an element.
    noEarly: '<img src=x onerror=alert(1)> plain text' };
  let submitted = {};
  await scenario('step6b-opinions-accepted', 'Opinions inside the voting window: hash, idempotence and the 429 cap', async () => {
    while (wallClock() < votingStart) await sleep(500);
    assert(wallClock() < roundEnd - 60, 'The voting window must still be open by wall clock');
    for (const side of ['yes', 'sniper', 'noEarly']) {
      const response = await postOpinion(sessions[side], opinions[side]);
      assert.equal(response.status, 200, `opinion ${side}: ${response.status}`);
      submitted[side] = await response.json();
      assert.equal(submitted[side].round, '0');
      assert.equal(submitted[side].reasonHash, keccak256(stringToHex(opinions[side])));
      assert.equal(submitted[side].text, opinions[side]);
    }
    const again = await postOpinion(sessions.yes, `  ${opinions.yes} `);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).id, submitted.yes.id, 'The same normalized text must reuse its id');
    for (let i = 0; i < 5; i++) {
      assert.equal((await postOpinion(sessions.noLate, `Draft number ${i} that no vote will confirm.`)).status, 200);
    }
    assert.equal((await postOpinion(sessions.noLate, 'A sixth unconfirmed draft.')).status, 429,
      'The sixth unconfirmed opinion of a voter must be refused');
    return { round: submitted.yes.round, yesHash: submitted.yes.reasonHash, sniperHash: submitted.sniper.reasonHash,
      injectionHash: submitted.noEarly.reasonHash, wallClockInWindow: wallClock() - votingStart };
  });

  // ---------------------------------------------------------------- Step 3 (after round 0 settles)
  const step3 = async () => scenario('step3b-keeper-through-executor', 'The keeper burns a project token through the executor', async () => {
    await setChainTime(genesis + ROUND_SECONDS + 200); // Past the 180 s burn cooldown.
    const supplyBefore = await supplyOf(project);
    const before = (await executedEvents()).length;
    await poll(runKeeper, async () => await supplyOf(project) < supplyBefore,
      { ms: 180_000, label: 'waiting for the first project buyback' });
    const events = await executedEvents();
    assert(events.length > before, 'The executor must record the keeper call');
    const burnSelector = toFunctionSelector('executeBurn(address,uint256,uint256,uint256)');
    const burn = events.find(event => event.args.selector === burnSelector
      && event.args.target.toLowerCase() === deployment.launch.toLowerCase());
    assert(burn, `No executeBurn through the executor; selectors seen: ${events.map(e => e.args.selector)}`);
    const transaction = await client.getTransaction({ hash: burn.transactionHash });
    assert.equal(transaction.from.toLowerCase(), operator.address.toLowerCase(), 'The operator must sign');
    assert.equal(transaction.to.toLowerCase(), deployment.keeperExecutor.toLowerCase(), 'It must go to the executor');
    const supplyAfter = await supplyOf(project);
    assert(supplyAfter < supplyBefore, 'The project supply must fall');
    return { burnTransaction: burn.transactionHash, executedSelector: burn.args.selector,
      projectSupplyBurned: formatEther(supplyBefore - supplyAfter) };
  });

  // ---------------------------------------------------------------- Step 4
  const step4 = async () => scenario('step4-distribution', 'A wrapped distribute still pays at least 100 recipients', async () => {
   try {
    await setChainTime(genesis + 2 * ROUND_SECONDS - VOTING_SECONDS - 400); // Let the lagged TWAP catch up.
    await call(deployment.launch, launchAbi, 'fundFees', [project], parseEther('400'));
    const payout = parseEther('10');
    // First the reward contract must hold the 1,000 tokens a minimum batch pays out.
    await poll(runKeeper, async () => await read(projectRewards, rewardsAbi, 'available') >= payout * 100n,
      { ms: 300_000, label: 'waiting for the reward contract to buy its own token' });
    // One mined block carrying 128 independent senders, the candidate source. The scanner looks back
    // only forty finalized blocks, so this block is created immediately before the batch is due.
    await client.request({ method: 'anvil_setAutomine', params: [false] });
    for (let i = 300; i < 428; i++) {
      const sender = privateKeyToAccount(`0x${i.toString(16).padStart(64, '0')}`);
      await setBalance(sender.address, parseEther('1'));
      await walletOf(sender).sendTransaction({ to: account.address, value: 1n, gas: 21000n,
        maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 0n });
    }
    await client.request({ method: 'evm_mine', params: [] });
    await client.request({ method: 'anvil_setAutomine', params: [true] });
    await finalize();
    await poll(runKeeper,
      async () => await read(projectRewards, rewardsAbi, 'totalPaid') >= 100n,
      { ms: 300_000, label: 'waiting for a distribution batch' });
    const paid = await client.getContractEvents({ address: projectRewards, abi: rewardsAbi,
      eventName: 'RewardPaid', fromBlock: BigInt(deployment.fromBlock) });
    const byTransaction = Map.groupBy(paid, event => event.transactionHash);
    const batches = [];
    for (const [hash, rows] of byTransaction) {
      const receipt = await client.getTransactionReceipt({ hash });
      const transaction = await client.getTransaction({ hash });
      assert.equal(transaction.to.toLowerCase(), deployment.keeperExecutor.toLowerCase(), 'distribute must be wrapped');
      assert.equal(transaction.from.toLowerCase(), operator.address.toLowerCase());
      assert(transaction.gas <= 5_000_000n, `gas limit ${transaction.gas} exceeds ARC_MAX_GAS_PER_TX`);
      assert(rows.length >= 100, `a batch paid only ${rows.length} recipients`);
      assert(rows.every(row => row.args.amount === payout));
      batches.push({ transactionHash: hash, recipients: rows.length,
        gasUsed: Number(receipt.gasUsed), gasLimit: Number(transaction.gas) });
    }
    const recipients = new Set(paid.map(event => event.args.recipient.toLowerCase()));
    assert(!recipients.has(operator.address.toLowerCase()), 'The operator must never be a recipient');
    assert(!recipients.has(deployment.keeperExecutor.toLowerCase()), 'The executor must never be a recipient');
    // The envelope's own cost: the same batch re-estimated on the state one block before it was mined,
    // once straight from the executor and once wrapped in execute() from the operator.
    const first = batches[0];
    const sample = paid.filter(event => event.transactionHash === first.transactionHash)
      .sort((a, b) => Number(a.args.payoutIndex - b.args.payoutIndex)).map(event => event.args.recipient);
    const at = (await client.getTransaction({ hash: first.transactionHash })).blockNumber - 1n;
    const totalPaid = await client.readContract({ address: projectRewards, abi: rewardsAbi,
      functionName: 'totalPaid', blockNumber: at });
    const data = encodeFunctionData({ abi: rewardsAbi, functionName: 'distribute', args: [totalPaid, sample] });
    const direct = await client.estimateGas({ account: deployment.keeperExecutor, to: projectRewards, data, blockNumber: at });
    const wrapped = await client.estimateGas({ account: operator.address, to: deployment.keeperExecutor,
      data: encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: [projectRewards, data] }),
      blockNumber: at });
    measuredDistribution = { batches, uniqueRecipients: recipients.size,
      wrappedGasUsed: first.gasUsed, recipientsInFirstBatch: first.recipients, gasLimit: first.gasLimit,
      envelope: { directEstimate: Number(direct), wrappedEstimate: Number(wrapped),
        overhead: Number(wrapped - direct),
        note: 'Same batch, same pre-state: distribute called straight from the executor versus the same '
          + 'call wrapped in ArcKeeperExecutor.execute() and signed by the operator.' } };
    return { batches: batches.length, recipientsInFirstBatch: first.recipients,
      wrappedGasUsed: first.gasUsed, uniqueRecipients: recipients.size,
      envelopeOverhead: Number(wrapped - direct) };
   } catch (error) {
    const say = async path => JSON.stringify(await getJson(path).catch(e => ({ unavailable: e.message }))).slice(0, 400);
    error.message += ` | rewards=${await say(`/api/arc/rewards?token=${project}`)}`
      + ` | candidates=${await say(`/api/arc/rewards/candidates?token=${project}`)}`;
    throw error;
   }
  });

  // ---------------------------------------------------------------- Step 5: Approved
  const potOfRound = {};
  let sparkAtSettle;
  await scenario('step5-approved', 'Round 0 settles Approved: 10% to the team, 90% to the buyback budget', async () => {
    await setChainTime(votingStart); // 1,200 s of chain history: past the price guard's 630 s floor.
    // Pin the pre-state. The backend also runs a keeper cycle on every UTC 180-second boundary, so whether the
    // project's fees were already collected used to depend on the second this script was started: when they
    // were not, the cycle after the settlement had to collect first, hit Slippage() and never reached SPARK.
    await runKeeper('before round 0 opens');
    await walletOf(account).sendTransaction({ to: deployment.satisfaction, value: parseEther('1') });
    const claimable = await factory('operationsClaimable');
    assert(claimable > 0n, 'The 1% operations share must be claimable so the real path funds the pot');
    await call(deployment.satisfaction, vaultAbi, 'openVoting', []);
    const opened = await roundOf(0);
    assert.equal(opened.opened, true);
    assert(opened.pot > parseEther('1'), `pot ${formatEther(opened.pot)} must include the claimed 1%`);
    assert.equal(await factory('operationsClaimable'), 0n, 'openVoting must claim the operations credit');
    potOfRound[0] = opened.pot;
    await voteWith(voters.yes, true, parseEther('3000'), submitted.yes.reasonHash);
    // A third confirmed opinion, so the page has one whose text is an injection probe. Its stake is
    // small enough to leave the snipe the larger raw stake and Yes the larger weight.
    await voteWith(voters.noEarly, true, parseEther('500'), submitted.noEarly.reasonHash);
    // The snipe: far more SPARK, one second before the close, so time weighting must beat it.
    await setChainTime(roundEnd - 1);
    await voteWith(voters.sniper, false, parseEther('100000'), submitted.sniper.reasonHash);
    const contested = await roundOf(0);
    assert(contested.noStake > contested.yesStake, 'The sniper must hold the larger raw stake');
    assert(contested.yes > contested.no, 'Time weighting must still put Yes ahead');

    const pendingBefore = (await factory('tokens', [deployment.platformToken]))[1];
    await setChainTime(roundEnd);
    sparkAtSettle = await supplyOf(deployment.platformToken);
    const settled = await call(deployment.satisfaction, vaultAbi, 'settle', [0n]);
    const result = await roundOf(0);
    assert.equal(result.outcome, 1, `outcome ${result.outcome} is not Approved`);
    const teamShare = result.pot / 10n;
    assert.equal(await vault('teamCredit'), teamShare);
    const funded = parseEventLogs({ abi: launchAbi, eventName: 'PlatformBuybackFunded', logs: settled.logs });
    assert.equal(funded.length, 1);
    assert.equal(funded[0].args.from.toLowerCase(), deployment.satisfaction.toLowerCase());
    assert.equal(funded[0].args.amount, result.pot - teamShare);
    const pendingAfter = (await factory('tokens', [deployment.platformToken]))[1];
    assert.equal(pendingAfter - pendingBefore, result.pot - teamShare, 'pendingNative must grow by the 90%');
    const teamBefore = await client.getBalance({ address: team.address });
    await call(deployment.satisfaction, vaultAbi, 'claimTeam', []);
    assert.equal(await client.getBalance({ address: team.address }) - teamBefore, teamShare);
    assert.equal(await vault('teamCredit'), 0n);
    for (const [name, signer, amount] of [['yes', voters.yes, parseEther('3000')],
      ['injection', voters.noEarly, parseEther('500')], ['sniper', voters.sniper, parseEther('100000')]]) {
      const before = await balanceOf(deployment.platformToken, signer.address);
      await call(deployment.satisfaction, vaultAbi, 'withdraw', [0n, signer.address], 0n, signer);
      assert.equal(await balanceOf(deployment.platformToken, signer.address) - before, amount, `${name} must recover its stake`);
      assert.equal(await vault('payoutOf', [0n, signer.address]), 0n, 'An Approved round pays no voter');
    }
    return { pot: formatEther(result.pot), teamShare: formatEther(teamShare),
      yesWeight: result.yes.toString(), noWeight: result.no.toString(),
      yesStake: formatEther(result.yesStake), noStake: formatEther(result.noStake) };
  });

  await scenario('step5-approved-buyback', 'The backend spends the new budget in the very next keeper cycle', async () => {
    const platform = deployment.platformToken.toLowerCase();
    await finalize();
    // One cycle only: the wake-up must not wait for the fifteen-minute idle re-audit.
    const view = await runKeeper('after an Approved settlement');
    const supplyAfter = await supplyOf(deployment.platformToken);
    const idle = testSql(dir, `SELECT idle FROM preflight WHERE token=${sqlString(platform)} AND kind='burn'`);
    assert.equal(idle, 'f', `SPARK was skipped as idle after a settlement (preflight.idle=${idle})`);
    assert(supplyAfter < sparkAtSettle,
      `SPARK supply unchanged after one cycle: ${formatEther(sparkAtSettle)} -> ${formatEther(supplyAfter)}; worker ${JSON.stringify(view.worker)}`);
    return { burned: formatEther(sparkAtSettle - supplyAfter), cycleError: view.worker?.error ?? null };
  });

  await step3();
  await step4();

  // ---------------------------------------------------------------- Step 5: Rejected
  await scenario('step5-rejected', 'Round 1 settles Rejected: the No voters split the pot by weight', async () => {
    const start = genesis + 2 * ROUND_SECONDS - VOTING_SECONDS;
    const end = genesis + 2 * ROUND_SECONDS;
    await setChainTime(start);
    await walletOf(account).sendTransaction({ to: deployment.satisfaction, value: parseEther('2') });
    await call(deployment.satisfaction, vaultAbi, 'openVoting', []);
    const opened = await roundOf(1);
    potOfRound[1] = opened.pot;
    assert(opened.pot > 0n);
    await voteWith(voters.noEarly, false, parseEther('2000'), keccak256(stringToHex('Rejected: hold the treasury.')));
    // A third party claiming the operations credit mid-round must not move this round's pot.
    if (await factory('operationsClaimable') === 0n) {
      await fundKeeperGas(parseEther('3'));
    }
    const vaultBalanceBefore = await client.getBalance({ address: deployment.satisfaction });
    await call(deployment.launch, launchAbi, 'claimOperations', [], 0n, privateKeyToAccount(key(3)));
    assert.equal((await roundOf(1)).pot, opened.pot, 'A mid-round claim must not change the opened pot');
    const arrived = await client.getBalance({ address: deployment.satisfaction }) - vaultBalanceBefore;
    assert(arrived > 0n, 'The claim must reach the vault');
    await setChainTime(start + 300);
    await voteWith(voters.noLate, false, parseEther('3000'), keccak256(stringToHex('Rejected: not yet convinced.')));
    await setChainTime(end);
    const teamCreditBefore = await vault('teamCredit');
    await call(deployment.satisfaction, vaultAbi, 'settle', [1n]);
    const result = await roundOf(1);
    assert.equal(result.outcome, 2, `outcome ${result.outcome} is not Rejected`);
    assert.equal(await vault('teamCredit'), teamCreditBefore, 'A Rejected round pays the team nothing');
    assert.equal(await vault('reserved'), result.pot);
    let payouts = 0n;
    const detail = [];
    for (const [name, signer] of [['noEarly', voters.noEarly], ['noLate', voters.noLate]]) {
      const [stake, weight] = await vault('positions', [1n, signer.address]);
      const expected = result.pot * weight / result.no;
      assert.equal(await vault('payoutOf', [1n, signer.address]), expected);
      const balanceBefore = await client.getBalance({ address: signer.address });
      const tokenBefore = await balanceOf(deployment.platformToken, signer.address);
      const receipt = await call(deployment.satisfaction, vaultAbi, 'withdraw', [1n, signer.address], 0n, signer);
      const spent = receipt.gasUsed * receipt.effectiveGasPrice;
      assert.equal(await client.getBalance({ address: signer.address }) - balanceBefore + spent, expected);
      assert.equal(await balanceOf(deployment.platformToken, signer.address) - tokenBefore, stake);
      payouts += expected;
      detail.push({ voter: name, stake: formatEther(stake), weight: weight.toString(), payout: formatEther(expected) });
    }
    assert.equal(await vault('reserved'), result.pot - payouts, 'Only the rounding remainder may stay reserved');
    assert(result.pot - payouts < 2n, `remainder ${result.pot - payouts} is more than per-voter dust`);
    return { pot: formatEther(result.pot), payouts: formatEther(payouts),
      remainderWei: (result.pot - payouts).toString(), voters: detail, thirdPartyClaim: formatEther(arrived) };
  });

  // ---------------------------------------------------------------- Step 5: Void and rollover
  await scenario('step5-void-and-rollover', 'Round 2 is Void on the weight floor and its pot rolls into round 3', async () => {
    const end = genesis + 3 * ROUND_SECONDS;
    await setChainTime(end - VOTING_SECONDS);
    await walletOf(account).sendTransaction({ to: deployment.satisfaction, value: parseEther('1') });
    await call(deployment.satisfaction, vaultAbi, 'openVoting', []);
    const opened = await roundOf(2);
    potOfRound[2] = opened.pot;
    assert(opened.pot > 0n, 'A Void by the weight floor needs a non-empty pot');
    // Both stakes arrive in the closing second: raw quorum is met, the weight floor is not.
    await setChainTime(end - 1);
    await voteWith(voters.noEarly, false, parseEther('800'), keccak256(stringToHex('Last second.')));
    await voteWith(voters.yes, true, parseEther('700'), keccak256(stringToHex('Also last second.')));
    const before = await roundOf(2);
    assert(before.yesStake + before.noStake >= parseEther(QUORUM), 'Raw quorum must be met');
    assert(before.yes + before.no < WEIGHT_QUORUM, 'The weight floor must not be met');
    await setChainTime(end);
    const reservedBefore = await vault('reserved');
    await call(deployment.satisfaction, vaultAbi, 'settle', [2n]);
    const result = await roundOf(2);
    assert.equal(result.outcome, 3, `outcome ${result.outcome} is not Void`);
    assert.equal(await vault('reserved'), reservedBefore, 'A Void round reserves nothing');
    for (const signer of [voters.noEarly, voters.yes]) {
      const before = await balanceOf(deployment.platformToken, signer.address);
      await call(deployment.satisfaction, vaultAbi, 'withdraw', [2n, signer.address], 0n, signer);
      assert(await balanceOf(deployment.platformToken, signer.address) > before);
    }
    await setChainTime(genesis + 4 * ROUND_SECONDS - VOTING_SECONDS);
    await call(deployment.satisfaction, vaultAbi, 'openVoting', []);
    const next = await roundOf(3);
    potOfRound[3] = next.pot;
    assert(next.pot >= result.pot, `round 3 pot ${formatEther(next.pot)} must carry round 2's ${formatEther(result.pot)}`);
    return { voidPot: formatEther(result.pot), rolledInto3: formatEther(next.pot),
      rawStake: formatEther(before.yesStake + before.noStake), weight: (before.yes + before.no).toString(),
      weightQuorum: WEIGHT_QUORUM.toString() };
  });

  // ---------------------------------------------------------------- Step 6c: index and moderation
  await scenario('step6c-index-and-moderation', 'Indexed opinions, moderation, status and round history', async () => {
    await finalize();
    const listed = await poll(() => getJson('/api/arc/satisfaction/opinions?round=0'),
      value => value.items.length === 3, { ms: 120_000, label: 'waiting for three finalized opinions' });
    const byHash = Object.fromEntries(listed.items.map(item => [item.reasonHash, item]));
    const yes = byHash[submitted.yes.reasonHash];
    const sniper = byHash[submitted.sniper.reasonHash];
    const injection = byHash[submitted.noEarly.reasonHash];
    assert(yes && sniper && injection, `hashes missing: ${JSON.stringify(listed.items)}`);
    assert.equal(yes.text, opinions.yes);
    // Stored verbatim, escaped only where it is rendered.
    assert.equal(injection.text, opinions.noEarly);
    assert.equal(injection.support, true);
    assert.equal(yes.support, true);
    assert.equal(yes.amount, parseEther('3000').toString());
    const [, yesWeight] = await vault('positions', [0n, voters.yes.address]);
    assert.equal(yes.weight, yesWeight.toString(), 'The listed weight must equal the chain');
    assert.equal(sniper.support, false);
    assert.equal(sniper.amount, parseEther('100000').toString());
    assert.equal((await getJson('/api/arc/satisfaction/opinions?round=0&side=yes')).items.length, 2);
    assert.equal((await getJson('/api/arc/satisfaction/opinions?round=0&side=no')).items.length, 1);

    assert.equal((await fetch(`${base}/api/arc/keeper/satisfaction/opinions/${sniper.id}/hide`, { method: 'POST' })).status, 401);
    const hidden = await admin(`/api/arc/keeper/satisfaction/opinions/${sniper.id}/hide`, { method: 'POST' });
    assert.equal(hidden.status, 200);
    const after = (await getJson('/api/arc/satisfaction/opinions?round=0')).items.find(item => item.id === sniper.id);
    assert.equal(after.text, null);
    assert.equal(after.hidden, true);
    assert.equal(after.voter.toLowerCase(), voters.sniper.address.toLowerCase());
    assert.equal(after.support, false);
    assert.equal(after.amount, sniper.amount);
    assert.equal(after.reasonHash, sniper.reasonHash);

    const status = await poll(() => getJson('/api/arc/satisfaction'),
      value => value.round === '3', { ms: 60_000, label: 'waiting for the status to reach round 3' });
    assert.equal(status.status, 'ready');
    assert.equal(status.phase, 'voting');
    assert.equal(status.stale, false);
    assert.equal(typeof status.ageMs, 'number');
    assert.equal(status.quorum, parseEther(QUORUM).toString());
    assert.equal(status.weightQuorum, WEIGHT_QUORUM.toString());
    assert.equal(status.potIsProjected, false, 'Round 3 is already open');
    assert.equal(status.pot, potOfRound[3].toString());
    assert.equal(status.reserved, (await vault('reserved')).toString());
    assert.equal(status.roundEndsAt, String(genesis + 4 * ROUND_SECONDS));
    assert.equal(status.votingStartsAt, String(genesis + 4 * ROUND_SECONDS - VOTING_SECONDS));

    const history = await poll(() => getJson('/api/arc/satisfaction/rounds?limit=10'),
      value => value.items.filter(item => item.settled).length >= 3, { ms: 90_000, label: 'waiting for three settled rounds' });
    const outcomes = Object.fromEntries(history.items.map(item => [item.round, item.outcome]));
    assert.equal(outcomes['0'], 'approved');
    assert.equal(outcomes['1'], 'rejected');
    assert.equal(outcomes['2'], 'void');

    // An open position appears while the stake is in the vault and disappears once withdrawn.
    const holder = voters.sniper;
    await voteWith(holder, true, parseEther('1000'), keccak256(stringToHex('Round three position.')));
    await finalize();
    const open = await poll(() => getJson(`/api/arc/satisfaction?address=${holder.address}`),
      value => (value.openPositions || []).some(item => item.round === '3'),
      { ms: 90_000, label: 'waiting for the round 3 position' });
    assert.equal(open.openPositions.find(item => item.round === '3').stake, parseEther('1000').toString());
    await setChainTime(genesis + 4 * ROUND_SECONDS);
    await call(deployment.satisfaction, vaultAbi, 'withdraw', [3n, holder.address], 0n, holder);
    await finalize();
    const closed = await poll(() => getJson(`/api/arc/satisfaction?address=${holder.address}`),
      value => !(value.openPositions || []).some(item => item.round === '3'),
      { ms: 90_000, label: 'waiting for the withdrawn position to disappear' });
    assert(Array.isArray(closed.openPositions));

    // A restart on the same data directory must neither lose nor duplicate anything.
    await stopApi(api);
    await serveApi();
    const again = await poll(() => getJson('/api/arc/satisfaction/opinions?round=0'),
      value => value.items.length > 0, { ms: 90_000, label: 'waiting for opinions after a restart' });
    assert.equal(again.items.length, 3, 'A restart must not duplicate opinions');
    assert.equal(again.items.find(item => item.id === sniper.id).hidden, true, 'Moderation survives a restart');
    const historyAgain = await poll(() => getJson('/api/arc/satisfaction/rounds?limit=10'),
      value => value.items.length >= history.items.length, { ms: 90_000, label: 'waiting for the round history after a restart' });
    assert.equal(historyAgain.items.length, history.items.length, 'A restart must not duplicate rounds');
    const outcomesAgain = Object.fromEntries(historyAgain.items.map(item => [item.round, item.outcome]));
    assert.deepEqual([outcomesAgain['0'], outcomesAgain['1'], outcomesAgain['2']], ['approved', 'rejected', 'void']);
    return { listed: listed.items.length, hiddenId: sniper.id, outcomes,
      roundsAfterRestart: historyAgain.items.length };
  });

  // ---------------------------------------------------------------- Step 7
  await scenario('step7-rotation-and-pause', 'Operator rotation, a retired journal, a live rotation and the pause', async () => {
    const detail = {};
    // Past the 180 s burn cooldown, then fresh pool fees: real work for the next operator to pick up.
    await setChainTime(await blockTime() + 400);
    await trade(project, true, parseEther('20'));
    await stopApi(api);
    await call(deployment.keeperExecutor, executorAbi, 'setOperator', [nextOperator.address], 0n, owner);

    // Held gas reaches an operator that cannot pay for its own first transaction.
    await setBalance(nextOperator.address, 0n);
    await fundKeeperGas(parseEther('1'));
    const held = await client.getBalance({ address: deployment.keeperExecutor });
    assert(held > 0n, 'A zero-balance operator must leave the reserve in the executor');
    assert.equal(await client.getBalance({ address: nextOperator.address }), 0n);
    await call(deployment.keeperExecutor, executorAbi, 'flush', [], 0n, voters.noEarly);
    const flushed = await client.getBalance({ address: nextOperator.address });
    assert(flushed > 0n, 'flush must sponsor the new operator');
    detail.flushed = formatEther(flushed);
    await setBalance(nextOperator.address, RICH);

    // A journal signed by the former operator is archived instead of blocking the new one.
    // An explicit gas limit: the executor already refuses this sender, so estimation would revert.
    const stale = await walletOf(operator).signTransaction(await walletOf(operator).prepareTransactionRequest({
      to: deployment.keeperExecutor, value: 0n, gas: 400_000n,
      data: encodeFunctionData({ abi: executorAbi, functionName: 'execute',
        args: [deployment.launch, encodeFunctionData({ abi: launchAbi, functionName: 'collectFees', args: [project] })] }) }));
    const staleHash = keccak256(stale);
    const journal = { identity: `5042002:${deployment.launch.toLowerCase()}:${deployment.fromBlock}`,
      sender: operator.address.toLowerCase(), hash: staleHash, raw: stale };
    testSql(dir, `INSERT INTO kv(key,value) VALUES('journal',${sqlString(JSON.stringify(journal))})
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`);

    await serveApi({ ARC_KEEPER_PRIVATE_KEY: nextOperatorKey });
    const rotated = await snapshot();
    assert.equal(rotated.keeperOperator.toLowerCase(), nextOperator.address.toLowerCase());
    assert.equal(rotated.keeperPaused, false);
    assert.equal(rotated.keeperEnabled, true);
    assert.equal(testSql(dir, "SELECT value FROM kv WHERE key='journal'"), 'null', 'The stale journal must be cleared');
    assert(testSql(dir, `SELECT count(*) FROM kv WHERE key=${sqlString(`journal_retired:${staleHash}`)}`) === '1',
      'The former operator\'s journal must be archived');
    detail.retiredJournal = staleHash;

    // The old operator can no longer drive the executor, and the archived transaction reverts on chain.
    await assert.rejects(client.simulateContract({ address: deployment.keeperExecutor, abi: executorAbi,
      functionName: 'execute', args: [deployment.launch,
        encodeFunctionData({ abi: launchAbi, functionName: 'collectFees', args: [project] })],
      account: operator }), /Unauthorized/, 'The former operator must be refused');
    const accountedBefore = await factory('nativeAccounted');
    const replayed = await client.sendRawTransaction({ serializedTransaction: stale });
    const receipt = await client.waitForTransactionReceipt({ hash: replayed });
    assert.equal(receipt.status, 'reverted', 'A former operator\'s signed transaction must revert');
    assert.equal(await factory('nativeAccounted'), accountedBefore, 'The reverted replay must change nothing');

    // The new operator does real work through the executor.
    const before = (await executedEvents()).length;
    await poll(runKeeper, async () => (await executedEvents()).length > before,
      { ms: 240_000, label: 'waiting for the new operator to execute' });
    const latest = (await executedEvents()).at(-1);
    const transaction = await client.getTransaction({ hash: latest.transactionHash });
    assert.equal(transaction.from.toLowerCase(), nextOperator.address.toLowerCase());
    detail.newOperatorCall = { transactionHash: latest.transactionHash, selector: latest.args.selector };

    // A rotation while the process runs stops all signing, without taking the API down.
    await call(deployment.keeperExecutor, executorAbi, 'setOperator', [thirdOperator.address], 0n, owner);
    const executedBefore = (await executedEvents()).length;
    const noticed = await poll(runKeeper,
      view => /Keeper operator changed on chain/.test(JSON.stringify(view.keeperErrors ?? view.worker?.error ?? '')),
      { ms: 180_000, label: 'waiting for the live rotation to be reported' });
    detail.liveRotationError = String(noticed.keeperErrors ?? noticed.worker?.error);
    for (let i = 0; i < 2; i++) await runKeeper('after the live rotation');
    assert.equal((await executedEvents()).length, executedBefore, 'No keeper transaction may follow a live rotation');
    assert.equal((await fetch(`${base}/api/arc/satisfaction`)).status, 200, 'The API stays up after a rotation');

    // The pause: a zero operator keeps the site running and every keeper path idle.
    await stopApi(api);
    await call(deployment.keeperExecutor, executorAbi, 'setOperator', [zeroAddress], 0n, owner);
    await serveApi({ ARC_KEEPER_PRIVATE_KEY: thirdOperatorKey });
    const paused = await snapshot();
    assert.equal(paused.keeperPaused, true);
    assert.equal(paused.keeperEnabled, false);
    assert.equal((await fetch(`${base}/api/arc/satisfaction`)).status, 200);
    assert.equal((await admin('/api/arc/keeper/run', { method: 'POST' })).status, 503,
      'A paused executor has no signer to run');
    await sleep(8000);
    assert.equal((await executedEvents()).length, executedBefore, 'A paused executor must execute nothing');

    // Restoring an operator brings the keeper back.
    await stopApi(api);
    await call(deployment.keeperExecutor, executorAbi, 'setOperator', [thirdOperator.address], 0n, owner);
    await setBalance(thirdOperator.address, RICH);
    await setChainTime(await blockTime() + 400);
    await trade(project, true, parseEther('20'));
    await serveApi({ ARC_KEEPER_PRIVATE_KEY: thirdOperatorKey });
    const resumed = await snapshot();
    assert.equal(resumed.keeperPaused, false);
    assert.equal(resumed.keeperOperator.toLowerCase(), thirdOperator.address.toLowerCase());
    await poll(runKeeper, async () => (await executedEvents()).length > executedBefore,
      { ms: 240_000, label: 'waiting for the restored operator to execute' });
    const resumedCall = (await executedEvents()).at(-1);
    assert.equal((await client.getTransaction({ hash: resumedCall.transactionHash })).from.toLowerCase(),
      thirdOperator.address.toLowerCase());
    detail.resumedCall = resumedCall.transactionHash;
    return detail;
  });

  // ------------------------------------------------------------- Plan 5 Task 4: the page itself
  // Only with --ui: the stack stays up, a fresh round is opened in its voting window with Yes and No
  // votes on chain, and the real page is driven by Playwright against this temporary backend.
  if (checkUI) {
    const now = await blockTime();
    const accumulating = ROUND_SECONDS - VOTING_SECONDS;
    let opensAt = genesis + Math.floor((now - genesis) / ROUND_SECONDS) * ROUND_SECONDS + accumulating;
    if (opensAt <= now) opensAt += ROUND_SECONDS;
    const uiRound = Math.floor((opensAt - genesis) / ROUND_SECONDS);
    await setChainTime(opensAt + 5);
    // Test funding, not revenue: a visible pot for the screenshots.
    await walletOf(account).sendTransaction({ to: deployment.satisfaction, value: parseEther('3') });
    await call(deployment.satisfaction, vaultAbi, 'openVoting', []);
    // No API call: the opinion endpoint files by wall clock, which round 0 left far behind. The votes
    // themselves only need the chain, and the page reads the tally from the chain through the status.
    await voteWith(voters.yes, true, parseEther('300'), keccak256(stringToHex('Live round: yes.')));
    await setChainTime(opensAt + 65);
    await voteWith(voters.noLate, false, parseEther('120'), keccak256(stringToHex('Live round: no.')));
    await finalize();
    const live = await poll(() => getJson('/api/arc/satisfaction'),
      view => view.round === String(uiRound) && view.phase === 'voting' && view.yes !== '0' && view.no !== '0',
      { ms: 120_000, label: 'waiting for the live voting round' });
    await poll(() => getJson('/api/arc/satisfaction/rounds?limit=20'),
      view => view.items.some(item => item.round === String(uiRound)),
      { ms: 120_000, label: 'waiting for the live round in the round history' });
    console.log(`UI fixture: round ${uiRound} is voting until ${live.roundEndsAt} (chain time ${await blockTime()}), `
      + `pot ${formatEther(BigInt(live.pot))}, yes ${formatEther(BigInt(live.yesStake))} / no ${formatEther(BigInt(live.noStake))} SPARK.`);
    vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'arc', '--host', '127.0.0.1',
      '--port', String(sitePort), '--strictPort'], { stdio: 'ignore', env: { ...process.env,
        VITE_API_BASE: base, VITE_ARC_LAUNCH_ENABLED: 'true', VITE_ARC_CHAIN_ID: '5042002',
        VITE_CHAIN_CONFIG_SIGNERS: JSON.stringify({ 'arc-local': account.address }) } });
    for (let i = 0; ; i++) {
      try { if ((await fetch(site)).ok) break; } catch { /* Vite is still booting. */ }
      assert(i < 600 && vite.exitCode === null, 'Vite must start on the temporary port');
      await sleep(100);
    }
    execFileSync(process.execPath, [resolve('SingleSparkContract/arc/check-satisfaction-ui.mjs'), site], { stdio: 'inherit',
      env: { ...process.env, SATISFACTION_UI_FIXTURE: JSON.stringify({ api: base, currentRound: uiRound,
        round: 0, normal: opinions.yes, hidden: opinions.sniper, injection: opinions.noEarly }) } });
    notes.push(`--ui run: round ${uiRound} was opened at chain time ${opensAt} and voted Yes (300 SPARK) and `
      + 'No (120 SPARK) sixty seconds apart; the three round 0 opinions the page shows are the ones submitted '
      + 'through the API inside round 0\'s wall-clock window. Screenshots: SingleSparkContract/arc/data/satisfaction-ui-check.');
  }

  deviations.push(
    'Scenario order: the wall-clock-sensitive opinion calls (step6a, step6b) run before every scenario that '
      + 'jumps chain time. The vault and the factory use block time, but POST /api/arc/satisfaction/opinions '
      + 'picks the round from the server wall clock, so Anvil starts at now - '
      + `${GENESIS_OFFSET} and round 0's voting window opens ninety real seconds into the run.`,
    'Steps 3 and 4 run after the round 0 settlement instead of before it, so that every keeper swap gets its '
      + 'own chain-time slot: the keeper price guard reads a 600 s TWAP lagged by 30 s, and back-to-back swaps '
      + 'inside one window would compare a moved spot price against a reference that has not caught up.',
    'Step 3\'s "the executor has accumulated 2 USDC" is set with anvil_setBalance rather than accumulated: the '
      + 'factory caps a top-up at 0.25 USDC and the whole day at 2 USDC, and this scenario already consumed '
      + 'part of that allowance, so 2 USDC cannot be reached by top-ups within one chain day. The assertion '
      + 'itself (keeperGasAvailable() == 0 at a 2 USDC executor) is unchanged.',
    'Step 6\'s "larger than 4096 bytes" is asserted as a request body over 4096 bytes (413). The backend also '
      + 'caps the text itself at 500 characters, which is a 400, not a 413.');
  notes.push(
    'Anvil reports finalized = latest - 64, so every scenario that waits on the finalized indexer mines 64 '
      + 'empty blocks (anvil_mine 0x40 0x0, block timestamp interval 0) before polling.',
    'Keeper cycles are requested through POST /api/arc/keeper/run with the admin token and awaited by watching '
      + 'the worker status; the script never sleeps past a missing result.',
    'Round 0 carries both the Approved settlement and the three opinions submitted through the API, so the '
      + 'listed opinions are confirmed by the very votes of the snipe scenario. The third one is an HTML '
      + 'injection probe, kept verbatim by the backend and asserted as text by the page check.',
    'Observation, not an assertion: ArcLaunchV2._topUpKeeper forwards only 30,000 gas, and '
      + 'ArcKeeperExecutor.receive() skips forwarding below 20,000 gas left. A caller whose own gas limit '
      + 'came from a bare eth_estimateGas therefore always lands on the non-forwarding path -- the '
      + 'estimator converges on exactly that limit, because the cheaper path is the one that still '
      + 'succeeds -- and the reserve stays in the executor until an execute() or flush() moves it. The '
      + 'keeper itself signs with the estimate plus a fifth (chain.rs estimate_gas), which is enough, and '
      + 'this scenario funds with the same margin. Measured locally: fundKeeperGas at the bare estimate '
      + '(154,110 gas) left 0.25 USDC in the executor; at estimate + 20% the operator received it.',
    'Observation, not an assertion: the reward candidate scanner reads at most forty finalized blocks '
      + 'back, and it only runs once the reward contract already holds a full batch, so the block of '
      + 'candidate senders has to be mined after the budget exists. A fixture that creates senders early '
      + 'and funds later finds no candidates at all.');

  const passed = results.every(entry => entry.status === 'passed');
  const report = { status: passed ? 'passed' : 'failed', checkedAt: new Date().toISOString(),
    environment: 'Local throwaway Anvil chain (chain id 5042002) started with Anvil\'s public development '
      + 'keys and the PostgreSQL test database. This is NOT a public chain: no address, balance, token or '
      + 'transaction recorded here exists anywhere else, and no running service was touched.',
    chainId: 5042002, anvilTimestamp, genesis,
    vault: { roundDuration: ROUND_SECONDS, votingDuration: VOTING_SECONDS, quorum: QUORUM,
      weightQuorum: WEIGHT_QUORUM.toString() },
    deployment, distribution: measuredDistribution, scenarios: results, deviations, notes };
  const outputPath = resolve('SingleSparkContract/arc/deployments/satisfaction-local-acceptance-20260919.json');
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.status.toUpperCase()}: ${results.filter(r => r.status === 'passed').length}/${results.length} scenarios in ${outputPath}`);
  if (!passed) process.exitCode = 1;
} finally {
  vite?.kill('SIGTERM');
  await stopApi(api);
  anvil.kill('SIGTERM');
}
