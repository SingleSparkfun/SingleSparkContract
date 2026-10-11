// Real USDC and V4 acceptance on the independent public-testnet deployment.
import assert from 'node:assert/strict';
import { openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { erc20Abi, parseEther, parseEventLogs, keccak256, toHex, zeroAddress, getAddress } from 'viem';
import { context, launchArgs, QUOTE } from './deploy.mjs';

const v2 = process.argv.includes('--v2');
const c = await context(v2 ? { version: 2 } : {});
assert(['deployed_pending_acceptance', 'acceptance_in_progress', 'passed'].includes(c.report.status), 'Complete deployment first');
assert(process.argv.includes('--broadcast'), 'Pass --broadcast for bounded public-testnet acceptance');
const lockPath = resolve(c.storageDir, 'run.lock'), lock = openSync(lockPath, 'wx', 0o600);
const { client, read, call, a, accounts } = c;
const { factory, router, platformToken } = c.report.addresses;
const va = a.implementation.abi, fa = a.factory.abi, ra = a.router.abi;
const same = (left, right) => assert.equal(left.toLowerCase(), right.toLowerCase());
const reverted = error => Boolean(error.walk?.(e => e.name === 'ContractFunctionRevertedError' || e.name === 'ExecutionRevertedError'));
const deny = async (address, abi, fn, args, role = 'executor') => assert.rejects(() => client.simulateContract({ address, abi, functionName: fn, args, account: accounts[role].address }), reverted);
const now = async () => (await client.getBlock()).timestamp;
const balance = (address, blockNumber) => read(QUOTE, erc20Abi, 'balanceOf', [address], blockNumber);
try {
  if (c.report.status === 'passed') { console.log(JSON.stringify({ status: 'already_verified', report: c.report.addresses })); process.exitCode = 0; }
  else {
    c.report.status = 'acceptance_in_progress'; c.save();
    const projects = [];
    for (const label of (v2 ? ['TVLT3', 'TVLT4', 'TSPARK2'] : ['TVLT1', 'TVLT2'])) {
      const salt = keccak256(toHex(`SingleSpark/ARC-Testnet/${label}`));
      const vault = await read(factory, fa, 'predictVault', [accounts.deployer.address, salt]);
      const receipt = await call(`launch-${label}`, 'deployer', factory, fa, 'launch', [...await launchArgs(c, vault, label), v2 ? 7 : 3, '']);
      const event = parseEventLogs({ abi: fa, eventName: 'VaultLaunched', logs: receipt.logs }).find(e => e.address.toLowerCase() === factory.toLowerCase());
      same(event.args.vault, vault); same(event.args.initiator, accounts.deployer.address);
      const token = event.args.token;
      const record = await read(c.build.portal, a.portal.abi, 'launches', [token], receipt.blockNumber);
      same(record[0], vault);
      same(await read(record[5], a.splitterImpl.abi, 'creator', [], receipt.blockNumber), vault);
      assert.equal(await balance(vault, receipt.blockNumber), 0n, 'No prepaid vault gas or asset deposit');
      assert.equal(await client.getBalance({ address: vault, blockNumber: receipt.blockNumber }), 0n);
      projects.push({ label, token, vault, splitter: record[5], locker: record[3] });
    }
    const { token, vault } = projects[0];
    c.report.projects = projects; c.save();
    await call('trader-allowance', 'deployer', QUOTE, erc20Abi, 'approve', [router, 2_000_000n]);
    await call('organic-trade', 'deployer', router, ra, 'trade', async () => {
      const deadline = await now() + 110n;
      const quote = await client.simulateContract({ address: router, abi: ra, functionName: 'trade', args: [token, true, parseEther('0.5'), 1n, deadline], account: accounts.deployer.address });
      assert(quote.result > 0n);
      return [token, true, parseEther('0.5'), quote.result * 97n / 100n, deadline];
    });
    const collection = await call('organic-collect', 'executor', vault, va, 'collect', []);
    const organic = await read(vault, va, 'received', [], collection.blockNumber);
    assert(organic > 0n, 'Actual trade fees must reach the vault');
    assert.equal(await balance(vault, collection.blockNumber), organic);
    const allocation = [8300n, 700n, 500n, 400n].map(weight => organic * weight / 10000n);
    allocation.push(organic - allocation.reduce((x, y) => x + y, 0n));
    assert.deepEqual((await read(vault, va, 'ledger', [], collection.blockNumber))[0], allocation);
    c.report.organicFeeUSDC6 = String(organic); c.save();
    // Explicit test donation supplies all plugin buckets without claiming it is organic revenue.
    await call('labelled-test-donation', 'deployer', QUOTE, erc20Abi, 'transfer', [vault, 500_000n]);
    const sync = await call('sync-donation', 'executor', vault, va, 'sync', []);
    const income = await read(vault, va, 'received', [], sync.blockNumber);
    assert.equal(income, organic + 500_000n);
    assert.equal(await read(projects[1].vault, va, 'received', [], sync.blockNumber), 0n, 'Project isolation');
    const native = await client.getBalance({ address: vault, blockNumber: sync.blockNumber });
    assert.equal(native / 10n ** 12n, await balance(vault, sync.blockNumber), 'Native and ERC20 USDC mirror');
    for (const [bucket, label] of [[0, 'own-burn'], [1, 'platform-burn'], [2, 'reward-buy']]) {
      const receipt = await call(label, 'executor', vault, va, v2 && bucket === 1 ? 'buyPlatform' : 'buy', async () => {
        const amount = await read(vault, va, 'budgets', [BigInt(bucket)]);
        const target = bucket === 1 ? platformToken : token;
        const quote = await client.simulateContract({ address: router, abi: ra, functionName: 'trade', args: [target, true, amount * 10n ** 12n, 1n, await now() + 110n], account: accounts.deployer.address });
        return [v2 && bucket === 1 ? platformToken : bucket, amount, quote.result * 97n / 100n, await now() + 29n, await read(vault, va, 'nonce')];
      });
      const event = parseEventLogs({ abi: va, eventName: 'Executed', logs: receipt.logs }).find(e => e.address.toLowerCase() === vault.toLowerCase());
      assert(event.args.output > 0n);
      if (bucket < 2) {
        const target = bucket === 1 ? platformToken : token, dead = '0x000000000000000000000000000000000000dEaD';
        const after = await read(target, erc20Abi, 'balanceOf', [dead], receipt.blockNumber);
        const before = await read(target, erc20Abi, 'balanceOf', [dead], receipt.blockNumber - 1n);
        assert.equal(after - before, event.args.output, 'Bought tokens arrive at the fixed burn address');
      }
      assert.equal(await read(QUOTE, erc20Abi, 'allowance', [vault, router], receipt.blockNumber), 0n, 'Exact allowance cleared');
      assert.equal(await read(vault, va, 'budgets', [BigInt(bucket)], receipt.blockNumber), 0n);
    }
    const recipients = Array.from({ length: 100 }, (_, i) => getAddress(`0x${keccak256(toHex(`SingleSpark/test-recipient/${i}`)).slice(-40)}`)).sort((x, y) => BigInt(x) < BigInt(y) ? -1 : 1);
    if (!c.journal.steps['reward-payout']) assert(await read(vault, va, 'rewardTokens') >= 2000n * 10n ** 18n, 'Replay test must retain enough inventory for a second batch');
    const payout = await call('reward-payout', 'executor', vault, va, 'distribute', async () => [await read(vault, va, 'nonce'), recipients]);
    assert.equal(await read(vault, va, 'totalPaid', [], payout.blockNumber), 100n);
    for (const recipient of recipients) {
      assert.equal(await read(token, erc20Abi, 'balanceOf', [recipient], payout.blockNumber), 10n ** 19n);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await deny(vault, va, 'distribute', [await read(vault, va, 'nonce'), recipients]);
    await deny(vault, va, 'buy', [0, 1n, 1n, await now() + 29n, await read(vault, va, 'nonce')], 'deployer');
    await deny(vault, va, 'settle', [false, 1n]);
    const settlement = await call('fixed-operations-payment', 'deployer', vault, va, 'settle', async () => [true, await read(vault, va, 'budgets', [4n])]);
    const paid = parseEventLogs({ abi: va, eventName: 'Executed', logs: settlement.logs }).find(e => e.address.toLowerCase() === vault.toLowerCase()).args.amount;
    assert.equal(await balance(accounts.admin.address, settlement.blockNumber) - await balance(accounts.admin.address, settlement.blockNumber - 1n), paid);
    assert((await read(vault, va, 'ledger'))[0][3] > 0n, 'Community share remains reserved with governance disabled');
    await call('trader-allowance-clear', 'deployer', QUOTE, erc20Abi, 'approve', [router, 0n]);
    await call('pause-second-project', 'executor', factory, fa, 'pause', [projects[1].vault, v2 ? 7 : 3]);
    assert.equal((await read(projects[1].vault, va, 'policy'))[1], v2 ? 7 : 3);
    assert.equal((await read(vault, va, 'policy'))[1], 0);
    await c.send('admin-gas', 'deployer', async () => ({ to: accounts.admin.address, value: parseEther('0.2') }));
    const policy = [projects[1].vault, v2 ? 7 : 3, [8300, 700, 500, 400, 100]];
    const scheduled = await call('schedule-policy', 'admin', factory, fa, 'schedulePolicy', policy);
    const eta = await read(factory, fa, 'readyAt', [], scheduled.blockNumber);
    assert.equal(eta, (await client.getBlock({ blockNumber: scheduled.blockNumber })).timestamp + 172800n);
    if (!c.journal.steps['cancel-policy']) await deny(factory, fa, 'executePolicy', policy);
    await call('cancel-policy', 'admin', factory, fa, 'cancel', []);
    if (v2) {
      const next = projects.find(p => p.label === 'TSPARK2').token;
      const scheduled = await call('schedule-platform-target', 'admin', factory, fa, 'schedulePlatformToken', [next]);
      const readyAt = await read(factory, fa, 'readyAt', [], scheduled.blockNumber);
      await deny(factory, fa, 'executePlatformToken', [next]);
      c.report.newPlatformToken = next;
      c.report.platformTargetUpdate = { previous: platformToken, next, readyAt: String(readyAt), readyAtISO: new Date(Number(readyAt) * 1000).toISOString(), status: 'scheduled' };
    }
    c.report.status = 'passed';
    c.report.acceptance = { creatorAndSplitterRecipient: 'per-project contract vault', actualNativeUsdc: true, realUniswapV4Trades: true, organicFeesCollected: true,
      labelledDonationUSDC6: '500000', isolatedProjects: projects.length, independentPlugins: v2 ? 3 : 2, ownAndPlatformBurn: true, rewardBuy: true, payouts: 100, payoutTokensEach: '10',
      syntheticTestRecipients: true, duplicatePayoutRejected: true, unauthorizedExecutionRejected: true, allowanceCleared: true,
      fixedOperationsPayment: true, communityShareReserved: true, projectPauseIsolated: true, policyDelaySeconds: 172800, earlyPolicyExecutionRejected: true,
      policyQueueCancelled: true, real48HourExecutionCompleted: false, backendAutomaticKeeperValidated: false };
    c.save();
    console.log(JSON.stringify({ status: 'passed', publicTransactions: true, projects, acceptance: c.report.acceptance }));
  }
} finally { closeSync(lock); unlinkSync(lockPath); }
