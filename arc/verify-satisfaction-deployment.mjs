// Read-only verification of a satisfaction deployment: compiled runtime code, bindings, parameters and the
// spent one-shot authorities. Only eth_call level requests (readContract / getCode / getChainId / call); it never
// signs, sends or reads a key. Usage:
//   ARC_RPC_URL=... node SingleSparkContract/arc/verify-satisfaction-deployment.mjs <deployment.json> <report.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { ContractFunctionRevertedError, createPublicClient, http, keccak256, parseEther, parseUnits } from 'viem';
import { artifact } from './deploy.mjs';
import { resolveProfile } from './chains/profile.mjs';

const [deploymentPath, reportPath] = process.argv.slice(2);
if (!deploymentPath || !reportPath || !process.env.ARC_RPC_URL) {
  throw new Error('Usage: ARC_RPC_URL=... node SingleSparkContract/arc/verify-satisfaction-deployment.mjs <deployment.json> <report.json>');
}
const record = JSON.parse(readFileSync(deploymentPath, 'utf8'));
const deployment = record.deployment || record;
const client = createPublicClient({ transport: http(process.env.ARC_RPC_URL) });

const checks = [];
const normalize = (value) => {
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return /^0x[0-9a-fA-F]*$/.test(value) ? value.toLowerCase() : value;
  if (value === null || value === undefined) return String(value);
  return JSON.stringify(value);
};
const check = async (name, expected, read) => {
  let actual;
  try { actual = normalize(await read()); }
  catch (error) { actual = `error: ${error.shortMessage || error.message}`; }
  const entry = { name, expected: normalize(expected), actual, ok: normalize(expected) === actual };
  checks.push(entry);
  return entry.ok;
};
const read = (name, address, functionName, args = []) => client.readContract({ address, abi: artifact(name).abi, functionName, args });
// The deployer is read from the contract itself; the record carries no deployer address and this stays read-only.
const revertOf = async (address, name, functionName, args, account, value) => {
  try {
    await client.simulateContract({ address, abi: artifact(name).abi, functionName, args, account, ...(value === undefined ? {} : { value }) });
    return 'no revert';
  } catch (error) {
    const reverted = error.walk?.(e => e instanceof ContractFunctionRevertedError);
    if (!reverted) return `call failed: ${error.shortMessage || error.message}`;
    return reverted.data?.errorName || reverted.signature || reverted.reason || 'unknown revert';
  }
};

// 1. Chain, and the committed profile for it (ARC_CHAIN_PROFILE names a profile file for a local chain).
await check('chain.id', deployment.chainId, () => client.getChainId());
const profile = resolveProfile(deployment.chainId);

const required = ['launch', 'strategy', 'rewards', 'satisfaction', 'keeperExecutor', 'platformToken'];
const missing = required.filter(key => !deployment[key]);
checks.push({ name: 'record.contracts', expected: required.join(', '), actual: missing.length ? `missing: ${missing.join(', ')}` : required.join(', '), ok: missing.length === 0 });
if (missing.length) {
  const report = { status: 'failed', checkedAt: new Date().toISOString(), deployment, checks,
    verification: 'The deployment record does not describe a satisfaction deployment.' };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, reportPath, failed: checks.filter(c => !c.ok).map(c => c.name) }, null, 2));
  process.exit(1);
}

// 2. On-chain runtime code equals the local artifact. Contracts with immutables differ in the immutable slots
//    only, so both sides are zeroed there first — the same masking verify-v2-testnet.mjs uses.
const contracts = { launch: 'ArcLaunchV2', strategy: 'ArcLaunchStrategy', rewards: 'ArcRewards',
  satisfaction: 'ArcSatisfaction', keeperExecutor: 'ArcKeeperExecutor', platformToken: 'ArcToken' };
