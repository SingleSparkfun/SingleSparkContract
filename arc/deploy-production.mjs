// One command for a fresh deployment: read-only preflight, build and tests, then the existing journaled
// deployer, a read-only verification and an address file for the backend. Nothing is broadcast without
// --broadcast, and a chain whose profile is not a testnet (Arc mainnet, 5042) additionally needs --mainnet.
// Every number and V4 address comes from the committed chain profile SingleSparkContract/arc/chains/<ARC_CHAIN_ID>.json; a
// chain without one is refused. Keys are read from the env file and never printed.
//
//   node SingleSparkContract/arc/deploy-production.mjs --env SingleSparkContract/arc/.env.production.local                         # rehearsal
//   node SingleSparkContract/arc/deploy-production.mjs --env SingleSparkContract/arc/.env.production.local --broadcast             # Arc Testnet
//   node SingleSparkContract/arc/deploy-production.mjs --env SingleSparkContract/arc/.env.production.local --mainnet --broadcast   # Arc mainnet
//
// Other flags: --skip-tests (the contract tests already ran for this commit), --allow-eoa-admin (mainnet only:
// accept a plain address as team or keeper owner instead of a multisig; not recommended).
import { existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, defineChain, formatEther, getAddress, http, isAddress, parseEther, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hasChainProfile, loadChainProfile } from './chains/profile.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const flag = name => process.argv.includes(name);
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const envFile = resolve(option('--env') || resolve(root, '.env.production.local'));
const CREATE2 = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const SUPPLY = 1_000_000_000;
const MAINNET_ROUND_SECONDS = 7 * 86_400;
const MAINNET_VOTING_SECONDS = MAINNET_ROUND_SECONDS - 3_600;

const problems = [], notes = [];
const pass = message => console.log(`  ok    ${message}`);
const fail = message => { problems.push(message); console.log(`  FAIL  ${message}`); };
const note = message => { notes.push(message); console.log(`  note  ${message}`); };
const section = title => console.log(`\n${title}`);
const stop = () => {
  console.log(`\nNot deployed: ${problems.length} check${problems.length === 1 ? '' : 's'} failed. Nothing was broadcast.`);
  process.exit(1);
};

section('Environment file');
if (!existsSync(envFile)) { fail(`${envFile} does not exist; copy SingleSparkContract/arc/.env.example and fill it in`); stop(); }
if (statSync(envFile).mode & 0o077) fail(`${envFile} is readable by other users; run: chmod 600 ${envFile}`);
else pass('only the owner can read it');
if (!envFile.startsWith(`${resolve(root, '..')}/`)) pass('outside the repository');
else if (spawnSync('git', ['check-ignore', '-q', envFile], { cwd: resolve(root, '..') }).status === 0) pass('ignored by git');
else fail('not ignored by git; a private key must never be committable');
process.loadEnvFile(envFile);
const env = process.env;

section('Configuration');
const need = key => { if (!env[key]) fail(`${key} is missing`); return env[key]; };
const chainId = Number(need('ARC_CHAIN_ID'));
const rpc = need('ARC_RPC_URL');
let profile;
if (!hasChainProfile(chainId)) { fail(`chain ${chainId} has no committed profile (SingleSparkContract/arc/chains/${chainId}.json); numbers for a new chain are worked out and committed first, never guessed`); stop(); }
try { profile = loadChainProfile(chainId); } catch (error) { fail(error.message); stop(); }
const mainnet = !profile.testnet;
const currency = profile.nativeCurrency.symbol;
if (mainnet !== flag('--mainnet')) fail(mainnet ? `chain ${chainId} (${profile.name}) is a mainnet; pass --mainnet to confirm that is intended` : `--mainnet was passed but ${profile.name} (${chainId}) is a testnet`);
else pass(`target is ${profile.name}${mainnet ? ' MAINNET' : ''} (${chainId}), quoted in native ${currency}`);
{
  const { halfSupplyCost, minLaunchTick, minBuyback, keeperGas } = profile.economics;
  pass(`profile: ${formatEther(halfSupplyCost)} ${currency} buys half the supply, range floor tick ${minLaunchTick}, `
    + `minimum buyback ${formatEther(minBuyback)} ${currency}`);
  pass(`profile keeper gas: trigger ${formatEther(keeperGas.trigger)}, buffer ${formatEther(keeperGas.buffer)}, top-up `
    + `${formatEther(keeperGas.minTopup)}-${formatEther(keeperGas.maxTopup)}, daily ${formatEther(keeperGas.dailyLimit)} ${currency}`);
}

