import assert from 'node:assert/strict';
import { PublicKey, TransactionInstruction, SystemProgram, TransactionMessage, VersionedTransaction, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';

export const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const pk = value => new PublicKey(value);
const key = value => pk(value).toBuffer();
const byte = value => { assert(Number.isInteger(value) && value >= 0 && value <= 255); return Buffer.from([value]); };
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
export const u64 = value => { assert(typeof value === 'bigint' || typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)); const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const bool = value => { assert(typeof value === 'boolean'); return byte(Number(value)); };
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey: pk(pubkey), isWritable, isSigner });
export const derive = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds, pk(program))[0];
export const configAddress = (program, authority) => derive(program, Buffer.from('config'), key(authority));
export const vaultAddress = (program, config, mint) => derive(program, Buffer.from('hook-vault'), key(config), key(mint));
export const projectAddress = (program, hook) => derive(program, Buffer.from('project'), key(hook));
export const governanceAddress = (program, config) => derive(program, Buffer.from('dao'), key(config));
export const roundAddress = (program, governance, number) => derive(program, Buffer.from('round'), key(governance), u64(number));
export const voteAddress = (program, round, voter) => derive(program, Buffer.from('vote'), key(round), key(voter));
export const teamClaimAddress = (program, round) => derive(program, Buffer.from('team-claim'), key(round));
export const curveAddress = mint => derive(PUMP, Buffer.from('bonding-curve'), key(mint));
export const tokenAddress = (mint, owner, tokenProgram = TOKEN_PROGRAM_ID) => getAssociatedTokenAddressSync(pk(mint), pk(owner), true, pk(tokenProgram));
const ix = (program, tag, keys, ...data) => new TransactionInstruction({ programId: pk(program), keys, data: Buffer.concat([byte(tag), ...data]) });

export function buildTransaction({ payer, blockhash, instructions, lookupTables = [] }) {
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: pk(payer), recentBlockhash: blockhash,
    instructions }).compileToV0Message(lookupTables));
  assert(tx.serialize().length <= 1232, 'Transaction too large: use a verified lookup table or split the batch');
  return tx;
}
const base = ({ program, payer, config, hook }) => [meta(payer, true, true), meta(config), meta(projectAddress(program, hook), true), meta(hook, true), meta(SystemProgram.programId)];
const createAta = (payer, mint, owner, tokenProgram = TOKEN_PROGRAM_ID) => createAssociatedTokenAccountIdempotentInstruction(pk(payer), tokenAddress(mint, owner, tokenProgram), pk(owner), pk(mint), pk(tokenProgram));

