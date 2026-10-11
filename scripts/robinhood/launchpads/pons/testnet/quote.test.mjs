import assert from 'node:assert/strict';
import { test } from 'node:test';
import { poolMinimum } from './quote.mjs';

test('native ETH input becomes token output at the V4 ratio, with integer slippage bounds',()=>{
  assert.equal(poolMinimum(100n,1n<<96n),90n);
  assert.equal(poolMinimum(100n,2n<<96n),360n);
  assert.equal(poolMinimum(100n,1n<<95n),22n);
  assert(poolMinimum(100_000_000_000n,1n<<120n)>100_000_000_000n);
  for(const sqrt of [0n,1n,1n<<160n])assert.throws(()=>poolMinimum(100n,sqrt));
});