let deployer;
const key = need('ARC_DEPLOYER_PRIVATE_KEY');
if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) fail('ARC_DEPLOYER_PRIVATE_KEY must be 0x followed by 64 hex characters');
else if (key) { deployer = privateKeyToAccount(key).address; pass(`deployer ${deployer}`); }

const address = (name, required = true) => {
  const value = required ? need(name) : env[name];
  if (!value) return undefined;
  if (!isAddress(value) || getAddress(value) === zeroAddress) { fail(`${name} is not a valid non-zero address`); return undefined; }
  return getAddress(value);
};
// The profile is the only source of the V4 addresses and the economics; an env value may only repeat it.
const positionManager = profile.uniswapV4.positionManager;
const poolManager = profile.uniswapV4.poolManager;
if (env.ARC_POSITION_MANAGER && (!isAddress(env.ARC_POSITION_MANAGER) || getAddress(env.ARC_POSITION_MANAGER) !== positionManager)) {
  fail(`ARC_POSITION_MANAGER differs from the ${profile.name} profile (${positionManager}); remove it or fix SingleSparkContract/arc/chains/${chainId}.json`);
}
if (env.ARC_COMMUNITY_ADDRESS) fail('ARC_COMMUNITY_ADDRESS is obsolete: SPARK has no project treasury; its 4% joins its buyback budget');
need('ARC_PLATFORM_NAME');
if (!/^[A-Za-z0-9]{1,12}$/.test(need('ARC_PLATFORM_SYMBOL') || '')) fail('ARC_PLATFORM_SYMBOL must be 1-12 letters or digits');
for (const name of ['ARC_PLATFORM_BUY_FEE', 'ARC_PLATFORM_SELL_FEE']) {
  const fee = Number(env[name] ?? 30_000);
  if (!Number.isInteger(fee) || fee < 0 || fee > 100_000) fail(`${name} must be an integer from 0 to 100000 (10%)`);
}
if (env.ARC_PLATFORM_FEE != null) fail('ARC_PLATFORM_FEE is obsolete; use ARC_PLATFORM_BUY_FEE and ARC_PLATFORM_SELL_FEE');
if (env.ARC_MIN_BUYBACK_USDC && (!/^\d+(\.\d{1,18})?$/.test(env.ARC_MIN_BUYBACK_USDC)
  || parseEther(env.ARC_MIN_BUYBACK_USDC) !== profile.economics.minBuyback)) {
  fail(`ARC_MIN_BUYBACK_USDC differs from the profile's ${formatEther(profile.economics.minBuyback)} ${currency}; remove it or fix SingleSparkContract/arc/chains/${chainId}.json`);
}

