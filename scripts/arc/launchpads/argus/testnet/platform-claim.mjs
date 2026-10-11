// Public testnet rollout: preserve the old controller and its pending operation.
import assert from 'node:assert/strict';
import { openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { keccak256, toHex, parseEventLogs, erc20Abi } from 'viem';
import { context, launchArgs, QUOTE } from './deploy.mjs';

const c = await context({ version: 3 });
assert.equal(c.report.status, 'passed', 'Finish contract acceptance before application rollout');
assert(process.argv.includes('--broadcast'));
const lockPath = resolve(c.storageDir, 'run.lock'), lock = openSync(lockPath, 'wx', 0o600);
try {
  const factory = c.report.addresses.factory, abi = c.a.factory.abi;
  const label = 'TSPARK3', salt = keccak256(toHex(`SingleSpark/ARC-Testnet/${label}`));
  const vault = await c.read(factory, abi, 'predictVault', [c.accounts.deployer.address, salt]);
  const receipt = await c.call('launch-TSPARK3', 'deployer', factory, abi, 'launch', [
    ...await launchArgs(c, vault, label), 7, '',
  ]);
  const event = parseEventLogs({ abi, eventName: 'VaultLaunched', logs: receipt.logs })
    .find(e => e.address.toLowerCase() === factory.toLowerCase());
  assert.equal(event.args.vault.toLowerCase(), vault.toLowerCase());
  const token = event.args.token;
  assert.equal((await c.read(factory, abi, 'vaultOf', [token])).toLowerCase(), vault.toLowerCase());
  c.report.platformProject = { label, name: 'SingleSpark Test TSPARK3', token, vault, plugins: 7 };
  c.save();
  await c.call('schedule-platform-TSPARK3', 'admin', factory, abi, 'schedulePlatformToken', [token]);
  if (!c.journal.steps['execute-platform-TSPARK3']) {
    const ready = await c.read(factory, abi, 'readyAt'), now = (await c.client.getBlock()).timestamp;
    c.report.platformTargetSwitch = { ...c.report.platformTargetSwitch, target: token, readyAt: String(ready), status: 'pending' }; c.save();
    if (now < ready) {
      console.log(JSON.stringify({ status: 'timelock_pending', readyAt: String(ready), token, vault }));
      process.exitCode = 0;
    } else {
      await c.call('execute-platform-TSPARK3', 'admin', factory, abi, 'executePlatformToken', [token]);
    }
  }
  if (c.journal.steps['execute-platform-TSPARK3']) {
    assert.equal((await c.read(factory, abi, 'platformToken')).toLowerCase(), token.toLowerCase());
    const block = BigInt(c.report.transactions['execute-platform-TSPARK3'].block);
    for (const project of [...c.report.projects, c.report.platformProject]) {
      assert.equal((await c.read(factory, abi, 'vaultOf', [project.token], block)).toLowerCase(), project.vault.toLowerCase());
      assert.deepEqual(await c.read(project.vault,c.a.implementation.abi,'ledger',[],block),
        await c.read(project.vault,c.a.implementation.abi,'ledger',[],block-1n));
      assert.equal(await c.read(QUOTE,erc20Abi,'balanceOf',[project.vault],block),
        await c.read(QUOTE,erc20Abi,'balanceOf',[project.vault],block-1n));
    }
    c.report.addresses.platformToken = token;
    c.report.platformTargetSwitch.status = 'executed';
    c.report.platformTargetSwitch.vaultsBalancesAndBudgetsPreserved = true; c.save();
    console.log(JSON.stringify({ status: 'platform_target_verified', token, vault }));
  }
} finally { closeSync(lock); unlinkSync(lockPath); }
