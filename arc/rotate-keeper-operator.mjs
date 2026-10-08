// Rotate or pause the keeper operator of the deployed `ArcKeeperExecutor` on the ARC testnet.
//
// The factory's `keeper` is the executor contract; only the executor's current `operator()` may
// drive it. The owner (the deployer wallet) can replace that operator without redeploying the
// factory, its tokens or their rewards contracts. This tool performs that rotation, the emergency
// pause (`setOperator(0)`) and the checks that prove it worked.
//
// Everything that sends is journaled the same way as `verify-satisfaction-testnet.mjs`: simulate ->
// sign -> persist -> broadcast -> reuse the receipt. Every sub-command is safe to re-run; a re-run
// never pays twice and never blindly re-sends.
//
// SECRETS: the operator key lives in `runtime.env` and in `operator-B.json` (mode 0600, inside the
// git-ignored deployment directory). This tool reads and rewrites those files in process and prints
// addresses, hashes and booleans only. It never writes a key to stdout or to any report.
//
// Sub-commands (no flag = preflight, which sends nothing):
//   (none)                        print owner, on-chain operator, balances, backend state
//   --new-operator                generate operator B once into operator-B.json (prints the address)
//   --set-operator <addr|zero|B>  owner calls setOperator; refuses while the backend runs and
//                                 refuses any address that was an operator BEFORE the address of
//                                 the key currently in runtime.env (unless --i-checked-nonces)
//   --swap-key B|A-archive-only   archive runtime.env under previous-env/ and (mode B) replace the
//                                 keeper private key line with operator B's key
//   --fund-operator               top up operator B: factory topUpKeeper(), executor flush(), and
//                                 only if still short, a direct transfer from the funder
//   --check-unauthorized <addr>   eth_call execute(...) from <addr>; must revert Unauthorized()
//   --buy-spark <usdc>            one small SPARK buy from the funder, so fees exist to collect
//   --sell-spark                  sell the SPARK this tool bought back to the funder
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, parseEther, formatEther, erc20Abi,
  keccak256, encodeFunctionData, parseTransaction, parseEventLogs, recoverTransactionAddress, getAddress,
  toFunctionSelector, zeroAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { artifact } from './deploy.mjs';
import { persist, stringify } from './runtime.mjs';

const dir = process.env.ARC_DEPLOYMENT_DIR || 'SingleSparkContract/arc/data/spark-satisfaction-testnet-20260919';
const reportPath = process.env.ARC_DEPLOYMENT_REPORT || 'SingleSparkContract/arc/deployments/spark-satisfaction-testnet-20260919.json';
const base = process.env.ARC_ACCEPTANCE_API_BASE || 'http://127.0.0.1:8090';
assert.equal(new URL(base).hostname, '127.0.0.1');
const apiPort = Number(new URL(base).port || 80);
const envPath = `${dir}/runtime.env`;
const journalPath = `${dir}/operator-rotation-journal.json`;
const statePath = `${dir}/operator-rotation-state.json`;
const operatorBPath = `${dir}/operator-B.json`;
const archiveDir = `${dir}/previous-env`;
const pidPath = `${dir}/backend.pid`;

process.loadEnvFile(envPath);
const record = JSON.parse(readFileSync(reportPath));
const d = record.deployment;
// The committed record is the only source of truth for the addresses this tool may touch.
assert.equal(d.chainId, 5042002);
assert.equal(d.launch.toLowerCase(), '0xd6a56abcddc83d4b780ef4cbfb8f6b7fc093ecf4');
assert.equal(d.keeperExecutor.toLowerCase(), '0xc5dbbbf37097f2539c7ac69775bf11f858409cd4');
assert.equal(d.keeperExecutor.toLowerCase(), d.keeper.toLowerCase());
assert.equal(d.platformToken.toLowerCase(), '0x6d8a5595a57749b1ae725c66a258bb730166073c');
assert.equal(d.keeperOwner.toLowerCase(), '0x0ca76906cef08981717f81dfa1519b5a3cecca57');

