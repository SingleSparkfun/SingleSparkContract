// Runs compiled SBF programs on an isolated local validator. Pump is an explicit test fixture;
// SPL Token, Token-2022, ATA, System, signatures, CPI privileges and rollback use the real runtime.
// ponytail: Pump liquidity is a fixture; verify official Pump/PumpSwap programs before deployment.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, MintLayout, AccountLayout,
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, createSyncNativeInstruction, getMint, getAccount } from '@solana/spl-token';
import * as sdk from '../client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.env.SOLANA_TEST_VALIDATOR ?? 'solana-test-validator';
const temporary = await mkdtemp(join(tmpdir(), 'ss-sol-'));
const program = Keypair.generate().publicKey;
const [payer, authority, hook, reserve, team, voter] = Array.from({ length: 6 }, () => Keypair.generate());
const recipients = Array.from({ length: 4 }, () => Keypair.generate().publicKey);
const mint = Keypair.generate().publicKey, platform = Keypair.generate().publicKey;
const config = sdk.configAddress(program, authority.publicKey), project = sdk.projectAddress(program, hook.publicKey);
const supply = 1_000_000_000_000_000n;
const fixtures = new Map();
const put = (pubkey, owner, data, lamports = 10_000_000) => fixtures.set(pubkey.toBase58(), { pubkey: pubkey.toBase58(), account: {
  lamports, data: [Buffer.from(data).toString('base64'), 'base64'], owner: owner.toBase58(), executable: false, rentEpoch: 0 } });
for (const who of [payer, authority, hook, reserve, team, voter]) put(who.publicKey, SystemProgram.programId, [], 100_000_000_000);
for (const who of recipients) put(who, SystemProgram.programId, [], 1_000_000);
function mintAccount(mint, tokenProgram) {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply, decimals: 6, isInitialized: true,
    freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  put(mint, tokenProgram, data);
}
function tokenAccount(mint, owner, amount, tokenProgram) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1,
    isNativeOption: mint.equals(NATIVE_MINT)?1:0, isNative: mint.equals(NATIVE_MINT)?2_039_280n:0n,
    delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  put(sdk.tokenAddress(mint, owner, tokenProgram), tokenProgram, data, 2_039_280+(mint.equals(NATIVE_MINT)?Number(amount):0));
}
const ammPool = mint => sdk.derive(sdk.AMM,Buffer.from('pool'),Buffer.alloc(2),
  sdk.derive(sdk.PUMP,Buffer.from('pool-authority'),mint.toBuffer()).toBuffer(),mint.toBuffer(),NATIVE_MINT.toBuffer());
for (const [m, tp] of [[mint, TOKEN_PROGRAM_ID], [platform, TOKEN_2022_PROGRAM_ID]]) {
  mintAccount(m, tp);
  const curve = sdk.curveAddress(m), data = Buffer.alloc(125);
  Buffer.from([23,183,248,55,96,216,172,96]).copy(data);
  data.writeBigUInt64LE(supply, 8); data.writeBigUInt64LE(100_000_000_000n, 16);
  data.writeBigUInt64LE(supply, 40); hook.publicKey.toBuffer().copy(data, 49);
  put(curve, sdk.PUMP, data);
  tokenAccount(m, curve, m.equals(platform) ? supply / 4n : supply / 2n, tp);
  const pool=ammPool(m);put(pool,sdk.AMM,[]);
  tokenAccount(m,pool,m.equals(platform)?supply/4n:supply/2n,tp);
  tokenAccount(NATIVE_MINT,pool,1_000_000_000n,TOKEN_PROGRAM_ID);
  tokenAccount(m, hook.publicKey, 0n, tp);
}
tokenAccount(platform, authority.publicKey, supply / 2n, TOKEN_2022_PROGRAM_ID);
const feeVault = sdk.derive(sdk.PUMP, Buffer.from('creator-vault'), hook.publicKey.toBuffer());
put(feeVault, sdk.PUMP, [], 101_000_000);
const ammVault=sdk.derive(sdk.AMM,Buffer.from('creator_vault'),hook.publicKey.toBuffer());
put(ammVault,sdk.AMM,[]);
tokenAccount(NATIVE_MINT,ammVault,20_000_000n,TOKEN_PROGRAM_ID);

