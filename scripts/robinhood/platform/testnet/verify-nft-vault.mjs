import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, keccak256, parseAbi } from 'viem';
import { nftDeploymentReportName } from './random-nft-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const index = process.argv.indexOf('--deployment-id');
const deploymentId = index < 0 ? null : process.argv[index + 1];
assert(!deploymentId || /^[a-z0-9][a-z0-9-]{0,63}$/.test(deploymentId));
const reportPath = resolve(root, 'chains/robinhood/deployments/testnet/platform', deploymentId ? `nft-random-${deploymentId}.json` : nftDeploymentReportName({
 random: process.argv.includes('--random'), immediateClaims: process.argv.includes('--immediate-claims') }));
const report = JSON.parse(readFileSync(reportPath));
assert.equal(report.chainId, 46630); assert.equal(report.environment, 'testnet');
const client = createPublicClient({ transport: http('https://rpc.testnet.chain.robinhood.com', { timeout: 30000, retryCount: 2 }) });
assert.equal(await client.getChainId(), 46630);
for (const name of ['factory', 'nft', 'vault', ...(report.openVrfRevision ? ['router'] : []), ...(report.boxVersion ? ['salesVault'] : [])]) {
 const code = await client.getCode({ address: report.addresses[name] });
 assert(code && code !== '0x'); assert.equal(keccak256(code), report.codeHashes[name]);
}
for (const tx of [...Object.values(report.transactions), ...(report.activation ? [report.activation] : [])]) {
 const receipt = await client.getTransactionReceipt({ hash: tx.hash });
 assert.equal(receipt.status, 'success'); assert.equal(receipt.blockHash, tx.blockHash);
 assert.equal((await client.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash);
}
const finalized = await client.getBlock({ blockTag: 'finalized' });
report.finalizedThroughBlock = String(finalized.number);
report.finalityComplete = Object.values(report.transactions).every(tx => BigInt(tx.blockNumber) <= finalized.number);
report.status = report.finalityComplete ? 'verified' : 'verified_pending_finality';
if (report.activation) report.activation.finalized = BigInt(report.activation.blockNumber) <= finalized.number;
report.totalGasCostWei = String([...Object.values(report.transactions), ...(report.activation ? [report.activation] : [])].reduce((sum, tx) => sum + BigInt(tx.gasCostWei), 0n));
const abi = parseAbi(['function totalReceived() view returns(uint256)', 'function accountedBalance() view returns(uint256)', 'function ownerCredit() view returns(uint256)', 'function nftReserve() view returns(uint256)', 'function totalOwnerClaimed() view returns(uint256)', 'function totalNftClaimed() view returns(uint256)']);
// Public testnet RPC replicas can briefly disagree at the tip; retain one recent, shared state block.
const blockNumber = (await client.getBlockNumber({ cacheTime: 0 })) - 100n;
const [received, accounted, owner, nft, ownerPaid, nftPaid, balance] = await Promise.all([
 ...['totalReceived', 'accountedBalance', 'ownerCredit', 'nftReserve', 'totalOwnerClaimed', 'totalNftClaimed'].map(functionName => client.readContract({ address: report.addresses.vault, abi, functionName, blockNumber })),
 client.getBalance({ address: report.addresses.vault, blockNumber }),
]);
assert.equal(accounted, owner + nft); assert.equal(balance, accounted); assert.equal(received, accounted + ownerPaid + nftPaid);
report.latestAccounting = { blockNumber: String(blockNumber), totalReceivedWei: String(received), ownerCreditWei: String(owner), nftReserveWei: String(nft), ownerPaidWei: String(ownerPaid), nftPaidWei: String(nftPaid) };
if (report.openVrfRevision) {
 const factoryAbi = parseAbi(['function owner() view returns(address)', 'function nft() view returns(address)', 'function vault() view returns(address)',
  'function randomnessRouter() view returns(address)', 'function probabilities(uint256) view returns(uint16)', 'function paused() view returns(bool)',
  'function DELAY() view returns(uint256)', 'function CLAIM_DELAY() view returns(uint256)', 'function BOX_VERSION() view returns(uint256)', 'function BOX_PRICE() view returns(uint256)', 'function salesVault() view returns(address)']);
 const nftAbi = parseAbi(['function MAX_SUPPLY() view returns(uint256)', 'function issuer() view returns(address)', 'function artworkUris(uint256) view returns(string)']);
 const vaultAbi = parseAbi(['function nft() view returns(address)', 'function controller() view returns(address)', 'function owner() view returns(address)', 'function EPOCH_DURATION() view returns(uint256)',
  'function qualityWeight(uint8) view returns(uint16)']);
 const routerAbi = parseAbi(['function owner() view returns(address)', 'function authorizedConsumers(address) view returns(bool)',
  'function authorizedRelayers(address) view returns(bool)', 'function requestFee() view returns(uint256)']);
 const read = (address, abi, functionName, args = []) => client.readContract({address,abi,functionName,args,blockNumber});
 const same = (actual, expected) => assert.equal(actual.toLowerCase(), expected.toLowerCase());
 const {factory,nft,vault,router} = report.addresses;
 same(await read(factory,factoryAbi,'owner'),report.owner);
 if(report.boxVersion!==undefined){
  assert.equal(report.boxVersion,1);assert.equal(await read(factory,factoryAbi,'BOX_VERSION'),1n);
  assert.equal(await read(factory,factoryAbi,'BOX_PRICE'),BigInt(report.boxPriceWei));
  same(await read(factory,factoryAbi,'salesVault'),report.addresses.salesVault);
  const salesAbi=parseAbi(['function owner() view returns(address)','function DELAY() view returns(uint256)']);
  same(await read(report.addresses.salesVault,salesAbi,'owner'),report.owner);
  assert.equal(await read(report.addresses.salesVault,salesAbi,'DELAY'),BigInt(report.verification.policyDelaySeconds));
 }
 assert.equal(await read(factory,factoryAbi,'DELAY'),BigInt(report.verification.policyDelaySeconds));
 if (report.claimEligibilityDelaySeconds !== undefined) {
  assert.equal(report.claimEligibilityDelaySeconds,0);
  assert.equal(await read(factory,factoryAbi,'CLAIM_DELAY'),0n);
 }
 same(await read(factory,factoryAbi,'nft'),nft); same(await read(factory,factoryAbi,'vault'),vault);
 same(await read(factory,factoryAbi,'randomnessRouter'),router); same(await read(nft,nftAbi,'issuer'),factory);
 same(await read(vault,vaultAbi,'nft'),nft); same(await read(vault,vaultAbi,'controller'),factory);
 same(await read(vault,vaultAbi,'owner'),report.owner); same(await read(router,routerAbi,'owner'),report.owner);
 assert.equal(await read(vault,vaultAbi,'EPOCH_DURATION'),BigInt(report.verification.weeklySettlementSeconds));
 assert.equal(await read(nft,nftAbi,'MAX_SUPPLY'),100_000n);
 assert.equal(await read(router,routerAbi,'authorizedConsumers',[factory]),true);
 assert.equal(await read(router,routerAbi,'authorizedRelayers',[report.relayerAddress]),true);
 assert.equal(await read(router,routerAbi,'requestFee'),BigInt(report.randomPolicy.requestFeeWei));
 for(let i=0;i<8;i++) {
  assert.equal(Number(await read(factory,factoryAbi,'probabilities',[BigInt(i)])),report.randomPolicy.probabilitiesBps[i]);
  assert.equal(Number(await read(vault,vaultAbi,'qualityWeight',[i+1])),report.randomPolicy.gradeWeights[i]);
  assert.equal(await read(nft,nftAbi,'artworkUris',[BigInt(i)]),report.randomPolicy.artworkUris[i]);
 }
 report.issuance.randomClaimsEnabled = !(await read(factory,factoryAbi,'paused'));
 report.verification = {...report.verification,maxSupply:100000,probabilitiesMatched:true,gradeWeightsMatched:true,
  artworkUrisMatched:true,randomnessBindingsMatched:true,randomnessAuthorizationsMatched:true};
}
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, finalizedThroughBlock: report.finalizedThroughBlock, accounting: report.latestAccounting, totalGasCostWei: report.totalGasCostWei }));
