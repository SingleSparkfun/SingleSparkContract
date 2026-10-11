import assert from 'node:assert/strict';

export function poolMinimum(amountWei, sqrtPriceX96) {
  assert(amountWei>0n && sqrtPriceX96>0n && sqrtPriceX96<(1n<<160n));
  const output=amountWei*sqrtPriceX96*sqrtPriceX96/(1n<<192n)*90n/100n;
  assert(output>0n,'Empty V4 quote');return output;
}