// The vault replaces the plain operations address and the executor replaces the plain keeper address.
const vaultKeys = ['ARC_SATISFACTION_TEAM', 'ARC_SATISFACTION_ROUND_SECONDS', 'ARC_SATISFACTION_VOTING_SECONDS', 'ARC_SATISFACTION_QUORUM'];
const executorKeys = ['ARC_KEEPER_OWNER', 'ARC_KEEPER_OPERATOR_ADDRESS'];
const group = keys => { const set = keys.filter(name => env[name]); if (set.length && set.length !== keys.length) fail(`set all of ${keys.join(', ')} or none`); return set.length === keys.length; };
const withVault = group(vaultKeys), withExecutor = group(executorKeys);
let team, keeperOwner, keeperOperator, operations, keeper;
if (mainnet && !withVault) fail('mainnet requires the Satisfaction vault with a 7-day voting round');
if (withVault) {
  team = address('ARC_SATISFACTION_TEAM');
  if (env.ARC_OPERATIONS_ADDRESS) fail('remove ARC_OPERATIONS_ADDRESS: the satisfaction vault becomes the operations address');
  const round = Number(env.ARC_SATISFACTION_ROUND_SECONDS), voting = Number(env.ARC_SATISFACTION_VOTING_SECONDS), quorum = env.ARC_SATISFACTION_QUORUM;
  if (!Number.isInteger(round) || !Number.isInteger(voting) || voting <= 0 || voting >= round) fail('the voting window must be a positive number of seconds shorter than the round');
  else pass(`satisfaction round ${(round / 86400).toFixed(2)} days, voting window ${(voting / 86400).toFixed(2)} days`);
  if (mainnet && (round !== MAINNET_ROUND_SECONDS || voting !== MAINNET_VOTING_SECONDS)) {
    fail(`mainnet Satisfaction schedule must be ${MAINNET_ROUND_SECONDS}s per round and ${MAINNET_VOTING_SECONDS}s of voting`);
  }
  if (!/^\d+(\.\d{1,18})?$/.test(quorum) || Number(quorum) <= 0) fail('ARC_SATISFACTION_QUORUM must be a positive SPARK amount');
  else if (Number(quorum) > SUPPLY) fail('ARC_SATISFACTION_QUORUM exceeds the whole supply; every round would be Void');
  else {
    pass(`quorum ${Number(quorum).toLocaleString('en-US')} SPARK = ${(Number(quorum) / SUPPLY * 100).toFixed(6)}% of supply (immutable)`);
    if (mainnet && Number(quorum) <= 1000) note('the quorum equals the test value; on mainnet it should be sized by value, and it can never be changed');
  }
} else { operations = address('ARC_OPERATIONS_ADDRESS'); note('no satisfaction vault: the 1% platform share goes to a plain address'); }
if (withExecutor) {
  keeperOwner = address('ARC_KEEPER_OWNER'); keeperOperator = address('ARC_KEEPER_OPERATOR_ADDRESS');
  if (env.ARC_KEEPER_ADDRESS) fail('remove ARC_KEEPER_ADDRESS: the keeper executor becomes the keeper');
} else { keeper = address('ARC_KEEPER_ADDRESS'); note('no keeper executor: the keeper wallet can never be rotated for this factory'); }

// The keeper operator signs deployment; treasuries and the executor owner stay separate.
const hot = keeperOperator || keeper;
for (const [name, value] of [['team', team], ['operations', operations], ['keeper owner', keeperOwner]]) {
  if (value && hot && value === hot) fail(`the ${name} address is the keeper hot wallet; treasuries and the keeper must be separate`);
  if (value && deployer && value === deployer) fail(`the ${name} address must be separate from the deployer`);
}
if (hot && deployer && hot !== deployer) fail('ARC_DEPLOYER_PRIVATE_KEY must belong to the keeper operator wallet');

const metadata = env.ARC_PLATFORM_METADATA_URI || '';
if (new TextEncoder().encode(metadata).length > 512) fail('ARC_PLATFORM_METADATA_URI exceeds 512 bytes');
if (!metadata) note('ARC_PLATFORM_METADATA_URI is empty: the platform token is launched without an image or links, permanently');
else if (mainnet && !/^https:\/\/(?!localhost|127\.|\[::1\])/.test(metadata)) fail('on mainnet the platform metadata URI is written on-chain and must be a public https URL');
for (const name of ['ARC_WEB_ORIGIN', 'ARC_MEDIA_PUBLIC_BASE']) if (mainnet && env[name] && !env[name].startsWith('https://')) fail(`${name} must be https on mainnet`);

const dataDir = resolve(env.ARC_DATA_DIR || resolve(root, 'data'));
const deploymentPath = resolve(dataDir, 'deployment.json');
if (existsSync(deploymentPath)) fail(`${deploymentPath} already exists; a finished deployment is never overwritten, choose a new ARC_DATA_DIR`);
else if (existsSync(resolve(dataDir, 'deployment-journal.json'))) note('a deployment journal exists: completed steps are reused, so the configuration must be unchanged');
else pass(`fresh data directory ${dataDir}`);
if (existsSync(resolve(dataDir, 'deployment.lock'))) fail(`${resolve(dataDir, 'deployment.lock')} exists; confirm that process stopped, then delete the lock (keep the journal)`);
if (problems.length) stop();

