import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFinalizedCode } from './finalized-code.mjs';

async function start() {
const directory = dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(readFileSync(resolve(directory, 'openvrf.json')));
const upstream = process.env.OPENVRF_DIR || resolve(directory, '../data/openvrf', pin.revision);
const { FetchRequest, JsonRpcProvider, Contract, Wallet, keccak256 } = createRequire(resolve(upstream, 'package.json'))('ethers');
assert(process.env.NFT_RANDOM_DEPLOYMENT_FILE && process.env.RELAYER_KEY_FILE && process.env.RPC_URL, 'Deployment, key file and RPC required');
const report = JSON.parse(readFileSync(process.env.NFT_RANDOM_DEPLOYMENT_FILE));
assert.equal(report.chainId, 46630); assert.equal(report.environment, 'testnet');
assert.equal(report.openVrfRevision, pin.revision); assert.equal(report.status, 'verified');
assert.equal(statSync(process.env.RELAYER_KEY_FILE).mode & 0o077, 0, 'Relayer key must be owner-only');
const connection = new FetchRequest(process.env.ARCHIVE_RPC_URL || process.env.RPC_URL); connection.timeout = 15_000;
const provider = new JsonRpcProvider(connection, undefined, { batchMaxCount: 1 });
try {
  assert.equal((await provider.getNetwork()).chainId, 46630n, 'RPC chain mismatch');
  const wallet = new Wallet(readFileSync(process.env.RELAYER_KEY_FILE, 'utf8').trim());
  assert.equal(wallet.address.toLowerCase(), report.relayerAddress.toLowerCase(), 'Wrong relayer key');
  assert.notEqual(wallet.address.toLowerCase(), report.owner.toLowerCase(), 'Relayer must not be the administrator');
  const finalized = await provider.getBlock('finalized');
  assert(finalized && BigInt(finalized.number) >= BigInt(report.authorizationBlock), 'Deployment authorization not finalized');
  for (const name of ['router', 'factory', 'nft', 'vault']) {
    const code = await readFinalizedCode(provider, report.addresses[name], finalized.number);
    assert.notEqual(code, '0x'); assert.equal(keccak256(code), report.codeHashes[name], `${name} code mismatch`);
  }
  const router = new Contract(report.addresses.router, ['function authorizedConsumers(address) view returns(bool)',
    'function authorizedRelayers(address) view returns(bool)', 'function requestFee() view returns(uint256)'], provider);
  const factory = new Contract(report.addresses.factory, ['function randomnessRouter() view returns(address)',
    'function nft() view returns(address)', 'function vault() view returns(address)'], provider);
  assert(await router.authorizedConsumers(report.addresses.factory), 'NFT issuer is not authorized');
  assert(await router.authorizedRelayers(wallet.address), 'Relayer is not authorized');
  assert.equal((await factory.randomnessRouter()).toLowerCase(), report.addresses.router.toLowerCase());
  assert.equal((await factory.nft()).toLowerCase(), report.addresses.nft.toLowerCase());
  assert.equal((await factory.vault()).toLowerCase(), report.addresses.vault.toLowerCase());
} finally { provider.destroy(); }
Object.assign(process.env, { CHAIN_ID: '46630', ROUTER_ADDRESS: report.addresses.router, CONSUMER_ADDRESS: report.addresses.factory,
  RELAY_ALL_CONSUMERS: 'false', START_BLOCK: report.routerDeploymentBlock, START_REQUEST_ID: '1' });
await import(pathToFileURL(resolve(upstream, 'relayer/main.mjs')).href);
}
try { await start(); }
catch (error) {
  console.error(`NFT Relayer startup failed (${error.code ?? error.name ?? 'error'}; RPC ${error.payload?.method ?? 'unavailable'}); check configuration, deployment pins and authorization`);
  if (error.payload?.method === 'eth_getCode') console.error(`Finalized code unavailable: ${error.payload.params[0]} at ${error.payload.params[1]}`);
  process.exitCode = 1;
}
