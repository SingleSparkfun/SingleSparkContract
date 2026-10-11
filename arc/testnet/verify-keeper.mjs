// Fund only the verified platform project; the deployed backend must submit the plugin work.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { erc20Abi, keccak256, parseEther, decodeFunctionData } from 'viem';
import { context, persist, QUOTE } from './deploy.mjs';
import { root, json } from './build.mjs';

const c = await context({ version: 2 });
const p = c.report.projects.find(p => p.token === c.report.newPlatformToken);
assert(p && p.label === 'TSPARK2');
const { factory, implementation, router } = c.report.addresses;
for (const [name, address] of Object.entries({ factory, implementation, router })) {
  assert.equal(keccak256(await c.client.getCode({ address })), c.report.codeHashes[name]);
}
assert.equal((await c.read(factory, c.a.factory.abi, 'implementation')).toLowerCase(), implementation.toLowerCase());
assert.equal((await c.read(factory, c.a.factory.abi, 'executor')).toLowerCase(), c.accounts.executor.address.toLowerCase());
assert.equal((await c.read(factory, c.a.factory.abi, 'vaultOf', [p.token])).toLowerCase(), p.vault.toLowerCase());
const va = c.a.implementation.abi;
const path = resolve(root, 'deployments/argus-keeper-public-testnet.json');
const saved = existsSync(path) ? JSON.parse(readFileSync(path)) : null;
const dead = '0x000000000000000000000000000000000000dEaD';
const at = await c.client.getBlock({ blockTag: 'finalized' });
const ledger = await c.read(p.vault, va, 'ledger', [], at.number);
const report = saved ?? {
  chainId: 5042002, platform: p, executor: c.accounts.executor.address,
  status: 'prepared', labelledTestDonationUSDC6: '6100000', executorGasTopUpUSDC: '1',
  beforeBlock: String(at.number), beforeLedger: ledger,
  beforeBurned: String(await c.read(p.token, erc20Abi, 'balanceOf', [dead], at.number)),
  ordinaryProjects: c.report.projects.filter(v => v.token !== p.token),
};
assert.equal(report.platform.vault, p.vault);
if (process.argv.includes('--broadcast')) {
  const lockPath = resolve(c.storageDir, 'run.lock'), lock = openSync(lockPath, 'wx', 0o600);
  try {
    persist(path, report);
    assert.deepEqual((await c.read(p.vault, va, 'policy')).slice(0, 2), [7, 0]);
    assert.equal(await c.read(factory, c.a.factory.abi, 'DELAY'), 172800n);
    // Fixed amounts and durable labels make reruns resume instead of donating twice.
    await c.send('automatic-keeper-gas', 'deployer', async () => ({ to: c.accounts.executor.address, value: parseEther('1') }));
    await c.call('automatic-keeper-test-donation', 'deployer', QUOTE, erc20Abi, 'transfer', [p.vault, 6_100_000n]);
    report.funding = Object.fromEntries(['automatic-keeper-gas', 'automatic-keeper-test-donation'].map(k => [k, c.report.transactions[k]]));
    report.status = 'funded_waiting_for_backend';
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
report.observedAt = new Date().toISOString();
report.latestLedger = await c.read(p.vault, va, 'ledger');
report.latestBurned = String(await c.read(p.token, erc20Abi, 'balanceOf', [dead]));
if (saved || process.argv.includes('--broadcast')) {
  const finalized = await c.client.getBlock({ blockTag: 'finalized' });
  const logs = await c.client.getLogs({ address: p.vault, event: va.find(e => e.type === 'event' && e.name === 'Executed'),
    fromBlock: BigInt(report.beforeBlock), toBlock: finalized.number, strict: true });
  const burn = logs.find(l => l.args.bucket === 0 && l.args.amount >= 5_000_000n);
  if (burn) {
    const tx = await c.client.getTransaction({ hash: burn.transactionHash });
    const receipt = await c.client.getTransactionReceipt({ hash: burn.transactionHash });
    assert.equal(receipt.status, 'success');
    assert.equal((await c.client.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash);
    assert.equal(tx.from.toLowerCase(), c.accounts.executor.address.toLowerCase());
    assert.equal(tx.to.toLowerCase(), p.vault.toLowerCase());
    const input = decodeFunctionData({ abi: va, data: tx.input });
    assert.equal(input.functionName, 'buy');
    assert.equal(input.args[0], 0);
    assert.equal(input.args[1], burn.args.amount);
    assert(burn.args.output >= input.args[2] && input.args[2] > 0n);
    const before = await c.read(p.token, erc20Abi, 'balanceOf', [dead], burn.blockNumber - 1n);
    const after = await c.read(p.token, erc20Abi, 'balanceOf', [dead], burn.blockNumber);
    assert.equal(after - before, burn.args.output);
    assert.equal(await c.read(QUOTE, erc20Abi, 'allowance', [p.vault, router], burn.blockNumber), 0n);
    report.status = report.backendJournal?.own?.transactionHash === burn.transactionHash ? 'passed' : 'chain_execution_verified';
    report.automaticBurn = { transactionHash: burn.transactionHash, block: String(burn.blockNumber), sender: tx.from,
      quoteUSDC6: String(burn.args.amount), tokensBurned: String(burn.args.output), minimumOutput: String(input.args[2]),
      gasPaidWei: String(receipt.gasUsed * receipt.effectiveGasPrice), finalized: true, allowanceCleared: true };
  }
}
if (saved || process.argv.includes('--broadcast')) persist(path, report);
console.log(json(report));
