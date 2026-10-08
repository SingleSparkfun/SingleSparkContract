import { readFileSync, mkdirSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, parseUnits, formatUnits, parseEventLogs, getAddress, keccak256, zeroAddress, encodeDeployData, encodeFunctionData, parseTransaction, recoverTransactionAddress, getCreate2Address, toHex, concatHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { stringify, persist } from './runtime.mjs';
import { arcAbi } from '../../SingleSparkFront/front/web3/arcAbi.ts';
import { loadChainProfile, keeperGasArgument, profileSummary } from './chains/profile.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
export function artifact(file, contract = file) {
  return JSON.parse(readFileSync(resolve(root, `out/${file}.sol/${contract}.json`), 'utf8'));
}

// Every number the contracts take from the chain (curve, keeper gas, minimum buyback, V4 addresses) comes from
// the chain profile, `SingleSparkContract/arc/chains/<chainId>.json` for the connected chain unless `profile` is passed (a
// parsed profile, e.g. the synthetic test profile on a local anvil). `positionManager` and `minBuyback` (a
// decimal native amount) may still be given explicitly: local checks deploy their own V4 and use tiny
// thresholds; the CLI below and deploy-production.mjs refuse any value that differs from the profile.
export async function deployArc(client, wallet, { positionManager, keeper, operations, platformName, platformSymbol, platformMetadataURI = '', minBuyback, journalPath, withRewards = false, version = 3, platformBuyFee = 30_000, platformSellFee = 30_000, satisfaction, executor, profile }) {
  if (![1, 3].includes(version)) throw new Error('Unsupported economics version');
  // The satisfaction vault and the keeper executor replace the plain `operations` / `keeper` addresses; require
  // whichever of the two is not deployed here.
  if (version === 3 && ((!satisfaction && !operations) || (!executor && !keeper)
    || (operations && keeper && operations.toLowerCase() === keeper.toLowerCase())
    || [platformBuyFee, platformSellFee].some(fee => !Number.isInteger(fee) || fee < 0 || fee > 100_000))) throw new Error('Independent 0–10% buy/sell fees and distinct keeper/platform roles are required');
  if ((satisfaction || executor) && version !== 3) throw new Error('Satisfaction vault and keeper executor require the USDC fee model');
  // `satisfaction` carries no default here on purpose: the caller must state the durations, and the
  // schedule the owner chose for future deployments is roundDuration 604800 s with votingDuration
  // 601200 s (6 d 23 h). The vault is immutable, so read what that implies in SingleSparkContract/arc/README.md first:
  // the pot is fixed about an hour into the round, and a quorum-sized stake must be in by mid-window
  // or the round is Void. A local or fast testnet run passes its own short durations instead.
  if (satisfaction) {
    if (operations) throw new Error('The satisfaction vault becomes the factory operations address; do not also pass operations');
    const { team, roundDuration, votingDuration, quorum } = satisfaction;
    if (!team || team === zeroAddress || !Number.isSafeInteger(roundDuration) || !Number.isSafeInteger(votingDuration)
      || votingDuration <= 0 || votingDuration >= roundDuration || !/^\d+(\.\d{1,18})?$/.test(String(quorum)) || Number(quorum) <= 0) {
      throw new Error('Invalid satisfaction parameters');
    }
  }
  if (executor) {
    if (keeper) throw new Error('The keeper executor becomes the factory keeper; pass executor.operator instead of keeper');
    if (!executor.owner || executor.owner === zeroAddress || !executor.operator || executor.operator === zeroAddress) throw new Error('Invalid executor parameters');
  }
  const factory = version === 3 ? 'ArcLaunchV2' : 'ArcLaunch';
  if ((artifact(factory).deployedBytecode.object.length - 2) / 2 > 24_576) throw new Error('Factory exceeds EIP-170 runtime size limit; do not broadcast');
  for (const [option, name] of [[satisfaction, 'ArcSatisfaction'], [executor, 'ArcKeeperExecutor']]) {
    if (option && (artifact(name).deployedBytecode.object.length - 2) / 2 > 24_576) throw new Error(`${name} exceeds EIP-170 runtime size limit; do not broadcast`);
  }
  const chainId = await client.getChainId();
  profile ??= loadChainProfile(chainId);
  if (profile.chainId !== chainId || chainId !== wallet.chain.id) throw new Error(`Connected to chain ${chainId}, but the profile and wallet are for ${profile.chainId} / ${wallet.chain.id}`);
  // The legacy V1 factory still carries its own Arc-only chain check.
  if (version === 1 && ![5042, 5042002].includes(chainId)) throw new Error('The legacy factory is Arc-only');
  positionManager ||= profile.uniswapV4.positionManager;
  if (!positionManager) throw new Error(`Profile ${profile.name} has no PositionManager; pass one explicitly`);
  const minBuybackWei = minBuyback === undefined ? profile.economics.minBuyback : parseUnits(String(minBuyback), 18);
  if (minBuybackWei <= 0n) throw new Error('minBuyback must be positive');
  minBuyback = formatUnits(minBuybackWei, 18); // the record keeps the decimal form older verifiers parse
  const economics = profile.economics;
  if (!await client.getCode({ address: positionManager })) throw new Error('PositionManager has no code');
  const create2 = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
  if (version === 3 && !await client.getCode({ address: create2 })) throw new Error('The standard CREATE2 deployer is required for the fee hook');
  if (!platformName || !/^[A-Za-z0-9]{1,12}$/.test(platformSymbol)) throw new Error('Platform token name and symbol are required');
  if (new TextEncoder().encode(platformMetadataURI).length > 512) throw new Error('Platform metadata URI exceeds 512 bytes');
  const identity = stringify({ chainId, profile: profileSummary(profile), deployer: wallet.account.address.toLowerCase(), positionManager: positionManager.toLowerCase(),
    keeper: executor ? null : keeper.toLowerCase(), operations: satisfaction ? null : operations.toLowerCase(), platformName, platformSymbol, minBuyback,
    ...(platformMetadataURI ? { platformMetadataURI } : {}),
    launchBytecodeHash: keccak256(artifact(factory).bytecode.object), ...(version === 3 ? { version, platformCommunity: zeroAddress, platformBuyFee, platformSellFee, strategyBytecodeHash: keccak256(artifact('ArcLaunchStrategy').bytecode.object), projectTreasuryDeployerBytecodeHash: keccak256(artifact('ArcProjectTreasuryDeployer').bytecode.object) } : {}), ...(withRewards || version === 3 ? {
      rewardsBytecodeHash: keccak256(artifact('ArcRewards').bytecode.object),
    } : {}),
    ...(satisfaction ? { satisfaction: { team: satisfaction.team.toLowerCase(), roundDuration: satisfaction.roundDuration,
      votingDuration: satisfaction.votingDuration, quorum: String(satisfaction.quorum) },
      satisfactionBytecodeHash: keccak256(artifact('ArcSatisfaction').bytecode.object) } : {}),
    ...(executor ? { executor: { owner: executor.owner.toLowerCase(), operator: executor.operator.toLowerCase() },
      executorBytecodeHash: keccak256(artifact('ArcKeeperExecutor').bytecode.object) } : {}) });
  let journal = { identity, fromBlock: String(await client.getBlockNumber()), steps: {} };
  if (journalPath) {
    try { journal = JSON.parse(readFileSync(journalPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (journal.identity !== identity) throw new Error('Deployment journal configuration mismatch');
  }
  const fromBlock = BigInt(journal.fromBlock);
  const broadcast = async (label, transaction) => {
    let step = journal.steps[label];
    if (!step) {
      const [latest, pending] = await Promise.all(['latest', 'pending'].map(blockTag => client.getTransactionCount({ address: wallet.account.address, blockTag })));
      if (latest !== pending) throw new Error('Deployer has another pending transaction');
      const request = await wallet.prepareTransactionRequest({ ...transaction, nonce: pending });
      if (profile.testnet && request.gas * (request.maxFeePerGas ?? request.gasPrice) > parseUnits('1', 18)) throw new Error(`Deployment transaction exceeds 1 test ${profile.nativeCurrency.symbol} gas budget`);
      const raw = await wallet.signTransaction(request);
      step = { raw, hash: keccak256(raw) };
      journal.steps[label] = step;
      if (journalPath) persist(journalPath, journal);
    }
    if (keccak256(step.raw) !== step.hash) throw new Error('Deployment journal hash mismatch');
    const decoded = parseTransaction(step.raw);
    if (decoded.chainId !== chainId || (decoded.to || '').toLowerCase() !== (transaction.to || '').toLowerCase()
      || decoded.data !== transaction.data || (decoded.value || 0n) !== (transaction.value || 0n)
      || (await recoverTransactionAddress({ serializedTransaction: step.raw })).toLowerCase() !== wallet.account.address.toLowerCase()) {
      throw new Error(`Deployment journal transaction mismatch: ${label}`);
    }
    let receipt;
    try { receipt = await client.getTransactionReceipt({ hash: step.hash }); }
    catch (error) { if (error.name !== 'TransactionReceiptNotFoundError') throw error; }
    if (!receipt) {
      try { await client.sendRawTransaction({ serializedTransaction: step.raw }); }
      catch (error) { if (!/already known|nonce too low|known transaction/i.test(error.message)) throw error; }
      receipt = await client.waitForTransactionReceipt({ hash: step.hash, timeout: 120_000 });
    }
    if (receipt.status !== 'success') throw new Error(`${label} reverted: ${step.hash}`);
    return receipt;
  };
  const deploy = async (name, args) => {
    const compiled = artifact(name);
    const data = encodeDeployData({ abi: compiled.abi, bytecode: compiled.bytecode.object, args });
    if (name === 'ArcLaunchStrategy') {
      const bytecodeHash = keccak256(data);
      for (let value = 0; value < 1_000_000; value++) {
        const salt = toHex(value, { size: 32 });
        const address = getCreate2Address({ from: create2, bytecodeHash, salt });
        if ((BigInt(address) & 0x3fffn) !== 0x28ecn) continue; // Initialize/add restrictions, swap deltas, and donation restriction.
        // The constructor refuses a curve the opening-tick search cannot solve; find out before broadcasting.
        if (!journal.steps[name]) await client.call({ account: wallet.account, to: create2, data: concatHex([salt, data]) });
        await broadcast(name, { to: create2, data: concatHex([salt, data]) });
        if (!await client.getCode({ address })) throw new Error('Fee hook deployment has no code');
        return address;
      }
      throw new Error('No matching launch hook salt found');
    }
    const receipt = await broadcast(name, { data });
    if (!receipt.contractAddress || !await client.getCode({ address: receipt.contractAddress })) throw new Error(`Deployment has no code: ${name}`);
    return receipt.contractAddress;
  };
  // Both record `msg.sender` as their administrator, so they must be created directly by the deployer account.
  const vault = satisfaction ? await deploy('ArcSatisfaction', [satisfaction.team, BigInt(satisfaction.roundDuration),
    BigInt(satisfaction.votingDuration), parseUnits(String(satisfaction.quorum), 18)]) : undefined;
  const keeperExecutor = executor ? await deploy('ArcKeeperExecutor', [executor.owner, executor.operator, economics.keeperGas.trigger]) : undefined;
  const operationsAddress = vault ?? operations;
  const keeperAddress = keeperExecutor ?? keeper;
  if (version === 3 && operationsAddress.toLowerCase() === keeperAddress.toLowerCase()) throw new Error('Operations and keeper must be distinct');
  const launch = await deploy(factory, [positionManager, keeperAddress, operationsAddress, minBuybackWei,
    ...(version === 3 ? [keeperGasArgument(profile)] : [])]);
  const projectTreasuryDeployer = version === 3 ? await client.readContract({ address: launch, abi: artifact(factory).abi, functionName: 'projectTreasuryDeployer' }) : undefined;
  const feeSplitter = await deploy('FeeSplitter', [positionManager, [{ recipient: launch, nativeBps: 10_000, tokenBps: 10_000, useCallback: true }]]);
  const poolManager = await client.readContract({ address: positionManager, abi: artifact('PositionManager').abi, functionName: 'poolManager' });
  // Read the newly deployed factory's constraint so the strategy cannot drift from its economics.
  const initialTick = version === 1 ? await client.readContract({ address: launch, abi: artifact(factory).abi, functionName: 'INITIAL_TICK' }) : undefined;
  const strategy = version === 3 ? await deploy('ArcLaunchStrategy', [launch, positionManager, feeSplitter, economics.halfSupplyCost, economics.minLaunchTick])
    : await deploy('InstantLaunchStrategy', [launch, positionManager, poolManager, feeSplitter, zeroAddress, initialTick]);
  const quoter = await deploy('V4Quoter', [poolManager]);
  const write = async (functionName, args) => {
    if (!journal.steps[functionName]) await client.simulateContract({ address: launch, abi: artifact(factory).abi, functionName, args, account: wallet.account });
    return broadcast(functionName, { to: launch, data: encodeFunctionData({ abi: artifact(factory).abi, functionName, args }) });
  };
  await write('configure', [strategy]);
  const receipt = await write('launch', [platformName, platformSymbol, platformMetadataURI, ...(version === 3 ? [platformBuyFee, platformSellFee, zeroAddress] : [])]);
  const platformToken = parseEventLogs({ abi: arcAbi, eventName: 'Launched', logs: receipt.logs })[0].args.token;
  if (version === 1) await write('setPlatformToken', [platformToken]);
  if (version === 3) await write('setProjectTeam', [satisfaction?.team ?? operations]);
  // The factory's own `configure` already owns that journal label; bind the two satellites under their own labels.
  const bind = async (label, address, name) => {
    const abi = artifact(name).abi;
    const data = encodeFunctionData({ abi, functionName: 'configure', args: [launch] });
    if (!journal.steps[label]) await client.simulateContract({ address, abi, functionName: 'configure', args: [launch], account: wallet.account });
    return broadcast(label, { to: address, data });
  };
  if (vault) await bind('satisfactionConfigure', vault, 'ArcSatisfaction');
  if (keeperExecutor) await bind('executorConfigure', keeperExecutor, 'ArcKeeperExecutor');
  let rewards;
  if (version === 3) {
    if (await client.readContract({ address: launch, abi: artifact(factory).abi, functionName: 'ECONOMICS_VERSION' }) !== 3n) throw new Error('USDC fee model version mismatch');
    rewards = (await client.readContract({ address: launch, abi: artifact(factory).abi, functionName: 'terms', args: [platformToken] }))[2];
    if (await client.readContract({ address: launch, abi: artifact(factory).abi, functionName: 'KEEPER_PRICE_GUARD_VERSION' }) !== 2n) throw new Error('Keeper guard version mismatch');
    if (await client.readContract({ address: strategy, abi: artifact('ArcLaunchStrategy').abi, functionName: 'launchProtectionVersion' }) !== 2n) throw new Error('Launch protection version mismatch');
    // The profile's numbers are what the chain now holds.
    const expected = { KEEPER_GAS_TRIGGER: economics.keeperGas.trigger, KEEPER_GAS_BUFFER: economics.keeperGas.buffer,
      KEEPER_GAS_MAX_TOPUP: economics.keeperGas.maxTopup, KEEPER_GAS_MIN_TOPUP: economics.keeperGas.minTopup,
      KEEPER_GAS_DAILY_LIMIT: economics.keeperGas.dailyLimit, minBuyback: minBuybackWei };
    for (const [functionName, value] of Object.entries(expected)) {
      if (await client.readContract({ address: launch, abi: artifact(factory).abi, functionName }) !== value) throw new Error(`Factory ${functionName} does not match the profile`);
    }
    const strategyAbi = artifact('ArcLaunchStrategy').abi;
    if (await client.readContract({ address: strategy, abi: strategyAbi, functionName: 'HALF_SUPPLY_COST' }) !== economics.halfSupplyCost
      || await client.readContract({ address: strategy, abi: strategyAbi, functionName: 'MIN_LAUNCH_TICK' }) !== economics.minLaunchTick) throw new Error('Strategy curve does not match the profile');
  } else if (withRewards) {
    rewards = await deploy('ArcRewards', [platformToken, launch, keeperAddress]);
    await write('setRewards', [rewards]);
  }
  // Refuse to hand back a deployment record whose satellites are not bound exactly as intended.
  const at = (name, address, functionName) => client.readContract({ address, abi: artifact(name).abi, functionName });
  const same = (actual, expected) => actual.toLowerCase() === expected.toLowerCase();
  if (vault) {
    if (await at('ArcSatisfaction', vault, 'SATISFACTION_VERSION') !== 3n) throw new Error('Satisfaction vault version mismatch');
    if (!same(await at('ArcSatisfaction', vault, 'factory'), launch) || !same(await at('ArcSatisfaction', vault, 'token'), platformToken)
      || !same(await at(factory, launch, 'operations'), vault)) throw new Error('Satisfaction vault is not bound to this deployment');
  }
  if (version === 3 && (!same(await at(factory, launch, 'projectTeam'), satisfaction?.team ?? operations)
    || !same(await at(factory, launch, 'projectTreasuryDeployer'), projectTreasuryDeployer))) {
    throw new Error('Project treasury team or deployer is not bound to this deployment');
  }
  if (keeperExecutor) {
    if (await at('ArcKeeperExecutor', keeperExecutor, 'KEEPER_EXECUTOR_VERSION') !== 1n) throw new Error('Keeper executor version mismatch');
    if (await at('ArcKeeperExecutor', keeperExecutor, 'OPERATOR_GAS_TARGET') !== economics.keeperGas.trigger) throw new Error('Keeper executor gas target does not match the profile');
    if (!same(await at('ArcKeeperExecutor', keeperExecutor, 'factory'), launch) || !same(await at(factory, launch, 'keeper'), keeperExecutor)
      || !same(await at('ArcKeeperExecutor', keeperExecutor, 'owner'), executor.owner)
      || !same(await at('ArcKeeperExecutor', keeperExecutor, 'operator'), executor.operator)) throw new Error('Keeper executor is not bound to this deployment');
    if (rewards && !same(await at('ArcRewards', rewards, 'keeper'), keeperExecutor)) throw new Error('Platform rewards keeper is not the executor');
  }
  return { chainId, fromBlock: fromBlock.toString(), launch, quoter, strategy, feeSplitter, poolManager, positionManager,
    platformToken, platformName, platformSymbol, keeper: keeperAddress, operations: operationsAddress, minBuyback, ...(version === 1 ? { initialTick } : { economicsVersion: 3, feeCurrency: profile.nativeCurrency.symbol, chainProfile: profileSummary(profile), independentFees: true, keeperPriceGuardVersion: 2, launchProtectionVersion: 2, platformCommunity: zeroAddress, projectTeam: satisfaction?.team ?? operations, projectTreasuryDeployer, platformBuyFee, platformSellFee }),
    ...(vault ? { satisfaction: vault, satisfactionParams: { team: satisfaction.team, roundDuration: satisfaction.roundDuration,
      votingDuration: satisfaction.votingDuration, quorum: String(satisfaction.quorum) } } : {}),
    ...(keeperExecutor ? { keeperExecutor, keeperOwner: executor.owner, keeperOperator: executor.operator } : {}),
    ...(withRewards || version === 3 ? { rewards } : {}), launchCodeHash: keccak256(await client.getCode({ address: launch })),
    transactions: Object.fromEntries(Object.entries(journal.steps).map(([label, step]) => [label, step.hash])) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv.includes('--broadcast')) throw new Error('Use npm run test:arc first; pass --broadcast to deploy with ARC_DEPLOYER_PRIVATE_KEY');
  if (!process.argv.includes('--legacy') && process.env.ARC_PLATFORM_FEE != null) throw new Error('Replace ARC_PLATFORM_FEE with ARC_PLATFORM_BUY_FEE and ARC_PLATFORM_SELL_FEE');
  if (!process.argv.includes('--legacy') && process.env.ARC_COMMUNITY_ADDRESS) throw new Error('SPARK has no project treasury; remove ARC_COMMUNITY_ADDRESS');
  const required = key => { if (!process.env[key]) throw new Error(`Missing ${key}`); return process.env[key]; };
  const chainId = Number(required('ARC_CHAIN_ID'));
  const profile = loadChainProfile(chainId); // refuses a chain with no committed profile
  if (process.argv.includes('--testnet') && !profile.testnet) throw new Error(`--testnet was passed but ${profile.name} (${chainId}) is not a testnet`);
  // The profile is the only source of these numbers for a real deployment.
  if (process.env.ARC_POSITION_MANAGER && getAddress(process.env.ARC_POSITION_MANAGER) !== profile.uniswapV4.positionManager) {
    throw new Error(`ARC_POSITION_MANAGER differs from the ${profile.name} profile; fix SingleSparkContract/arc/chains/${chainId}.json or unset it`);
  }
  if (process.env.ARC_MIN_BUYBACK_USDC && parseUnits(process.env.ARC_MIN_BUYBACK_USDC, 18) !== profile.economics.minBuyback) {
    throw new Error(`ARC_MIN_BUYBACK_USDC differs from the ${profile.name} profile; fix SingleSparkContract/arc/chains/${chainId}.json or unset it`);
  }
  const rpc = required('ARC_RPC_URL');
  const account = privateKeyToAccount(required('ARC_DEPLOYER_PRIVATE_KEY'));
  const chain = defineChain({ id: chainId, name: profile.name, nativeCurrency: profile.nativeCurrency, rpcUrls: { default: { http: [rpc] } } });
  const client = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });
  // Deploying the satisfaction vault or the keeper executor replaces the corresponding plain address variable.
  const satisfactionKeys = ['ARC_SATISFACTION_TEAM', 'ARC_SATISFACTION_ROUND_SECONDS', 'ARC_SATISFACTION_VOTING_SECONDS', 'ARC_SATISFACTION_QUORUM'];
  const executorKeys = ['ARC_KEEPER_OWNER', 'ARC_KEEPER_OPERATOR_ADDRESS'];
  for (const keys of [satisfactionKeys, executorKeys]) {
    const set = keys.filter(key => process.env[key]);
    if (set.length && set.length !== keys.length) throw new Error(`Set all of ${keys.join(', ')} or none of them`);
  }
  const satisfaction = satisfactionKeys.every(key => process.env[key]) ? {
    team: getAddress(process.env.ARC_SATISFACTION_TEAM), roundDuration: Number(process.env.ARC_SATISFACTION_ROUND_SECONDS),
    votingDuration: Number(process.env.ARC_SATISFACTION_VOTING_SECONDS), quorum: process.env.ARC_SATISFACTION_QUORUM,
  } : undefined;
  const executor = executorKeys.every(key => process.env[key])
    ? { owner: getAddress(process.env.ARC_KEEPER_OWNER), operator: getAddress(process.env.ARC_KEEPER_OPERATOR_ADDRESS) } : undefined;
  const keeper = executor?.operator ?? getAddress(required('ARC_KEEPER_ADDRESS'));
  if (!process.argv.includes('--legacy') && keeper.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error('ARC_DEPLOYER_PRIVATE_KEY must belong to the keeper operator wallet');
  }
  const dataDir = resolve(process.env.ARC_DATA_DIR || resolve(root, 'data'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // After an unclean exit, verify the recorded PID stopped before removing only this lock.
  const lockPath = resolve(dataDir, 'deployment.lock');
  const lock = openSync(lockPath, 'wx', 0o600);
  writeFileSync(lock, String(process.pid));
  try {
  const deployment = await deployArc(client, wallet, {
    profile, keeper: executor ? undefined : keeper,
    operations: satisfaction ? undefined : getAddress(required('ARC_OPERATIONS_ADDRESS')), platformName: required('ARC_PLATFORM_NAME'),
    platformSymbol: required('ARC_PLATFORM_SYMBOL'),
    journalPath: resolve(dataDir, 'deployment-journal.json'),
    withRewards: process.argv.includes('--rewards'), version: process.argv.includes('--legacy') ? 1 : 3,
    platformBuyFee: Number(process.env.ARC_PLATFORM_BUY_FEE || 30_000),
    platformSellFee: Number(process.env.ARC_PLATFORM_SELL_FEE || 30_000),
    platformMetadataURI: process.env.ARC_PLATFORM_METADATA_URI || '',
    satisfaction, executor,
  });
  persist(resolve(dataDir, 'deployment.json'), deployment);
  console.log(stringify(deployment));
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
