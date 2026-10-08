import assert from 'node:assert/strict';
import { readFileSync, openSync, closeSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, encodeFunctionData, erc20Abi,
  keccak256, parseEventLogs, parseTransaction, recoverTransactionAddress, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcAbi } from '../../SingleSparkFront/front/web3/arcAbi.ts';
import { persist, stringify } from './runtime.mjs';

// One fixed, resumable testnet batch. The default invocation only estimates costs.
process.loadEnvFile('SingleSparkContract/arc/.env.testnet.local');
const deployment = JSON.parse(readFileSync('SingleSparkContract/arc/deployments/jet-arc-testnet.json'));
assert.equal(Number(process.env.ARC_CHAIN_ID), 5042002);
assert.equal(deployment.chainId, 5042002);
assert.equal(process.env.ARC_LAUNCH_ADDRESS.toLowerCase(), deployment.launch.toLowerCase());
const account = privateKeyToAccount(process.env.ARC_DEPLOYER_PRIVATE_KEY);
assert.notEqual(account.address.toLowerCase(), deployment.keeper.toLowerCase());
const chain = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL] } } });
const transport = http(process.env.ARC_RPC_URL, { retryCount: 0, timeout: 15_000 });
const client = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account, chain, transport });
assert.equal(await client.getChainId(), chain.id);
assert.equal(keccak256(await client.getCode({ address: deployment.launch })), deployment.launchCodeHash);
const tokens = [['Jet Demo Alpha', 'JDA'], ['Jet Demo Beta', 'JDB'], ['Jet Demo Gamma', 'JDG']];
const identity = stringify({ chainId: chain.id, launch: deployment.launch, creator: account.address, tokens });
const journalPath = resolve(process.env.ARC_DATA_DIR, 'demo-launch-journal.json');
let journal = { identity, steps: {} };
try { journal = JSON.parse(readFileSync(journalPath)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
assert.equal(journal.identity, identity, 'Launch journal belongs to another batch');
const report = { chainId: chain.id, launch: deployment.launch, creator: account.address, tokens: [] };
const broadcast = process.argv.includes('--broadcast');
const lockPath = resolve(process.env.ARC_DATA_DIR, 'demo-launch.lock');
const lock = openSync(lockPath, 'wx', 0o600);
writeFileSync(lock, String(process.pid));
try {
  for (const [name, symbol] of tokens) {
    const call = { address: deployment.launch, abi: arcAbi, functionName: 'launch', args: [name, symbol, ''], account };
    const data = encodeFunctionData(call);
    let step = journal.steps[symbol];
    if (!step) {
      await client.simulateContract(call);
      const estimate = await client.estimateContractGas(call);
      const gas = estimate + estimate / 5n;
      assert(gas <= 1_500_000n, 'Launch exceeds the gas budget');
      const fees = await client.estimateFeesPerGas();
      const maxCost = gas * fees.maxFeePerGas;
      assert(maxCost <= parseEther('0.1'), 'Launch fee moved above the preflight budget');
      assert(await client.getBalance({ address: account.address }) >= maxCost + parseEther('1'), 'Insufficient gas reserve');
      console.log(stringify({ symbol, gas, maximumFeeUSDC: formatEther(maxCost), broadcast }));
      if (!broadcast) continue;
      const [latest, nonce] = await Promise.all(['latest', 'pending'].map(blockTag => client.getTransactionCount({ address: account.address, blockTag })));
      assert.equal(latest, nonce, 'Creator has another pending transaction');
      const request = await wallet.prepareTransactionRequest({ to: deployment.launch, data, value: 0n, gas, nonce, ...fees });
      const raw = await wallet.signTransaction(request);
      step = { raw, hash: keccak256(raw) };
      journal.steps[symbol] = step;
      persist(journalPath, journal); // Save exact signed bytes before any broadcast.
    }
    assert.equal(keccak256(step.raw), step.hash);
    const tx = parseTransaction(step.raw);
    assert.equal(tx.chainId, chain.id);
    assert.equal(tx.to.toLowerCase(), deployment.launch.toLowerCase());
    assert.equal(tx.data, data);
    assert.equal(tx.value ?? 0n, 0n);
    assert.equal((await recoverTransactionAddress({ serializedTransaction: step.raw })).toLowerCase(), account.address.toLowerCase());
    let receipt;
    try { receipt = await client.getTransactionReceipt({ hash: step.hash }); }
    catch (error) { if (error.name !== 'TransactionReceiptNotFoundError') throw error; }
    if (!receipt) {
      if (!broadcast) { console.log(stringify({ symbol, pendingHash: step.hash })); continue; }
      try { await client.sendRawTransaction({ serializedTransaction: step.raw }); }
      catch (error) { if (!/already known|nonce too low|known transaction/i.test(error.message)) throw error; }
      receipt = await client.waitForTransactionReceipt({ hash: step.hash, timeout: 45_000 });
    }
    assert.equal(receipt.status, 'success', `Launch reverted: ${step.hash}`);
    const events = parseEventLogs({ abi: arcAbi, eventName: 'Launched', logs: receipt.logs })
      .filter(event => event.address.toLowerCase() === deployment.launch.toLowerCase());
    assert.equal(events.length, 1);
    const event = events[0].args;
    assert.equal(event.name, name); assert.equal(event.symbol, symbol);
    assert.equal(event.creator.toLowerCase(), account.address.toLowerCase());
    const [state, supply] = await Promise.all([
      client.readContract({ address: deployment.launch, abi: arcAbi, functionName: 'tokens', args: [event.token] }),
      client.readContract({ address: event.token, abi: erc20Abi, functionName: 'totalSupply' }),
    ]);
    assert.equal(state[0], event.positionId);
    assert(supply > 0n && supply <= 1_000_000_000n * 10n ** 18n);
    report.tokens.push({ name, symbol, token: event.token, positionId: String(event.positionId), transactionHash: receipt.transactionHash,
      blockNumber: String(receipt.blockNumber), gasUsed: String(receipt.gasUsed), gasCostUSDC: formatEther(receipt.gasUsed * receipt.effectiveGasPrice) });
    console.log(stringify(report.tokens.at(-1)));
    if (broadcast) persist('SingleSparkContract/arc/deployments/jet-arc-testnet-demo-tokens.json', report);
  }
} finally { closeSync(lock); unlinkSync(lockPath); }
