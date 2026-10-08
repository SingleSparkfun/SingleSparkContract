// node --test backend/chains
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hasChainProfile, loadChainProfile, loadProfileFile, parseAmount, parseProfile, profileSummary } from './profile.mjs';

const ethLikePath = fileURLToPath(new URL('../test/profiles/eth-like.json', import.meta.url));
const arcJson = () => JSON.parse(readFileSync(new URL('./5042.json', import.meta.url), 'utf8'));

test('amounts parse exactly, in integer or scientific form', () => {
  assert.equal(parseAmount('10000000000000000000000'), 10_000n * 10n ** 18n);
  assert.equal(parseAmount('2e18'), 2n * 10n ** 18n);
  assert.equal(parseAmount('0.25e18'), 25n * 10n ** 16n);
  assert.equal(parseAmount('0.0000925e18'), 92_500_000_000_000n);
  for (const bad of ['1.5', '1e-3', '0.1e0', '01', '-1', ' 1', '1e', '1E18', '2e400']) assert.throws(() => parseAmount(bad), bad);
  assert.throws(() => parseAmount(2e18), /string/);
});

test('both Arc profiles carry exactly the constants the contracts used to hard-code', () => {
  for (const chainId of [5042, 5042002]) {
    const profile = loadChainProfile(chainId);
    assert.equal(profile.chainId, chainId);
    assert.equal(profile.testnet, chainId === 5042002);
    assert.deepEqual(profile.nativeCurrency, { name: 'USDC', symbol: 'USDC', decimals: 18 });
    assert.equal(profile.economics.halfSupplyCost, 10_000n * 10n ** 18n);
    assert.equal(profile.economics.minLaunchTick, -160_100);
    assert.equal(profile.economics.minBuyback, 5n * 10n ** 18n);
    assert.deepEqual(profile.economics.keeperGas, { trigger: 2n * 10n ** 18n, buffer: 10n ** 18n,
      maxTopup: 25n * 10n ** 16n, minTopup: 10n ** 16n, dailyLimit: 2n * 10n ** 18n });
  }
  assert.equal(loadChainProfile(5042).uniswapV4.positionManager, '0x6049c9a0e26405C0985f9E3685C87d0aE917f82B');
  assert.equal(loadChainProfile(5042002).uniswapV4.positionManager, '0x0f42e91f2cd13E6f03CC7650e72ceBed6031A125');
});

test('a chain without a committed profile is refused', () => {
  assert.equal(hasChainProfile(8453), false);
  assert.throws(() => loadChainProfile(8453), /No committed chain profile for chain 8453/);
  assert.throws(() => loadChainProfile('abc'), /Invalid chain id/);
});

test('the synthetic ETH-like test profile parses and is not committed as a chain', () => {
  const profile = loadProfileFile(ethLikePath);
  assert.equal(profile.chainId, 31337);
  assert.equal(profile.economics.halfSupplyCost, 37n * 10n ** 17n);
  assert.equal(profile.economics.minLaunchTick, -81_075);
  assert.equal(profile.uniswapV4.positionManager, null);
  assert.equal(hasChainProfile(31337), false);
  assert.equal(profileSummary(profile).keeperGas.maxTopup, '92500000000000');
});

test('validation is strict', () => {
  const mutate = (change) => { const json = arcJson(); change(json); return () => parseProfile(json, 'test'); };
  assert.throws(mutate(j => { j.extra = 1; }), /unknown key profile.extra/);
  assert.throws(mutate(j => { delete j.economics.keeperGas.buffer; }), /missing economics.keeperGas.buffer/);
  assert.throws(mutate(j => { j.nativeCurrency.decimals = 6; }), /decimals must be 18/);
  assert.throws(mutate(j => { j.uniswapV4.poolManager = '0x1234'; }), /poolManager/);
  assert.throws(mutate(j => { j.economics.minLaunchTick = -160_110; }), /minLaunchTick/);
  assert.throws(mutate(j => { j.economics.minLaunchTick = '-160100'; }), /minLaunchTick/);
  assert.throws(mutate(j => { j.economics.halfSupplyCost = 1e22; }), /string/);
  assert.throws(mutate(j => { j.economics.halfSupplyCost = '0'; }), /halfSupplyCost must be positive/);
  assert.throws(mutate(j => { j.economics.keeperGas.minTopup = '0'; }), /minTopup must be positive/);
  assert.throws(mutate(j => { j.economics.keeperGas.minTopup = '0.3e18'; }), /minTopup must not exceed maxTopup/);
  assert.throws(mutate(j => { j.economics.keeperGas.trigger = '0.2e18'; }), /maxTopup must not exceed trigger/);
  assert.throws(mutate(j => { j.economics.keeperGas.dailyLimit = '0.2e18'; }), /maxTopup must not exceed dailyLimit/);
  assert.throws(mutate(j => { j.economics.keeperGas.buffer = '0.2e18'; }), /buffer must cover/);
  assert.throws(mutate(j => { j.testnet = 'no'; }), /testnet/);
});
