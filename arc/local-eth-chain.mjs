// A second, local chain for trying the multi-chain frontend: an Anvil node (chain 31337) quoting in ETH, with
// Uniswap v4 and the whole SingleSpark stack deployed from the synthetic ETH-like test profile, two demo memes
// with a few trades, and the env file for its own backend. Everything is local: Anvil's published development
// keys, synthetic balances, no public network. The numbers are test numbers, not a price for any real chain.
//
//   node SingleSparkContract/arc/local-eth-chain.mjs            start (or reuse) the node, deploy once, write the backend env
//   node SingleSparkContract/arc/local-eth-chain.mjs --stop     stop the node (its state is kept for the next start)
//
// The backend then runs with:  SingleSparkContract/arc/data/local-eth-31337/backend SingleSparkContract/arc/data/local-eth-31337/runtime.env
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, parseEventLogs, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { artifact, deployArc } from './deploy.mjs';
import { loadProfileFile } from './chains/profile.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const dir = resolve(root, 'data/local-eth-31337');
const PORT = 8546, API_PORT = 8091;
const url = `http://127.0.0.1:${PORT}`;
const profilePath = resolve(root, 'test/profiles/eth-like.json');
const profile = loadProfileFile(profilePath);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const pidFile = resolve(dir, 'anvil.pid');

if (process.argv.includes('--stop')) {
  if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch {} }
  console.log('anvil stopped; state kept in', resolve(dir, 'anvil-state.json'));
  process.exit(0);
}

const chain = defineChain({ id: profile.chainId, name: 'Local ETH Test', nativeCurrency: profile.nativeCurrency,
  rpcUrls: { default: { http: [url] } } });
const client = createPublicClient({ chain, transport: http(url, { retryCount: 0 }), cacheTime: 0 });
const alive = async () => { try { return await client.getChainId() === profile.chainId; } catch { return false; } };

if (!await alive()) {
  // Detached, so the node outlives this script; --state writes the chain to disk on exit and reloads it.
  // Blocks only when a transaction arrives: a block every second grew Anvil's temp state by about 1 GB an hour.
  const log = openSync(resolve(dir, 'anvil.log'), 'a');
  const node = spawn('anvil', ['--port', String(PORT), '--chain-id', String(profile.chainId), '--gas-limit', '60000000',
    '--state', resolve(dir, 'anvil-state.json'), '--silent'], { detached: true, stdio: ['ignore', log, log] });
  node.unref();
  writeFileSync(pidFile, String(node.pid));
  for (let i = 0; !await alive(); i++) { assert(i < 100, 'anvil did not start'); await new Promise(r => setTimeout(r, 100)); }
  console.log(`anvil ${PORT} started (pid ${node.pid})`);
} else console.log(`anvil ${PORT} already running`);

// Anvil's published development keys; they only ever hold Anvil's own balances.
const keys = ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'];
const [deployer, operator, trader] = keys.map(key => privateKeyToAccount(key));
const walletFor = account => createWalletClient({ account, chain, transport: http(url) });
const recordPath = resolve(dir, 'deployment.json');
const launchAbi = artifact('ArcLaunchV2').abi;