// Preserve fixed account positions and append each CPI's additional accounts only once.
function wrap(program, tag, keys, data, instructions) {
  const index = m => {
    let i = keys.findIndex(k => k.pubkey.equals(m.pubkey));
    if (i < 0) { i = keys.length; keys.push({ ...m }); }
    else { keys[i].isSigner ||= m.isSigner; keys[i].isWritable ||= m.isWritable; }
    assert(i < 256); return i;
  };
  const steps = instructions.map(instruction => Buffer.concat([
    byte(index(meta(instruction.programId))), u32(instruction.keys.length),
    ...instruction.keys.map(m => Buffer.concat([byte(index(m)), bool(m.isSigner), bool(m.isWritable)])),
    u32(instruction.data.length), instruction.data,
  ]));
  // Inner CPI signer privileges belong to the PDA, never the transaction's signature list.
  keys.forEach(m => { if (m.pubkey.equals(keys[3].pubkey)) m.isSigner = false; });
  return ix(program, tag, keys, ...data, u32(steps.length), ...steps);
}
export function initializeConfig(v) {
  assert([0, 1].includes(v.bountySource), 'Choose the reward funding policy explicitly');
  return ix(v.program, 0, [meta(v.payer, true, true), meta(v.authority, false, true), meta(configAddress(v.program, v.authority), true),
    meta(v.platformMint), meta(curveAddress(v.platformMint)), meta(SystemProgram.programId)], byte(v.bountySource), u64(v.minimum), u64(v.maximum));
}
export function initializeProject(v) {
  return ix(v.program, 1, [meta(v.payer, true, true), meta(v.authority, false, true), meta(v.config), meta(projectAddress(v.program, v.hook), true),
    meta(v.hook, true), meta(v.mint), meta(curveAddress(v.mint)), meta(SystemProgram.programId),
    meta(programDataAddress(v.program)), meta(v.timelock), meta(programDataAddress(v.timelock)), meta(v.program), meta(pluginGateAddress(v.program,v.config),true)],
    bool(v.buyback), bool(v.distribution), key(v.reserveRecipient), key(v.timelock));
}
export function collectRevenue(v) {
  assert(v.instructions.length > 0 && v.instructions.length <= 2 && v.instructions.every(i => [PUMP, AMM].some(p => p.equals(i.programId))));
  const wrapped = tokenAddress(NATIVE_MINT, v.hook);
  const inner = wrap(v.program, 2, [...base(v), meta(v.mint), meta(curveAddress(v.mint)), meta(wrapped, true)], [u64(v.nonce)], v.instructions);
  return vaultOperation(v, inner);
}
export function buyAndExecute(v) {
  assert([0, 1, 2].includes(v.kind));
  const wrapped = tokenAddress(NATIVE_MINT, v.hook);
  // The user funds ATA setup; the program handles unwrapping and burns under its own checks.
  assert(v.instructions.every(i => [PUMP, AMM, SystemProgram.programId, TOKEN_PROGRAM_ID].some(p => p.equals(i.programId))));
  const inner = wrap(v.program, 3, [...base(v), meta(v.targetMint, true), meta(tokenAddress(v.targetMint, v.hook, v.tokenProgram), true),
    meta(v.tokenProgram), meta(wrapped, true), meta(curveAddress(v.targetMint), true)],
    [u64(v.nonce), byte(v.kind), u64(v.maxDebit), u64(v.minTokens), u64(v.minReward), u64(v.sponsorRent), u64(v.deadline)], v.instructions);
  return [createAta(v.payer, v.targetMint, v.hook, v.tokenProgram), ...vaultOperation(v, inner)];
}
export function distribute(v) {
  assert(v.recipients.length > 0 && v.recipients.length <= 4 && new Set(v.recipients.map(r => pk(r).toBase58())).size === v.recipients.length);
  return [...v.recipients.map(r => createAta(v.payer, v.mint, r, v.tokenProgram)), ...vaultOperation(v, ix(v.program, 6, [...base(v), meta(v.mint),
    meta(tokenAddress(v.mint, v.hook, v.tokenProgram), true), meta(v.tokenProgram), ...v.recipients.flatMap(r => [meta(r),
      meta(tokenAddress(v.mint, r, v.tokenProgram), true)])],
    u64(v.nonce), u64(v.minReward), u64(v.deadline)))];
}
export function withdrawReserve(v) {
  assert([3, 4].includes(v.bucket));
  return vaultOperation(v, ix(v.program, 5, [...base(v), meta(v.recipient, true, true)], u64(v.nonce), byte(v.bucket), u64(v.amount)));
}
export function initializeGovernance(v) {
  assert([0, 1].includes(v.releaseBasis), 'Choose the release basis explicitly');
  assert(Number.isInteger(v.weightCapSeconds) && v.weightCapSeconds > 0 && v.weightCapSeconds <= 86400);
  const dao = governanceAddress(v.program, v.config);
  return [createAta(v.authority, v.mint, dao, v.tokenProgram), ix(v.program, 16, [meta(v.authority, true, true), meta(v.config),
    meta(dao, true), meta(v.mint), meta(tokenAddress(v.mint, v.authority, v.tokenProgram), true), meta(tokenAddress(v.mint, dao, v.tokenProgram), true),
    meta(v.tokenProgram), meta(curveAddress(v.mint)), meta(SystemProgram.programId)], key(v.team), byte(v.releaseBasis), u64(v.quorum), u32(v.weightCapSeconds))];
}
export function openRound(v) {
  const dao = governanceAddress(v.program, v.config), round = roundAddress(v.program, dao, v.number);
  return [createAta(v.payer, v.mint, round, v.tokenProgram), ix(v.program, 17, [meta(v.payer, true, true), meta(dao, true), meta(round, true),
    meta(tokenAddress(v.mint, dao, v.tokenProgram), true), meta(tokenAddress(v.mint, round, v.tokenProgram), true),
    meta(v.mint), meta(v.tokenProgram), meta(SystemProgram.programId)])];
}
export function stakeVote(v) {
  const dao = governanceAddress(v.program, v.config), round = roundAddress(v.program, dao, v.number);
  return ix(v.program, 18, [meta(v.voter, true, true), meta(dao), meta(round, true), meta(voteAddress(v.program, round, v.voter), true),
    meta(tokenAddress(v.mint, v.voter, v.tokenProgram), true), meta(tokenAddress(v.mint, round, v.tokenProgram), true),
    meta(v.mint), meta(v.tokenProgram), meta(SystemProgram.programId)], u64(v.amount), bool(v.support));
}
export function settleRound(v) {
  const dao = governanceAddress(v.program, v.config), round = roundAddress(v.program, dao, v.number);
  if (v.independentTeamClaims === true) return [ix(v.program, 22, [meta(v.payer, true, true), meta(dao, true), meta(round, true),
    meta(tokenAddress(v.mint, dao, v.tokenProgram), true), meta(tokenAddress(v.mint, round, v.tokenProgram), true),
    meta(teamClaimAddress(v.program, round), true), meta(v.mint, true), meta(v.tokenProgram), meta(SystemProgram.programId)])];
  return [createAta(v.payer, v.mint, v.team, v.tokenProgram), ix(v.program, 19, [meta(dao, true), meta(round, true),
    meta(tokenAddress(v.mint, dao, v.tokenProgram), true), meta(tokenAddress(v.mint, round, v.tokenProgram), true),
    meta(tokenAddress(v.mint, v.team, v.tokenProgram), true), meta(v.mint, true), meta(v.tokenProgram)])];
}
export function claimTeam(v) {
  assert(v.independentTeamClaims === true, 'Independent team claims require a verified DAO deployment');
  assert(pk(v.payer).equals(pk(v.team)), 'Only the fixed team can claim');
  const dao = governanceAddress(v.program, v.config), round = roundAddress(v.program, dao, v.number);
  return [createAta(v.payer, v.mint, v.team, v.tokenProgram), ix(v.program, 21, [meta(v.team, false, true), meta(dao), meta(round),
    meta(teamClaimAddress(v.program, round), true), meta(tokenAddress(v.mint, round, v.tokenProgram), true),
    meta(tokenAddress(v.mint, v.team, v.tokenProgram), true), meta(v.mint), meta(v.tokenProgram)])];
}
export function withdrawVote(v) {
  const dao = governanceAddress(v.program, v.config), round = roundAddress(v.program, dao, v.number);
  return ix(v.program, 20, [meta(v.voter, false, true), meta(dao), meta(round, true), meta(voteAddress(v.program, round, v.voter), true),
    meta(tokenAddress(v.mint, round, v.tokenProgram), true), meta(tokenAddress(v.mint, v.voter, v.tokenProgram), true), meta(v.mint), meta(v.tokenProgram)]);
}

