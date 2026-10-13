import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, keccak256, parseAbi } from 'viem';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const reportPath = resolve(root, 'chains/robinhood/deployments/testnet/platform/nft-vault.json');
const report = JSON.parse(readFileSync(reportPath));
assert.equal(report.chainId, 46630); assert.equal(report.environment, 'testnet');
const client = createPublicClient({ transport: http('https://rpc.testnet.chain.robinhood.com', { timeout: 30000, retryCount: 2 }) });
assert.equal(await client.getChainId(), 46630);
for (const name of ['factory', 'nft', 'vault']) {
 const code = await client.getCode({ address: report.addresses[name] });
 assert(code && code !== '0x'); assert.equal(keccak256(code), report.codeHashes[name]);
}
for (const tx of Object.values(report.transactions)) {
 const receipt = await client.getTransactionReceipt({ hash: tx.hash });
 assert.equal(receipt.status, 'success'); assert.equal(receipt.blockHash, tx.blockHash);
 assert.equal((await client.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash);
}
const finalized = await client.getBlock({ blockTag: 'finalized' });
report.finalizedThroughBlock = String(finalized.number);
report.finalityComplete = Object.values(report.transactions).every(tx => BigInt(tx.blockNumber) <= finalized.number);
report.status = report.finalityComplete ? 'verified' : 'verified_pending_finality';
report.totalGasCostWei = String(Object.values(report.transactions).reduce((sum, tx) => sum + BigInt(tx.gasCostWei), 0n));
const abi = parseAbi(['function totalReceived() view returns(uint256)', 'function accountedBalance() view returns(uint256)', 'function ownerCredit() view returns(uint256)', 'function nftReserve() view returns(uint256)', 'function totalOwnerClaimed() view returns(uint256)', 'function totalNftClaimed() view returns(uint256)']);
const blockNumber = await client.getBlockNumber();
const [received, accounted, owner, nft, ownerPaid, nftPaid, balance] = await Promise.all([
 ...['totalReceived', 'accountedBalance', 'ownerCredit', 'nftReserve', 'totalOwnerClaimed', 'totalNftClaimed'].map(functionName => client.readContract({ address: report.addresses.vault, abi, functionName, blockNumber })),
 client.getBalance({ address: report.addresses.vault, blockNumber }),
]);
assert.equal(accounted, owner + nft); assert.equal(balance, accounted); assert.equal(received, accounted + ownerPaid + nftPaid);
report.latestAccounting = { blockNumber: String(blockNumber), totalReceivedWei: String(received), ownerCreditWei: String(owner), nftReserveWei: String(nft), ownerPaidWei: String(ownerPaid), nftPaidWei: String(nftPaid) };
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, finalizedThroughBlock: report.finalizedThroughBlock, accounting: report.latestAccounting, totalGasCostWei: report.totalGasCostWei }));