let validator, log = '', conn, sequence = 0, assertions = 0;
const check = (value, expected) => { assert.deepEqual(value, expected); assertions++; };
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function stop() {
  if (!validator || validator.exitCode != null) return;
  const exited = once(validator, 'exit'); validator.kill('SIGTERM');
  const timer = setTimeout(() => validator.kill('SIGKILL'), 6000);
  await exited; clearTimeout(timer);
}
async function start(accounts, label) {
  await stop(); log = '';
  const port = await freePort(), folder = join(temporary, label); await mkdir(folder);
  let faucet = await freePort(); while (faucet === port || faucet === port + 1) faucet = await freePort();
  const args = ['--ledger', join(folder, 'ledger'), '--reset', '--quiet', '--rpc-port', String(port), '--faucet-port', String(faucet),
    '--bind-address', '127.0.0.1', '--bpf-program', program.toBase58(), join(root, 'target/deploy/singlespark_solana.so'),
    '--bpf-program', sdk.PUMP.toBase58(), join(root, 'target/deploy/singlespark_pump_fixture.so'),
    '--bpf-program', sdk.AMM.toBase58(), join(root, 'target/deploy/singlespark_pump_fixture.so')];
  for (const item of accounts.values()) {
    const file = join(folder, `${item.pubkey}.json`); await writeFile(file, JSON.stringify(item)); args.push('--account', item.pubkey, file);
  }
  validator = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  validator.on('error', error => { log += error.message; });
  validator.stdout.on('data', data => { log += data; }); validator.stderr.on('data', data => { log += data; });
  conn = new Connection(`http://127.0.0.1:${port}`, { commitment: 'confirmed', disableRetryOnRateLimit: true });
  for (let i = 0; i < 150; i++) {
    if (validator.exitCode != null) throw Error(`Validator exited: ${log}`);
    try { if (await conn.getSlot() >= 2 && (await conn.getAccountInfo(program))?.executable) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Error(`Validator startup timeout: ${log}`);
}
async function send(instructions, signers = [payer]) {
  const latest = await conn.getLatestBlockhash();
  const tx = new Transaction({ feePayer: signers[0].publicKey, ...latest }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: ++sequence }), ...instructions.flat());
  tx.sign(...signers);
  const signature = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed', maxRetries: 0 });
  for (let i=0;i<150;i++) {
    const status=(await conn.getSignatureStatuses([signature])).value[0];
    if(status?.confirmationStatus==='confirmed'||status?.confirmationStatus==='finalized') { assert.equal(status.err,null);return signature; }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('Local transaction confirmation timed out');
}
async function fails(instructions, signers = [payer, hook]) {
  await assert.rejects(() => send(instructions, signers)); assertions++;
}
const state = async key => sdk.decodeState(await conn.getAccountInfo(key), program);
const balance = async (m, owner, tp) => (await getAccount(conn, sdk.tokenAddress(m, owner, tp), 'confirmed', tp)).amount;
const v = { program, payer: payer.publicKey, config, hook: hook.publicKey, mint };
function buyIx(target, tokenProgram, output, cost) {
  const keys = Array.from({ length: 27 }, () => ({ pubkey: SystemProgram.programId, isSigner: false, isWritable: false }));
  for (const [i, pubkey, writable, signer] of [[1,target,false,false],[2,NATIVE_MINT,false,false],[3,tokenProgram,false,false],
    [4,TOKEN_PROGRAM_ID,false,false],[10,sdk.curveAddress(target),true,false],
    [11,sdk.tokenAddress(target,sdk.curveAddress(target),tokenProgram),true,false],
    [13,hook.publicKey,true,true],[14,sdk.tokenAddress(target,hook.publicKey,tokenProgram),true,false],
    [15,sdk.tokenAddress(NATIVE_MINT,hook.publicKey),true,false],[26,sdk.PUMP,false,false]]) keys[i] = { pubkey, isWritable:writable, isSigner:signer };
  return new TransactionInstruction({ programId:sdk.PUMP,keys,data:Buffer.concat([Buffer.from([184,23,238,97,103,197,211,61]),sdk.u64(output),sdk.u64(cost)]) });
}
async function buy(kind, debit, tokens, overrides = {}) {
  const p = await state(project), targetMint = kind === 1 ? platform : mint, tokenProgram = kind === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  return sdk.buyAndExecute({ ...v, kind, targetMint, tokenProgram, nonce:p.nonce, maxDebit:debit, minTokens:tokens, minReward:0n,
    sponsorRent:0n, deadline:BigInt(Math.floor(Date.now()/1000)+55), instructions:[buyIx(targetMint,tokenProgram,tokens,debit)], ...overrides });
}
async function snapshot() {
  const result = new Map();
  for (const owner of [program,sdk.PUMP,sdk.AMM,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID]) {
    for (const {pubkey,account} of await conn.getProgramAccounts(owner)) result.set(pubkey.toBase58(), {pubkey:pubkey.toBase58(), account:{ ...account,
      owner:account.owner.toBase58(), rentEpoch:0, data:[account.data.toString('base64'),'base64'] }});
  }
  for (const who of [payer,authority,hook,reserve,team,voter]) {
    const account = await conn.getAccountInfo(who.publicKey);
    result.set(who.publicKey.toBase58(), {pubkey:who.publicKey.toBase58(),account:{...account,owner:account.owner.toBase58(),rentEpoch:0,data:[account.data.toString('base64'),'base64']}});
  }
  return result;
}
function expire(accounts, round) {
  // Only the test genesis fixture changes time; the deployed program has no clock/admin bypass.
  const item = accounts.get(round.toBase58()), data = Buffer.from(item.account.data[0],'base64');
  data.writeBigInt64LE(BigInt(Math.floor(Date.now()/1000)-10),41); item.account.data[0]=data.toString('base64');
}

try {
  await start(fixtures, 'execution');
  await send([sdk.initializeConfig({program,payer:payer.publicKey,authority:authority.publicKey,platformMint:platform,bountySource:0,minimum:1n,maximum:1_000_000_000n})],[payer,authority]);
  const registration = sdk.initializeProject({...v,authority:authority.publicKey,reserveRecipient:reserve.publicKey,buyback:true,distribution:true});
  await send([registration],[payer,authority,hook]);
  await fails([registration],[payer,authority,hook]);
  const wrapped = sdk.tokenAddress(NATIVE_MINT,hook.publicKey);
  const keys = [hook.publicKey,wrapped,feeVault,wrapped,NATIVE_MINT,TOKEN_PROGRAM_ID,SystemProgram.programId,SystemProgram.programId,SystemProgram.programId,sdk.PUMP]
    .map((pubkey,i)=>({pubkey,isSigner:false,isWritable:[0,1,2,3].includes(i)}));
  const collect = new TransactionInstruction({programId:sdk.PUMP,keys,data:Buffer.from([207,17,138,242,4,34,19,56])});
  await send(sdk.collectRevenue({...v,nonce:0n,instructions:[collect]}),[payer,hook]);
  check((await state(project)).balances,[83_000_000n,7_000_000n,5_000_000n,4_000_000n,0n]);
  check((await state(project)).bounty,1_000_000n);
  const first = await buy(0,41_500_000n,100_000_000n);
  await send(first,[payer,hook]); check((await state(project)).burned,100_000_000n);
  await fails(first); // Same nonce, different transaction signature.
  const stable = await state(project), hookBalance = await conn.getBalance(hook.publicKey), oldSupply = (await getMint(conn,mint)).supply;
  await fails(await buy(0,41_500_001n,1n));
  await fails(await buy(0,1_000_000n,1_000_000n,{minTokens:1_000_001n}));
  await fails(await buy(0,1_000_000n,1_000_000n,{minReward:1_000_000_000n}));
  await fails(await buy(0,1_000_000n,1_000_000n,{deadline:1n}));
  const unsignedHook = await buy(0,1_000_000n,1_000_000n);
  for(const instruction of unsignedHook) for(const m of instruction.keys) if(m.pubkey.equals(hook.publicKey))m.isSigner=false;
  await fails(unsignedHook,[payer]);
  check(await state(project),stable); check(await conn.getBalance(hook.publicKey),hookBalance); check((await getMint(conn,mint)).supply,oldSupply);
  await send(await buy(1,7_000_000n,20_000_000n),[payer,hook]); check((await state(project)).platformBurned,20_000_000n);
  await send(await buy(2,5_000_000n,40_000_000n),[payer,hook]); check((await state(project)).rewardTokens,40_000_000n);
  const payout = async list => sdk.distribute({...v,tokenProgram:TOKEN_PROGRAM_ID,nonce:(await state(project)).nonce,
    minReward:0n,deadline:BigInt(Math.floor(Date.now()/1000)+55),recipients:list});
  await send(await payout(recipients.slice(0,2)),[payer,hook]);
  check(await balance(mint,recipients[0],TOKEN_PROGRAM_ID),10_000_000n);
  const beforeDuplicate = await state(project);
  await fails(await payout([recipients[0]])); check(await state(project),beforeDuplicate);
  await send(await payout(recipients.slice(2)),[payer,hook]);
  await send(await buy(0,41_500_000n,100_000_000n),[payer,hook]);
  check((await state(project)).bountyPaid,1_000_000n); check((await state(project)).bounty,0n);
  check((await state(project)).rewardTokens,0n); check((await state(project)).recipientsPaid,4n);
  await fails(sdk.collectRevenue({...v,nonce:(await state(project)).nonce,instructions:[collect]}));
  await send([SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:hook.publicKey,lamports:2_000_000})]);
  await fails(sdk.collectRevenue({...v,nonce:(await state(project)).nonce,instructions:[collect]}));
  check((await state(project)).received,100_000_000n);
  await fails([sdk.withdrawReserve({...v,nonce:(await state(project)).nonce,bucket:3,amount:4_000_000n,recipient:payer.publicKey})]);
  await send([sdk.withdrawReserve({...v,nonce:(await state(project)).nonce,bucket:3,amount:4_000_000n,recipient:reserve.publicKey})],[payer,hook,reserve]);
  check((await state(project)).balances,[0n,0n,0n,0n,0n]);
  const ammCollect=new TransactionInstruction({programId:sdk.AMM,data:Buffer.from([160,57,89,42,181,139,43,66]),
    keys:[NATIVE_MINT,TOKEN_PROGRAM_ID,hook.publicKey,ammVault,sdk.tokenAddress(NATIVE_MINT,ammVault),wrapped,SystemProgram.programId,sdk.AMM]
      .map((pubkey,i)=>({pubkey,isSigner:false,isWritable:[4,5].includes(i)}))});
  await send(sdk.collectRevenue({...v,nonce:(await state(project)).nonce,instructions:[ammCollect]}),[payer,hook]);
  check((await state(project)).received,120_000_000n);
  for(const [kind,target,tp,cost] of [[0,mint,TOKEN_PROGRAM_ID,16_600_000n],[1,platform,TOKEN_2022_PROGRAM_ID,1_400_000n]]) {
    const pool=ammPool(target), keys=Array.from({length:23},()=>({pubkey:SystemProgram.programId,isSigner:false,isWritable:false}));
    for(const [i,pubkey,writable,signer] of [[0,pool,true,false],[1,hook.publicKey,true,true],[3,target,false,false],[4,NATIVE_MINT,false,false],
      [5,sdk.tokenAddress(target,hook.publicKey,tp),true,false],[6,wrapped,true,false],[7,sdk.tokenAddress(target,pool,tp),true,false],
      [8,sdk.tokenAddress(NATIVE_MINT,pool),true,false],[11,tp,false,false],[12,TOKEN_PROGRAM_ID,false,false],[16,sdk.AMM,false,false]])keys[i]={pubkey,isWritable:writable,isSigner:signer};
    const instruction=new TransactionInstruction({programId:sdk.AMM,keys,data:Buffer.concat([Buffer.from([102,6,61,18,1,218,235,234]),sdk.u64(10_000_000n),sdk.u64(cost),Buffer.from([0])])});
    const before=await state(project);
    await send(sdk.buyAndExecute({...v,kind,targetMint:target,tokenProgram:tp,nonce:before.nonce,maxDebit:cost,minTokens:10_000_000n,minReward:0n,
      sponsorRent:0n,deadline:BigInt(Math.floor(Date.now()/1000)+55),instructions:[SystemProgram.transfer({fromPubkey:hook.publicKey,toPubkey:wrapped,lamports:cost}),createSyncNativeInstruction(wrapped),instruction]}),[payer,hook]);
    check((await state(project))[kind===0?'burned':'platformBurned'],before[kind===0?'burned':'platformBurned']+10_000_000n);
  }
  console.log(`Revenue: ${assertions} assertions passed (real SBF and SPL CPIs; fixture Pump).`);

  const gv = {program,config,mint:platform,tokenProgram:TOKEN_2022_PROGRAM_ID,team:team.publicKey,payer:payer.publicKey,number:0n};
  const dao = sdk.governanceAddress(program,config), round = sdk.roundAddress(program,dao,0n);
  // Anyone can pre-create and dust a public PDA's ATA; neither operation may be blocked by it.
  for (const owner of [dao, round]) {
    await send([createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,sdk.tokenAddress(platform,owner,TOKEN_2022_PROGRAM_ID),owner,platform,TOKEN_2022_PROGRAM_ID),
      createTransferCheckedInstruction(sdk.tokenAddress(platform,authority.publicKey,TOKEN_2022_PROGRAM_ID),platform,sdk.tokenAddress(platform,owner,TOKEN_2022_PROGRAM_ID),authority.publicKey,1n,6,[],TOKEN_2022_PROGRAM_ID)], [payer,authority]);
  }
  await send(sdk.initializeGovernance({...gv,authority:authority.publicKey,releaseBasis:0,quorum:1_000_000n,weightCapSeconds:86400}),[authority]);
  check((await state(dao)).initial,supply*30n/100n); // Original supply, even after buybacks burned tokens.
  check(await balance(platform,dao,TOKEN_2022_PROGRAM_ID),supply*30n/100n+1n);
  await send(sdk.openRound(gv));
  check((await state(round)).pot,supply*30n/100n/1000n);
  check(await balance(platform,round,TOKEN_2022_PROGRAM_ID),(await state(round)).pot+1n);
  const noVotes = await snapshot(); expire(noVotes,round);
  await send([createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,sdk.tokenAddress(platform,voter.publicKey,TOKEN_2022_PROGRAM_ID),voter.publicKey,platform,TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(sdk.tokenAddress(platform,authority.publicKey,TOKEN_2022_PROGRAM_ID),platform,sdk.tokenAddress(platform,voter.publicKey,TOKEN_2022_PROGRAM_ID),authority.publicKey,100_000_000n,6,[],TOKEN_2022_PROGRAM_ID)], [payer,authority]);
  await send([sdk.stakeVote({...gv,voter:voter.publicKey,amount:100_000_000n,support:true})],[voter]);
  check((await state(sdk.voteAddress(program,round,voter.publicKey))).stake,100_000_000n);
  await fails([sdk.stakeVote({...gv,voter:voter.publicKey,amount:1n,support:false})],[voter]);
  await fails([sdk.withdrawVote({...gv,voter:voter.publicKey})],[voter]);
  await fails(sdk.settleRound(gv),[payer]);
  const voted = await snapshot(); expire(voted,round);
  await start(voted,'settlement');
  const pot = (await state(round)).pot;
  await send(sdk.settleRound(gv)); check((await state(round)).outcome,1);
  check(await balance(platform,team.publicKey,TOKEN_2022_PROGRAM_ID),pot*90n/100n);
  await send([sdk.withdrawVote({...gv,voter:voter.publicKey})],[voter]);
  check(await balance(platform,voter.publicKey,TOKEN_2022_PROGRAM_ID),100_000_000n+pot-pot*90n/100n);
  await fails([sdk.withdrawVote({...gv,voter:voter.publicKey})],[voter]);
  await fails(sdk.settleRound(gv),[payer]);
  check((await state(round)).rewardRemaining,0n);

  const rejected = structuredClone(voted);
  const r = rejected.get(round.toBase58()), rd=Buffer.from(r.account.data[0],'base64');
  rd.copy(rd,73,57,73); rd.fill(0,57,73); rd.copy(rd,97,89,97); rd.fill(0,89,97); r.account.data[0]=rd.toString('base64');
  const vp = rejected.get(sdk.voteAddress(program,round,voter.publicKey).toBase58()), vd=Buffer.from(vp.account.data[0],'base64');
  vd[65]=0;vp.account.data[0]=vd.toString('base64');
  await start(rejected,'rejected');
  const supplyBefore=(await getMint(conn,platform,'confirmed',TOKEN_2022_PROGRAM_ID)).supply;
  await send(sdk.settleRound(gv)); check((await state(round)).outcome,2);
  check((await getMint(conn,platform,'confirmed',TOKEN_2022_PROGRAM_ID)).supply,supplyBefore-pot*90n/100n);
  await send([sdk.withdrawVote({...gv,voter:voter.publicKey})],[voter]);
  check(await balance(platform,voter.publicKey,TOKEN_2022_PROGRAM_ID),100_000_000n+pot-pot*90n/100n);
  await start(noVotes,'void'); await send(sdk.settleRound(gv));
  check((await state(round)).outcome,3); check((await state(dao)).remaining,(await state(dao)).initial);
  console.log(`PASS: ${assertions} assertions. Claim, rollback, replay, distributions, Token-2022, 30% lock, voting, 90/10 settlement, burn, void, and withdrawals.`);
} catch(error) {
  console.error(error); if(error.logs) console.error(error.logs.join('\n')); console.error(`Local validator fixtures: ${temporary}`);
  await writeFile(join(temporary,'validator-output.log'),log); process.exitCode=1;
} finally { await stop(); }
