import assert from 'node:assert/strict';
import { readFileSync, openSync, closeSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeDeployData, encodeFunctionData, parseEventLogs, erc20Abi, zeroAddress, toHex, getContractAddress, keccak256 } from 'viem';
import { compile, root, json } from './build.mjs';
import { context } from './transactions.mjs';
import { deploy, maskImmutables } from './deploy.mjs';

const walletIndex = process.argv.indexOf('--wallet');
assert(walletIndex >= 0, 'Pass --wallet with an owner-only testnet wallet');
const c = await context({ walletPath: resolve(process.argv[walletIndex + 1]), broadcast: process.argv.includes('--broadcast') });
try {
  await deploy(c);
  assert(c.broadcast, 'Contracts verified. Add --broadcast to run the bounded public-testnet acceptance transactions.');
  mkdirSync(c.storageDir, { recursive: true, mode: 0o700 });
  const path = resolve(c.storageDir, 'run.lock'), lock = openSync(path, 'wx', 0o600);
  try {
    const a = c.build.artifacts, addresses = c.report.addresses;
    const call = (label, address, abi, functionName, args = [], value = 0n) => c.send(label, { to: address, data: encodeFunctionData({ abi, functionName, args }), value });
    const file = 'chains/robinhood/launchpads/pons/test/PonsTestRevenueVault.sol';
    const input = { language: 'Solidity', sources: { [file]: { content: readFileSync(resolve(root, file), 'utf8') } },
      settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'] } } } };
    const fixture = compile(input, '0.8.35')[file].PonsTestRevenueVault;
    const nonce = c.journal.steps['test-revenue-vault']?.nonce ?? await c.client.getTransactionCount({ address: c.account.address, blockTag: 'pending' });
    const vault = getContractAddress({ from: c.account.address, nonce: BigInt(nonce) });
    const vaultReceipt = await c.send('test-revenue-vault', { data: encodeDeployData({ abi: fixture.abi, bytecode: `0x${fixture.evm.bytecode.object}`, args: [addresses.escrow] }) });
    assert.equal(vaultReceipt.contractAddress.toLowerCase(), vault.toLowerCase());
    const vaultCode = await c.client.getCode({ address: vault });
    assert.equal(maskImmutables(vaultCode, fixture.evm.deployedBytecode.immutableReferences), maskImmutables(fixture.evm.deployedBytecode.object, fixture.evm.deployedBytecode.immutableReferences));
    c.report.addresses.testRevenueVault = vault; c.report.codeHashes.testRevenueVault = keccak256(vaultCode); c.save();
    const economics = await c.read(addresses.factory, a.factory.abi, 'previewLaunchEconomics', [0n, zeroAddress]);
    const params = { name: 'SingleSpark Pons Test', symbol: 'SSPTEST', logo: '', description: 'Robinhood testnet acceptance; no real value',
      socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' }, creatorFeeRecipient: vault,
      creatorTaxBps: 200, buybackEnabled: false, expectedEconomics: economics, salt: toHex(1, { size: 32 }) };
    const launched = await call('test-launch', addresses.factory, a.factory.abi, 'launchToken', [params, 0n, zeroAddress, []], BigInt(c.config.launchFeeWei));
    const events = parseEventLogs({ abi: a.factory.abi, eventName: 'TokenLaunched', logs: launched.logs });
    assert.equal(events.length, 1);
    const { token, curve } = events[0].args;
    c.report.addresses.testToken = token; c.report.addresses.testCurve = curve; c.save();
    await assert.rejects(c.client.simulateContract({ account: c.account.address, address: addresses.factory, abi: a.factory.abi, functionName: 'launchToken',
      args: [{ ...params, salt: toHex(2, { size: 32 }), expectedEconomics: toHex(1, { size: 32 }) }, 0n, zeroAddress, []], value: BigInt(c.config.launchFeeWei) }),
    error => error.walk?.(e => e.data?.errorName === 'LaunchEconomicsMismatch')?.data?.errorName === 'LaunchEconomicsMismatch');
    const buy = BigInt(c.config.launchConfig.graduationThreshold) / 10n;
    const bought = await call('test-buy', curve, a.PonsV2BondingCurve.abi, 'buy', [buy, 1n, c.account.address], buy);
    const balance = await c.client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [c.account.address], blockNumber: bought.blockNumber });
    assert(balance > 0n);
    await call('test-approve-sell', token, erc20Abi, 'approve', [curve, balance / 2n]);
    const sold = await call('test-sell', curve, a.PonsV2BondingCurve.abi, 'sell', [balance / 2n, 1n, c.account.address]);
    assert.equal(await c.client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [c.account.address], blockNumber: sold.blockNumber }), balance - balance / 2n);
    // Graduation sweeps fees permissionlessly; manual sweep belongs to the creator contract/operator.
    const crossingBuy = BigInt(c.config.launchConfig.graduationThreshold) * 2n;
    let swept = await call('test-cross-threshold', curve, a.PonsV2BondingCurve.abi, 'buy', [crossingBuy, 1n, c.account.address], crossingBuy);
    let launch = await c.read(addresses.factory, a.factory.abi, 'getLaunchedToken', [token]);
    if (launch.phase === 0 || c.journal.steps['test-graduate']) swept = await call('test-graduate', addresses.factory, a.factory.abi, 'graduate', [token]);
    assert(await c.client.readContract({ address: addresses.escrow, abi: a.escrow.abi, functionName: 'balanceOf', args: [vault], blockNumber: swept.blockNumber }) > 0n);
    const claimed = await call('test-claim-fees', vault, fixture.abi, 'claim');
    assert.equal(await c.client.readContract({ address: addresses.escrow, abi: a.escrow.abi, functionName: 'balanceOf', args: [vault], blockNumber: claimed.blockNumber }), 0n);
    assert(await c.client.getBalance({ address: vault, blockNumber: claimed.blockNumber }) > 0n);
    launch = await c.read(addresses.factory, a.factory.abi, 'getLaunchedToken', [token]);
    if (launch.phase === 1) await call('test-create-pool', addresses.factory, a.factory.abi, 'createGraduatedPool', [token]);
    assert.equal((await c.read(addresses.factory, a.factory.abi, 'getLaunchedToken', [token])).phase, 2);
    const finalized = await c.client.getBlock({ blockTag: 'finalized' });
    c.report.finalizedThroughBlock = String(finalized.number);
    c.report.status = Object.values(c.report.transactions).every(tx => BigInt(tx.blockNumber) <= finalized.number) ? 'testnet_acceptance_passed' : 'testnet_acceptance_passed_pending_finality';
    c.report.verification = { token, curve, revenueVault: vault, checks: ['verified Pons executable bytecode', 'factory and dependency bindings', 'native launch', 'stale economics rejected', 'curve buy and sell', 'creator fees claimed into a separate contract', 'graduation and Uniswap V4 pool creation'] };
    c.save(); console.log(json({ status: c.report.status, verification: c.report.verification }));
  } finally { closeSync(lock); unlinkSync(path); }
} catch (error) { console.error(error.shortMessage ?? error.message); process.exitCode = 1; }
