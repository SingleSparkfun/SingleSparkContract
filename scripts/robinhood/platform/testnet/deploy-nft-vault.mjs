import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, statSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createPublicClient, createWalletClient, defineChain, http, encodeDeployData, encodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { randomNftConfig, nftDeploymentReportName } from './random-nft-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item, 2);
const read = path => JSON.parse(readFileSync(path));
const arg = flag => { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; };
const testnetBuildPath = arg('--testnet-build');
const deploymentId = arg('--deployment-id');
assert(!deploymentId || /^[a-z0-9][a-z0-9-]{0,63}$/.test(deploymentId), 'Invalid testnet deployment ID');
assert.equal(Boolean(testnetBuildPath), Boolean(deploymentId), 'An isolated testnet build requires its own deployment ID');
const testnetBuild = testnetBuildPath ? read(resolve(testnetBuildPath)) : null;
if (testnetBuild) { assert.equal(testnetBuild.chainId, 46630); assert.equal(testnetBuild.policyDelaySeconds, 600); assert.equal(testnetBuild.epochDurationSeconds, 14400); }
const policyPath = arg('--random-config');
const policy = policyPath ? randomNftConfig(read(policyPath)) : null;
const openVrfPin = policy ? read(resolve(root, 'chains/robinhood/randomness/openvrf.json')) : null;
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
const names = policy ? ['PlatformRandomNftFactory', 'PlatformRandomNft', 'PlatformRandomNftRevenueVault', 'PlatformNftSalesVault']
  : ['PlatformNftVaultFactory', 'PlatformNft', 'PlatformNftRevenueVault'];
const artifacts = Object.fromEntries(names.map(name => [name, testnetBuild ? testnetBuild.artifacts[name] : read(resolve(root, `chains/robinhood/out/platform/${name}.sol/${name}.json`))]));
if (policy) artifacts.OpenVRF = read(resolve(root, `chains/robinhood/data/openvrf/${openVrfPin.revision}/out/OpenVRF.sol/OpenVRF.json`));
const owner = accounts.admin.address;
if (policy) for (const account of Object.values(accounts)) assert.notEqual(policy.relayer.toLowerCase(), account.address.toLowerCase(), 'Use a dedicated Relayer Gas wallet');
const identity = createHash('sha256').update(json({ chainId: 46630, owner, deployer: accounts.deployer.address,
  artifacts: Object.fromEntries(Object.keys(artifacts).map(name => [name, artifacts[name].bytecode.object])), randomPolicy: policy ?? undefined })).digest('hex');
const privateDir = resolve(root, policy ? 'chains/robinhood/data/platform-random-nft-vault' : 'chains/robinhood/data/platform-nft-vault', identity);
const journalPath = resolve(privateDir, 'transactions.json');
const immediateClaims = process.argv.includes('--immediate-claims');
const reportPath = resolve(root, 'chains/robinhood/deployments/testnet/platform', deploymentId ? `nft-random-${deploymentId}.json` : nftDeploymentReportName({ random: !!policy, immediateClaims }));
const journal = existsSync(journalPath) ? read(journalPath) : { identity, steps: {} };
assert.equal(journal.identity, identity);
const report = existsSync(reportPath) ? read(reportPath) : { identity, chainId: 46630, environment: 'testnet', owner,
  addresses: {}, codeHashes: {}, transactions: {}, issuance: { randomClaimsEnabled: false, xClaimsEnabled: false, referralClaimsEnabled: false } };
