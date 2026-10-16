import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testnetNftSource } from './build-nft-testnet.mjs';
test('isolated testnet uses ten-minute administration and four-hour settlement',()=>{
  const source='uint256 public constant DELAY = 48 hours; uint256 public constant EPOCH_DURATION = 7 days;';
  assert.equal(testnetNftSource('chains/robinhood/platform/PlatformRandomNftFactory.sol',source),source.replace('48 hours','10 minutes'));
  assert.equal(testnetNftSource('chains/robinhood/platform/PlatformNftRevenueVault.sol',source),source.replace('48 hours','10 minutes').replace('7 days','4 hours'));
  assert.equal(testnetNftSource('chains/robinhood/platform/PlatformRandomNft.sol',source),source);
  assert.equal(testnetNftSource('chains/robinhood/platform/PlatformNftSalesVault.sol',source),source.replace('48 hours','10 minutes'));
  assert.throws(()=>testnetNftSource('chains/robinhood/platform/PlatformRandomNftFactory.sol','DELAY = 1 minutes'));
});
