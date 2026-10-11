// Public ARC testnet only. Signed transactions are durable before broadcast.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, encodeDeployData, encodeFunctionData, decodeFunctionData, getContractAddress, getCreate2Address, encodeAbiParameters, parseAbiParameters, parseEventLogs, parseTransaction, recoverTransactionAddress, keccak256, toHex, erc20Abi, parseEther, formatEther, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { root, dir, v2dir, claimDir, json, hash } from './build.mjs';

export const QUOTE = '0x3600000000000000000000000000000000000000';
export function persist(path, value) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, json(value), { mode: 0o600 });
  const fd = openSync(temp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const parent = openSync(dirname(path), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
}
export function link(a, libraries, runtime = false) {
  const b = runtime ? a.runtime : a.bytecode;
  let code = b.object;
  for (const refs of Object.values(b.linkReferences ?? {})) for (const [name, positions] of Object.entries(refs)) {
    assert(libraries[name], `Missing library ${name}`);
    for (const { start, length } of positions) {
      assert.equal(length, 20);
      code = code.slice(0, start * 2) + libraries[name].slice(2).toLowerCase() + code.slice((start + length) * 2);
    }
  }
  assert(/^[a-fA-F0-9]+$/.test(code));
  return `0x${code}`;
}
export async function context(options = {}) {
  assert(options.version == null || [2, 3].includes(options.version));
  const deploymentDir = options.version === 3 ? claimDir : options.version === 2 ? v2dir : dir;
  const build = JSON.parse(readFileSync(resolve(deploymentDir, 'build.json')));
  const path = resolve(dir, 'wallets.json');
  assert.equal(statSync(path).mode & 0o077, 0, 'Wallet file must be owner-only');
  const saved = JSON.parse(readFileSync(path));
  const accounts = Object.fromEntries(Object.entries(saved).map(([role, wallet]) => {
    const account = privateKeyToAccount(wallet.privateKey);
    assert.equal(account.address, wallet.address);
    return [role, account];
  }));
  assert.equal(accounts.deployer.address, build.deployer);
  assert.equal(new Set(Object.values(accounts).map(a => a.address)).size, 3);
  const rpc = options.rpc ?? process.env.ARC_TESTNET_RPC_URL ?? 'https://rpc.testnet.arc.io';
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(rpc).hostname);
  assert.equal(Boolean(options.storageDir), local, 'Rehearsals require a separate journal directory');
  const storageDir = options.storageDir ?? deploymentDir;
  const chain = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const timeout = local ? 60000 : 15000;
  // Share pacing between reads and signing so public RPC bursts cannot interrupt recovery.
  let nextRequestAt = 0;
  const onFetchRequest = async () => {
    if (local) return;
    const now = Date.now(), wait = Math.max(0, nextRequestAt - now);
    nextRequestAt = now + wait + 1200;
    await new Promise(resolve => setTimeout(resolve, wait));
  };
  const transport = options => {
    const base = http(rpc, { timeout, retryCount: 1, onFetchRequest })(options);
    return { ...base, request: async (...args) => {
      for (let attempt = 0; ; attempt++) {
        try { return await base.request(...args); }
        catch (error) {
          if (attempt >= 3 || !/rate limit|exceeds defined limit/i.test(error.message)) throw error;
          await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
        }
      }
    } };
  };
  const client = createPublicClient({ chain, transport, pollingInterval: 1000, cacheTime: 0 });
  assert.equal(await client.getChainId(), 5042002);
  const read = async (address, abi, functionName, args = [], blockNumber) => {
    for (let attempt = 0; ; attempt++) {
      try { return await client.readContract({ address, abi, functionName, args, blockNumber }); }
      catch (error) {
        if (attempt >= 3 || !/rate limit|exceeds defined limit/i.test(error.message)) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  };
  assert.equal(await read(QUOTE, erc20Abi, 'decimals'), 6);
  const profile = JSON.parse(readFileSync(resolve(root, 'chains/5042002.json')));
  const pool = profile.uniswapV4.poolManager, position = profile.uniswapV4.positionManager;
  for (const address of [pool, position]) assert((await client.getCode({ address }))?.length > 2);
  const a = build.artifacts;
  assert.equal((await read(position, [{ type: 'function', name: 'poolManager', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }], 'poolManager')).toLowerCase(), pool.toLowerCase());
  const journalPath = resolve(storageDir, 'transactions.json');
  const identity = hash({ chainId: chain.id, build, accounts: Object.fromEntries(Object.entries(accounts).map(([role, account]) => [role, account.address])) });
  const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath)) : { identity, steps: {} };
  assert.equal(journal.identity, identity, 'Build or wallet identity changed; preserve original deployment');
  const reportPath = local ? resolve(storageDir, 'report.json') : resolve(root, options.version === 3 ? 'deployments/argus-public-testnet-claim.json' : options.version === 2 ? 'deployments/argus-public-testnet-v2.json' : 'deployments/argus-public-testnet.json');
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath)) : { status: 'prepared', chainId: chain.id, rpc, independentTestDeployment: true, publicTransactions: false,
    accounts: Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k, v.address])), provenance: build.provenance, testnetChanges: build.testnetChanges,
    addresses: {}, transactions: {}, codeHashes: {}, limitations: ['USDC only; other quote routes and conversions disabled', `Real ${options.version === 3 ? '10-minute' : '48-hour'} delay cannot be fast-forwarded on public testnet`, 'Application frontend/backend rollout is separate from this contract deployment'] };
  if (report.identity) assert.equal(report.identity, identity);
  report.identity = identity;
  const save = () => { report.updatedAt = new Date().toISOString(); persist(reportPath, report); };
  async function send(label, role, makeTransaction) {
    assert(process.argv.includes('--broadcast'), 'Broadcast must be explicitly selected');
    console.log(json({ preparing: label, network: local ? 'local-rehearsal' : 'arc-public-testnet' }));
    const account = accounts[role];
    let step = journal.steps[label];
    if (!step) {
      assert.equal(await client.getChainId(), 5042002);
      const [latest, nonce] = await Promise.all(['latest', 'pending'].map(blockTag => client.getTransactionCount({ address: account.address, blockTag })));
      assert.equal(latest, nonce, 'Resolve external pending transactions first');
      const transaction = await makeTransaction();
      const wallet = createWalletClient({ chain, account, transport });
      const request = await wallet.prepareTransactionRequest({ ...transaction, nonce });
      const maximum = request.gas * (request.maxFeePerGas ?? request.gasPrice);
      assert(maximum <= parseEther('0.5'), `${label}: per-transaction gas ceiling`);
      const committed = Object.values(journal.steps).reduce((sum, s) => sum + BigInt(s.maximum) + BigInt(s.transaction.value ?? 0), 0n);
      const reserved = options.version === 3 ? '7' : '1';
      assert(committed + maximum + (transaction.value ?? 0n) + parseEther(reserved) <= parseEther('10'), '10 test USDC cap includes reserved trade and donation amounts');
      assert(await client.getBalance({ address: account.address }) >= maximum + (transaction.value ?? 0n) + parseEther('0.05'), `${role}: insufficient test USDC`);
      const raw = await wallet.signTransaction(request);
      step = { role, transaction, nonce, raw, hash: keccak256(raw), maximum: String(maximum) };
      journal.steps[label] = step;
      persist(journalPath, journal);
    }
    assert.equal(step.role, role);
    const parsed = parseTransaction(step.raw);
    assert.equal(parsed.chainId, chain.id);
    assert.equal((await recoverTransactionAddress({ serializedTransaction: step.raw })).toLowerCase(), account.address.toLowerCase());
    assert.equal(keccak256(step.raw), step.hash);
    assert.equal(parsed.to?.toLowerCase(), step.transaction.to?.toLowerCase());
    assert.equal(parsed.data ?? '0x', step.transaction.data ?? '0x');
    assert.equal(parsed.value ?? 0n, BigInt(step.transaction.value ?? 0));
    assert.equal(parsed.nonce, step.nonce);
    let receipt = await client.getTransactionReceipt({ hash: step.hash }).catch(e => { if (e.name !== 'TransactionReceiptNotFoundError') throw e; });
    if (!receipt) {
      await client.sendRawTransaction({ serializedTransaction: step.raw }).catch(e => { if (!/already known|nonce too low/i.test(e.message)) throw e; });
      receipt = await client.waitForTransactionReceipt({ hash: step.hash, timeout: 60000 });
    }
    assert.equal(receipt.status, 'success', `${label}: reverted; retain journal and investigate`);
    // A local fork has no public consensus; finality is checked only for real testnet receipts.
    for (let n = 0; !local && (await client.getBlock({ blockTag: 'finalized' })).number < receipt.blockNumber; n++) {
      assert(n < 60, 'Finality pending; rerun using the same journal');
      await new Promise(r => setTimeout(r, 1000));
    }
    assert.equal((await client.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash);
    report.publicTransactions = !local;
    report.transactions[label] = { hash: receipt.transactionHash, block: String(receipt.blockNumber), gasUSDC: formatEther(receipt.gasUsed * receipt.effectiveGasPrice), status: receipt.status };
    save();
    console.log(json({ step: label, ...report.transactions[label] }));
    return receipt;
  }
  async function call(label, role, address, abi, fn, args, value = 0n) {
    if (journal.steps[label]) {
      const old = journal.steps[label].transaction;
      assert.equal(old.to.toLowerCase(), address.toLowerCase());
      const decoded = decodeFunctionData({ abi, data: old.data });
      assert.equal(decoded.functionName, fn);
      if (typeof args !== 'function') assert.equal(json(decoded.args ?? []), json(args));
      assert.equal(BigInt(old.value ?? 0), value);
    }
    return send(label, role, async () => ({ to: address, data: encodeFunctionData({ abi, functionName: fn, args: typeof args === 'function' ? await args() : args }), value }));
  }
  async function deploy(name, args, nonce, libraries = {}) {
    const address = getContractAddress({ from: accounts.deployer.address, nonce: BigInt(nonce) });
    const data = encodeDeployData({ abi: a[name].abi, bytecode: link(a[name], libraries), args });
    if (journal.steps[name]) assert.equal(journal.steps[name].transaction.data, data);
    const receipt = await send(name, 'deployer', async () => {
      assert.equal(await client.getTransactionCount({ address: accounts.deployer.address, blockTag: 'pending' }), nonce, `${name}: deployment nonce`);
      return { data, value: 0n };
    });
    assert.equal(receipt.contractAddress.toLowerCase(), address.toLowerCase());
    let expected = link(a[name], libraries, true).slice(2).toLowerCase();
    let actual = (await client.getCode({ address })).slice(2).toLowerCase();
    assert.equal(actual.length, expected.length);
    const immutable = Object.values(a[name].runtime.immutableReferences ?? {}).flat();
    if (name.startsWith('ArgusV4')) immutable.push({ start: 1, length: 20 });
    for (const { start, length } of immutable) { expected = expected.slice(0, start * 2) + '0'.repeat(length * 2) + expected.slice((start + length) * 2); actual = actual.slice(0, start * 2) + '0'.repeat(length * 2) + actual.slice((start + length) * 2); }
    assert.equal(actual, expected, `${name}: deployed runtime mismatch`);
    report.addresses[name] = address;
    report.codeHashes[name] = keccak256(await client.getCode({ address }));
    save();
    return address;
  }
  return { build, accounts, client, read, pool, position, a, report, save, send, call, deploy, journal, storageDir, reportPath };
}
export async function launchArgs(c, creator, label) {
  const portal = c.build.portal, abi = c.a.portal.abi;
  const salt = keccak256(toHex(`SingleSpark/ARC-Testnet/${label}`));
  const splitter = await c.read(portal, abi, 'predictSplitter', [creator, salt]);
  const bytecodeHash = await c.read(portal, abi, 'hookInitCodeHash', [splitter, 200, 200, QUOTE]);
  let hookSalt;
  for (let i = 0n; i < 1000000n; i++) {
    const candidate = toHex(i, { size: 32 }), scoped = keccak256(encodeAbiParameters(parseAbiParameters('address,bytes32'), [creator, candidate]));
    if ((BigInt(getCreate2Address({ from: portal, salt: scoped, bytecodeHash })) & 0x3fffn) === 0x2044n) { hookSalt = candidate; break; }
  }
  assert(hookSalt);
  return [{ name: `SingleSpark Test ${label}`, symbol: label, totalSupply: 10n ** 27n, startFdvUsdc6: 2500n * 10n ** 6n, bondFdvUsdc6: 45000n * 10n ** 6n,
    buyTaxBps: 200, sellTaxBps: 200, creatorBps: 10000, burnBps: 0, dividendBps: 0, liquidityBps: 0, devBuyQuote: 0n, quoteAsset: QUOTE, expectConvert: 1 },
  { imageURI: '', website: '', twitter: '', telegram: '', description: 'Independent ARC public testnet verification; test assets only.' }, salt, hookSalt];
}
async function main() {
  const c = await context();
  if (!process.argv.includes('--broadcast')) {
    console.log(json({ status: 'reviewable_plan', chainId: 5042002, portal: c.build.portal, accounts: c.report.accounts,
      balanceUSDC: formatEther(await c.client.getBalance({ address: c.accounts.deployer.address })), totalTestBudgetUSDC: '10', ...{ testnetChanges: c.build.testnetChanges } }));
    return;
  }
  await deployAll(c);
}
export async function deployAll(c) {
  const lockPath = resolve(c.storageDir, 'run.lock'), lock = openSync(lockPath, 'wx', 0o600);
  try {
    const sv = await c.deploy('stateView', [c.pool], 0);
    const routes = await c.deploy('usdcOnly', [c.pool, sv], 1);
    const cfg = await c.deploy('launchConfig', [], 2);
    const token = await c.deploy('tokenImpl', [c.pool, QUOTE, cfg], 3);
    const locker = await c.deploy('lockerImpl', [], 4);
    const splitter = await c.deploy('splitterImpl', [routes, routes, QUOTE], 5);
    const curve = await c.deploy('ArgusV4Curve', [], 6);
    const devBuy = await c.deploy('ArgusV4DevBuyERC20', [], 7);
    const portal = await c.deploy('portal', [c.pool, c.position, sv, token, locker, splitter, QUOTE, c.accounts.admin.address, 1000, 10000, c.accounts.admin.address, routes], 8, { ArgusV4Curve: curve, ArgusV4DevBuyERC20: devBuy });
    assert.equal(portal, c.build.portal);
    c.report.status = 'portal_deployed'; c.save();
    await c.send('executor-gas', 'deployer', async () => ({ to: c.accounts.executor.address, value: parseEther('1') }));
    const receipt = await c.call('platform-launch', 'executor', portal, c.a.portal.abi, 'launch', await launchArgs(c, c.accounts.executor.address, 'TSPARK'));
    const platform = parseEventLogs({ abi: c.a.portal.abi, eventName: 'TokenCreated', logs: receipt.logs }).find(e => e.address.toLowerCase() === portal.toLowerCase()).args.token;
    c.report.addresses.platformToken = platform; c.save();
    const router = await c.deploy('router', [c.accounts.executor.address, platform, c.accounts.admin.address, false], 10);
    const implementation = await c.deploy('implementation', [], 11);
    const factory = await c.deploy('factory', [router, c.accounts.admin.address, c.accounts.executor.address, implementation], 12);
    assert.equal(await c.read(factory, c.a.factory.abi, 'DELAY'), 172800n);
    assert.equal((await c.read(router, c.a.router.abi, 'portal')).toLowerCase(), portal.toLowerCase());
    assert.equal((await c.read(factory, c.a.factory.abi, 'executor')).toLowerCase(), c.accounts.executor.address.toLowerCase());
    c.report.status = 'deployed_pending_acceptance'; c.save();
    console.log(json({ status: c.report.status, addresses: c.report.addresses, report: c.reportPath }));
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.shortMessage ?? e.message); process.exitCode = 1; });