export function decodeState(info, program, expectedTag) {
  assert(info && info.owner.equals(pk(program)), 'Unexpected state owner');
  const data = Buffer.from(info.data); let offset = 1;
  if (expectedTag !== undefined) assert.equal(data[0], expectedTag, 'Unexpected SingleSpark account type');
  const read = size => { assert(offset + size <= data.length); const result = data.subarray(offset, offset + size); offset += size; return result; };
  const p = () => new PublicKey(read(32)).toBase58(), n = () => read(8).readBigUInt64LE(), b = () => read(1)[0];
  const boolean = () => { const value = b(); assert(value <= 1); return value === 1; };
  const wide = () => { const value = read(16); return value.readBigUInt64LE() + (value.readBigUInt64LE(8) << 64n); };
  let result;
  if (data[0] === 1) result = { authority: p(), platform: p(), bountySource: b(), minimum: n(), maximum: n() };
  else if (data[0] === 7) result = { config: p(), mint: p(), hook: p(), reserveRecipient: p(), buyback: boolean(), distribution: boolean(), platform: boolean(),
    nonce: n(), received: n(), balances: Array.from({ length: 5 }, n), bounty: n(), bountyPaid: n(), spent: n(), rewardTokens: n(), rewardCost: n(),
    burned: n(), platformBurned: n(), recipientsPaid: n(), timelock: p(), paused: b(), weights: Array.from({ length: 5 }, () => read(2).readUInt16LE()), policyRevision: n() };
  else if (data[0] === 8) result = { config: p(), timelock: p(), paused: b(), revision: n() };
  else if (data[0] === 16) result = { config: p(), mint: p(), team: p(), tokenProgram: p(), initial: n(), remaining: n(), genesis: read(8).readBigInt64LE(),
    releaseBasis: b(), quorum: n(), weightCapSeconds: read(4).readUInt32LE(), nextRound: n(), active: boolean() };
  else if (data[0] === 17) result = { governance: p(), number: n(), end: read(8).readBigInt64LE(), pot: n(), yes: wide(), no: wide(), yesStake: n(), noStake: n(),
    outcome: b(), rewardRemaining: n(), weightRemaining: wide() };
  else if (data[0] === 18) result = { round: p(), voter: p(), support: boolean(), stake: n(), weight: wide(), withdrawn: boolean() };
  else if (data[0] === 19) result = { round: p(), team: p(), amount: n(), claimed: boolean() };
  else if (data[0] === 3) result = { nonce: n() };
  else throw Error('Unknown SingleSpark account version');
  assert.equal(offset, data.length, 'Unexpected state length'); return result;
}

// Mirrors governance.rs, including the final winner's rounding dust. No floating-point token math.
export function voteReward(round, vote) {
  if (!vote || vote.withdrawn || vote.stake === 0n) return 0n;
  if (round.outcome === 3 || (round.outcome === 1 && !vote.support) || (round.outcome === 2 && vote.support)) return 0n;
  const total = vote.support ? round.yes : round.no;
  if (total === 0n) return 0n;
  if (round.outcome !== 0 && vote.weight === round.weightRemaining) return round.rewardRemaining;
  return (round.pot - round.pot * 90n / 100n) * vote.weight / total;
}