const codeHashes = {};
for (const [key, name] of Object.entries(contracts)) {
  const compiled = (name === 'ArcToken' ? artifact('ArcLaunch', name) : artifact(name)).deployedBytecode;
  const expected = Buffer.from(compiled.object.slice(2), 'hex');
  const immutables = Object.values(compiled.immutableReferences || {}).flat();
  await check(`code.${key} (${name}${immutables.length ? `, ${immutables.length} immutable slots masked` : ''})`,
    (() => { for (const { start, length } of immutables) expected.fill(0, start, start + length); return keccak256(expected); })(),
    async () => {
      const code = await client.getCode({ address: deployment[key] });
      if (!code || code === '0x') throw new Error(`no code at ${deployment[key]}`);
      codeHashes[key] = keccak256(code);
      const actual = Buffer.from(code.slice(2), 'hex');
      for (const { start, length } of immutables) actual.fill(0, start, start + length);
      return keccak256(actual);
    });
}

// 3. Bindings.
await check('factory.operations == satisfaction vault', deployment.satisfaction, () => read('ArcLaunchV2', deployment.launch, 'operations'));
await check('factory.keeper == keeper executor', deployment.keeperExecutor, () => read('ArcLaunchV2', deployment.launch, 'keeper'));
await check('factory.platformToken', deployment.platformToken, () => read('ArcLaunchV2', deployment.launch, 'platformToken'));
await check('vault.factory == factory', deployment.launch, () => read('ArcSatisfaction', deployment.satisfaction, 'factory'));
await check('vault.token == factory.platformToken', await read('ArcLaunchV2', deployment.launch, 'platformToken').catch(() => deployment.platformToken),
  () => read('ArcSatisfaction', deployment.satisfaction, 'token'));
await check('executor.factory == factory', deployment.launch, () => read('ArcKeeperExecutor', deployment.keeperExecutor, 'factory'));
await check('platform rewards.keeper == keeper executor', deployment.keeperExecutor, () => read('ArcRewards', deployment.rewards, 'keeper'));
await check('factory.terms(platformToken).rewards', deployment.rewards, async () => (await read('ArcLaunchV2', deployment.launch, 'terms', [deployment.platformToken]))[2]);
if (deployment.platformCommunity != null) {
  await check('factory.terms(platformToken).community', deployment.platformCommunity,
    async () => (await read('ArcLaunchV2', deployment.launch, 'terms', [deployment.platformToken]))[1]);
}

// 4. Parameters.
const params = deployment.satisfactionParams || {};
await check('vault.team', params.team ?? '(missing satisfactionParams.team)', () => read('ArcSatisfaction', deployment.satisfaction, 'team'));
await check('vault.roundDuration', params.roundDuration ?? '(missing satisfactionParams.roundDuration)', () => read('ArcSatisfaction', deployment.satisfaction, 'roundDuration'));
await check('vault.votingDuration', params.votingDuration ?? '(missing satisfactionParams.votingDuration)', () => read('ArcSatisfaction', deployment.satisfaction, 'votingDuration'));
await check('vault.quorum', params.quorum === undefined ? '(missing satisfactionParams.quorum)' : parseUnits(String(params.quorum), 18),
  () => read('ArcSatisfaction', deployment.satisfaction, 'quorum'));
await check('vault.TEAM_BPS', 1000n, () => read('ArcSatisfaction', deployment.satisfaction, 'TEAM_BPS'));
await check('vault.SATISFACTION_VERSION', 3n, () => read('ArcSatisfaction', deployment.satisfaction, 'SATISFACTION_VERSION'));
await check('executor.owner', deployment.keeperOwner ?? '(missing keeperOwner)', () => read('ArcKeeperExecutor', deployment.keeperExecutor, 'owner'));
// After a rotation the record keeps `keeperOperator` as the operator at deployment and names the current one in its history.
await check('executor.operator', deployment.keeperOperatorHistory?.find(entry => entry.since && !entry.until)?.address
  ?? deployment.keeperOperator ?? '(missing keeperOperator)', () => read('ArcKeeperExecutor', deployment.keeperExecutor, 'operator'));
