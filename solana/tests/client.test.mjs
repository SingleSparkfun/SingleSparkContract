import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, TransactionInstruction, AddressLookupTableAccount, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import * as sdk from '../client.mjs';

const [program, payer, authority, hook, mint, team] = Array.from({length:6},()=>Keypair.generate().publicKey);
const config = sdk.configAddress(program,authority);

test('financial choices must be explicit; numbers retain all lamports',()=>{
  const v={program,payer,authority,platformMint:mint,minimum:1n,maximum:1_000_000_000n};
  assert.throws(()=>sdk.initializeConfig(v));
  assert.equal(sdk.initializeConfig({...v,bountySource:0}).data[1],0);
  assert.equal(sdk.initializeConfig({...v,bountySource:1}).data[1],1);
  assert.equal(sdk.u64('18446744073709551615').readBigUInt64LE(),(1n<<64n)-1n);
  for(const value of ['01','-1','1.1',1,'18446744073709551616'])assert.throws(()=>sdk.u64(value));
  assert.throws(()=>sdk.initializeGovernance({program,authority,config,mint,team,tokenProgram:TOKEN_PROGRAM_ID,quorum:1n,weightCapSeconds:86400}));
});

test('config, Hook, round, voter and recipient identities are isolated in PDA seeds',()=>{
  assert(!sdk.projectAddress(program,hook).equals(sdk.projectAddress(program,payer)));
  const dao=sdk.governanceAddress(program,config);
  assert(!sdk.roundAddress(program,dao,0n).equals(sdk.roundAddress(program,dao,1n)));
  const round=sdk.roundAddress(program,dao,0n);
  assert(!sdk.voteAddress(program,round,payer).equals(sdk.voteAddress(program,round,authority)));
  assert(!sdk.paidAddress(program,round,payer).equals(sdk.paidAddress(program,round,authority)));
  assert.throws(()=>sdk.distribute({program,payer,config,hook,mint,tokenProgram:TOKEN_PROGRAM_ID,nonce:0n,minReward:0n,deadline:1n,recipients:[team,team]}));
});

test('v0 transactions retain the user fee payer and Hook signer with a lookup table',()=>{
  const addresses=Array.from({length:38},()=>Keypair.generate().publicKey);
  const instruction=new TransactionInstruction({programId:program,keys:[{pubkey:hook,isSigner:true,isWritable:true},
    ...addresses.map(pubkey=>({pubkey,isSigner:false,isWritable:false}))],data:Buffer.alloc(100)});
  const input={payer,blockhash:Keypair.generate().publicKey.toBase58(),instructions:[instruction]};
  assert.throws(()=>sdk.buildTransaction(input));
  const table=new AddressLookupTableAccount({key:Keypair.generate().publicKey,state:{deactivationSlot:(1n<<64n)-1n,
    lastExtendedSlot:1,lastExtendedSlotStartIndex:0,authority:undefined,addresses}});
  const tx=sdk.buildTransaction({...input,lookupTables:[table]});
  assert.equal(tx.message.header.numRequiredSignatures,2);
  assert(tx.message.staticAccountKeys[0].equals(payer));
  assert(tx.message.staticAccountKeys[1].equals(hook));
  assert(tx.serialize().length<=1232);
});

test('account decoding rejects wrong owners, trailing bytes and unrecognized versions',()=>{
  const data=Buffer.concat([Buffer.from([1]),authority.toBuffer(),mint.toBuffer(),Buffer.from([0]),sdk.u64(1n),sdk.u64(100n)]);
  assert.equal(sdk.decodeState({owner:program,data},program).maximum,100n);
  assert.throws(()=>sdk.decodeState({owner:SystemProgram.programId,data},program));
  assert.throws(()=>sdk.decodeState({owner:program,data:Buffer.concat([data,Buffer.alloc(1)])},program));
  assert.throws(()=>sdk.decodeState({owner:program,data:Buffer.from([255])},program));
  assert.throws(()=>sdk.decodeState({owner:program,data:Buffer.from([1])},program));
});