function vaultOperation(v, instruction) {
  assert(vaultAddress(v.program, v.config, v.mint).equals(pk(v.hook)), 'Unexpected vault PDA');
  instruction.keys.push(meta(v.authority, false, true), meta(tokenAddress(NATIVE_MINT, v.hook), true),
    meta(NATIVE_MINT), meta(TOKEN_PROGRAM_ID), meta(ASSOCIATED_TOKEN_PROGRAM_ID), meta(pluginGateAddress(v.program,v.config)));
  return [createAta(v.payer, NATIVE_MINT, v.hook), instruction];
}

export const pluginGateAddress = (program, config) => derive(program, Buffer.from('plugins'), key(config));
export const UPGRADE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export const UPGRADE_DELAY_SECONDS = 172800;
export const programDataAddress = program => derive(UPGRADE_LOADER, key(program));
export const timelockAddress = (timelock, program) => derive(timelock, Buffer.from('upgrade'), key(program));
export function initializeTimelock(v) {
  return ix(v.timelock, 0, [meta(v.admin, true, true), meta(timelockAddress(v.timelock, v.program), true),
    meta(v.program), meta(programDataAddress(v.program), true), meta(v.timelock), meta(programDataAddress(v.timelock)),
    meta(SystemProgram.programId), meta(UPGRADE_LOADER)]);
}
export function pluginParameters(v) {
  assert(v.weights.length === 5 && v.weights.every(n => Number.isInteger(n) && n >= 0 && n <= 10000));
  assert([9900, 10000].includes(v.weights.reduce((a,b) => a+b,0)) && Number.isInteger(v.paused) && v.paused >= 0 && v.paused <= 3);
  const weights = Buffer.alloc(10); v.weights.forEach((n,i) => weights.writeUInt16LE(n,i*2));
  return Buffer.concat([bool(v.buyback), bool(v.distribution), weights, byte(v.paused)]);
}
export function pausePlugins(v) {
  assert(Number.isInteger(v.mask) && v.mask > 0 && v.mask <= 3);
  return ix(v.program, 7, [meta(v.authority, false, true), meta(v.config), meta(projectAddress(v.program,v.hook),true)], byte(v.mask));
}
export function pauseAllPlugins(v) {
  assert(Number.isInteger(v.mask) && v.mask > 0 && v.mask <= 3);
  return ix(v.program,9,[meta(v.authority,false,true),meta(v.config),meta(pluginGateAddress(v.program,v.config),true)],byte(v.mask));
}
export function scheduleGlobalResume(v) {
  assert(Number.isInteger(v.mask) && v.mask > 0 && v.mask <= 3);
  return lockOperation({ ...v, buffer: pluginGateAddress(v.program,v.config) },5,byte(v.mask));
}
export function scheduleUpgrade(v) { return lockOperation(v, 1); }
export function schedulePlugins(v) { return lockOperation(v, 4, pluginParameters(v.change)); }
export function cancelScheduled(v) { return lockOperation(v, 2); }
export function executeScheduled(v) { return lockOperation(v, 3); }
function lockOperation(v, tag, data = Buffer.alloc(0)) {
  const keys = [meta(v.admin,true,tag !== 3), meta(timelockAddress(v.timelock,v.program),true),
    meta(v.program,tag === 3), meta(programDataAddress(v.program),tag === 3), meta(v.buffer,true), meta(UPGRADE_LOADER)];
  if (tag === 4 || tag === 5 || tag === 3 && v.config) keys.push(meta(v.config));
  else if (tag === 3) keys.push(meta(SYSVAR_RENT_PUBKEY),meta(SYSVAR_CLOCK_PUBKEY));
  if (tag === 3 && v.hook) { assert(v.config); keys.push(meta(v.hook),meta(tokenAddress(NATIVE_MINT,v.hook))); }
  return ix(v.timelock,tag,keys,data);
}
export function decodeTimelock(info, timelock, program) {
  assert(info?.owner.equals(pk(timelock)) && info.data.length === 190, 'Invalid timelock state');
  const d = info.data;
  const result = { program: new PublicKey(d.subarray(0,32)).toBase58(), admin: new PublicKey(d.subarray(32,64)).toBase58(),
    buffer: new PublicKey(d.subarray(64,96)).toBase58(), digest: d.subarray(96,128).toString('hex'),
    executableAt: d.readBigInt64LE(128), action: d[136], config: new PublicKey(d.subarray(137,169)).toBase58(), parameters: d.subarray(169,182), policyRevision: d.readBigUInt64LE(182) };
  assert(result.program === pk(program).toBase58() && result.action <= 2, 'Timelock program mismatch'); return result;
}
