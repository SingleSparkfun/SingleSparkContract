import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { root, data, hash, json, readJson } from './build.mjs';

export function persist(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  writeFileSync(temp, json(value), { mode: 0o600 });
  const fd = openSync(temp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const parent = openSync(dirname(path), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
}

export function requireTestnet(config, chainId) {
  assert.equal(config.environment, 'testnet', 'Only the testnet deployment is authorized');
  assert.equal(config.chainId, 46630, 'Only Robinhood Testnet is authorized');
  assert.equal(chainId, 46630, 'RPC chain mismatch');
}

export async function context({ walletPath, rpc, storageDir, local = false, broadcast = false, deploymentName, artifacts, deploymentId = '' }) {
  assert(!deploymentName || ['vault-launch', 'gameplay'].includes(deploymentName), 'Unknown deployment journal');
  assert.equal(Boolean(deploymentName), Boolean(artifacts), 'A separate deployment must pin its own artifacts');
  assert(!deploymentId || deploymentName && /^[a-z0-9][a-z0-9-]{0,63}$/.test(deploymentId), 'Invalid testnet deployment ID');
  const config = readJson(resolve(root, 'chains/robinhood/deployments/testnet/pons/config.json'));
  rpc ??= config.rpc;
  const url = new URL(rpc);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  assert.equal(local, loopback, 'Local rehearsal requires a loopback RPC and --local');
  assert(local || url.protocol === 'https:', 'Public RPC requires HTTPS');
  assert(!url.username && !url.password, 'RPC credentials must not enter public reports');
  assert.equal(Boolean(storageDir), local, 'Local rehearsal requires a separate journal');
  storageDir = local ? resolve(storageDir) : resolve(data, 'testnet');
  assert(!local || storageDir !== resolve(data, 'testnet'), 'Preserve the public testnet journal');
  assert.equal(statSync(walletPath).mode & 0o077, 0, 'Wallet file must be owner-only');
  const wallets = readJson(walletPath);
  const saved = wallets.deployer;
  const account = privateKeyToAccount(saved.privateKey);
  assert.equal(account.address.toLowerCase(), saved.address.toLowerCase(), 'Deployer identity mismatch');
  const chain = defineChain({ id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const transport = http(rpc, { retryCount: 3, timeout: 30000, batch: { batchSize: 10, wait: 10 } });
  const client = createPublicClient({ chain, transport, pollingInterval: 1000, cacheTime: 0 });
  const wallet = createWalletClient({ chain, account, transport });
  requireTestnet(config, await client.getChainId());
  if (deploymentName) storageDir = resolve(storageDir, deploymentName);
  if (deploymentId) storageDir = resolve(storageDir, 'redeployments', deploymentId);
  const build = artifacts ?? readJson(resolve(data, 'build.json'));
  const identity = hash({ chainId: chain.id, local, config, build, deployer: account.address });
  const journalPath = resolve(storageDir, 'transactions.json');
  const journal = existsSync(journalPath) ? readJson(journalPath) : { identity, steps: {} };
  assert.equal(journal.identity, identity, 'Build/config/wallet changed; preserve this journal and create a reviewed deployment');
  const reportPath = local ? resolve(storageDir, 'deployment.json') : resolve(root, `chains/robinhood/deployments/testnet/pons/${deploymentName ?? 'deployment'}${deploymentId ? `-${deploymentId}` : ''}.json`);
  const report = existsSync(reportPath) ? readJson(reportPath) : { identity, status: 'prepared', chainId: 46630, local,
    independentDeployment: true, officialPonsDeployment: false, deployer: account.address, addresses: {}, codeHashes: {}, transactions: {}, testnetDifferences: config.testnetDifferences };
  assert.equal(report.identity, identity, 'Deployment report belongs to another build');
  const save = () => {
    if (existsSync(reportPath)) for (const [label, tx] of Object.entries(readJson(reportPath).transactions))
      assert.equal(report.transactions[label]?.hash, tx.hash, 'Another run advanced the report; reload before continuing');
    persist(reportPath, report);
  };
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });

  async function send(label, transaction, role = 'deployer') {
    assert(['deployer', 'admin', 'executor'].includes(role), 'Unknown signing role');
    const actor = role === 'deployer' ? account : privateKeyToAccount(wallets[role].privateKey);
    assert.equal(actor.address.toLowerCase(), wallets[role].address.toLowerCase(), 'Signing role mismatch');
    const sender = role === 'deployer' ? wallet : createWalletClient({ chain, account: actor, transport });
    assert(broadcast, 'Broadcast not selected');
    requireTestnet(config, await client.getChainId());
    if (existsSync(journalPath)) assert.equal(json(readJson(journalPath)), json(journal), 'Another run advanced the journal; reload before signing');
    const intended = { ...transaction, value: transaction.value ?? 0n };
    let step = journal.steps[label];
    if (step) assert.equal(json(step.transaction), json(intended), `${label}: transaction changed`);
    else {
      const [latest, pending] = await Promise.all(['latest', 'pending'].map(blockTag => client.getTransactionCount({ address: actor.address, blockTag })));
      assert.equal(latest, pending, 'Resolve existing pending transactions before signing');
      // Use the L2 RPC's gas price; a generic 1-gwei priority-fee fallback overprices testnet deployments.
      const request = await sender.prepareTransactionRequest({ ...intended, nonce: pending, type: 'legacy', gasPrice: await client.getGasPrice() });
      const gasCost = request.gas * (request.maxFeePerGas ?? request.gasPrice);
      assert(gasCost <= BigInt(config.maximumTransactionGasCostWei), `${label}: transaction gas budget exceeded (${gasCost} wei)`);
      const committed = Object.values(journal.steps).reduce((sum, s) => sum + BigInt(s.maximumCostWei), 0n);
      const maximumCostWei = gasCost + intended.value;
      assert(committed + maximumCostWei <= BigInt(config.maximumTotalCostWei), 'Total test ETH budget exceeded');
      assert(await client.getBalance({ address: actor.address }) >= maximumCostWei, 'Insufficient Robinhood test ETH');
      const raw = await sender.signTransaction(request);
      step = { transaction: intended, raw, hash: keccak256(raw), nonce: pending, maximumCostWei: String(maximumCostWei) };
      journal.steps[label] = step;
      persist(journalPath, journal);
    }
    const parsed = parseTransaction(step.raw);
    assert.equal(parsed.chainId, 46630);
    assert.equal((await recoverTransactionAddress({ serializedTransaction: step.raw })).toLowerCase(), actor.address.toLowerCase());
    assert.equal(keccak256(step.raw), step.hash);
    assert.equal(parsed.to?.toLowerCase(), intended.to?.toLowerCase());
    assert.equal(parsed.data ?? '0x', intended.data ?? '0x');
    assert.equal(parsed.value ?? 0n, BigInt(intended.value));
    assert.equal(parsed.nonce, step.nonce);
    let receipt = await client.getTransactionReceipt({ hash: step.hash }).catch(error => {
      if (error.name !== 'TransactionReceiptNotFoundError') throw error;
    });
    if (!receipt) {
      await client.sendRawTransaction({ serializedTransaction: step.raw }).catch(error => {
        if (!/already known|nonce too low/i.test(error.shortMessage ?? error.message)) throw error;
      });
      receipt = await client.waitForTransactionReceipt({ hash: step.hash, timeout: 60000 });
    }
    assert.equal(receipt.status, 'success', `${label}: reverted; preserve journal`);
    if (!local) receipt = await client.waitForTransactionReceipt({ hash: step.hash, confirmations: 2, timeout: 60000 });
    assert.equal((await client.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash);
    report.transactions[label] = { hash: receipt.transactionHash, blockNumber: String(receipt.blockNumber), blockHash: receipt.blockHash, gasCostWei: String(receipt.gasUsed * receipt.effectiveGasPrice) };
    save();
    console.log(`${label}: ${receipt.transactionHash}`);
    return receipt;
  }
  return { config, build, account, client, read, send, save, report, journal, journalPath, storageDir, local, broadcast };
}