const launchAbi = artifact('ArcLaunchV2').abi;
const executorAbi = artifact('ArcKeeperExecutor').abi;
const quoterAbi = artifact('V4Quoter').abi;
const positionManagerAbi = artifact('PositionManager').abi;

const chain = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL] } } });
// The public RPC rate-limits (-32005 / HTTP 429). Reads back off; sends are journaled, so a retry
// of a send never duplicates a transaction.
const transport = http(process.env.ARC_RPC_URL, { timeout: 25000, retryCount: 4, retryDelay: 2000 });
const client = createPublicClient({ chain, transport, cacheTime: 0 });

const funder = privateKeyToAccount(process.env.ARC_DEPLOYER_PRIVATE_KEY);
assert.equal(funder.address.toLowerCase(), d.keeperOwner.toLowerCase(), 'The deployer key must be the executor owner');
const reserve = parseEther(process.env.ARC_DEPLOYER_RESERVE_USDC || '50');
const maxGasCost = parseEther('0.2');
const MAX_DIRECT_FUNDING = parseEther('1.5');
const OPERATOR_TARGET = parseEther('1.2');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const UNAUTHORIZED = toFunctionSelector('Unauthorized()');

// ------------------------------------------------------------------ rate-limit tolerant reads
const transient = message => /429|too many requests|-32005|rate.?limit|timeout|timed out|socket|ECONNRESET|fetch failed/i.test(message);
async function retry(label, action) {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      const message = String(error?.shortMessage || error?.message || error);
      if (attempt >= 5 || !transient(message)) throw error;
      const wait = 3000 * 2 ** attempt;
      console.error(`${label}: rate-limited, retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}
const read = (address, abi, functionName, args = []) =>
  retry(`read ${functionName}`, () => client.readContract({ address, abi, functionName, args }));
const executor = (functionName, args = []) => read(d.keeperExecutor, executorAbi, functionName, args);
const factory = (functionName, args = []) => read(d.launch, launchAbi, functionName, args);
const balanceOf = address => retry('getBalance', () => client.getBalance({ address }));
const now = async () => Number((await retry('getBlock', () => client.getBlock())).timestamp);

// ------------------------------------------------------------------ files
const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath)) : {};
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath))
  // Seeded from the committed record: the operator the executor was deployed with is operator A.
  : { operators: [{ address: getAddress(d.keeperOperator), source: 'deployment', at: record.startedAt }], funding: [], trades: {} };
state.funding ??= [];
state.trades ??= {};
const saveState = () => persist(statePath, state);

const readEnv = () => readFileSync(envPath, 'utf8');
const unquote = value =>
  (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")) ? value.slice(1, -1) : value;
function envValue(text, name) {
  const line = text.split('\n').find(l => l.startsWith(`${name}=`));
  return line === undefined ? undefined : unquote(line.slice(name.length + 1));
}
function replaceEnvLine(text, name, value) {
  let seen = 0;
  const lines = text.split('\n').map(line => {
    if (!line.startsWith(`${name}=`)) return line;
    seen++;
    const raw = line.slice(name.length + 1);
    const quote = raw.startsWith('"') ? '"' : raw.startsWith("'") ? "'" : '';
    return `${name}=${quote}${value}${quote}`;
  });
  assert.equal(seen, 1, `${name} must appear exactly once in runtime.env`);
  return lines.join('\n');
}
function writeEnv(text) {
  const temporary = `${envPath}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  const file = openSync(temporary, 'r');
  try { fsyncSync(file); } finally { closeSync(file); }
  renameSync(temporary, envPath);
  const directory = openSync(dir, 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
// Only ever returns the ADDRESS of the configured key; the key itself never leaves this function.
const envKeyAddress = (text = readEnv()) => privateKeyToAccount(envValue(text, 'ARC_KEEPER_PRIVATE_KEY')).address;
// Returns the address and the raw key. Viem's account object has no `privateKey` field, so the key
// is carried explicitly; it is only ever written into runtime.env, never printed.
const operatorB = () => {
  assert(existsSync(operatorBPath), 'Run --new-operator first');
  const saved = JSON.parse(readFileSync(operatorBPath));
  assert(/^0x[0-9a-fA-F]{64}$/.test(saved.privateKey ?? ''), 'operator-B.json has no usable key');
  const account = privateKeyToAccount(saved.privateKey);
  assert.equal(account.address, getAddress(saved.address), 'operator-B.json address does not match its key');
  return { address: account.address, privateKey: saved.privateKey, account };
};

// ------------------------------------------------------------------ backend process
function backendState() {
  let pid = null;
  if (existsSync(pidPath)) {
    const parsed = Number(readFileSync(pidPath, 'utf8').trim());
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  }
  let alive = false;
  if (pid !== null) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
  let listening = false;
  try {
    listening = execFileSync('lsof', ['-nP', `-iTCP:${apiPort}`, '-sTCP:LISTEN', '-t'],
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0;
  } catch { listening = false; }
  return { pid, alive, listening, running: alive || listening };
}
const snapshotKeeper = async () => {
  try {
    const response = await fetch(`${base}/api/arc/snapshot`, { signal: AbortSignal.timeout(10000) });
    if (response.status !== 200) return { status: response.status };
    const body = await response.json();
    return { status: 200, keeper: body.keeper, keeperExecutor: body.keeperExecutor, keeperOperator: body.keeperOperator,
      keeperPaused: body.keeperPaused, keeperEnabled: body.keeperEnabled, keeperErrors: body.keeperErrors ?? null,
      worker: body.worker ? { busy: body.worker.busy, error: body.worker.error, lastCycleAt: body.worker.lastCycleAt,
        nextCheckAt: body.worker.nextCheckAt, pendingHash: body.worker.pendingHash } : null };
  } catch (error) { return { status: 'unreachable', error: String(error.message).slice(0, 120) }; }
};

// ------------------------------------------------------------------ journaled send
async function send(label, signer, to, data, value = 0n, gasHeadroomPercent = 0) {
  const wallet = createWalletClient({ account: signer, chain, transport });
  let step = journal[label];
  if (!step) {
    const nonce = await retry(`${label} nonce`, () => client.getTransactionCount({ address: signer.address }));
    assert.equal(nonce, await retry(`${label} pending nonce`,
      () => client.getTransactionCount({ address: signer.address, blockTag: 'pending' })),
      `${label}: ${signer.address} has an external pending transaction`);
    const request = await retry(`${label} prepare`, () => wallet.prepareTransactionRequest({ to, data, value, nonce }));
    if (gasHeadroomPercent) request.gas = request.gas * BigInt(100 + gasHeadroomPercent) / 100n;
    const maxCost = request.gas * (request.maxFeePerGas ?? request.gasPrice);
    assert(maxCost <= maxGasCost, `${label}: per-transaction gas budget (${formatEther(maxCost)} USDC)`);
    const balance = await balanceOf(signer.address);
    if (signer.address === funder.address) {
      assert(balance >= reserve + value + maxCost, `${label}: keep the ${formatEther(reserve)} USDC funder reserve`);
    } else assert(balance >= value + maxCost, `${label}: ${signer.address} is short of gas`);
    await retry(`${label} simulate`, () => client.call({ to, data, value, account: signer.address }));
    const raw = await wallet.signTransaction(request);
    step = { raw, hash: keccak256(raw), from: signer.address, label, at: new Date().toISOString() };
    journal[label] = step;
    persist(journalPath, journal);
  }
  const decoded = parseTransaction(step.raw);
  assert.equal(decoded.chainId, chain.id);
  assert.equal(decoded.to.toLowerCase(), to.toLowerCase());
  assert.equal(decoded.data ?? '0x', data);
  assert.equal(decoded.value ?? 0n, value);
  assert.equal(keccak256(step.raw), step.hash);
  assert.equal((await recoverTransactionAddress({ serializedTransaction: step.raw })).toLowerCase(), signer.address.toLowerCase());
  let receipt;
  try { receipt = await retry(`${label} receipt`, () => client.getTransactionReceipt({ hash: step.hash })); }
  catch (error) { if (error.name !== 'TransactionReceiptNotFoundError') throw error; }
  if (!receipt) {
    try { await client.sendRawTransaction({ serializedTransaction: step.raw }); }
    catch (error) { if (!/already known|nonce too low|known transaction/i.test(error.message)) throw error; }
    receipt = await retry(`${label} wait`, () => client.waitForTransactionReceipt({ hash: step.hash, timeout: 180000 }));
  }
  assert.equal(receipt.status, 'success', label);
  console.log(stringify({ step: label, from: signer.address, hash: step.hash, block: String(receipt.blockNumber) }));
  return receipt;
}

// ------------------------------------------------------------------ hard assertions before anything
assert.equal(await retry('chainId', () => client.getChainId()), 5042002);
const [chainOwner, chainOperator, boundFactory, executorVersion] = await Promise.all([
  executor('owner'), executor('operator'), executor('factory'), executor('KEEPER_EXECUTOR_VERSION'),
]);
assert.equal(executorVersion, 1n, 'Unknown keeper executor version');
assert.equal(boundFactory.toLowerCase(), d.launch.toLowerCase(), 'The executor is not bound to the recorded factory');
assert.equal(chainOwner.toLowerCase(), d.keeperOwner.toLowerCase(), 'The executor owner is not the recorded owner');
assert.equal((await factory('keeper')).toLowerCase(), d.keeperExecutor.toLowerCase(), 'The factory keeper is not the executor');

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const valueOf = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

// Any address that held the operator role BEFORE the address of the key now in runtime.env. Setting
// one of those again re-validates every transaction that address ever signed for this executor.
function previousOperators() {
  const current = envKeyAddress();
  const history = state.operators.map(entry => getAddress(entry.address));
  const index = history.lastIndexOf(getAddress(current));
  const earlier = index < 0 ? history : history.slice(0, index);
  return [...new Set(earlier.filter(address => address !== zeroAddress && address !== getAddress(current)))];
}

// ------------------------------------------------------------------ preflight
if (argv.length === 0) {
  const b = existsSync(operatorBPath) ? getAddress(JSON.parse(readFileSync(operatorBPath)).address) : null;
  const backend = backendState();
  const addresses = [...new Set([d.keeperExecutor, chainOperator, envKeyAddress(), funder.address, ...(b ? [b] : []),
    ...state.operators.map(entry => entry.address)].filter(a => a && getAddress(a) !== zeroAddress).map(a => getAddress(a)))];
  const balances = {};
  for (const address of addresses) balances[address] = formatEther(await balanceOf(address));
  console.log(JSON.stringify({
    chainId: 5042002,
    executor: getAddress(d.keeperExecutor),
    executorVersion: Number(executorVersion),
    owner: getAddress(chainOwner),
    onChainOperator: getAddress(chainOperator),
    paused: getAddress(chainOperator) === zeroAddress,
    envKeyAddress: envKeyAddress(),
    envKeyIsOnChainOperator: envKeyAddress() === getAddress(chainOperator),
    operatorB: b,
    operatorHistory: state.operators,
    previousOperatorsRefused: previousOperators(),
    keeperGasAvailableUSDC: formatEther(await factory('keeperGasAvailable')),
    balancesUSDC: balances,
    backend,
    snapshot: await snapshotKeeper(),
  }, null, 2));
}

// ------------------------------------------------------------------ generate operator B
if (flag('--new-operator')) {
  const saved = existsSync(operatorBPath) ? JSON.parse(readFileSync(operatorBPath)) : null;
  if (!saved?.privateKey) {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    // persist() writes with mode 0600 and fsyncs the file and its directory.
    persist(operatorBPath, { address: account.address, privateKey,
      createdAt: new Date().toISOString(), note: 'Keeper operator B for the executor rotation drill. Secret: never commit or print.' });
  }
  console.log(JSON.stringify({ operatorB: operatorB().address, file: operatorBPath, mode: '0600' }));
}

// ------------------------------------------------------------------ setOperator
if (flag('--set-operator')) {
  const raw = valueOf('--set-operator');
  assert(raw, '--set-operator needs <address|zero|B>');
  const target = raw === 'zero' ? zeroAddress : raw === 'B' ? operatorB().address : getAddress(raw);
  assert.notEqual(target, getAddress(d.keeperExecutor), 'The executor itself may not be the operator');
  assert(target === zeroAddress || target !== getAddress(d.launch), 'The factory may not be the operator');

  // Operating order: stop the backend FIRST. A running process keeps signing with the old key.
  const backend = backendState();
  assert(!backend.running, `Stop the backend first (pid ${backend.pid}, alive ${backend.alive}, port ${apiPort} ${backend.listening})`);

  const refused = previousOperators();
  if (target !== zeroAddress && refused.includes(target)) {
    assert(flag('--i-checked-nonces'),
      `${target} was an operator before the key now in runtime.env. Rotating back re-validates every transaction it ` +
      'ever signed for this executor. Confirm its nonce consumed each journaled transaction, then pass --i-checked-nonces.');
  }

  if (getAddress(chainOperator) === target) {
    console.log(JSON.stringify({ setOperator: 'already', operator: target }));
  } else {
    const label = `setOperator:${target}:${state.operators.length}`;
    const receipt = await send(label, funder, d.keeperExecutor,
      encodeFunctionData({ abi: executorAbi, functionName: 'setOperator', args: [target] }));
    const [event] = parseEventLogs({ abi: executorAbi, eventName: 'OperatorChanged', logs: receipt.logs });
    assert(event, 'No OperatorChanged event');
    assert.equal(getAddress(event.args.next), target);
    assert.equal(getAddress(event.args.previous), getAddress(chainOperator));
    state.operators.push({ address: target, source: 'rotate-keeper-operator.mjs', at: new Date().toISOString(),
      previous: getAddress(chainOperator), transactionHash: receipt.transactionHash, block: String(receipt.blockNumber) });
    saveState();
    const confirmed = await executor('operator');
    assert.equal(getAddress(confirmed), target);
    console.log(JSON.stringify({ setOperator: 'sent', previous: getAddress(chainOperator), operator: target,
      transactionHash: receipt.transactionHash, block: String(receipt.blockNumber) }));
  }
}

// ------------------------------------------------------------------ swap the configured key
if (flag('--swap-key')) {
  const mode = valueOf('--swap-key');
  assert(['B', 'A-archive-only'].includes(mode), '--swap-key needs B or A-archive-only');
  const before = readEnv();
  const previousAddress = envKeyAddress(before);
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archived = `${archiveDir}/runtime.env.${previousAddress}.${stamp}`;
  if (!existsSync(archived)) writeFileSync(archived, before, { mode: 0o600 });

  if (mode === 'A-archive-only') {
    console.log(JSON.stringify({ swapKey: 'archive-only', archived, envKeyAddress: previousAddress }));
  } else {
    const account = operatorB();
    if (previousAddress === account.address) {
      console.log(JSON.stringify({ swapKey: 'already', archived, envKeyAddress: previousAddress }));
    } else {
      let text = replaceEnvLine(before, 'ARC_KEEPER_PRIVATE_KEY', account.privateKey);
      const hasOperatorLine = envValue(before, 'ARC_KEEPER_OPERATOR_ADDRESS') !== undefined;
      if (hasOperatorLine) text = replaceEnvLine(text, 'ARC_KEEPER_OPERATOR_ADDRESS', account.address);
      // Check the candidate text BEFORE it replaces a working configuration file.
      assert.equal(envKeyAddress(text), account.address, 'The rewritten runtime.env would not derive to operator B');
      assert.equal(text.split('\n').length, before.split('\n').length, 'runtime.env line count would change');
      writeEnv(text);
      // Verify from the file on disk, not from the value we just held in memory.
      const after = readEnv();
      assert.equal(envKeyAddress(after), account.address, 'runtime.env does not derive to operator B');
      if (hasOperatorLine) assert.equal(getAddress(envValue(after, 'ARC_KEEPER_OPERATOR_ADDRESS')), account.address);
      assert.equal(after.split('\n').length, before.split('\n').length, 'runtime.env line count changed');
      console.log(JSON.stringify({ swapKey: 'rewritten', archived, previousKeyAddress: previousAddress,
        envKeyAddress: account.address, operatorAddressLineUpdated: hasOperatorLine }));
    }
  }
}

// ------------------------------------------------------------------ fund operator B
if (flag('--fund-operator')) {
  const account = operatorB();
  const used = [];
  let balance = await balanceOf(account.address);
  for (let attempt = 0; attempt < 4 && balance < OPERATOR_TARGET; attempt++) {
    const available = await factory('keeperGasAvailable');
    if (available === 0n) { used.push({ step: 'topUpKeeper', skipped: 'keeperGasAvailable is 0' }); break; }
    // 20% headroom: the factory forwards only 30,000 gas to the executor, and a bare estimate
    // converges on the cheaper "do not forward" branch, which parks the money in the executor.
    const label = `topUpKeeper:${state.funding.length}`;
    const receipt = await send(label, funder, d.launch,
      encodeFunctionData({ abi: launchAbi, functionName: 'topUpKeeper', args: [] }), 0n, 20);
    state.funding.push({ step: 'topUpKeeper', transactionHash: receipt.transactionHash, block: String(receipt.blockNumber) });
    saveState();
    used.push({ step: 'topUpKeeper', transactionHash: receipt.transactionHash, block: String(receipt.blockNumber) });
    balance = await balanceOf(account.address);
  }
  if (balance < OPERATOR_TARGET) {
    const held = await balanceOf(d.keeperExecutor);
    if (held > 0n) {
      const label = `flush:${state.funding.length}`;
      const receipt = await send(label, funder, d.keeperExecutor,
        encodeFunctionData({ abi: executorAbi, functionName: 'flush', args: [] }), 0n, 20);
      state.funding.push({ step: 'flush', transactionHash: receipt.transactionHash, block: String(receipt.blockNumber) });
      saveState();
      used.push({ step: 'flush', transactionHash: receipt.transactionHash, block: String(receipt.blockNumber) });
      balance = await balanceOf(account.address);
    } else used.push({ step: 'flush', skipped: 'the executor holds nothing' });
  }
  if (balance < OPERATOR_TARGET) {
    const amount = OPERATOR_TARGET - balance > MAX_DIRECT_FUNDING ? MAX_DIRECT_FUNDING : OPERATOR_TARGET - balance;
    const label = `fund-direct:${state.funding.length}`;
    const receipt = await send(label, funder, account.address, '0x', amount);
    state.funding.push({ step: 'direct', amountUSDC: formatEther(amount),
      transactionHash: receipt.transactionHash, block: String(receipt.blockNumber) });
    saveState();
    used.push({ step: 'direct', amountUSDC: formatEther(amount), transactionHash: receipt.transactionHash,
      block: String(receipt.blockNumber) });
    balance = await balanceOf(account.address);
  }
  console.log(JSON.stringify({ operator: account.address, balanceUSDC: formatEther(balance),
    targetUSDC: formatEther(OPERATOR_TARGET), used }, null, 2));
}

// ------------------------------------------------------------------ prove a non-operator is refused
if (flag('--check-unauthorized')) {
  const from = getAddress(valueOf('--check-unauthorized'));
  const inner = encodeFunctionData({ abi: launchAbi, functionName: 'collectFees', args: [d.platformToken] });
  const data = encodeFunctionData({ abi: executorAbi, functionName: 'execute', args: [d.launch, inner] });
  const revertData = error => {
    const seen = new Set();
    for (let cause = error; cause && !seen.has(cause); cause = cause.cause) {
      seen.add(cause);
      if (typeof cause.data === 'string' && cause.data.startsWith('0x')) return cause.data;
      if (cause.data && typeof cause.data === 'object' && typeof cause.data.data === 'string') return cause.data.data;
      if (typeof cause.raw === 'string' && cause.raw.startsWith('0x')) return cause.raw;
    }
    const match = /0x[0-9a-fA-F]{8,}/.exec(`${error?.details ?? ''} ${error?.metaMessages?.join(' ') ?? ''} ${error?.message ?? ''}`);
    return match ? match[0] : null;
  };
  let result;
  try {
    await retry('check-unauthorized', () => client.call({ to: d.keeperExecutor, data, account: from }));
    result = { from, reverted: false, unauthorized: false, note: 'The call did NOT revert: this address is accepted' };
  } catch (error) {
    const returned = revertData(error);
    result = { from, reverted: true, revertSelector: returned ? returned.slice(0, 10) : null,
      expected: UNAUTHORIZED, unauthorized: returned?.slice(0, 10) === UNAUTHORIZED,
      ...(returned?.slice(0, 10) === UNAUTHORIZED ? {} : { detail: String(error.shortMessage || error.message).slice(0, 200) }) };
  }
  console.log(JSON.stringify({ checkUnauthorized: result }, null, 2));
}

// ------------------------------------------------------------------ small trades, so fees exist to collect
const poolKeyOfPlatformToken = async () => {
  const [positionId] = await factory('tokens', [d.platformToken]);
  const [poolKey] = await read(d.positionManager, positionManagerAbi, 'getPoolAndPositionInfo', [positionId]);
  return poolKey;
};
if (flag('--buy-spark')) {
  const amount = parseEther(valueOf('--buy-spark') || '1');
  assert(amount <= parseEther('1'), 'This tool buys at most 1 USDC of SPARK');
  const label = `buy-spark:${Object.keys(state.trades).length}`;
  if (state.trades[label]) console.log(JSON.stringify({ buySpark: 'already', ...state.trades[label] }));
  else {
    const before = await read(d.platformToken, erc20Abi, 'balanceOf', [funder.address]);
    const poolKey = await poolKeyOfPlatformToken();
    const { result: [quoted] } = await retry('quote buy', () => client.simulateContract({ address: d.quoter, abi: quoterAbi,
      functionName: 'quoteExactInputSingle', args: [{ poolKey, zeroForOne: true, exactAmount: amount, hookData: '0x' }] }));
    const deadline = BigInt(await now()) + 100n;
    const receipt = await send(label, funder, d.launch, encodeFunctionData({ abi: launchAbi, functionName: 'trade',
      args: [d.platformToken, true, amount, quoted * 95n / 100n, deadline] }), amount, 20);
    const after = await read(d.platformToken, erc20Abi, 'balanceOf', [funder.address]);
    state.trades[label] = { side: 'buy', spentUSDC: formatEther(amount), receivedSPARK: formatEther(after - before),
      transactionHash: receipt.transactionHash, block: String(receipt.blockNumber) };
    saveState();
    console.log(JSON.stringify({ buySpark: state.trades[label] }, null, 2));
  }
}
if (flag('--sell-spark')) {
  const bought = Object.values(state.trades).filter(t => t.side === 'buy').reduce((sum, t) => sum + parseEther(t.receivedSPARK), 0n);
  const held = await read(d.platformToken, erc20Abi, 'balanceOf', [funder.address]);
  const amount = bought < held ? bought : held;
  assert(amount > 0n, 'Nothing to sell');
  const index = Object.keys(state.trades).length;
  const approveLabel = `approve-spark:${index}`;
  const sellLabel = `sell-spark:${index}`;
  if (state.trades[sellLabel]) console.log(JSON.stringify({ sellSpark: 'already', ...state.trades[sellLabel] }));
  else {
    if (await read(d.platformToken, erc20Abi, 'allowance', [funder.address, d.launch]) < amount) {
      await send(approveLabel, funder, d.platformToken,
        encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [d.launch, amount] }));
    }
    const poolKey = await poolKeyOfPlatformToken();
    const { result: [quoted] } = await retry('quote sell', () => client.simulateContract({ address: d.quoter, abi: quoterAbi,
      functionName: 'quoteExactInputSingle', args: [{ poolKey, zeroForOne: false, exactAmount: amount, hookData: '0x' }] }));
    const deadline = BigInt(await now()) + 100n;
    const receipt = await send(sellLabel, funder, d.launch, encodeFunctionData({ abi: launchAbi, functionName: 'trade',
      args: [d.platformToken, false, amount, quoted * 90n / 100n, deadline] }), 0n, 20);
    state.trades[sellLabel] = { side: 'sell', soldSPARK: formatEther(amount),
      transactionHash: receipt.transactionHash, block: String(receipt.blockNumber) };
    saveState();
    console.log(JSON.stringify({ sellSpark: state.trades[sellLabel] }, null, 2));
  }
}
