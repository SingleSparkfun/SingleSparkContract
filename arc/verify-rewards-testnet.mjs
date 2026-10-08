// Independent ARC-testnet mechanism proof. Never rewrites the active site's deployment.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, parseEther, formatEther, erc20Abi,
  encodeFunctionData, encodeAbiParameters, keccak256, concat, parseEventLogs, parseTransaction, recoverTransactionAddress, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deployArc, artifact } from './deploy.mjs';
import { persist, stringify } from './runtime.mjs';
import { arcAbi, quoterAbi } from '../../SingleSparkFront/front/web3/arcAbi.ts';

const dir = 'SingleSparkContract/arc/data/jet-rewards-verification';
mkdirSync(dir, { recursive: true, mode: 0o700 });
process.loadEnvFile('SingleSparkContract/arc/.env.testnet.local');
assert.equal(Number(process.env.ARC_CHAIN_ID), 5042002);
const account = privateKeyToAccount(JSON.parse(readFileSync('SingleSparkContract/arc/data/jet-test-wallets-20260916/wallets.json')).wallets[0].privateKey);
const funder = privateKeyToAccount(process.env.ARC_DEPLOYER_PRIVATE_KEY);
const chain = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL] } } });
const transport = http(process.env.ARC_RPC_URL, { timeout: 15000, retryCount: 1 });
const client = createPublicClient({ chain, transport, cacheTime: 0 });
const wallet = createWalletClient({ account, chain, transport });
assert.equal(await client.getChainId(), 5042002);
const reportPath = 'SingleSparkContract/arc/deployments/jet-rewards-testnet-verification.json';
let report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath)) : {
  chainId: 5042002, purpose: 'Isolated mechanism verification; not the live JET deployment',
  minBuybackUSDC: '0.001', productionMinimumUnchanged: '5', testWallet: account.address, transactions: {},
};
assert.equal(report.testWallet, account.address);
const journalPath = `${dir}/transactions.json`;
const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath)) : {};
const log = value => console.log(stringify(value));
if (!process.argv.includes('--broadcast')) {
  log({ mode: 'preflight', chainId: chain.id, account: account.address,
    balanceUSDC: formatEther(await client.getBalance({ address: account.address })),
    fundingUSDC: '10', buyUSDC: '5', minBuybackUSDC: '0.001', maxGasUSDCPerCall: '0.1' });
  process.exit(0);
}
// The automatic worker may have advanced the reward round since this one-time proof.
if (report.status === 'passed') { log({ status: 'already_verified', reportPath }); process.exit(0); }
const lockPath = `${dir}/run.lock`;
const lock = openSync(lockPath, 'wx', 0o600);
try {
  async function send(label, signer, transaction) {
    let step = journal[label];
    if (!step) {
      const [latest, nonce] = await Promise.all(['latest','pending'].map(blockTag => client.getTransactionCount({ address: signer.address, blockTag })));
      assert.equal(latest, nonce, 'Pending transaction must resolve before signing');
      await client.call({ ...transaction, account: signer });
      const estimate = await client.estimateGas({ ...transaction, account: signer });
      const gas = estimate + estimate / 5n;
      assert(gas <= 1_500_000n);
      const fees = await client.estimateFeesPerGas();
      if (fees.maxFeePerGas < 20_000_000_000n) fees.maxFeePerGas = 20_000_000_000n;
      const gasBudget = gas * fees.maxFeePerGas;
      assert(gasBudget <= parseEther('0.1'));
      assert(await client.getBalance({ address: signer.address }) >= (transaction.value ?? 0n) + gasBudget + parseEther('0.2'));
      const sender = createWalletClient({ account: signer, chain, transport });
      const raw = await sender.signTransaction({ ...transaction, ...fees, gas, nonce, chainId: chain.id, type: 'eip1559' });
      step = { raw, hash: keccak256(raw), transaction };
      journal[label] = step; persist(journalPath, journal);
    }
    const tx = parseTransaction(step.raw);
    assert.equal(tx.chainId, chain.id);
    assert.equal(tx.to.toLowerCase(), transaction.to.toLowerCase());
    assert.equal(tx.data ?? '0x', step.transaction.data ?? '0x');
    assert.equal(tx.value ?? 0n, BigInt(step.transaction.value ?? 0));
    assert.equal((await recoverTransactionAddress({ serializedTransaction: step.raw })).toLowerCase(), signer.address.toLowerCase());
    assert.equal(keccak256(step.raw), step.hash);
    let receipt;
    try { receipt = await client.getTransactionReceipt({ hash: step.hash }); }
    catch (error) { if (error.name !== 'TransactionReceiptNotFoundError') throw error; }
    if (!receipt) {
      try { await client.sendRawTransaction({ serializedTransaction: step.raw }); }
      catch(error) { if (!/already known|nonce too low/i.test(error.message)) throw error; }
      receipt = await client.waitForTransactionReceipt({ hash: step.hash, timeout: 45000 });
    }
    assert.equal(receipt.status, 'success', label);
    report.transactions[label] = { hash: step.hash, block: String(receipt.blockNumber), gasUSDC: formatEther(receipt.gasUsed * receipt.effectiveGasPrice) };
    persist(reportPath, report); log({ step: label, ...report.transactions[label] });
    return receipt;
  }
  await send('test-wallet-funding', funder, { to: account.address, value: parseEther('10') });
  const deployment = await deployArc(client, wallet, { version: 1,
    positionManager: process.env.ARC_POSITION_MANAGER, keeper: account.address, operations: process.env.ARC_OPERATIONS_ADDRESS,
    platformName: 'Jet Rewards Test', platformSymbol: 'JET', minBuyback: '0.001', withRewards: true,
    journalPath: `${dir}/deployment.json`,
  });
  report.deployment = deployment; persist(reportPath, report); log({ deployment });
  const rewardAbi = artifact('ArcRewards').abi;
  const readReward = functionName => client.readContract({ address: deployment.rewards, abi: rewardAbi, functionName });
  const state = () => client.readContract({ address: deployment.launch, abi: arcAbi, functionName: 'tokens', args: [deployment.platformToken] });
  const supply = blockNumber => client.readContract({ address: deployment.platformToken, abi: erc20Abi, functionName: 'totalSupply', blockNumber });
  const deadline = async () => (await client.getBlock()).timestamp + 115n;
  const contractCall = async (label, address, abi, functionName, args, value = 0n) => send(label, account, {
    to: address, data: encodeFunctionData({ abi, functionName, args }), value,
  });
  const quote = async amount => (await client.simulateContract({ address: deployment.quoter, abi: quoterAbi,
    functionName: 'quoteExactInputSingle', args: [{ poolKey: { currency0: zeroAddress, currency1: deployment.platformToken,
      fee: 2500, tickSpacing: 25, hooks: zeroAddress }, zeroForOne: true, exactAmount: amount, hookData: '0x' }] })).result[0];
  await contractCall('buy', deployment.launch, arcAbi, 'trade', [deployment.platformToken, true, parseEther('5'), await quote(parseEther('5')) * 97n / 100n, await deadline()], parseEther('5'));
  const collection = await contractCall('collect', deployment.launch, arcAbi, 'collectFees', [deployment.platformToken]);
  const feeEvent = parseEventLogs({ abi: arcAbi, eventName: 'FeesReceived', logs: collection.logs }).find(e => e.address.toLowerCase() === deployment.launch.toLowerCase()).args;
  assert(feeEvent.nativeAmount > 0n); assert.equal(feeEvent.projectShare + feeEvent.platformShare + feeEvent.operationsShare, feeEvent.nativeAmount);
  report.organicFees = feeEvent;
  const pending = (await state())[1];
  const burn = await contractCall('buyback-burn', deployment.launch, arcAbi, 'executeBurn', [deployment.platformToken, pending, pending ? await quote(pending) * 97n / 100n : 0n, await deadline()]);
  const event = parseEventLogs({ abi: arcAbi, eventName: 'Burned', logs: burn.logs }).find(e => e.address.toLowerCase() === deployment.launch.toLowerCase()).args;
  const reward = event.bought / 10n;
  assert.equal(event.totalBurned, event.bought - reward + event.feeTokens);
  assert.equal(await supply(burn.blockNumber - 1n) - await supply(burn.blockNumber), event.totalBurned);
  assert(reward >= parseEther('1000'));
  report.buyback = { ...event, reward, supplyReduction: event.totalBurned }; persist(reportPath, report);

  // Snapshot public transaction senders at finalized blocks, never token holders or invented addresses.
  const snapshotPath = `${dir}/candidates.json`;
  let snapshot;
  if (existsSync(snapshotPath)) snapshot = JSON.parse(readFileSync(snapshotPath));
  else {
    const head = await client.getBlock({ blockTag: 'finalized' });
    const excluded = new Set([zeroAddress, '0x000000000000000000000000000000000000dead', account.address, funder.address,
      ...Object.values(deployment).filter(v => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v))].map(v=>v.toLowerCase()));
    const addresses = new Set(); let from = head.number;
    for (let offset=0; offset<40; offset++) {
      from = head.number - BigInt(offset);
      const block = await client.getBlock({ blockNumber: from, includeTransactions: true });
      for(const tx of block.transactions) if (!excluded.has(tx.from.toLowerCase())) addresses.add(tx.from.toLowerCase());
      if (addresses.size >= 128) break;
    }
    assert(addresses.size >= 100, 'Need at least 100 active wallets for a batch');
    snapshot = { chainId: chain.id, source: 'Unique transaction senders in a contiguous finalized block window; no holder filter',
      fromBlock: String(from), toBlock: String(head.number), toBlockHash: head.hash, excluded: [...excluded], addresses: [...addresses].sort().slice(0, 256) };
    persist(snapshotPath, snapshot);
  }
  assert.equal((await client.getBlock({ blockNumber: BigInt(snapshot.toBlock) })).hash, snapshot.toBlockHash);
  const count = 100;
  const addresses = snapshot.addresses.slice(0, count);
  report.candidateSnapshot = snapshot; persist(reportPath, report);
  const beforePaid = await readReward('totalPaid');
  const receipt = await contractCall('direct-distribution', deployment.rewards, rewardAbi, 'distribute', [beforePaid, addresses]);
  const paid = parseEventLogs({ abi: rewardAbi, eventName: 'RewardPaid', logs: receipt.logs }).filter(e => e.address.toLowerCase() === deployment.rewards.toLowerCase());
  assert.equal(paid.length, count);
  report.payouts = paid.map((event, index) => {
    assert.equal(event.args.recipient.toLowerCase(), addresses[index]);
    assert.equal(event.args.amount, parseEther('10'));
    return { recipient: addresses[index], amount: '10', hash: receipt.transactionHash };
  });
  assert.equal(new Set(report.payouts.map(p => p.recipient)).size, count);
  assert.equal(await readReward('totalPaid'), beforePaid + BigInt(count));
  assert.equal(await readReward('available'), reward - BigInt(count) * parseEther('10'));
  await assert.rejects(client.simulateContract({ address: deployment.rewards, abi: rewardAbi, functionName: 'distribute', args: [beforePaid, addresses], account }));
  report.status='passed'; report.completedAt=new Date().toISOString();report.replayRejected=true;
  report.remainingRewardTokens=formatEther(await readReward('available'));
  persist(reportPath,report);log({status:report.status,burnedJET:formatEther(event.totalBurned),rewardsJET:formatEther(reward),recipients:count,remainingRewardTokens:report.remainingRewardTokens,reportPath});
} finally {closeSync(lock);unlinkSync(lockPath);}