section('Chain (read-only)');
const chain = defineChain({ id: chainId, name: profile.name, nativeCurrency: profile.nativeCurrency, rpcUrls: { default: { http: [rpc] } } });
const client = createPublicClient({ chain, transport: http(rpc, { timeout: 15_000, retryCount: 2 }) });
const hasCode = async value => { const code = await client.getCode({ address: value }); return !!code && code !== '0x'; };
/**
 * Classifies an address: a plain account, a real contract, or an EOA that has handed its behaviour to
 * someone else's code with EIP-7702. The delegation indicator is `0xef0100` plus the 20-byte delegate,
 * exactly 23 bytes. Value sent to such an account runs that code, which can forward the money onward
 * and still report success — so an address in this state must never be written into an immutable slot.
 * Weak keys are routinely claimed this way; the fork run on 2026-09-20 hit it with `0x00..00c3`.
 */
const classify = async value => {
  const code = await client.getCode({ address: value });
  if (!code || code === '0x') return { kind: 'account' };
  if (/^0xef0100[0-9a-f]{40}$/i.test(code)) return { kind: 'delegated', delegate: getAddress(`0x${code.slice(8)}`) };
  return { kind: 'contract', size: (code.length - 2) / 2 };
};
const refuseDelegated = (name, value, state) => {
  if (state.kind !== 'delegated') return false;
  fail(`${name} ${value} has handed itself to ${state.delegate} with EIP-7702. Native ${currency} sent there runs `
    + 'that code and can be forwarded away while the transfer still reports success. A multisig is never '
    + 'in this state, so this address is either compromised or not the one you meant. Use a different address.');
  return true;
};
try {
  const reported = await client.getChainId();
  if (reported !== chainId) fail(`the RPC reports chain ${reported}, not ${chainId}`); else pass(`RPC ${new URL(rpc).host} is chain ${chainId}`);
  if (await hasCode(positionManager)) pass('Uniswap V4 PositionManager has code'); else fail(`no contract at the profile's PositionManager ${positionManager}`);
  if (!await hasCode(poolManager)) fail(`no contract at the profile's PoolManager ${poolManager}`);
  else {
    const wired = await client.readContract({ address: positionManager, functionName: 'poolManager',
      abi: [{ type: 'function', name: 'poolManager', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }] });
    if (getAddress(wired) === poolManager) pass('the PositionManager points at the profile\'s PoolManager');
    else fail(`the PositionManager points at ${wired}, not the profile's PoolManager ${poolManager}`);
  }
  if (await hasCode(CREATE2)) pass('standard CREATE2 deployer is present'); else fail(`the standard CREATE2 deployer ${CREATE2} is missing on this chain; the fee hook cannot be deployed`);
  const deployerState = await classify(deployer);
  if (!refuseDelegated('the deployer', deployer, deployerState) && deployerState.kind === 'contract') {
    fail('the deployer address is a contract; the vault and executor must be deployed by a plain account');
  }
  // Admin roles: a multisig is expected, a plain account is a permanent single point of failure.
  for (const [name, value] of [['satisfaction team', team], ['keeper owner', keeperOwner]]) {
    if (!value) continue;
    const state = await classify(value);
    if (refuseDelegated(name, value, state)) continue;
    if (state.kind === 'contract') pass(`${name} ${value} is a contract (multisig), ${state.size} bytes`);
    else if (!mainnet) note(`${name} ${value} is a plain address; mainnet needs a multisig`);
    else if (flag('--allow-eoa-admin')) note(`${name} ${value} is a plain address, accepted by --allow-eoa-admin; it is immutable`);
    else fail(`${name} ${value} is a plain address; use a multisig, or pass --allow-eoa-admin to accept that permanently`);
  }
  // Everything else that is written into an immutable slot or is paid the native currency by the contracts.
  for (const [name, value, immutable] of [['keeper operator', keeperOperator, false],
    ['operations address', operations, true], ['keeper wallet', keeper, true]]) {
    if (!value) continue;
    const state = await classify(value);
    if (refuseDelegated(name, value, state)) continue;
    if (state.kind === 'account') pass(`${name} ${value} is a plain account`);
    else if (immutable) {
      note(`${name} ${value} is a contract (${state.size} bytes) and is written on-chain permanently; `
        + `if it cannot receive native ${currency} its share is stuck there for good`);
    } else note(`${name} ${value} is a contract (${state.size} bytes); it must be able to receive native ${currency} for gas`);
  }
  const balance = await client.getBalance({ address: deployer });
  // Default: what 3 USDC is worth in this currency by the profile's own scale (halfSupplyCost = 10,000 USDC).
  const minimumSetting = env.ARC_DEPLOYER_MIN_NATIVE || env.ARC_DEPLOYER_MIN_USDC;
  const minimum = minimumSetting ? parseEther(minimumSetting) : profile.economics.halfSupplyCost * 3n / 10_000n;
  if (balance < minimum) fail(`deployer holds ${formatEther(balance)} ${currency}, below the ${formatEther(minimum)} ${currency} minimum (ARC_DEPLOYER_MIN_NATIVE)`);
  else pass(`deployer holds ${formatEther(balance)} ${currency} for gas`);
} catch (error) { fail(`the RPC could not be read: ${error.shortMessage || error.message}`); }
if (problems.length) stop();