if (policy) Object.assign(report, { openVrfRevision: openVrfPin.revision, relayerAddress: policy.relayer,
  randomPolicy: { probabilitiesBps: policy.probabilities, gradeWeights: policy.weights, artworkUris: policy.artwork, requestFeeWei: String(policy.requestFeeWei) } });
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
 const factoryArtifact = artifacts[names[0]], vaultArtifact = artifacts[names[2]];
 let router;
 if (policy) {
  const routerDeployment = await send('deploy-randomness-router', { data: encodeDeployData({ abi: artifacts.OpenVRF.abi,
   bytecode: artifacts.OpenVRF.bytecode.object, args: [owner, policy.relayer, policy.requestFeeWei] }) });
  router = routerDeployment.contractAddress; assert(router);
  report.routerDeploymentBlock = String(routerDeployment.blockNumber);
 }
 const deployment = await send('deploy-platform-factory', { data: encodeDeployData({ abi: factoryArtifact.abi, bytecode: factoryArtifact.bytecode.object,
  args: policy ? [owner, router, policy.probabilities, policy.weights, policy.artwork] : [owner] }) });
 const factory = deployment.contractAddress; assert(factory);
 const nft = await call(factory, factoryArtifact, 'nft'); const vault = await call(factory, factoryArtifact, 'vault');
 report.addresses = { factory, nft, vault, ...(router ? { router } : {}) }; report.deploymentBlock = String(deployment.blockNumber);
 if(policy) { report.addresses.salesVault=await call(factory,factoryArtifact,'salesVault'); report.boxVersion=1; report.boxPriceWei=String(await call(factory,factoryArtifact,'BOX_PRICE')); }
 const mask = (code, references) => { let value = code.slice(2); for (const entries of Object.values(references ?? {})) for (const { start, length } of entries) value = value.slice(0, start * 2) + '0'.repeat(length * 2) + value.slice((start + length) * 2); return value.toLowerCase(); };
 for (const [name, address, artifact] of [['factory', factory, factoryArtifact], ['nft', nft, artifacts[names[1]]], ['vault', vault, vaultArtifact], ...(router ? [['router', router, artifacts.OpenVRF],['salesVault',report.addresses.salesVault,artifacts.PlatformNftSalesVault]] : [])]) {
  const code = await client.getCode({ address }); assert(code && code !== '0x');
  assert.equal(mask(code, artifact.deployedBytecode.immutableReferences), mask(artifact.deployedBytecode.object, artifact.deployedBytecode.immutableReferences), `${name} runtime mismatch`);
  report.codeHashes[name] = keccak256(code);
 }
 assert.equal((await call(vault, vaultArtifact, 'owner')).toLowerCase(), owner.toLowerCase());
 assert.equal((await call(vault, vaultArtifact, 'nft')).toLowerCase(), nft.toLowerCase());
 assert.equal((await call(vault, vaultArtifact, 'controller')).toLowerCase(), factory.toLowerCase());
 assert.equal(await call(vault, vaultArtifact, 'EPOCH_DURATION'), BigInt(testnetBuild?.epochDurationSeconds ?? 604800)); assert.equal(await call(factory, factoryArtifact, 'DELAY'), BigInt(testnetBuild?.policyDelaySeconds ?? 172800));
 if (policy) {
  if (immediateClaims) {
   assert.equal(await call(factory, factoryArtifact, 'CLAIM_DELAY'), 0n);
   report.claimEligibilityDelaySeconds = 0;
  }
  assert.equal((await call(factory, factoryArtifact, 'randomnessRouter')).toLowerCase(), router.toLowerCase());
  assert.equal(await call(factory, factoryArtifact, 'paused'), true);
  for (let i = 0; i < 8; i++) {
   assert.equal(Number(await call(factory, factoryArtifact, 'probabilities', [BigInt(i)])), policy.probabilities[i]);
   assert.equal(Number(await call(vault, vaultArtifact, 'qualityWeight', [i + 1])), policy.weights[i]);
  }
  const authorization = await send('authorize-nft-randomness', { to: router, data: encodeFunctionData({ abi: artifacts.OpenVRF.abi,
   functionName: 'setConsumerAuthorization', args: [factory, true] }) }, 'admin');
  report.authorizationBlock = String(authorization.blockNumber);
  assert.equal(await call(router, artifacts.OpenVRF, 'authorizedConsumers', [factory]), true);
  assert.equal(await call(router, artifacts.OpenVRF, 'authorizedRelayers', [policy.relayer]), true);
  if (testnetBuild) {
   await send('schedule-testnet-resume', { to: factory, data: encodeFunctionData({ abi: factoryArtifact.abi, functionName: 'scheduleResume' }) }, 'admin');
   report.resumeAfter = String(await call(factory, factoryArtifact, 'resumeAfter'));
   if (journal.steps['fund-testnet-relayer'] || await client.getBalance({ address: policy.relayer }) < 50_000_000_000_000n)
    await send('fund-testnet-relayer', { to: policy.relayer, value: 50_000_000_000_000n });
  }
 }
 report.genesis = String(await call(vault, vaultArtifact, 'genesis')); persist(reportPath, report);
 const income = 1_000_000_000_000n;
 const deposit = await send('verify-treasury-forwarding', { to: factory, value: income });
 const recordedIncome = parseEventLogs({ abi: vaultArtifact.abi, eventName: 'Income', logs: deposit.logs }).filter(event => event.address.toLowerCase() === vault.toLowerCase());
 assert.equal(recordedIncome.length, 1); assert.equal(recordedIncome[0].args.amount, income);
 assert.equal(recordedIncome[0].args.ownerAmount, income / 2n); assert.equal(recordedIncome[0].args.nftAmount, income / 2n);
 const claimed = await send('verify-owner-half-withdrawal', { to: vault, data: encodeFunctionData({ abi: vaultArtifact.abi, functionName: 'claimOwner' }) }, 'admin');
 const recordedOwner = parseEventLogs({ abi: vaultArtifact.abi, eventName: 'OwnerClaimed', logs: claimed.logs }).filter(event => event.address.toLowerCase() === vault.toLowerCase());
 assert.equal(recordedOwner.length, 1); assert.equal(recordedOwner[0].args.amount, income / 2n);
 assert.equal(await call(vault, vaultArtifact, 'ownerCredit'), 0n);
 assert.equal(await call(vault, vaultArtifact, 'nftReserve'), income / 2n);
 assert.equal(await client.getBalance({ address: vault }), income / 2n);
 const finalized = await client.getBlock({ blockTag: 'finalized' });
 report.finalizedThroughBlock = String(finalized.number);
 report.finalityComplete = Object.values(report.transactions).every(tx => BigInt(tx.blockNumber) <= finalized.number);
 report.status = report.finalityComplete ? 'verified' : 'verified_pending_finality';
 report.verification = { treasuryForwarding: true, ownerHalfWithdrawal: true, nftReservePreserved: true, runtimeCodeMatched: true,
  weeklySettlementSeconds: testnetBuild?.epochDurationSeconds ?? 604800, policyDelaySeconds: testnetBuild?.policyDelaySeconds ?? 172800, weeklyClaimLiveVerified: false };
 persist(reportPath, report); console.log(json({ status: report.status, addresses: report.addresses, verification: report.verification }));
} finally { closeSync(lock); unlinkSync(lockPath); }
