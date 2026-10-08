// Fund an existing controlled ARC test-wallet batch; signed transactions survive restarts.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, custom, parseEther, formatEther,
  keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { persist, stringify } from './runtime.mjs';

const dir = process.argv[2];
assert(dir?.startsWith('SingleSparkContract/arc/data/'), 'Pass the saved test-wallet directory');
const amount = parseEther(process.argv[3] || '0.5');
assert(amount > 0n && amount <= parseEther('0.5'), 'Maximum funding is 0.5 test USDC per wallet');
const plan = JSON.parse(readFileSync(`${dir}/wallets.json`));
assert(plan.synthetic && plan.chainId === 5042002 && plan.wallets.length === 100);
assert.equal(new Set(plan.wallets.map(w => w.address.toLowerCase())).size, 100);
for (const w of plan.wallets) assert.equal(privateKeyToAccount(w.privateKey).address, w.address);
const source = JSON.parse(readFileSync('SingleSparkContract/arc/data/jet-test-wallets-20260916/wallets.json')).wallets[1];
const account = privateKeyToAccount(source.privateKey);
assert.equal(account.address, plan.fundingAddress);
assert(plan.wallets.every(w => w.address !== account.address));
const rpcUrl = 'https://rpc.drpc.testnet.arc.network';
const chain = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const rpc = http(rpcUrl, { timeout: 15000, retryCount: 0 })({ chain });
let queue = Promise.resolve(), nextRequest = 0;
const transport = custom({ request: async args => {
  for (let attempt = 0; ; attempt++) {
    const turn = queue.then(async () => { await new Promise(r => setTimeout(r, Math.max(0, nextRequest - Date.now()))); nextRequest = Date.now() + 350; });
    queue = turn.catch(() => {}); await turn;
    try { return await rpc.request(args); }
    catch (error) {
      if (attempt >= 3 || !/rate limit|limit exceeded|timed out|timeout|fetch failed|ECONNRESET/i.test(error.message)) throw error;
      nextRequest = Math.max(nextRequest, Date.now() + (attempt + 1) * 2000);
    }
  }
} }, { retryCount: 0 });
const client = createPublicClient({ chain, transport, cacheTime: 0 });
const wallet = createWalletClient({ chain, account, transport });
const identity = stringify({ chainId: chain.id, funder: account.address, amount: String(amount), recipients: plan.wallets.map(w => w.address) });
const journalPath = `${dir}/funding-journal.json`, reportPath = `${dir}/funding-report.json`;
const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath)) : { identity, steps: {} };
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath)) : { identity, chainId: chain.id, funder: account.address,
  perWalletUSDC: formatEther(amount), walletCount: 100, synthetic: true, startedAt: new Date().toISOString(), transactions: {}, status: 'pending' };
