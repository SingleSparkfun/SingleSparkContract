import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deploymentId } from './build.mjs';

test('redeployment IDs preserve historical journal paths and reject path traversal', () => {
  const original = process.argv;
  try {
    process.argv = ['node', 'test']; assert.equal(deploymentId(), '');
    process.argv.push('--deployment-id', 'security-20261011'); assert.equal(deploymentId(), 'security-20261011');
    for (const id of [undefined, '..', '../claim', '/tmp/claim', 'security/20261011', '--broadcast']) {
      process.argv = ['node', 'test', '--deployment-id', id]; assert.throws(deploymentId, /Invalid testnet deployment ID/);
    }
  } finally { process.argv = original; }
});
