// Read-only acceptance against the existing isolated Base fork; never signs or sends transactions.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, erc20Abi, http } from 'viem';

const launch = JSON.parse(readFileSync('SingleSparkContract/arc/deployments/clanker-abi-image-local-web-test-20261006.json', 'utf8')).launch;
const api = 'http://127.0.0.1:8092';
const rpc = createPublicClient({ transport: http('http://127.0.0.1:8548') });
const response = await fetch(`${api}/api/launch/clanker/token?chainId=8453&token=${launch.token}`);
assert.equal(response.status, 200);
const view = await response.json();
assert.equal(view.token.toLowerCase(), launch.token.toLowerCase());
assert.equal(view.revenueAccount.toLowerCase(), launch.address.toLowerCase());
assert.equal(view.testnet, true);
assert.equal(view.chainId, 8453);
assert.equal(view.treasury, null);
const blockNumber = BigInt(view.blockNumber);
const [weth, tokens, gas] = await Promise.all([
  rpc.readContract({ address: '0x4200000000000000000000000000000000000006', abi: erc20Abi, functionName: 'balanceOf', args: [launch.address], blockNumber }),
  rpc.readContract({ address: launch.token, abi: erc20Abi, functionName: 'balanceOf', args: [launch.address], blockNumber }),
  rpc.getBalance({ address: launch.address, blockNumber }),
]);
assert.equal(view.quoteBalance, weth.toString());
assert.equal(view.tokenBalance, tokens.toString());
assert.equal(view.gasBalance, gas.toString());
assert.equal((await fetch(`${api}/api/launch/clanker/token?chainId=8453&token=0x0000000000000000000000000000000000000001`)).status, 404);
assert.equal((await fetch(`${api}/api/launch/clanker/token?chainId=8453&token=invalid`)).status, 400);
for (const key of ['owner', 'requestId', 'encryptedMaterial', 'nonce', 'rawTx', 'privateKey']) assert.equal(key in view, false);
writeFileSync('SingleSparkContract/arc/deployments/project-balances-local-20261006.json', JSON.stringify({
  status: 'passed_read_only_local_balances', generatedAt: new Date().toISOString(), publicTransactions: false,
  checks: ['anonymous confirmed token read', 'wallet binding', 'three balances at the same finalized block', 'unknown token 404', 'invalid token 400', 'no custody secrets'], view,
}, null, 2) + '\n');
console.log('Project balances: real WETH, token and gas balances match; invalid/unbound tokens rejected. No transactions sent.');