const run = (title, command, args, extraEnv) => {
  section(title);
  const result = spawnSync(command, args, { cwd: resolve(root, '..'), stdio: 'inherit', env: { ...env, ...extraEnv } });
  if (result.status !== 0) { fail(`${command} ${args[0]} exited with ${result.status ?? result.signal}`); stop(); }
};
run('Build', 'forge', ['build', '--root', 'backend']);
if (flag('--skip-tests')) note('contract tests skipped by --skip-tests'); else run('Contract tests', 'forge', ['test', '--root', 'backend']);

if (!flag('--broadcast')) {
  console.log(`\nRehearsal passed. Nothing was broadcast. ${notes.length ? `Review the ${notes.length} note${notes.length === 1 ? '' : 's'} above, then` : 'To deploy,'} add --broadcast.`);
  if (mainnet) console.log('These contracts are immutable and have not been audited; a mistake cannot be patched, only redeployed.');
  process.exit(0);
}

run(`Deploying to ${profile.name}${mainnet ? ' MAINNET' : ''}`, process.execPath, [resolve(root, 'deploy.mjs'), '--broadcast', ...(mainnet ? [] : ['--testnet'])]);
const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'));
if (deployment.satisfaction || deployment.keeperExecutor) {
  run('Verification (read-only)', process.execPath, [resolve(root, 'verify-satisfaction-deployment.mjs'), deploymentPath, resolve(dataDir, 'deployment-verification.json')]);
}

// Public values only. Secrets for the running backend (keeper key, config signing key, treasury encryption key)
// belong in the backend's own env file and are not copied here.
const addresses = { ARC_CHAIN_ID: chainId, ARC_LAUNCH_ADDRESS: deployment.launch, ARC_QUOTER_ADDRESS: deployment.quoter,
  ARC_POSITION_MANAGER: deployment.positionManager, ARC_FROM_BLOCK: deployment.fromBlock,
  ARC_DATABASE_SCHEMA: `arc_${deployment.launch.slice(2).toLowerCase()}`,
  ...(deployment.satisfaction ? { ARC_SATISFACTION_ADDRESS: deployment.satisfaction, ARC_SATISFACTION_FROM_BLOCK: deployment.fromBlock } : {}),
  ...(deployment.keeperExecutor ? { ARC_KEEPER_EXECUTOR: deployment.keeperExecutor, ARC_KEEPER_OPERATOR_ADDRESS: deployment.keeperOperator } : {}) };
const addressFile = resolve(dataDir, 'deployment-addresses.env');
writeFileSync(addressFile, `${Object.entries(addresses).map(([name, value]) => `${name}=${value}`).join('\n')}\n`, { mode: 0o600 });

section('Deployed');
for (const [name, value] of Object.entries({ factory: deployment.launch, platformToken: deployment.platformToken, strategy: deployment.strategy,
  quoter: deployment.quoter, rewards: deployment.rewards, satisfaction: deployment.satisfaction, keeperExecutor: deployment.keeperExecutor })) if (value) console.log(`  ${name.padEnd(15)} ${value}`);
console.log(`\n  record     ${deploymentPath}\n  addresses  ${addressFile}`);
console.log(`
Next, in this order:
  1. Put the same wallet key in the backend env as ARC_KEEPER_PRIVATE_KEY, then remove ARC_DEPLOYER_PRIVATE_KEY from ${envFile}.
  2. Copy ${addressFile} into the backend env file, with a new ARC_DATA_DIR and the backend's other secrets.
  3. Put the config signer's public address in the frontend VITE_CHAIN_CONFIG_SIGNERS, then start one backend.
  4. Fund the keeper operator with ${currency} for gas. Exactly one keeper process may run per keeper wallet.`);