assert.equal(journal.identity, identity); assert.equal(report.identity, identity);
const lockPath = `${dir}/funding.lock`;
let lock;
try {
  lock = openSync(lockPath, 'wx', 0o600); writeFileSync(lock, String(process.pid));
  assert.equal(await client.getChainId(), chain.id);
  const balance = await client.getBalance({ address: account.address });
  const fees = await client.estimateFeesPerGas();
  const feeCap = fees.maxFeePerGas > 20_000_000_000n ? fees.maxFeePerGas : 20_000_000_000n;
  assert(feeCap * 21000n <= parseEther('0.002'), 'Funding gas budget exceeded');
  const remaining = plan.wallets.filter(w => !report.transactions[w.index]).length;
  const required = BigInt(remaining) * (amount + 21000n * feeCap);
  console.log(stringify({ mode: process.argv.includes('--broadcast') ? 'broadcast' : 'preflight', balanceUSDC: formatEther(balance),
    remainingWallets: remaining, requiredUSDCWithMaximumGas: formatEther(required), perWalletUSDC: formatEther(amount) }));
  assert(balance >= required, 'Insufficient test USDC for the complete batch');
  if (process.argv.includes('--broadcast')) {
    async function confirm(w) {
      const step = journal.steps[w.index];
      const tx = parseTransaction(step.raw);
      assert.equal(keccak256(step.raw), step.hash); assert.equal(tx.chainId, chain.id);
      assert.equal(tx.to.toLowerCase(), w.address.toLowerCase()); assert.equal(tx.value, amount);
      assert.equal(tx.data ?? '0x', '0x'); assert.equal(tx.gas, 21000n);
      assert(tx.maxFeePerGas * tx.gas <= parseEther('0.002'));
      assert.equal((await recoverTransactionAddress({ serializedTransaction: step.raw })).toLowerCase(), account.address.toLowerCase());
      let receipt;
      try { receipt = await client.getTransactionReceipt({ hash: step.hash }); }
      catch (error) { if (error.name !== 'TransactionReceiptNotFoundError') throw error; }
      if (!receipt) {
        try { assert.equal(await client.sendRawTransaction({ serializedTransaction: step.raw }), step.hash); }
        catch (error) { if (!/already known|nonce too low/i.test(error.message)) throw error; }
        receipt = await client.waitForTransactionReceipt({ hash: step.hash, timeout: 45000, pollingInterval: 1500 });
      }
      assert.equal(receipt.status, 'success', `Funding failed: wallet ${w.index}`);
      report.transactions[w.index] = { address: w.address, hash: step.hash, block: String(receipt.blockNumber), amountUSDC: formatEther(amount),
        gasUSDC: formatEther(receipt.gasUsed * receipt.effectiveGasPrice) };
      persist(reportPath, report);
    }
    // Reconcile durable sends before assigning more nonces. Never replace an uncertain transaction.
    for (const w of plan.wallets) if (journal.steps[w.index] && !report.transactions[w.index]) await confirm(w);
    for (let offset = 0; offset < plan.wallets.length; offset += 4) {
      const batch = plan.wallets.slice(offset, offset + 4).filter(w => !report.transactions[w.index]);
      if (!batch.length) continue;
      const nonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
      assert.equal(nonce, await client.getTransactionCount({ address: account.address, blockTag: 'latest' }), 'Resolve pending funder transactions first');
      const f = await client.estimateFeesPerGas();
      if (f.maxFeePerGas < 20_000_000_000n) f.maxFeePerGas = 20_000_000_000n;
      assert(f.maxFeePerGas * 21000n <= parseEther('0.002'), 'Funding gas budget exceeded');
      for (const [i, w] of batch.entries()) {
        assert(!journal.steps[w.index]);
        const raw = await wallet.signTransaction({ to: w.address, value: amount, nonce: nonce + i, gas: 21000n, ...f, type: 'eip1559' });
        journal.steps[w.index] = { raw, hash: keccak256(raw) };
        persist(journalPath, journal);
      }
      for (const w of batch) await confirm(w);
      console.log(stringify({ funded: Object.keys(report.transactions).length, total: 100 }));
    }
    const verifiedBlock = await client.getBlockNumber();
    const balances = [];
    for (const w of plan.wallets) balances.push({ address: w.address, balanceUSDC: formatEther(await client.getBalance({ address: w.address, blockNumber: verifiedBlock })) });
    assert.equal(Object.keys(report.transactions).length, 100);
    assert(balances.every(w => parseEther(w.balanceUSDC) >= amount), 'Recipient balance verification failed');
    report.status = 'funded'; report.completedAt = new Date().toISOString(); report.verifiedBlock = String(verifiedBlock);
    report.totalSentUSDC = formatEther(amount * 100n);
    report.totalGasUSDC = formatEther(Object.values(report.transactions).reduce((sum, tx) => sum + parseEther(tx.gasUSDC), 0n));
    report.funderBalanceUSDC = formatEther(await client.getBalance({ address: account.address })); report.balances = balances;
    persist(reportPath, report); plan.status = 'funded'; plan.fundingReport = reportPath; persist(`${dir}/wallets.json`, plan);
    const publicPlan = JSON.parse(readFileSync(`${dir}/addresses.json`));
    publicPlan.status = 'funded'; publicPlan.fundingReport = reportPath; persist(`${dir}/addresses.json`, publicPlan);
    console.log(stringify({ status: report.status, wallets: 100, totalUSDC: report.totalSentUSDC, gasUSDC: report.totalGasUSDC, funderBalanceUSDC: report.funderBalanceUSDC, reportPath }));
  }
} catch (error) {
  // RPC errors can embed signed bytes. Keep them out of terminal logs.
  console.error(error.shortMessage || (error.name === 'AssertionError' ? error.message : 'Funding stopped; keep the journal and retry to reconcile receipts.'));
  process.exitCode = 1;
} finally {
  if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
}
