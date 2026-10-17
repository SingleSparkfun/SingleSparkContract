import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFinalizedCode} from '../../../../chains/robinhood/randomness/finalized-code.mjs';

const pruned = () => Object.assign(new Error('could not coalesce error'), {error:{message:'historical state abc is not available'}});
test('retries the same finalized block without falling back to latest', async () => {
  const calls=[];
  const provider={async getCode(address,block){calls.push([address,block]);if(calls.length<3)throw pruned();return '0x1234';}};
  assert.equal(await readFinalizedCode(provider,'reviewed-address',123),'0x1234');
  assert.deepEqual(calls,Array(3).fill(['reviewed-address',123]));
});
test('fails closed after bounded historical failures and on unrelated errors', async () => {
  let calls=0;
  await assert.rejects(readFinalizedCode({getCode:async()=>{calls++;throw pruned();}},'address',123));
  assert.equal(calls,5);
  calls=0;const error=new Error('network or authorization failure');
  await assert.rejects(readFinalizedCode({getCode:async()=>{calls++;throw error;}},'address',123),error);
  assert.equal(calls,1);
});