await check('executor.KEEPER_EXECUTOR_VERSION', 1n, () => read('ArcKeeperExecutor', deployment.keeperExecutor, 'KEEPER_EXECUTOR_VERSION'));
const { keeperGas } = profile.economics;
await check('executor.OPERATOR_GAS_TARGET == profile keeperGas.trigger', keeperGas.trigger, () => read('ArcKeeperExecutor', deployment.keeperExecutor, 'OPERATOR_GAS_TARGET'));
for (const [fn, value] of Object.entries({ KEEPER_GAS_TRIGGER: keeperGas.trigger, KEEPER_GAS_BUFFER: keeperGas.buffer,
  KEEPER_GAS_MAX_TOPUP: keeperGas.maxTopup, KEEPER_GAS_MIN_TOPUP: keeperGas.minTopup, KEEPER_GAS_DAILY_LIMIT: keeperGas.dailyLimit })) {
  await check(`factory.${fn}`, value, () => read('ArcLaunchV2', deployment.launch, fn));
}
await check('strategy.HALF_SUPPLY_COST', profile.economics.halfSupplyCost, () => read('ArcLaunchStrategy', deployment.strategy, 'HALF_SUPPLY_COST'));
await check('strategy.MIN_LAUNCH_TICK', profile.economics.minLaunchTick, () => read('ArcLaunchStrategy', deployment.strategy, 'MIN_LAUNCH_TICK'));
await check('factory.ECONOMICS_VERSION', 3n, () => read('ArcLaunchV2', deployment.launch, 'ECONOMICS_VERSION'));
await check('factory.KEEPER_PRICE_GUARD_VERSION', 2n, () => read('ArcLaunchV2', deployment.launch, 'KEEPER_PRICE_GUARD_VERSION'));
await check('factory.minBuyback', parseEther(String(deployment.minBuyback)), () => read('ArcLaunchV2', deployment.launch, 'minBuyback'));
await check('platform token buy fee', deployment.platformBuyFee, async () => (await read('ArcLaunchV2', deployment.launch, 'tradeFees', [deployment.platformToken]))[0]);
await check('platform token sell fee', deployment.platformSellFee, async () => (await read('ArcLaunchV2', deployment.launch, 'tradeFees', [deployment.platformToken]))[1]);

// 5. The one-shot binding authority is spent: the original administrator can no longer call configure.
for (const [key, name] of [['satisfaction', 'ArcSatisfaction'], ['keeperExecutor', 'ArcKeeperExecutor']]) {
  await check(`${name}.configure is spent (Unauthorized for its administrator)`, 'Unauthorized', async () => {
    const administrator = await read(name, deployment[key], 'administrator');
    return revertOf(deployment[key], name, 'configure', [deployment.launch], administrator);
  });
}

// 6. The factory carries the new buyback entry point: a zero-value call decodes to InvalidAmount.
await check('factory.fundPlatformBuyback() with zero value reverts InvalidAmount', 'InvalidAmount',
  () => revertOf(deployment.launch, 'ArcLaunchV2', 'fundPlatformBuyback', [], deployment.satisfaction, 0n));

const failed = checks.filter(c => !c.ok);
const report = { status: failed.length ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
  chainId: deployment.chainId, deployment, checks, codeHashes,
  contracts: { factory: deployment.launch, strategy: deployment.strategy, rewards: deployment.rewards,
    satisfaction: deployment.satisfaction, keeperExecutor: deployment.keeperExecutor, platformToken: deployment.platformToken },
  failedChecks: failed.map(c => c.name),
  verification: 'Read-only: compiled runtime code (immutable slots masked), on-chain bindings, vault and executor parameters, '
    + 'spent one-shot configure authority and the fundPlatformBuyback entry point. No transaction was signed or sent.' };
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, reportPath, checks: checks.length, failed: report.failedChecks }, null, 2));
if (failed.length) process.exit(1);
