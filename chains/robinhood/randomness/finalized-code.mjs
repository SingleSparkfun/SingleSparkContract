import {setTimeout} from 'node:timers/promises';

// The public testnet RPC sometimes routes a historical read to a pruned backend.
export async function readFinalizedCode(provider, address, blockNumber) {
  for (let attempt = 0; ; attempt++) {
    try { return await provider.getCode(address, blockNumber); }
    catch (error) {
      if (attempt >= 4 || !/historical state .* is not available/i.test(error.error?.message ?? '')) throw error;
      await setTimeout(500);
    }
  }
}
