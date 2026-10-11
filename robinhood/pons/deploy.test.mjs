import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, getCreate2Address } from 'viem';
import { hookAddress, maskImmutables, executableCode, preflight } from './deploy.mjs';
import { requireTestnet } from './transactions.mjs';
import { validateBundle, hash, sorted } from './build.mjs';

test('deployment refuses mainnet, another testnet and mislabeled configuration', () => {
  requireTestnet({ chainId: 46630, environment: 'testnet' }, 46630);
  for (const id of [4663, 5042002, 1, 31337]) assert.throws(() => requireTestnet({ chainId: 46630, environment: 'testnet' }, id));
  assert.throws(() => requireTestnet({ chainId: 4663, environment: 'testnet' }, 46630));
  assert.throws(() => requireTestnet({ chainId: 46630, environment: 'mainnet' }, 46630));
});

test('source review pins reject altered compiler, source and deployment bytecode', () => {
  const bundle = { chainId: '4663', address: '0xabc', runtimeMatch: 'exact_match', sources: { A: { content: 'original' } }, compilation: { compilerVersion: '0.8.35' }, creationBytecode: { recompiledBytecode: '0x6000' } };
  const pin = { address: bundle.address, sourcesSha256: hash(sorted(bundle.sources)), compilationSha256: hash(bundle.compilation), creationSha256: hash('0x6000') };
  validateBundle(bundle, pin);
  for (const change of [{ chainId: '46630' }, { runtimeMatch: null }, { sources: { A: { content: 'changed' } } }, { compilation: {} }, { creationBytecode: { recompiledBytecode: '0x6001' } }]) assert.throws(() => validateBundle({ ...bundle, ...change }, pin));
});

test('hook salt resolves to required permissions and includes constructor arguments', () => {
  const proxy = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
  const result = hookAddress(proxy, '0x60006000');
  assert.equal(BigInt(result.address) & 0x3fffn, 0x2044n);
  assert.equal(result.address, getCreate2Address({ from: proxy, salt: result.salt, bytecodeHash: keccak256('0x60006000') }));
  assert.notEqual(result.address, getCreate2Address({ from: proxy, salt: result.salt, bytecodeHash: keccak256('0x60006001') }));
});

test('runtime comparison masks constructor immutables only', () => {
  assert.equal(maskImmutables('0x11223344', { 1: [{ start: 1, length: 2 }] }), '11000044');
  assert.notEqual(maskImmutables('0x11223344', {}), maskImmutables('0x11223345', {}));
});

test('reuse comparison strips only a recognized metadata footer and preserves executable differences', () => {
  const footer = `a2646970667358221220${'ab'.repeat(32)}64736f6c63430008230033`;
  assert.equal(executableCode(`0x6000${footer}`, {}), '6000');
  assert.notEqual(executableCode(`0x6001${footer}`, {}), executableCode(`0x6000${footer}`, {}));
  assert.throws(() => executableCode('0x60000033', {}));
});

test('preflight rejects missing, substituted and mismatched dependencies before signing', async () => {
  const address = '0x1111111111111111111111111111111111111111';
  const config = { dependencies: { poolManager: { address, codeHash: keccak256('0x6000') }, positionManager: { address, codeHash: keccak256('0x6000') } } };
  await preflight({ config, client: { getCode: async () => '0x6000' }, read: async () => address });
  for (const code of ['0x', '0x6001']) await assert.rejects(preflight({ config, client: { getCode: async () => code } }));
  await assert.rejects(preflight({ config, client: { getCode: async () => '0x6000' }, read: async () => '0x2222222222222222222222222222222222222222' }));
});