let deployment = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : null;
if (deployment && (await client.getCode({ address: deployment.launch }))?.length > 2) {
  console.log('stack already deployed at', deployment.launch);
} else {
  const deployContract = async (name, args) => {
    const compiled = artifact(name);
    const hash = await walletFor(deployer).deployContract({ abi: compiled.abi, bytecode: compiled.bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    return receipt.contractAddress;
  };
  const fromBlock = await client.getBlockNumber();
  const poolManager = await deployContract('PoolManager', [deployer.address]);
  const positionManager = await deployContract('PositionManager', [poolManager, zeroAddress, 100000, zeroAddress, zeroAddress]);
  const community = privateKeyToAccount(`0x${'2'.padStart(64, '0')}`).address;
  deployment = await deployArc(client, walletFor(deployer), {
    profile, positionManager, community, platformName: 'SingleSpark', platformSymbol: 'SPARK',
    satisfaction: { team: privateKeyToAccount(`0x${'4'.padStart(64, '0')}`).address, roundDuration: 1800, votingDuration: 600, quorum: 1000 },
    executor: { owner: deployer.address, operator: operator.address }, journalPath: resolve(dir, 'deployment-journal.json'),
  });
  deployment.fromBlock = fromBlock.toString();
  writeFileSync(recordPath, JSON.stringify(deployment, null, 2));
  console.log('stack deployed at', deployment.launch);

  // Two demo memes and a few trades, priced in the profile's own units (one "dollar" = halfSupplyCost / 10,000).
  const unit = profile.economics.halfSupplyCost / 10_000n;
  const now = async () => (await client.getBlock()).timestamp;
  const send = async (account, address, abi, functionName, args = [], value = 0n) => {
    const receipt = await client.waitForTransactionReceipt({ hash: await walletFor(account).writeContract({ address, abi, functionName, args, value }) });
    assert.equal(receipt.status, 'success', `${functionName} reverted`);
    return receipt;
  };
  for (const [name, symbol, buyFee, sellFee] of [['Ether Cat', 'ECAT', 30_000, 30_000], ['Moon Frog', 'MFROG', 10_000, 50_000]]) {
    const launched = await send(trader, deployment.launch, launchAbi, 'launch', [name, symbol, '', buyFee, sellFee, community]);
    const token = parseEventLogs({ abi: launchAbi, eventName: 'Launched', logs: launched.logs })[0].args.token;
    await new Promise(r => setTimeout(r, 4_000)); // past the opening ladder, on the node's own clock
    await send(trader, deployment.launch, launchAbi, 'trade', [token, true, 200n * unit, 1n, await now() + 600n], 200n * unit);
    const bought = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [trader.address] });
    await send(trader, token, erc20Abi, 'approve', [deployment.launch, bought / 3n]);
    await send(trader, deployment.launch, launchAbi, 'trade', [token, false, bought / 3n, 1n, await now() + 600n]);
    console.log(`demo meme ${symbol} at ${token}`);
  }
}

// The backend's env. Secrets are generated once and kept: this file is the node's identity for the frontend.
const envPath = resolve(dir, 'runtime.env');
const keep = existsSync(envPath) ? Object.fromEntries(readFileSync(envPath, 'utf8').split('\n')
  .filter(line => /^[A-Z_]+=/.test(line)).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).replace(/^"|"$/g, '')])) : {};
const signingKey = keep.ARC_CONFIG_SIGNING_KEY || `0x${randomBytes(32).toString('hex')}`;
const env = {
  ARC_CHAIN_ID: String(profile.chainId), ARC_CHAIN_NAME: 'Local ETH Test', ARC_NATIVE_NAME: profile.nativeCurrency.name,
  ARC_NATIVE_SYMBOL: profile.nativeCurrency.symbol, ARC_NATIVE_DECIMALS: '18', ARC_TESTNET: 'true',
  ARC_RPC_URL: url, ARC_PUBLIC_RPC_URL: url, ARC_WS_URL: `ws://127.0.0.1:${PORT}`,
  ARC_EXPLORER_URL: `http://127.0.0.1:${API_PORT}`, ARC_WEB_ORIGIN: 'http://127.0.0.1:5176',
  ARC_HOST: '127.0.0.1', ARC_PORT: String(API_PORT), ARC_DATA_DIR: resolve(dir, 'runtime'),
  ARC_DATABASE_SCHEMA: 'arc_local_eth_31337', ARC_MEDIA_PUBLIC_BASE: `http://127.0.0.1:${API_PORT}/api/arc/media`,
  ARC_LAUNCH_ADDRESS: deployment.launch, ARC_QUOTER_ADDRESS: deployment.quoter, ARC_POSITION_MANAGER: deployment.positionManager,
  ARC_FROM_BLOCK: deployment.fromBlock ?? '0', ARC_OPERATIONS_ADDRESS: deployment.operations,
  ARC_KEEPER_EXECUTOR: deployment.keeperExecutor ?? '', ARC_KEEPER_OPERATOR_ADDRESS: operator.address,
  ARC_KEEPER_PRIVATE_KEY: keys[1], ARC_SATISFACTION_ADDRESS: deployment.satisfaction ?? '',
  ARC_SATISFACTION_FROM_BLOCK: deployment.fromBlock ?? '0',
  ARC_CONFIG_SIGNING_KEY: signingKey, ARC_CONFIG_KEY_ID: 'local-eth-31337',
  ARC_TREASURY_ENCRYPTION_KEY: keep.ARC_TREASURY_ENCRYPTION_KEY || randomBytes(32).toString('hex'),
  ARC_INSTANCE_NAME: 'local-eth-31337',
};
writeFileSync(envPath, Object.entries(env).map(([k, v]) => `${k}="${v}"`).join('\n') + '\n', { mode: 0o600 });
mkdirSync(env.ARC_DATA_DIR, { recursive: true, mode: 0o700 });
console.log(`env written to ${envPath}`);
console.log(`frontend signer entry: "local-eth-31337": "${privateKeyToAccount(signingKey).address}"`);
