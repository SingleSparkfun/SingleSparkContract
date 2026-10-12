import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashTypedData, keccak256, toHex } from 'viem';
import { claimTypedData } from './claim-authorization.mjs';

test('Argus authorization matches the Solidity/backend vector and binds the Vault and work', () => {
  const address = i => toHex(i, { size:20 });
  const request = { caller:address(1), bucket:5, target:address(2), amount:0n, minimum:0n, deadline:1000n,
    nonce:7n, revision:3n, implementation:address(3), reward:9n, recipientsHash:keccak256('0x') };
  const expected = '0xacf43ec01366e98811f266fbf8e892f4b335665de05e0c3707e24897f71a3fea';
  assert.equal(hashTypedData(claimTypedData(address(0x1009),request)),expected);
  assert.notEqual(hashTypedData(claimTypedData(address(8),request)),expected);
  assert.notEqual(hashTypedData(claimTypedData(address(0x1009),{...request,reward:10n})),expected);
});
