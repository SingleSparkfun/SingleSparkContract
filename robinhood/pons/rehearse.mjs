// Real Pons bytecode and a local fork of Robinhood Testnet; never broadcasts to the public RPC.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, http, encodeFunctionData, parseEventLogs, erc20Abi, zeroAddress, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { data, readJson, root, json } from './build.mjs';
import { context } from './transactions.mjs';
import { deploy } from './deploy.mjs';

const dir = resolve(data, `rehearsal-${Date.now()}`);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const privateKey = generatePrivateKey(), account = privateKeyToAccount(privateKey);
const walletPath = resolve(dir, 'wallet.json');
writeFileSync(walletPath, json({ deployer: { privateKey, address: account.address } }), { mode: 0o600 });
const config = readJson(resolve(root, 'deployments/testnet/robinhood/pons/config.json'));
const rpc = 'http://127.0.0.1:18631';
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', '18631', '--chain-id', '46630', '--fork-url', config.rpc, '--gas-price', '10000000', '--base-fee', '10000000', '--disable-min-priority-fee', '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] });
let failure = '';
anvil.stderr.on('data', chunk => { failure += chunk.toString(); });
try {
  const client = createPublicClient({ transport: http(rpc, { retryCount: 0, timeout: 1000 }) });
  for (let n = 0; ; n++) {
    try { assert.equal(await client.getChainId(), 46630); break; }
    catch { assert(n < 30 && anvil.exitCode == null, failure || 'Local Anvil did not start'); await new Promise(r => setTimeout(r, 500)); }
  }
  await client.request({ method: 'anvil_setBalance', params: [account.address, toHex(10n ** 19n)] });
  const options = { walletPath, rpc, storageDir: dir, local: true, broadcast: true };
  const c = await context(options);
  await deploy(c);
  const nonce = await c.client.getTransactionCount({ address: account.address });
  await deploy(await context(options));
  assert.equal(await c.client.getTransactionCount({ address: account.address }), nonce, 'Recovery must not redeploy or repeat configuration');
  const a = c.build.artifacts, addresses = c.report.addresses;
  const call = (label, address, abi, functionName, args = [], value = 0n) => c.send(label, { to: address, data: encodeFunctionData({ abi, functionName, args }), value });
  const economics = await c.read(addresses.factory, a.factory.abi, 'previewLaunchEconomics', [0n, zeroAddress]);
  const params = { name: 'Pons Rehearsal', symbol: 'REHEARSE', logo: 'https://example.com/token.png', description: 'Local verification',
    socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' }, creatorFeeRecipient: account.address,
    creatorTaxBps: 200, buybackEnabled: false, expectedEconomics: economics, salt: toHex(1, { size: 32 }) };
  const receipt = await call('test-launch', addresses.factory, a.factory.abi, 'launchToken', [params, 0n, zeroAddress, []], BigInt(config.launchFeeWei));
  const events = parseEventLogs({ abi: a.factory.abi, eventName: 'TokenLaunched', logs: receipt.logs });
  assert.equal(events.length, 1);
  const { token, curve } = events[0].args;
  const curveAbi = a.PonsV2BondingCurve.abi;
  await assert.rejects(c.client.simulateContract({ account: account.address, address: addresses.factory, abi: a.factory.abi, functionName: 'launchToken', args: [{ ...params, salt: toHex(2, { size: 32 }), expectedEconomics: toHex(1, { size: 32 }) }, 0n, zeroAddress, []], value: BigInt(config.launchFeeWei) }), 'Stale economics must fail');
  const buy = BigInt(config.launchConfig.graduationThreshold) / 10n;
  await call('test-buy', curve, curveAbi, 'buy', [buy, 1n, account.address], buy);
  const balance = await c.read(token, erc20Abi, 'balanceOf', [account.address]);
  assert(balance > 0n);
  await call('test-approve-sell', token, erc20Abi, 'approve', [curve, balance / 2n]);
  await call('test-sell', curve, curveAbi, 'sell', [balance / 2n, 1n, account.address]);
  assert.equal(await c.read(token, erc20Abi, 'balanceOf', [account.address]), balance - balance / 2n);
  await call('test-fees', curve, curveAbi, 'sweepFees', [0n]);
  assert(await c.read(addresses.escrow, a.escrow.abi, 'balanceOf', [account.address]) > 0n);
  await call('test-claim-fees', addresses.escrow, a.escrow.abi, 'claim', []);
  assert.equal(await c.read(addresses.escrow, a.escrow.abi, 'balanceOf', [account.address]), 0n);
  const crossingBuy = BigInt(config.launchConfig.graduationThreshold) * 2n;
  await call('test-cross-threshold', curve, curveAbi, 'buy', [crossingBuy, 1n, account.address], crossingBuy);
  if ((await c.read(addresses.factory, a.factory.abi, 'getLaunchedToken', [token])).phase === 0)
    await call('test-graduate', addresses.factory, a.factory.abi, 'graduate', [token]);
  await call('test-create-pool', addresses.factory, a.factory.abi, 'createGraduatedPool', [token]);
  const launch = await c.read(addresses.factory, a.factory.abi, 'getLaunchedToken', [token]);
  assert.equal(launch.phase, 2);
  c.report.status = 'local_rehearsal_passed';
  c.report.verification = { token, curve, checks: ['source bytecode reproduction', 'deployment wiring', 'durable restart without duplicate transactions', 'economics commitment rejection', 'native launch', 'curve buy and sell', 'fee escrow collection', 'graduation to Uniswap V4'] };
  c.save();
  console.log(json({ status: c.report.status, report: resolve(dir, 'deployment.json'), verification: c.report.verification }));
} finally { anvil.kill('SIGTERM'); }
