// Complete the already scheduled public-testnet target change after its real 48-hour delay.
import assert from 'node:assert/strict';
import { openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { keccak256 } from 'viem';
import { context } from './deploy.mjs';
import { json } from './build.mjs';
const c = await context({ version: 2 });
assert.equal(c.report.status, 'passed');
const change = c.report.platformTargetUpdate;
assert(change && change.next === c.report.newPlatformToken);
const { factory, implementation } = c.report.addresses;
for (const [name, address] of [['factory', factory], ['implementation', implementation]]) {
  assert.equal(keccak256(await c.client.getCode({ address })), c.report.codeHashes[name]);
}
assert.equal((await c.read(factory, c.a.factory.abi, 'implementation')).toLowerCase(), implementation.toLowerCase());
const target = await c.read(factory, c.a.factory.abi, 'platformToken');
const now = (await c.client.getBlock({ blockTag: 'finalized' })).timestamp;
if (target.toLowerCase() === change.next.toLowerCase()) {
  change.status = 'applied'; c.report.addresses.platformToken = target; c.save();
  console.log(json({ status: 'applied', platformToken: target }));
} else if (!process.argv.includes('--broadcast') || now < BigInt(change.readyAt)) {
  console.log(json({ ...change, status: now < BigInt(change.readyAt) ? 'waiting_for_timelock' : 'ready_to_apply' }));
} else {
  assert.equal(target.toLowerCase(), change.previous.toLowerCase());
  assert.equal(String(await c.read(factory, c.a.factory.abi, 'readyAt')), change.readyAt);
  const path = resolve(c.storageDir, 'run.lock'), lock = openSync(path, 'wx', 0o600);
  try {
    await c.call('apply-platform-target', 'deployer', factory, c.a.factory.abi, 'executePlatformToken', [change.next]);
    assert.equal((await c.read(factory, c.a.factory.abi, 'platformToken')).toLowerCase(), change.next.toLowerCase());
    change.status = 'applied'; c.report.addresses.platformToken = change.next; c.save();
    console.log(json({ status: 'applied', platformToken: change.next }));
  } finally { closeSync(lock); unlinkSync(path); }
}
