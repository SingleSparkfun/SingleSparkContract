// Rehearse the already scheduled operation on a public-testnet fork; never changes public time.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, parseEther, toHex, keccak256 } from 'viem';
import { context, persist } from './deploy.mjs';
import { root, json } from './build.mjs';

const c = await context({ version: 2 });
const change = c.report.platformTargetUpdate, factory = c.report.addresses.factory;
const abi = c.a.factory.abi, va = c.a.implementation.abi;
const reverted = error => Boolean(error.walk?.(e => e.name === 'ContractFunctionRevertedError' || e.name === 'ExecutionRevertedError'));
const block = await c.client.getBlock({ blockTag: 'finalized' });
assert(block.timestamp < BigInt(change.readyAt), 'Use the public finalizer once the timelock expires');
assert.equal(String(await c.read(factory, abi, 'readyAt', [], block.number)), change.readyAt);
await assert.rejects(() => c.client.simulateContract({ address: factory, abi, functionName: 'executePlatformToken', args: [change.next], account: c.accounts.deployer.address }), reverted);

const port = 18651, rpc = `http://127.0.0.1:${port}`;
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '5042002', '--fork-url', c.client.transport.url,
  '--fork-block-number', String(block.number), '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = ''; anvil.stderr.on('data', chunk => stderr += chunk);
try {
  const client = createPublicClient({ transport: http(rpc, { retryCount: 0, timeout: 30000 }), cacheTime: 0 });
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try { assert.equal(await client.getChainId(), 5042002); ready = true; break; } catch {}
    assert(anvil.exitCode === null, stderr.slice(-1000));
    await new Promise(r => setTimeout(r, 1000));
  }
  assert(ready, 'Local fork unavailable');
  assert.equal(keccak256(await client.getCode({ address: factory })), c.report.codeHashes.factory);
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const snapshots = async () => Promise.all(c.report.projects.map(async p => ({ token: await read(p.vault, va, 'token'),
    vault: await read(factory, abi, 'vaultOf', [p.token]), ledger: await read(p.vault, va, 'ledger'), balance: await client.getBalance({ address: p.vault }) })));
  const before = await snapshots();
  // Only the loopback fork accepts impersonation and a synthetic fee balance.
  const account = c.accounts.deployer.address;
  await client.request({ method: 'anvil_impersonateAccount', params: [account] });
  await client.request({ method: 'anvil_setBalance', params: [account, toHex(parseEther('1'))] });
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [Number(change.readyAt) - 1] });
  await client.request({ method: 'evm_mine', params: [] });
  await assert.rejects(() => client.simulateContract({ address: factory, abi, functionName: 'executePlatformToken', args: [change.next], account }), reverted);
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [Number(change.readyAt)] });
  await client.request({ method: 'evm_mine', params: [] });
  const wallet = createWalletClient({ account, transport: http(rpc), chain: c.client.chain });
  const { request } = await client.simulateContract({ address: factory, abi, functionName: 'executePlatformToken', args: [change.next], account });
  const hash = await wallet.writeContract(request);
  assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success');
  assert.equal((await read(factory, abi, 'platformToken')).toLowerCase(), change.next.toLowerCase());
  assert.equal(await read(factory, abi, 'readyAt'), 0n);
  assert.deepEqual(await snapshots(), before, 'Target change must preserve every token, vault, balance and budget');
  await assert.rejects(() => client.simulateContract({ address: factory, abi, functionName: 'executePlatformToken', args: [change.next], account }), reverted);
  assert.equal((await c.read(factory, abi, 'platformToken')).toLowerCase(), change.previous.toLowerCase());
  const report = { status: 'passed', network: 'local-fork-of-arc-testnet', publicTransactions: false, publicEarlyExecutionRejected: true,
    sourceBlock: String(block.number), factory, previous: change.previous, next: change.next, publicReadyAt: change.readyAtISO,
    oneSecondEarlyRejected: true, afterDelayExecuted: true, replayRejected: true, projectsPreserved: before,
    publicTargetUnchanged: true, verifiedAt: new Date().toISOString() };
  persist(resolve(root, '../deployments/local/arc/argus/argus-platform-target-rehearsal.json'), report);
  console.log(json(report));
} finally { anvil.kill('SIGTERM'); }
