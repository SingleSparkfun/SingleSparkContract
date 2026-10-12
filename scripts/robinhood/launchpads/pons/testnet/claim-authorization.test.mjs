import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashTypedData, keccak256, toHex } from 'viem';
import { claimTypedData } from './claim-authorization.mjs';

test('Pons authorization matches the Solidity/backend vector and binds the Vault and work', () => {
  const address = i => toHex(i, { size:20 });
  const request = { caller:address(1), pluginId:keccak256(toHex('distribution@1')), amount:0n, minimumOutput:0n, reward:9n,
    deadline:1000n, nonce:7n, policyRevision:3n, registryRevision:4n, dataHash:keccak256('0x') };
  const expected = '0x16fd5fa328621425921e3e8945702cb910200f5786aaa364f440baf8f967eb6b';
  assert.equal(hashTypedData(claimTypedData(address(0x1009),request)),expected);
  assert.notEqual(hashTypedData(claimTypedData(address(8),request)),expected);
  assert.notEqual(hashTypedData(claimTypedData(address(0x1009),{...request,nonce:8n})),expected);
});
