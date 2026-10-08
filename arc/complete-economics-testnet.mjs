// Finish the Rust-committed test batch with bounded nonce batches, then let Rust reindex it.
// ARC test assets only; this verification driver is not the production worker.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createPublicClient, createWalletClient, defineChain, http, encodeFunctionData, encodeAbiParameters,
  concatHex, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { artifact } from './deploy.mjs';
import { persist } from './runtime.mjs';

const dir = 'SingleSparkContract/arc/data/economics-v2-testnet';
const reportPath = 'SingleSparkContract/arc/deployments/arc-economics-v2-testnet.json';
const report = JSON.parse(readFileSync(reportPath));
const address = report.project.rewards;
// Frozen ABI for this archived drand deployment; current rewards use distribute().
const abi = parseAbi([
  'function keeper() view returns (address)', 'function root() view returns (bytes32)',
  'function roundId() view returns (uint256)', 'function payoutCount() view returns (uint256)',
  'function selectedCount() view returns (uint256)', 'function nextPayoutIndex() view returns (uint256)',
  'function beaconRound() view returns (uint64)', 'function seeded() view returns (bool)',
  'function winners(uint256) view returns (uint256)', 'function reserved() view returns (uint256)',
  'function fulfill(bytes)', 'function draw()', 'function pay(address,bytes32[])',
]);
const account = privateKeyToAccount(JSON.parse(readFileSync(`${dir}/wallets.json`)).keeper.privateKey);
assert.equal(account.address, report.keeper);
const rpc = 'https://rpc.drpc.testnet.arc.network';
const chain = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const transport = http(rpc, { timeout: 15000, retryCount: 1 });
const client = createPublicClient({ chain, transport, cacheTime: 0, pollingInterval: 1000 });
const wallet = createWalletClient({ account, chain, transport });
assert.equal(await client.getChainId(), 5042002);
assert.equal(keccak256(await client.getCode({ address: report.deployment.launch })), report.deployment.launchCodeHash);
const read = (functionName, args = []) => client.readContract({ address, abi, functionName, args });
assert.equal((await read('keeper')).toLowerCase(), account.address.toLowerCase());
const db = new DatabaseSync(`${dir}/runtime/arc.sqlite`, { readOnly: true });
assert.equal(JSON.parse(db.prepare('SELECT value FROM kv WHERE key = ?').get('journal')?.value ?? 'null'), null, 'Resume the Rust transaction before this driver');
const candidate = JSON.parse(db.prepare('SELECT value FROM kv WHERE key = ?').get(`rewards:5042002:${address.toLowerCase()}:candidates`).value);
db.close();
const round = await read('roundId');
assert.equal(BigInt(candidate.expectedRound), round);
const layers = [candidate.addresses.map((address, i) => keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [BigInt(i), address])))];
while (layers.at(-1).length > 1) {
  const nodes = layers.at(-1), next = [];
  for (let i = 0; i < nodes.length; i += 2) next.push(keccak256(concatHex([nodes[i], nodes[i + 1] ?? nodes[i]].sort())));
  layers.push(next);
}
assert.equal(layers.at(-1)[0], candidate.root);
assert.equal(await read('root'), candidate.root);
assert.equal(await read('payoutCount'), 100n);
if (!process.argv.includes('--broadcast')) {
  console.log({ round: String(round), candidates: candidate.addresses.length, selected: String(await read('selectedCount')), paid: String(await read('nextPayoutIndex')) });
  process.exit(0);
}
const lockPath = `${dir}/verification.lock`;
if (existsSync(lockPath)) {
  const pid = Number(readFileSync(lockPath, 'utf8'));
  assert(Number.isSafeInteger(pid) && pid > 0);
  try { process.kill(pid, 0); throw Error('Verification writer is still running'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  unlinkSync(lockPath);
}
const lock = openSync(lockPath, 'wx', 0o600); writeFileSync(lock, String(process.pid));
const path = `${dir}/completion-transactions.json`;
const journal = existsSync(path) ? JSON.parse(readFileSync(path)) : {};
try {
  async function confirm(label) {
    const step = journal[label], tx = parseTransaction(step.raw);
    assert.equal(tx.chainId, 5042002); assert.equal(tx.to.toLowerCase(), address.toLowerCase()); assert.equal(tx.value ?? 0n, 0n);
    assert.equal(tx.data, step.data); assert.equal(keccak256(step.raw), step.hash);
    assert.equal((await recoverTransactionAddress({ serializedTransaction: step.raw })).toLowerCase(), account.address.toLowerCase());
    let receipt;
    try { receipt = await client.getTransactionReceipt({ hash: step.hash }); }
    catch (e) { if (e.name !== 'TransactionReceiptNotFoundError') throw e; }
    if (!receipt) {
      try { await client.sendRawTransaction({ serializedTransaction: step.raw }); }
      catch (e) { if (!/already known|nonce too low/i.test(e.message)) throw e; }
      receipt = await client.waitForTransactionReceipt({ hash: step.hash, timeout: 90000 });
    }
    assert.equal(receipt.status, 'success', label);
    step.confirmed = true; step.gasUSDC = formatEther(receipt.gasUsed * receipt.effectiveGasPrice); persist(path, journal);
  }
  async function sign(label, data, nonce, gas, fees) {
    assert(gas <= 1500000n && gas * fees.maxFeePerGas <= parseEther('0.1'));
    const raw = await wallet.signTransaction({ to: address, data, value: 0n, nonce, gas, ...fees, chainId: 5042002, type: 'eip1559' });
    journal[label] = { raw, data, hash: keccak256(raw), confirmed: false }; persist(path, journal);
  }
  async function prepare(data) {
    const nonce = await client.getTransactionCount({ address: account.address });
    assert.equal(nonce, await client.getTransactionCount({ address: account.address, blockTag: 'pending' }));
    const estimate = await client.estimateGas({ account, to: address, data });
    const fees = await client.estimateFeesPerGas();
    if (fees.maxFeePerGas < 20000000000n) fees.maxFeePerGas = 20000000000n;
    const gas = estimate + estimate / 5n + 100000n;
    assert(await client.getBalance({ address: account.address }) > parseEther('1') + gas * fees.maxFeePerGas * 4n);
    return { nonce, gas, fees };
  }
  // Reconcile all durable signatures in nonce order before creating another batch.
  for (const [label, step] of Object.entries(journal)) if (!step.confirmed) await confirm(label);
  if (!await read('seeded')) {
    const beacon = await read('beaconRound');
    const response = await fetch(`https://api.drand.sh/04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3/public/${beacon}`);
    assert(response.ok, 'Committed future beacon must be published'); const value = await response.json(); assert.equal(BigInt(value.round), beacon);
    const data = encodeFunctionData({ abi, functionName: 'fulfill', args: [`0x${value.signature}`] });
    const { nonce, gas, fees } = await prepare(data); const label = `fulfill-${round}`;
    await sign(label, data, nonce, gas, fees); await confirm(label);
  }
  for (let i = 0; ; i++) {
    const selected = await read('selectedCount'); if (selected === 100n) break;
    assert(i < 100, 'Bounded draw verification');
    const data = encodeFunctionData({ abi, functionName: 'draw' });
    const { nonce, gas, fees } = await prepare(data); const label = `draw-${round}-${nonce}`;
    await sign(label, data, nonce, gas, fees); await confirm(label);
    console.log({ selectedBeforeDraw: String(selected), hash: journal[label].hash });
  }
  for (;;) {
    const next = Number(await read('nextPayoutIndex')); if (next === 100) break;
    const calls = [];
    for (let index = next; index < Math.min(next + 4, 100); index++) {
      let node = Number(await read('winners', [BigInt(index)])); const recipient = candidate.addresses[node], proof = [];
      for (const layer of layers.slice(0, -1)) { proof.push(layer[node ^ 1] ?? layer[node]); node = Math.floor(node / 2); }
      calls.push({ label: `pay-${round}-${index}`, data: encodeFunctionData({ abi, functionName: 'pay', args: [recipient, proof] }) });
    }
    // All calls have the same bounded Merkle path and ERC-20 transfer shape. Estimate the current
    // payout and retain a 100k extra margin; future indices cannot be simulated before prior payments.
    const { nonce, gas, fees } = await prepare(calls[0].data);
    for (let i = 0; i < calls.length; i++) await sign(calls[i].label, calls[i].data, nonce + i, gas, fees);
    for (const call of calls) {
      try { await client.sendRawTransaction({ serializedTransaction: journal[call.label].raw }); }
      catch (e) { if (!/already known|nonce too low/i.test(e.message)) throw e; }
    }
    const receipts = await Promise.allSettled(calls.map(call => confirm(call.label)));
    for (const result of receipts) if (result.status === 'rejected') throw result.reason;
    console.log({ paid: next + calls.length, total: 100 });
  }
  assert.equal(await read('reserved'), 0n);
  report.distributionDriver = { round: String(round), candidates: candidate.addresses.length,
    openedBy: 'Rust keeper', completedBy: 'bounded test driver using the same keeper',
    transactions: Object.fromEntries(Object.entries(journal).map(([label, step]) => [label, { hash: step.hash, gasUSDC: step.gasUSDC }])) };
  persist(reportPath, report); console.log('100 payouts confirmed; restart Rust to verify indexing and public pagination.');
} finally { closeSync(lock); unlinkSync(lockPath); }
