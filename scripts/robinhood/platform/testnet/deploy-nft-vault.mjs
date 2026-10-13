import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, statSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createPublicClient, createWalletClient, defineChain, http, encodeDeployData, encodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item, 2);
const read = path => JSON.parse(readFileSync(path));
const arg = flag => { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; };
const walletPath = arg('--wallet'); assert(walletPath, 'Pass an owner-only workspace testnet --wallet file');
assert.equal(statSync(walletPath).mode & 0o077, 0, 'Wallet file must be owner-only');
const saved = read(walletPath);
const accounts = Object.fromEntries(['deployer', 'admin'].map(role => {
  const account = privateKeyToAccount(saved[role].privateKey);
  assert.equal(account.address.toLowerCase(), saved[role].address.toLowerCase()); return [role, account];
}));
const rpc = 'https://rpc.testnet.chain.robinhood.com';
const chain = defineChain({ id: 46630, name: 'Robinhood Chain Testnet', testnet: true,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const transport = http(rpc, { timeout: 30000, retryCount: 2 });
const client = createPublicClient({ chain, transport, pollingInterval: 1500, cacheTime: 0 });
assert.equal(await client.getChainId(), 46630, 'RPC chain mismatch');
const names = ['PlatformNftVaultFactory', 'PlatformNft', 'PlatformNftRevenueVault'];
const artifacts = Object.fromEntries(names.map(name => [name, read(resolve(root, `chains/robinhood/out/platform/${name}.sol/${name}.json`))]));
const owner = accounts.admin.address;
const identity = createHash('sha256').update(json({ chainId: 46630, owner, deployer: accounts.deployer.address,
  artifacts: Object.fromEntries(names.map(name => [name, artifacts[name].bytecode.object])) })).digest('hex');
const privateDir = resolve(root, 'chains/robinhood/data/platform-nft-vault', identity);
const journalPath = resolve(privateDir, 'transactions.json');
const reportPath = resolve(root, 'chains/robinhood/deployments/testnet/platform/nft-vault.json');
const journal = existsSync(journalPath) ? read(journalPath) : { identity, steps: {} };
assert.equal(journal.identity, identity);
const report = existsSync(reportPath) ? read(reportPath) : { identity, chainId: 46630, environment: 'testnet', owner,
  addresses: {}, codeHashes: {}, transactions: {}, issuance: { randomClaimsEnabled: false, xClaimsEnabled: false, referralClaimsEnabled: false } };
assert.equal(report.identity, identity, 'Preserve the original deployment report; use a new reviewed report path for another build');
const persist = (path, value) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.tmp'; writeFileSync(temp, json(value) + '\n', { mode: 0o600 });
  const fd = openSync(temp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const parent = openSync(dirname(path), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
};
const maximumTotalCostWei = 1_000_000_000_000_000n;
if (!process.argv.includes('--broadcast')) {
  console.log(json({ status: 'prepared', chainId: 46630, owner, identity, maximumTotalCostWei, journalPath })); process.exit(0);
}
mkdirSync(privateDir, { recursive: true, mode: 0o700 });
const lockPath = resolve(privateDir, 'run.lock'); const lock = openSync(lockPath, 'wx', 0o600);
try {
 async function send(label, tx, role = 'deployer') {
  assert.equal(await client.getChainId(), 46630);
  const account = accounts[role]; const wallet = createWalletClient({ chain, account, transport });
  if (existsSync(journalPath)) assert.equal(json(read(journalPath)), json(journal), 'Another process advanced the journal');
  const intended = { ...tx, value: tx.value ?? 0n };
  let step = journal.steps[label];
  if (step) { assert.equal(json(step.transaction), json(intended)); assert.equal(step.from.toLowerCase(), account.address.toLowerCase()); }
  else {
   const [latest, pending] = await Promise.all(['latest', 'pending'].map(blockTag => client.getTransactionCount({ address: account.address, blockTag })));
   assert.equal(latest, pending, 'Resolve pending transactions before deploying');
   const request = await wallet.prepareTransactionRequest({ ...intended, nonce: pending, type: 'legacy', gasPrice: await client.getGasPrice() });
   const maximumCostWei = request.gas * request.gasPrice + intended.value;
   assert(maximumCostWei <= 500_000_000_000_000n, 'Per-transaction test ETH budget exceeded');
   assert(Object.values(journal.steps).reduce((sum, entry) => sum + BigInt(entry.maximumCostWei), 0n) + maximumCostWei <= maximumTotalCostWei, 'Total test ETH budget exceeded');
   assert(await client.getBalance({ address: account.address }) >= maximumCostWei, 'Insufficient test ETH');
   const raw = await wallet.signTransaction(request);
   step = { from: account.address, transaction: intended, raw, hash: keccak256(raw), maximumCostWei: String(maximumCostWei) };
   journal.steps[label] = step; persist(journalPath, journal);
  }
  const parsed = parseTransaction(step.raw);
  assert.equal(parsed.chainId, 46630); assert.equal(keccak256(step.raw), step.hash);
  assert.equal((await recoverTransactionAddress({ serializedTransaction: step.raw })).toLowerCase(), account.address.toLowerCase());
  assert.equal(parsed.to?.toLowerCase(), intended.to?.toLowerCase()); assert.equal(parsed.data ?? '0x', intended.data ?? '0x');
  assert.equal(parsed.value ?? 0n, BigInt(intended.value));
  let receipt = await client.getTransactionReceipt({ hash: step.hash }).catch(error => { if (error.name !== 'TransactionReceiptNotFoundError') throw error; });
  if (!receipt) {
   await client.sendRawTransaction({ serializedTransaction: step.raw }).catch(error => { if (!/already known|nonce too low/i.test(error.shortMessage ?? error.message)) throw error; });
   receipt = await client.waitForTransactionReceipt({ hash: step.hash, confirmations: 2, timeout: 60000 });
  }
  assert.equal(receipt.status, 'success', `${label} reverted; preserve the journal`);
  assert.equal((await client.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash);
  report.transactions[label] = { hash: receipt.transactionHash, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash,
   gasCostWei: String(receipt.gasUsed * receipt.effectiveGasPrice) };
  persist(reportPath, report); console.log(label, receipt.transactionHash); return receipt;
 }
 const call = (address, artifact, functionName, args = [], blockNumber) => client.readContract({ address, abi: artifact.abi, functionName, args, blockNumber });
 const factoryArtifact = artifacts.PlatformNftVaultFactory, vaultArtifact = artifacts.PlatformNftRevenueVault;
 const deployment = await send('deploy-platform-factory', { data: encodeDeployData({ abi: factoryArtifact.abi, bytecode: factoryArtifact.bytecode.object, args: [owner] }) });
 const factory = deployment.contractAddress; assert(factory);
 const nft = await call(factory, factoryArtifact, 'nft'); const vault = await call(factory, factoryArtifact, 'vault');
 report.addresses = { factory, nft, vault }; report.deploymentBlock = String(deployment.blockNumber);
 const mask = (code, references) => { let value = code.slice(2); for (const entries of Object.values(references ?? {})) for (const { start, length } of entries) value = value.slice(0, start * 2) + '0'.repeat(length * 2) + value.slice((start + length) * 2); return value.toLowerCase(); };
 for (const [name, address, artifact] of [['factory', factory, factoryArtifact], ['nft', nft, artifacts.PlatformNft], ['vault', vault, vaultArtifact]]) {
  const code = await client.getCode({ address }); assert(code && code !== '0x');
  assert.equal(mask(code, artifact.deployedBytecode.immutableReferences), mask(artifact.deployedBytecode.object, artifact.deployedBytecode.immutableReferences), `${name} runtime mismatch`);
  report.codeHashes[name] = keccak256(code);
 }
 assert.equal((await call(vault, vaultArtifact, 'owner')).toLowerCase(), owner.toLowerCase());
 assert.equal((await call(vault, vaultArtifact, 'nft')).toLowerCase(), nft.toLowerCase());
 assert.equal((await call(vault, vaultArtifact, 'controller')).toLowerCase(), factory.toLowerCase());
 assert.equal(await call(vault, vaultArtifact, 'EPOCH_DURATION'), 604800n); assert.equal(await call(factory, factoryArtifact, 'DELAY'), 172800n);
 report.genesis = String(await call(vault, vaultArtifact, 'genesis')); persist(reportPath, report);
 const income = 1_000_000_000_000n;
 const deposit = await send('verify-treasury-forwarding', { to: factory, value: income });
 assert.equal(await call(vault, vaultArtifact, 'totalReceived', [], deposit.blockNumber), income);
 assert.equal(await call(vault, vaultArtifact, 'ownerCredit', [], deposit.blockNumber), income / 2n);
 assert.equal(await call(vault, vaultArtifact, 'nftReserve', [], deposit.blockNumber), income / 2n);
 const claimed = await send('verify-owner-half-withdrawal', { to: vault, data: encodeFunctionData({ abi: vaultArtifact.abi, functionName: 'claimOwner' }) }, 'admin');
 assert.equal(await call(vault, vaultArtifact, 'ownerCredit', [], claimed.blockNumber), 0n);
 assert.equal(await call(vault, vaultArtifact, 'nftReserve', [], claimed.blockNumber), income / 2n);
 assert.equal(await client.getBalance({ address: vault, blockNumber: claimed.blockNumber }), income / 2n);
 const finalized = await client.getBlock({ blockTag: 'finalized' });
 report.finalizedThroughBlock = String(finalized.number);
 report.finalityComplete = Object.values(report.transactions).every(tx => BigInt(tx.blockNumber) <= finalized.number);
 report.status = report.finalityComplete ? 'verified' : 'verified_pending_finality';
 report.verification = { treasuryForwarding: true, ownerHalfWithdrawal: true, nftReservePreserved: true, runtimeCodeMatched: true,
  weeklySettlementSeconds: 604800, policyDelaySeconds: 172800, weeklyClaimLiveVerified: false };
 persist(reportPath, report); console.log(json({ status: report.status, addresses: report.addresses, verification: report.verification }));
} finally { closeSync(lock); unlinkSync(lockPath); }
