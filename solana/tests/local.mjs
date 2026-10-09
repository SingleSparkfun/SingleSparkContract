// Runs compiled SBF programs on an isolated local validator. Pump is an explicit test fixture;
// SPL Token, Token-2022, ATA, System, signatures, CPI privileges and rollback use the real runtime.
// shortcut: Pump liquidity is a fixture; verify official Pump/PumpSwap programs before deployment.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, Transaction, VersionedTransaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, MintLayout, AccountLayout,
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, createSyncNativeInstruction, getMint, getAccount } from '@solana/spl-token';
import * as sdk from '../client.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Optional, explicit workspace integration; standalone contract tests have no backend dependency.
const runtime = process.env.SINGLESPARK_SOLANA_RUNTIME ? await import(pathToFileURL(resolve(root, process.env.SINGLESPARK_SOLANA_RUNTIME))) : null;
const binary = process.env.SOLANA_TEST_VALIDATOR ?? 'solana-test-validator';
const temporary = await mkdtemp(join(tmpdir(), 'ss-sol-'));
const program = Keypair.generate().publicKey;
const split = process.env.SINGLESPARK_SOLANA_SPLIT === '1';
const daoProgram = split ? Keypair.generate().publicKey : program;
const [payer, authority, reserve, team, voter] = Array.from({ length: 5 }, () => Keypair.generate());
const recipients = Array.from({ length: 100 }, () => Keypair.generate().publicKey);
const mint = Keypair.generate().publicKey, platform = Keypair.generate().publicKey;
const config = sdk.configAddress(program, authority.publicKey);
const hook = { publicKey: sdk.vaultAddress(program,config,mint) };
const platformVault = sdk.vaultAddress(program,config,platform);
const project = sdk.projectAddress(program, hook.publicKey);
const timelock = Keypair.generate().publicKey, lock = sdk.timelockAddress(timelock,program);
const lockValues = { program, timelock, admin: authority.publicKey };
const daoAuthority = split ? team : authority;
const daoConfig = sdk.configAddress(daoProgram, daoAuthority.publicKey);
const supply = 1_000_000_000_000_000n;
const fixtures = new Map();
const put = (pubkey, owner, data, lamports = 10_000_000) => fixtures.set(pubkey.toBase58(), { pubkey: pubkey.toBase58(), account: {
  lamports, data: [Buffer.from(data).toString('base64'), 'base64'], owner: owner.toBase58(), executable: false, rentEpoch: 0 } });
for (const who of [payer, authority, reserve, team, voter]) put(who.publicKey, SystemProgram.programId, [], 100_000_000_000);
put(hook.publicKey, SystemProgram.programId, [], 890880);
put(platformVault, SystemProgram.programId, [], 890880);
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
  data.writeBigUInt64LE(supply, 40); (m.equals(platform) ? platformVault : hook.publicKey).toBuffer().copy(data, 49);
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
    '--bind-address', '127.0.0.1',
    '--upgradeable-program', String(program), join(root, `target/deploy-split/${split ? 'singlespark_revenue' : 'singlespark_solana'}.so`), String(accounts.has(String(lock)) ? lock : authority.publicKey),
    '--upgradeable-program', String(timelock), join(root, 'target/deploy-split/singlespark_timelock.so'), accounts.has(String(lock)) ? 'none' : String(authority.publicKey),
    ...(split ? ['--upgradeable-program', String(daoProgram), join(root, 'target/deploy-split/singlespark_dao.so'), String(team.publicKey)] : []),
    '--bpf-program', sdk.PUMP.toBase58(), join(root, 'target/deploy-split/singlespark_pump_fixture.so'),
    '--bpf-program', sdk.AMM.toBase58(), join(root, 'target/deploy-split/singlespark_pump_fixture.so')];
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
async function finalized() {
  const slot = await conn.getSlot('confirmed');
  for (let i=0;i<400;i++) {
    if (await conn.getSlot('finalized') >= slot) return;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('Finalization timed out');
}
const runtimeInput = (who=payer) => ({ program: String(program), timelock: String(timelock), authority: String(authority.publicKey), config: String(config), platformMint: String(platform), payer: String(who.publicKey), maxGas:'20000000', minProfit:'1' });
const daoInput = (who=payer) => ({ ...runtimeInput(who), program: String(daoProgram), config: String(daoConfig), authority: undefined });
async function submitPrepared(prepared, signers, input) {
  let tx=VersionedTransaction.deserialize(Buffer.from(prepared.transaction,'base64'));
  if (tx.signatures.length === 2) {
    const hookSigner = signers.find(s => String(s.publicKey) === input.authority); assert(hookSigner);
    tx.sign([hookSigner]);
    const partial = await runtime.executeProgram({ ...input, action: 'program-partial', prepared,
      signature: Buffer.from(tx.signatures[1]).toString('base64') });
    tx = VersionedTransaction.deserialize(Buffer.from(partial.transaction, 'base64'));
    check(tx.signatures[0].every(byte => byte === 0), true);
    check(tx.signatures[1].some(byte => byte !== 0), true);
  }
  tx.sign([signers[0]]);
  const transaction=Buffer.from(tx.serialize()).toString('base64');
  const signed=await runtime.executeProgram({...input,action:'program-validate',prepared,transaction});
  const call={...input,action:'program-reconcile',prepared,...signed,broadcast:true};
  await runtime.executeProgram(call,conn);
  for(let i=0;i<400;i++) {
    const result=await runtime.executeProgram(call,conn);
    if(result.status==='confirmed') { assertions++; return result; }
    assert(!['failed','expired'].includes(result.status),JSON.stringify(result));
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('Runtime transaction finalization timed out');
}
async function governanceAction(operation, who=payer, fields={}) {
  await finalized(); const input={...daoInput(who),action:'dao-prepare',operation,...fields};
  const preview=await runtime.executeProgram(input,conn); assert.equal(preview.kind,operation);
  return submitPrepared(preview,[who],input);
}
async function fails(instructions, signers = [payer, authority]) {
  await assert.rejects(() => send(instructions, signers)); assertions++;
}
const chainNow = async () => (await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY)).data.readBigInt64LE(32);
const state = async key => sdk.decodeState(await conn.getAccountInfo(key), program);
const daoState = async key => sdk.decodeState(await conn.getAccountInfo(key), daoProgram);
const balance = async (m, owner, tp) => (await getAccount(conn, sdk.tokenAddress(m, owner, tp), 'confirmed', tp)).amount;
const v = { program, timelock, authority: authority.publicKey, payer: payer.publicKey, config, hook: hook.publicKey, mint };
function buyIx(target, tokenProgram, output, cost, vault = hook.publicKey) {
  const keys = Array.from({ length: 27 }, () => ({ pubkey: SystemProgram.programId, isSigner: false, isWritable: false }));
  for (const [i, pubkey, writable, signer] of [[1,target,false,false],[2,NATIVE_MINT,false,false],[3,tokenProgram,false,false],
    [4,TOKEN_PROGRAM_ID,false,false],[10,sdk.curveAddress(target),true,false],
    [11,sdk.tokenAddress(target,sdk.curveAddress(target),tokenProgram),true,false],
    [13,vault,true,true],[14,sdk.tokenAddress(target,vault,tokenProgram),true,false],
    [15,sdk.tokenAddress(NATIVE_MINT,vault),true,false],[26,sdk.PUMP,false,false]]) keys[i] = { pubkey, isWritable:writable, isSigner:signer };
  return new TransactionInstruction({ programId:sdk.PUMP,keys,data:Buffer.concat([Buffer.from([184,23,238,97,103,197,211,61]),sdk.u64(output),sdk.u64(cost)]) });
}
async function buy(kind, debit, tokens, overrides = {}) {
  const p = await state(project), targetMint = kind === 1 ? platform : mint, tokenProgram = kind === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  return sdk.buyAndExecute({ ...v, kind, targetMint, tokenProgram, nonce:p.nonce, maxDebit:debit, minTokens:tokens, minReward:0n,
    sponsorRent:0n, deadline:(await chainNow())+55n, instructions:[buyIx(targetMint,tokenProgram,tokens,debit)], ...overrides });
}
async function snapshot() {
  const result = new Map();
  for (const owner of new Set([program,daoProgram,timelock,sdk.PUMP,sdk.AMM,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID])) {
    for (const {pubkey,account} of await conn.getProgramAccounts(owner)) result.set(pubkey.toBase58(), {pubkey:pubkey.toBase58(), account:{ ...account,
      owner:account.owner.toBase58(), rentEpoch:0, data:[account.data.toString('base64'),'base64'] }});
  }
  for (const who of [payer,authority,hook,{publicKey:platformVault},reserve,team,voter]) {
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
  if (split) {
    const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
    const dataAddress = p => PublicKey.findProgramAddressSync([p.toBuffer()], loader)[0];
    const upgradeAuthority = async p => {
      const info = await conn.getAccountInfo(dataAddress(p)); assert(info?.owner.equals(loader));
      check(info.data.readUInt32LE(0), 3);
      return info.data[12] ? String(new PublicKey(info.data.subarray(13,45))) : null;
    };
    const setAuthority = (p, current, next) => new TransactionInstruction({ programId: loader, data: Buffer.from([4,0,0,0]), keys: [
      {pubkey:dataAddress(p),isWritable:true,isSigner:false}, {pubkey:current,isWritable:false,isSigner:true},
      ...(next ? [{pubkey:next,isWritable:false,isSigner:false}] : [])] });
    check(await upgradeAuthority(program), String(authority.publicKey));
    check(await upgradeAuthority(daoProgram), String(team.publicKey));
    await send([setAuthority(daoProgram,team.publicKey,null)],[payer,team]);
    check(await upgradeAuthority(daoProgram), null);
    check(await upgradeAuthority(program), String(authority.publicKey));
    await fails([setAuthority(program,team.publicKey,reserve.publicKey)],[payer,team]);
    await send([setAuthority(program,authority.publicKey,reserve.publicKey)],[payer,authority]);
    check(await upgradeAuthority(program), String(reserve.publicKey));
    await fails([setAuthority(daoProgram,team.publicKey,authority.publicKey)],[payer,team]);
    await send([setAuthority(program,reserve.publicKey,authority.publicKey)],[payer,reserve]);
    console.log('Split authority isolation: DAO finalized locally; revenue authority remains independently changeable.');
  }
  const finalizeController = new TransactionInstruction({ programId: sdk.UPGRADE_LOADER, data: Buffer.from([4,0,0,0]), keys: [
    {pubkey:sdk.programDataAddress(timelock),isWritable:true,isSigner:false}, {pubkey:authority.publicKey,isWritable:false,isSigner:true}] });
  await fails([sdk.initializeTimelock(lockValues)],[payer,authority]);
  await send([finalizeController],[payer,authority]);
  await send([sdk.initializeTimelock(lockValues)],[payer,authority]);
  await fails([sdk.initializeTimelock(lockValues)],[payer,authority]);
  check((await conn.getAccountInfo(sdk.programDataAddress(program))).data.subarray(13,45),lock.toBuffer());
  await send([sdk.initializeConfig({program,payer:payer.publicKey,authority:authority.publicKey,platformMint:platform,bountySource:0,minimum:1n,maximum:1_000_000_000n})],[payer,authority]);
  const registration = sdk.initializeProject({...v,authority:authority.publicKey,reserveRecipient:reserve.publicKey,buyback:true,distribution:true});
  if(runtime) {
    await finalized(); const input={...runtimeInput(authority),action:'claim-register',mint:String(mint),hook:String(hook.publicKey),reserveRecipient:String(reserve.publicKey),plugins:{buyback:true,distribution:true}};
    const preview=await runtime.executeProgram(input,conn); await submitPrepared(preview,[authority],input);
  } else await send([registration],[payer,authority]);
  await fails([registration],[payer,authority]);
  const wrapped = sdk.tokenAddress(NATIVE_MINT,hook.publicKey);
  const keys = [hook.publicKey,wrapped,feeVault,wrapped,NATIVE_MINT,TOKEN_PROGRAM_ID,SystemProgram.programId,SystemProgram.programId,SystemProgram.programId,sdk.PUMP]
    .map((pubkey,i)=>({pubkey,isSigner:false,isWritable:[0,1,2,3].includes(i)}));
  const collect = new TransactionInstruction({programId:sdk.PUMP,keys,data:Buffer.from([207,17,138,242,4,34,19,56])});
  const callerBefore = BigInt(await conn.getBalance(payer.publicKey));
  await send(sdk.collectRevenue({...v,nonce:0n,instructions:[collect]}),[payer,authority]);
  check((await state(project)).balances,[83_000_000n,7_000_000n,5_000_000n,4_000_000n,0n]);
  check((await state(project)).bounty,1_000_000n);
  const first = await buy(0,41_500_000n,100_000_000n);
  if(runtime) {
    await finalized(); const input={...runtimeInput(),hook:String(hook.publicKey)};
    const preview=await runtime.prepareTransaction(conn,input,first,{kind:'own',project:String(project),nonce:'1'},sim=>{
      // Parse the actual SBF settlement event; no estimated reward is substituted.
      const lines=sim.logs.filter(l=>l.startsWith('Program data: '));
      return Buffer.from(lines.at(-1).split(' ').at(-1),'base64').readBigUInt64LE();
    });
    const receipt=await submitPrepared(preview,[payer,authority],input);check(receipt.bought,'100000000');
  } else await send(first,[payer,authority]); check((await state(project)).burned,100_000_000n);
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
  await send(await buy(1,7_000_000n,20_000_000n),[payer,authority]); check((await state(project)).platformBurned,20_000_000n);
  await send(await buy(2,5_000_000n,1_000_000_000n),[payer,authority]); check((await state(project)).rewardTokens,1_000_000_000n);
  const payout = async list => sdk.distribute({...v,tokenProgram:TOKEN_PROGRAM_ID,nonce:(await state(project)).nonce,
    minReward:0n,deadline:(await chainNow())+55n,recipients:list});
  const firstPayout = await payout(recipients.slice(0,4));
  await send(firstPayout,[payer,authority]);
  check(await balance(mint,recipients[0],TOKEN_PROGRAM_ID),10_000_000n);
  const beforeDuplicate = await state(project);
  await fails(firstPayout); check(await state(project),beforeDuplicate);
  const duplicateBatch = await payout(recipients.slice(0,2));
  duplicateBatch.at(-1).keys[10] = duplicateBatch.at(-1).keys[8];
  duplicateBatch.at(-1).keys[11] = duplicateBatch.at(-1).keys[9];
  await fails(duplicateBatch); check(await state(project),beforeDuplicate);
  check(await balance(mint,recipients[0],TOKEN_PROGRAM_ID),10_000_000n);
  for (let offset = 4; offset < recipients.length; offset += 4) {
    await send(await payout(recipients.slice(offset, offset + 4)),[payer,authority]);
  }
  const received = await Promise.all(recipients.map(r => balance(mint, r, TOKEN_PROGRAM_ID)));
  check(received, recipients.map(() => 10_000_000n));
  await send(await buy(0,41_500_000n,100_000_000n),[payer,authority]);
  check((await state(project)).bountyPaid,1_000_000n); check((await state(project)).bounty,0n);
  check((await state(project)).rewardTokens,0n); check((await state(project)).recipientsPaid,100n);
  const settled = await state(project), net = BigInt(await conn.getBalance(payer.publicKey)) - callerBefore;
  const legacyReceipts = await conn.getMultipleAccountsInfo(recipients.map(r =>
    sdk.derive(program, Buffer.from('paid'), project.toBuffer(), r.toBuffer())));
  check(legacyReceipts.every(info => info === null), true);
  const report = { network: 'isolated-local-validator', pump: 'fixture', recipients: recipients.length, payoutTransactions: 25,
    collectedLamports: String(settled.received), callerRewardLamports: String(settled.bountyPaid),
    callerCostLamports: String(settled.bountyPaid - net), callerNetLamports: String(net),
    profitable: net > 0n, productionProfitGuardEnabled: false };
  // This fixture verifies transfers with minReward=0; it must not be mistaken for a profitable public Claim.
  check(report.profitable, false);
  await writeFile(join(temporary, 'claim-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Claim economics: ${JSON.stringify(report)}\nReport: ${join(temporary, 'claim-result.json')}`);
  await fails(sdk.collectRevenue({...v,nonce:(await state(project)).nonce,instructions:[collect]}));
  await send([SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:hook.publicKey,lamports:2_000_000})]);
  await fails(sdk.collectRevenue({...v,nonce:(await state(project)).nonce,instructions:[collect]}));
  check((await state(project)).received,100_000_000n);
  await fails([sdk.withdrawReserve({...v,nonce:(await state(project)).nonce,bucket:3,amount:4_000_000n,recipient:payer.publicKey})]);
  await send([sdk.withdrawReserve({...v,nonce:(await state(project)).nonce,bucket:3,amount:4_000_000n,recipient:reserve.publicKey})],[payer,authority,reserve]);
  check((await state(project)).balances,[1_660_000n,140_000n,100_000n,80_000n,0n]);
  const ammCollect=new TransactionInstruction({programId:sdk.AMM,data:Buffer.from([160,57,89,42,181,139,43,66]),
    keys:[NATIVE_MINT,TOKEN_PROGRAM_ID,hook.publicKey,ammVault,sdk.tokenAddress(NATIVE_MINT,ammVault),wrapped,SystemProgram.programId,sdk.AMM]
      .map((pubkey,i)=>({pubkey,isSigner:false,isWritable:[4,5].includes(i)}))});
  await send(sdk.collectRevenue({...v,nonce:(await state(project)).nonce,instructions:[ammCollect]}),[payer,authority]);
  check((await state(project)).received,122_000_000n);
  for(const [kind,target,tp,cost] of [[0,mint,TOKEN_PROGRAM_ID,16_600_000n],[1,platform,TOKEN_2022_PROGRAM_ID,1_400_000n]]) {
    const pool=ammPool(target), keys=Array.from({length:23},()=>({pubkey:SystemProgram.programId,isSigner:false,isWritable:false}));
    for(const [i,pubkey,writable,signer] of [[0,pool,true,false],[1,hook.publicKey,true,true],[3,target,false,false],[4,NATIVE_MINT,false,false],
      [5,sdk.tokenAddress(target,hook.publicKey,tp),true,false],[6,wrapped,true,false],[7,sdk.tokenAddress(target,pool,tp),true,false],
      [8,sdk.tokenAddress(NATIVE_MINT,pool),true,false],[11,tp,false,false],[12,TOKEN_PROGRAM_ID,false,false],[16,sdk.AMM,false,false]])keys[i]={pubkey,isWritable:writable,isSigner:signer};
    const instruction=new TransactionInstruction({programId:sdk.AMM,keys,data:Buffer.concat([Buffer.from([102,6,61,18,1,218,235,234]),sdk.u64(10_000_000n),sdk.u64(cost),Buffer.from([0])])});
    const before=await state(project);
    await send(sdk.buyAndExecute({...v,kind,targetMint:target,tokenProgram:tp,nonce:before.nonce,maxDebit:cost,minTokens:10_000_000n,minReward:0n,
      sponsorRent:0n,deadline:(await chainNow())+55n,instructions:[SystemProgram.transfer({fromPubkey:hook.publicKey,toPubkey:wrapped,lamports:cost}),createSyncNativeInstruction(wrapped),instruction]}),[payer,authority]);
    check((await state(project))[kind===0?'burned':'platformBurned'],before[kind===0?'burned':'platformBurned']+10_000_000n);
  }
  await send(await buy(2,1_000_000n,80_000_000n),[payer,authority]);
  // A frozen legacy transaction keeps its original ABI; its receipts must not block a later new payout.
  const legacyPayout = await payout(recipients.slice(0,4)), legacyIx = legacyPayout.at(-1);
  legacyIx.data[0] = 4;
  legacyIx.keys = [...legacyIx.keys.slice(0,8), ...recipients.slice(0,4).flatMap((r,i) => [
    ...legacyIx.keys.slice(8 + i * 2,10 + i * 2),
    { pubkey: sdk.derive(program, Buffer.from('paid'), project.toBuffer(), r.toBuffer()), isSigner: false, isWritable: true },
  ]), ...legacyIx.keys.slice(-6)];
  await send(legacyPayout,[payer,authority]);
  const repeatBefore = await state(project), payerBeforeRepeat = BigInt(await conn.getBalance(payer.publicKey));
  await send(await payout(recipients.slice(0,4)),[payer,authority]);
  for (const recipient of recipients.slice(0,4)) check(await balance(mint,recipient,TOKEN_PROGRAM_ID),30_000_000n);
  const repeatAfter = await state(project);
  const repeatCost = repeatAfter.bountyPaid - repeatBefore.bountyPaid + payerBeforeRepeat - BigInt(await conn.getBalance(payer.publicKey));
  check(repeatAfter.recipientsPaid,108n);
  check(repeatCost >= 10_000n && repeatCost < 20_000n, true);
  console.log(`Repeat payout: four existing recipients, ${repeatCost} lamports caller cost, no new token accounts or payout receipts.`);
  console.log(`Revenue: ${assertions} assertions passed (real SBF and SPL CPIs; fixture Pump).`);

  // Global gate applies to existing and future vaults without enumerating them.
  const gate = sdk.pluginGateAddress(program,config), beforePause = await state(project);
  await fails([sdk.pauseAllPlugins({...v,authority:reserve.publicKey,mask:1})],[payer,reserve]);
  await send([sdk.pauseAllPlugins({...v,mask:1})],[payer,authority]);
  check((await state(gate)).paused,1); check(await state(project),beforePause);
  await fails(await buy(0,10_000n,10_000_000n));
  await fails(await buy(1,10_000n,10_000_000n));
  await send(await buy(2,10_000n,10_000_000n),[payer,authority]);
  const second = {...v,hook:platformVault,mint:platform};
  await send([sdk.initializeProject({...second,reserveRecipient:reserve.publicKey,buyback:true,distribution:true})],[payer,authority]);
  await send([SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:platformVault,lamports:100_000})]);
  const secondBuy = async () => sdk.buyAndExecute({...second,nonce:(await state(sdk.projectAddress(program,platformVault))).nonce,
    kind:0,targetMint:platform,tokenProgram:TOKEN_2022_PROGRAM_ID,maxDebit:10_000n,minTokens:10_000_000n,minReward:0n,
    sponsorRent:0n,deadline:(await chainNow())+55n,instructions:[buyIx(platform,TOKEN_2022_PROGRAM_ID,10_000_000n,10_000n,platformVault)]});
  await fails(await secondBuy());
  await send([sdk.pausePlugins({...v,mask:2})],[payer,authority]);
  await fails(await buy(2,10_000n,10_000_000n));
  const readLock = async () => sdk.decodeTimelock(await conn.getAccountInfo(lock),timelock,program);
  const expireLock = accounts => {
    const item=accounts.get(String(lock)), data=Buffer.from(item.account.data[0],'base64');
    data.writeBigInt64LE(BigInt(Math.floor(Date.now()/1000)-10),128);item.account.data[0]=data.toString('base64');
  };
  const resume = {...lockValues,config,buffer:gate};
  await send([sdk.scheduleGlobalResume({...lockValues,config,mask:1})],[payer,authority]);
  check((await readLock()).executableAt > (await chainNow())+172700n,true);
  await fails([sdk.executeScheduled(resume)],[payer]);
  const directResume = new TransactionInstruction({programId:program,keys:sdk.pauseAllPlugins({...v,mask:1}).keys,
    data:Buffer.concat([Buffer.from([10]),sdk.u64((await state(gate)).revision),Buffer.from([1])])});
  await fails([directResume],[payer,authority]);
  await send([sdk.pauseAllPlugins({...v,mask:1})],[payer,authority]);
  let fork=await snapshot();expireLock(fork);await start(fork,'stale-resume');
  await fails([sdk.executeScheduled(resume)],[payer]);
  await send([sdk.cancelScheduled(resume)],[payer,authority]);
  await send([sdk.scheduleGlobalResume({...lockValues,config,mask:1})],[payer,authority]);
  await fails([sdk.executeScheduled(resume)],[payer]);
  fork=await snapshot();expireLock(fork);await start(fork,'global-resume');
  await send([sdk.executeScheduled(resume)],[reserve]);
  check((await state(gate)).paused,0);check((await state(project)).paused,2);
  await send(await buy(0,10_000n,10_000_000n),[payer,authority]);
  await send(await secondBuy(),[payer,authority]);
  await fails(await buy(2,10_000n,10_000_000n));
  const change={buyback:true,distribution:true,weights:[7900,700,500,800,0],paused:0};
  const policy={...lockValues,config,buffer:project,hook:hook.publicKey,change};
  await send([sdk.schedulePlugins(policy)],[payer,authority]);
  await fails([sdk.executeScheduled(policy)],[payer]);
  const old=await state(project);
  await send([SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:hook.publicKey,lamports:10_000}),
    SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:wrapped,lamports:10_000})]);
  fork=await snapshot();expireLock(fork);await start(fork,'project-policy');
  await send([sdk.executeScheduled(policy)],[payer]);
  const updated=await state(project);
  check(updated.paused,0);check(updated.weights,change.weights);
  check(updated.received,old.received+20_000n);
  check(updated.balances,old.balances.map((n,i)=>n+[16600n,1400n,1000n,800n,0n][i]));
  await send([SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:hook.publicKey,lamports:10_000})]);
  await send(await buy(2,100n,10_000_000n),[payer,authority]);
  check((await state(project)).balances,updated.balances.map((n,i)=>n+[7900n,700n,400n,800n,0n][i]));
  // Upgrade buffers are local genesis fixtures containing the actual freshly built ELF.
  const elf=await readFile(join(root,`target/deploy-split/${split?'singlespark_revenue':'singlespark_solana'}.so`));
  const buffers=[Keypair.generate().publicKey,Keypair.generate().publicKey];
  fork=await snapshot();
  for(const buffer of buffers) {
    const data=Buffer.concat([Buffer.from([1,0,0,0,1]),authority.publicKey.toBuffer(),elf]);
    fork.set(String(buffer),{pubkey:String(buffer),account:{lamports:await conn.getMinimumBalanceForRentExemption(data.length),
      data:[data.toString('base64'),'base64'],owner:String(sdk.UPGRADE_LOADER),executable:false,rentEpoch:0}});
  }
  await start(fork,'upgrade-buffers');
  const upgrade={...lockValues,buffer:buffers[0]};
  await fails([sdk.scheduleUpgrade({...upgrade,admin:reserve.publicKey})],[payer,reserve]);
  await send([sdk.scheduleUpgrade(upgrade)],[payer,authority]);
  check((await conn.getAccountInfo(buffers[0])).data.subarray(5,37),lock.toBuffer());
  const writeBuffer=new TransactionInstruction({programId:sdk.UPGRADE_LOADER,keys:[
    {pubkey:buffers[0],isWritable:true,isSigner:false},{pubkey:authority.publicKey,isWritable:false,isSigner:true}],
    data:Buffer.from([1,0,0,0,0,0,0,0,1,0,0,0,255])});
  await fails([writeBuffer],[payer,authority]);
  await fails([sdk.executeScheduled(upgrade)],[payer]);
  await send([sdk.cancelScheduled(upgrade)],[payer,authority]);
  check(await conn.getAccountInfo(buffers[0]),null);
  upgrade.buffer=buffers[1];
  await send([sdk.scheduleUpgrade(upgrade)],[payer,authority]);
  check((await readLock()).executableAt > (await chainNow())+172700n,true);
  await fails([sdk.executeScheduled(upgrade)],[payer]);
  fork=await snapshot();
  const held=await conn.getAccountInfo(buffers[1]);
  fork.set(String(buffers[1]),{pubkey:String(buffers[1]),account:{...held,owner:String(held.owner),rentEpoch:0,data:[held.data.toString('base64'),'base64']}});
  expireLock(fork);
  const tampered=structuredClone(fork), item=tampered.get(String(buffers[1])), bytes=Buffer.from(item.account.data[0],'base64');
  bytes[bytes.length-1]^=1;item.account.data[0]=bytes.toString('base64');
  await start(tampered,'tampered-upgrade');
  await fails([sdk.executeScheduled(upgrade)],[payer]);
  await start(fork,'delayed-upgrade');
  await send([sdk.executeScheduled(upgrade)],[payer]);
  check((await readLock()).buffer,String(PublicKey.default));
  check((await conn.getAccountInfo(sdk.programDataAddress(program))).data.subarray(13,45),lock.toBuffer());
  console.log(`PDA controls: global/local pauses, stale resume invalidation, new vault inheritance, old-income allocation, buffer freeze/hash and delayed upgrade passed (${assertions} assertions).`);

  const gv = {program:daoProgram,config:daoConfig,mint:platform,tokenProgram:TOKEN_2022_PROGRAM_ID,team:team.publicKey,payer:payer.publicKey,number:0n};
  const dao = sdk.governanceAddress(daoProgram,daoConfig), round = sdk.roundAddress(daoProgram,dao,0n);
  if (split) {
    await send([sdk.initializeConfig({program:daoProgram,payer:payer.publicKey,authority:daoAuthority.publicKey,platformMint:platform,bountySource:0,minimum:1n,maximum:1_000_000_000n})],[payer,daoAuthority]);
    await send([createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,sdk.tokenAddress(platform,daoAuthority.publicKey,TOKEN_2022_PROGRAM_ID),daoAuthority.publicKey,platform,TOKEN_2022_PROGRAM_ID),
      createTransferCheckedInstruction(sdk.tokenAddress(platform,authority.publicKey,TOKEN_2022_PROGRAM_ID),platform,sdk.tokenAddress(platform,daoAuthority.publicKey,TOKEN_2022_PROGRAM_ID),authority.publicKey,supply*30n/100n+100_000_000n,6,[],TOKEN_2022_PROGRAM_ID)],[payer,authority]);
    for (const [target,data] of [[daoProgram,registration.data], [program,sdk.initializeGovernance({...gv,authority:daoAuthority.publicKey,releaseBasis:0,quorum:1_000_000n,weightCapSeconds:86400}).at(-1).data]]) {
      await assert.rejects(()=>send([new TransactionInstruction({programId:target,keys:[],data})]),/invalid instruction data/i); assertions++;
    }
    await fails(sdk.initializeGovernance({...gv,config,authority:authority.publicKey,releaseBasis:0,quorum:1_000_000n,weightCapSeconds:86400}),[authority]);
  }
  // Anyone can pre-create and dust a public PDA's ATA; neither operation may be blocked by it.
  for (const owner of [dao, round]) {
    await send([createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,sdk.tokenAddress(platform,owner,TOKEN_2022_PROGRAM_ID),owner,platform,TOKEN_2022_PROGRAM_ID),
      createTransferCheckedInstruction(sdk.tokenAddress(platform,authority.publicKey,TOKEN_2022_PROGRAM_ID),platform,sdk.tokenAddress(platform,owner,TOKEN_2022_PROGRAM_ID),authority.publicKey,1n,6,[],TOKEN_2022_PROGRAM_ID)], [payer,authority]);
  }
  await send(sdk.initializeGovernance({...gv,authority:daoAuthority.publicKey,releaseBasis:0,quorum:1_000_000n,weightCapSeconds:86400}),[daoAuthority]);
  check((await daoState(dao)).initial,supply*30n/100n); // Original supply, even after buybacks burned tokens.
  check(await balance(platform,dao,TOKEN_2022_PROGRAM_ID),supply*30n/100n+1n);
  await send(sdk.openRound(gv));
  check((await daoState(round)).pot,supply*30n/100n/1000n);
  check(await balance(platform,round,TOKEN_2022_PROGRAM_ID),(await daoState(round)).pot+1n);
  const noVotes = await snapshot(); expire(noVotes,round);
  await send([createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,sdk.tokenAddress(platform,voter.publicKey,TOKEN_2022_PROGRAM_ID),voter.publicKey,platform,TOKEN_2022_PROGRAM_ID),
    createTransferCheckedInstruction(sdk.tokenAddress(platform,daoAuthority.publicKey,TOKEN_2022_PROGRAM_ID),platform,sdk.tokenAddress(platform,voter.publicKey,TOKEN_2022_PROGRAM_ID),daoAuthority.publicKey,100_000_000n,6,[],TOKEN_2022_PROGRAM_ID)], [payer,daoAuthority]);
  if(runtime) await governanceAction('vote',voter,{amount:'100000000',support:true});
  else await send([sdk.stakeVote({...gv,voter:voter.publicKey,amount:100_000_000n,support:true})],[voter]);
  check((await daoState(sdk.voteAddress(daoProgram,round,voter.publicKey))).stake,100_000_000n);
  await fails([sdk.stakeVote({...gv,voter:voter.publicKey,amount:1n,support:false})],[voter]);
  await fails([sdk.withdrawVote({...gv,voter:voter.publicKey})],[voter]);
  await fails(sdk.settleRound(gv),[payer]);
  const voted = await snapshot(); expire(voted,round);
  await start(voted,'settlement');
  const pot = (await daoState(round)).pot;
  if(runtime) await governanceAction('settle'); else await send(sdk.settleRound(gv)); check((await daoState(round)).outcome,1);
  check(await balance(platform,team.publicKey,TOKEN_2022_PROGRAM_ID),pot*90n/100n);
  if(runtime) {
    const view=await runtime.executeProgram({...daoInput(voter),action:'dao-view'},conn);
    check(view.history[0].claimable,true); check(view.history[0].estimatedReward,String(pot-pot*90n/100n));
    await governanceAction('withdraw',voter,{round:'0'});
    const claimed=await runtime.executeProgram({...daoInput(voter),action:'dao-view'},conn);check(claimed.history[0].claimable,false);
  } else await send([sdk.withdrawVote({...gv,voter:voter.publicKey})],[voter]);
  check(await balance(platform,voter.publicKey,TOKEN_2022_PROGRAM_ID),100_000_000n+pot-pot*90n/100n);
  await fails([sdk.withdrawVote({...gv,voter:voter.publicKey})],[voter]);
  await fails(sdk.settleRound(gv),[payer]);
  check((await daoState(round)).rewardRemaining,0n);

  const rejected = structuredClone(voted);
  const r = rejected.get(round.toBase58()), rd=Buffer.from(r.account.data[0],'base64');
  rd.copy(rd,73,57,73); rd.fill(0,57,73); rd.copy(rd,97,89,97); rd.fill(0,89,97); r.account.data[0]=rd.toString('base64');
  const vp = rejected.get(sdk.voteAddress(daoProgram,round,voter.publicKey).toBase58()), vd=Buffer.from(vp.account.data[0],'base64');
  vd[65]=0;vp.account.data[0]=vd.toString('base64');
  await start(rejected,'rejected');
  const supplyBefore=(await getMint(conn,platform,'confirmed',TOKEN_2022_PROGRAM_ID)).supply;
  await send(sdk.settleRound(gv)); check((await daoState(round)).outcome,2);
  check((await getMint(conn,platform,'confirmed',TOKEN_2022_PROGRAM_ID)).supply,supplyBefore-pot*90n/100n);
  await send([sdk.withdrawVote({...gv,voter:voter.publicKey})],[voter]);
  check(await balance(platform,voter.publicKey,TOKEN_2022_PROGRAM_ID),100_000_000n+pot-pot*90n/100n);
  await start(noVotes,'void'); await send(sdk.settleRound(gv));
  check((await daoState(round)).outcome,3); check((await daoState(dao)).remaining,(await daoState(dao)).initial);
  console.log(`PASS: ${assertions} assertions. Claim, rollback, replay, distributions, Token-2022, 30% lock, voting, 90/10 settlement, burn, void, and withdrawals.`);
} catch(error) {
  console.error(error); if(error.logs) console.error(error.logs.join('\n')); console.error(`Local validator fixtures: ${temporary}`);
  await writeFile(join(temporary,'validator-output.log'),log); process.exitCode=1;
} finally { await stop(); }
