// End-to-end run of the whole stack against a fork of Arc mainnet, using the real Uniswap v4
// contracts deployed there. A fork is not mainnet: the balances below are conjured by Anvil and
// are test funds, never revenue, and the addresses that receive distributions are synthetic. What
// this does prove is that these contracts deploy and run against mainnet's actual v4 deployment.
//
//   node SingleSparkContract/arc/verify-mainnet-fork.mjs [--out SingleSparkContract/arc/deployments/mainnet-fork-20260920.json]
//
// No key here is ever funded on a public network: they are Anvil's published development keys.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, parseEther, formatEther, erc20Abi,
  parseEventLogs, encodeFunctionData, zeroAddress, getAddress, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deployArc, artifact } from './deploy.mjs';
import { arcAbi } from '../../SingleSparkFront/front/web3/arcAbi.ts';
import { loadChainProfile } from './chains/profile.mjs';

const FORK_RPC = process.env.ARC_MAINNET_RPC ?? 'https://rpc.mainnet.arc.io';
const CHAIN_ID = 5042;
// The committed Arc mainnet profile: its V4 addresses and every number the constructors take.
const PROFILE = loadChainProfile(CHAIN_ID);
// Pinned so the run is reproducible and Anvil can serve most state from its own fork cache
// instead of asking the public endpoint again, which rate-limits.
const FORK_BLOCK = process.env.ARC_MAINNET_FORK_BLOCK ?? '21846439';
// Published by Uniswap for Arc and committed in SingleSparkContract/arc/chains/5042.json (the UniversalRouter is not part of
// the profile, since nothing deploys against it); every one is re-checked on the fork before anything is deployed.
const V4 = {
  ...Object.fromEntries(Object.entries(PROFILE.uniswapV4).filter(([, address]) => address)),
  universalRouter: '0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1',
};
const CREATE2 = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
// What the user settled on for new deployments: a seven-day round with the window one hour short of it.
const ROUND_SECONDS = 604_800;
const VOTING_SECONDS = 601_200;

const outFlag = process.argv.indexOf('--out');
const outPath = resolve(outFlag === -1 ? 'SingleSparkContract/arc/deployments/mainnet-fork-20260920.json' : process.argv[outFlag + 1]);
const steps = [];
const record = (name, detail) => { steps.push({ name, ...detail }); console.log(`✔ ${name}`); };

const reserve = createServer();
await new Promise(r => reserve.listen(0, '127.0.0.1', r));
const port = reserve.address().port;
await new Promise(r => reserve.close(r));
const url = `http://127.0.0.1:${port}`;

// Deterministic but not guessable. Well-known keys — Anvil's published ones, or `0x00..00c3` — are
// already occupied on Arc mainnet: several carry a 23-byte EIP-7702 delegation, the signature of a
// sweeper that forwards anything sent to them. The fork inherits that code, so a payout to such an
// address leaves the vault, succeeds, and never lands. Step 0 below refuses to run if any of these
// addresses carries code on the fork, which is the check that would have caught it immediately.
const testKey = label => keccak256(toHex(`singlespark-mainnet-fork/${label}`));
const deployer = privateKeyToAccount(testKey('deployer'));
const operator = privateKeyToAccount(testKey('keeper-operator'));
const trader = privateKeyToAccount(testKey('trader'));
const voterOne = privateKeyToAccount(testKey('voter-one'));
const voterTwo = privateKeyToAccount(testKey('voter-two'));
const team = privateKeyToAccount(testKey('team')).address;

const chain = defineChain({ id: CHAIN_ID, name: 'Arc Mainnet Fork',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
// Generous: every uncached read on a fork becomes a call to the public endpoint behind Anvil.
const transport = () => http(url, { retryCount: 3, retryDelay: 500, timeout: 180_000 });
const client = createPublicClient({ chain, transport: transport(), cacheTime: 0 });
const wallet = createWalletClient({ account: deployer, chain, transport: transport() });
const walletFor = account => createWalletClient({ account, chain, transport: transport() });
const dir = mkdtempSync(resolve(tmpdir(), 'arc-mainnet-fork-'));

const anvil = spawn('anvil', ['--fork-url', FORK_RPC, '--fork-block-number', String(FORK_BLOCK),
  '--port', String(port), '--chain-id', String(CHAIN_ID), '--silent', '--gas-limit', '60000000',
  '--timeout', '180000', '--retries', '10'], { stdio: ['ignore', 'ignore', 'pipe'] });
let anvilError = '';
anvil.stderr.on('data', b => { anvilError += b; });

const launchAbi = artifact('ArcLaunchV2').abi;
const strategyAbi = artifact('ArcLaunchStrategy').abi;
const rewardsAbi = artifact('ArcRewards').abi;
const vaultAbi = artifact('ArcSatisfaction').abi;
const executorAbi = artifact('ArcKeeperExecutor').abi;

const send = async (account, address, abi, functionName, args = [], value = 0n) => {
  const hash = await walletFor(account).writeContract({ address, abi, functionName, args, value, gas: 30_000_000n });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', `${functionName} reverted`);
  return receipt;
};
const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
const now = async () => (await client.getBlock()).timestamp;
const warp = async seconds => {
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [Number(await now()) + seconds] });
  await client.request({ method: 'evm_mine', params: [] });
};
const fund = (address, amount) =>
  client.request({ method: 'anvil_setBalance', params: [address, `0x${amount.toString(16)}`] });
/** Every keeper action goes through the executor, the way a real deployment would run it. */
const viaKeeper = (executor, target, abi, functionName, args) =>
  send(operator, executor, executorAbi, 'execute', [target, encodeFunctionData({ abi, functionName, args })]);

let status = 'failed', failure;
try {
  for (let i = 0; ; i++) {
    if (anvil.exitCode !== null) throw new Error(`Anvil stopped: ${anvilError}`);
    try { await client.getChainId(); break; } catch (error) { if (i > 60) throw error; await new Promise(r => setTimeout(r, 250)); }
  }
  await client.request({ method: 'anvil_setBlockTimestampInterval', params: [1] });

  // ---- 0. The fork really is Arc mainnet, with the v4 deployment we expect ----------------------
  const forkBlock = await client.getBlockNumber();
  assert.equal(await client.getChainId(), CHAIN_ID);
  const codeSizes = {};
  for (const [name, address] of Object.entries({ ...V4, create2: CREATE2 })) {
    const code = await client.getCode({ address });
    assert(code && code.length > 4, `${name} has no code on the fork`);
    codeSizes[name] = (code.length - 2) / 2;
  }
  assert.equal(getAddress(await read(V4.positionManager, artifact('PositionManager').abi, 'poolManager')),
    getAddress(V4.poolManager), 'the mainnet PositionManager must point at the mainnet PoolManager');
  record('mainnet v4 verified on the fork', { forkBlock: forkBlock.toString(), chainId: CHAIN_ID, codeSizes });

  // Every address we act as, or pay, must be empty on the forked chain. An occupied address would
  // run its own code on a plain value transfer and can swallow a payout while reporting success.
  const occupied = [];
  for (const [name, address] of [['deployer', deployer.address], ['operator', operator.address],
    ['trader', trader.address], ['voterOne', voterOne.address], ['voterTwo', voterTwo.address],
    ['team', team]]) {
    const code = await client.getCode({ address });
    if (code && code !== '0x') occupied.push(`${name} ${address} carries ${(code.length - 2) / 2} bytes`);
  }
  assert.equal(occupied.length, 0, `test accounts must be empty on the fork: ${occupied.join('; ')}`);
  record('test accounts are empty on the fork', { checked: 6 });

  for (const account of [deployer, operator, trader, voterOne, voterTwo]) await fund(account.address, parseEther('2000000'));

  // ---- 1. Deploy the whole stack against mainnet's own PositionManager --------------------------
  const deployment = await deployArc(client, wallet, {
    // PositionManager and minimum buyback come from the profile
    platformName: 'SingleSpark', platformSymbol: 'SPARK', platformBuyFee: 30_000, platformSellFee: 30_000,
    satisfaction: { team, roundDuration: ROUND_SECONDS, votingDuration: VOTING_SECONDS, quorum: 1_000 },
    executor: { owner: deployer.address, operator: operator.address },
    journalPath: resolve(dir, 'deployment.json'),
  });
  const { launch, strategy, platformToken: spark, satisfaction: vault, keeperExecutor: executor, quoter } = deployment;
  await fund(executor, parseEther('5')); // above KEEPER_GAS_TRIGGER, so top-ups stop draining the platform credit
  assert.equal(await read(spark, erc20Abi, 'symbol'), 'SPARK');
  assert.equal(await read(launch, launchAbi, 'TRADE_DEADLINE_WINDOW'), 900n);
  assert.equal(await read(vault, vaultAbi, 'SATISFACTION_VERSION'), 3n);
  record('stack deployed on the fork', { launch, strategy, spark, vault, executor, quoter });

  // ---- 2. A launch: one-sided liquidity through the real PositionManager ------------------------
  const metadataURI = 'https://media.example/api/arc/media/0123456789abcdef.json';
  const treasuryCreated = await send(deployer, launch, launchAbi, 'createProjectTreasury', []);
  const community = parseEventLogs({ abi: launchAbi, eventName: 'ProjectTreasuryCreated', logs: treasuryCreated.logs })[0].args.treasury;
  assert(await client.getCode({ address: community }), 'the project treasury must have code');
  const launched = await send(deployer, launch, launchAbi, 'launch',
    ['Fork Meme', 'FORK', metadataURI, 30_000, 30_000, community]);
  const token = parseEventLogs({ abi: launchAbi, eventName: 'Launched', logs: launched.logs })[0].args.token;
  const [positionId] = await read(launch, launchAbi, 'tokens', [token]);
  const [poolKey] = await read(V4.positionManager, artifact('PositionManager').abi, 'getPoolAndPositionInfo', [positionId]);
  assert.equal(poolKey.currency0, zeroAddress, 'the pool must be quoted in native USDC');
  assert.equal(getAddress(poolKey.currency1), getAddress(token));
  assert.equal(await read(token, erc20Abi, 'totalSupply'), await read(launch, launchAbi, 'SUPPLY'));
  // ERC-7572: the same URI the Launched event carries, readable from the token alone, so an
  // integrator needs neither this factory's address nor its event layout to find the socials.
  const erc7572Abi = [{ type: 'function', name: 'contractURI', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' }];
  assert.equal(await read(token, erc7572Abi, 'contractURI'), metadataURI, 'the token must expose its launch metadata');
  // The WETH9() on mainnet's PositionManager is a stub; the launch above never touches it.
  record('launch minted one-sided liquidity through mainnet v4', {
    contractURI: await read(token, erc7572Abi, 'contractURI'),
    token, positionId: positionId.toString(), weth9Stub: await read(V4.positionManager, [
      { type: 'function', name: 'WETH9', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }], 'WETH9'),
  });

  // ---- 3. The deadline ceiling the 100-wallet run needed ----------------------------------------
  await warp(4); // past the three-second opening ladder
  const atCeiling = await now() + 900n;
  await send(trader, launch, launchAbi, 'trade', [token, true, parseEther('1'), 1n, atCeiling], parseEther('1'));
  // A deadline past the ceiling is refused on chain, not at send time: with an explicit gas limit
  // the node accepts the transaction and the factory reverts it inside the block.
  const tooFar = await walletFor(trader).writeContract({ address: launch, abi: launchAbi, functionName: 'trade',
    args: [token, true, parseEther('1'), 1n, await now() + 902n], value: parseEther('1'), gas: 30_000_000n });
  const refused = await client.waitForTransactionReceipt({ hash: tooFar });
  assert.equal(refused.status, 'reverted', 'a deadline past the window must still be refused');
  // And the old 120 s ceiling is genuinely gone: this is what the wallet now signs.
  await send(trader, launch, launchAbi, 'trade', [token, true, parseEther('1'), 1n, await now() + 600n], parseEther('1'));
  record('deadline window enforced', { accepted: ['600s ahead', '900s ahead'], refused: '902s ahead',
    note: 'the old ceiling was 120s, shorter than the p95 quote-to-block time measured on 2026-09-20' });

  // ---- 4. Real volume, then collection and the five-way split -----------------------------------
  for (let i = 0; i < 4; i++) {
    await send(trader, launch, launchAbi, 'trade', [token, true, parseEther('1000'), 1n, await now() + 600n], parseEther('1000'));
  }
  const bought = await read(token, erc20Abi, 'balanceOf', [trader.address]);
  await send(trader, token, erc20Abi, 'approve', [launch, bought]);
  await send(trader, launch, launchAbi, 'trade', [token, false, bought / 4n, 1n, await now() + 600n]);

  const accrued = await read(strategy, strategyAbi, 'accruedNative', [token]);
  assert(accrued > 0n, 'the hook must have taken native USDC tax');
  const collected = await send(deployer, launch, launchAbi, 'collectFees', [token]);
  const split = parseEventLogs({ abi: launchAbi, eventName: 'FeesAllocated', logs: collected.logs })[0].args;
  const base = split.nativeAmount; // the opening window is over, so nothing is an opening surcharge
  assert.equal(split.ownBuyback, base * 83n / 100n);
  assert.equal(split.jetBuyback, base * 7n / 100n);
  assert.equal(split.distributions, base * 5n / 100n);
  assert.equal(split.community, base * 4n / 100n);
  assert.equal(split.platform, base - split.ownBuyback - split.jetBuyback - split.distributions - split.community);
  await send(deployer, launch, launchAbi, 'claimCommunity', [token]);
  assert.equal(await client.getBalance({ address: community }), split.community,
    'the 4% community share must reach the project voting treasury');
  record('fees collected and split 83/7/5/4/1', {
    collectedUsdc: formatEther(split.nativeAmount), ownBuyback: formatEther(split.ownBuyback),
    sparkBuyback: formatEther(split.jetBuyback), distributions: formatEther(split.distributions),
    community: formatEther(split.community), communityVault: community, platform: formatEther(split.platform),
  });

  // ---- 5. The 83%: buy back and burn the token's own supply -------------------------------------
  await warp(200); // the keeper's 180-second interval
  const supplyBefore = await read(token, erc20Abi, 'totalSupply');
  const [, ownBudget] = await read(launch, launchAbi, 'tokens', [token]);
  const [, ownLimit] = await read(strategy, strategyAbi, 'keeperSwapState', [token, true]);
  const ownSpend = ownBudget < ownLimit ? ownBudget : ownLimit;
  assert(ownSpend >= parseEther('5'), `own buyback budget below the 5 USDC minimum: ${formatEther(ownSpend)}`);
  const burned = await viaKeeper(executor, launch, launchAbi, 'executeBurn', [token, ownSpend, 1n, await now() + 60n]);
  const burnEvent = parseEventLogs({ abi: launchAbi, eventName: 'Burned', logs: burned.logs })[0].args;
  assert.equal(await read(token, erc20Abi, 'totalSupply'), supplyBefore - burnEvent.totalBurned);
  record('83% bought back and burned', { spentUsdc: formatEther(burnEvent.nativeAmount), burned: formatEther(burnEvent.totalBurned) });

  // ---- 6. The 7%: the SPARK budget, a path never executed on a public chain ---------------------
  // Give SPARK its own pool depth first: the keeper may spend at most 0.5% of the virtual reserve.
  for (let i = 0; i < 3; i++) {
    await send(trader, launch, launchAbi, 'trade', [spark, true, parseEther('20000'), 1n, await now() + 600n], parseEther('20000'));
  }
  await send(deployer, launch, launchAbi, 'collectFees', [spark]);
  await warp(200);
  const [, sparkBudget] = await read(launch, launchAbi, 'tokens', [spark]);
  const [, sparkLimit] = await read(strategy, strategyAbi, 'keeperSwapState', [spark, true]);
  const sparkSpend = sparkBudget < sparkLimit ? sparkBudget : sparkLimit;
  assert(sparkSpend >= parseEther('5'), `SPARK budget below the 5 USDC minimum: ${formatEther(sparkSpend)}`);
  const sparkSupplyBefore = await read(spark, erc20Abi, 'totalSupply');
  const sparkBurn = await viaKeeper(executor, launch, launchAbi, 'executeBurn', [spark, sparkSpend, 1n, await now() + 60n]);
  const sparkEvent = parseEventLogs({ abi: launchAbi, eventName: 'Burned', logs: sparkBurn.logs })[0].args;
  assert.equal(await read(spark, erc20Abi, 'totalSupply'), sparkSupplyBefore - sparkEvent.totalBurned);
  record('7% SPARK buyback and burn executed', {
    spentUsdc: formatEther(sparkEvent.nativeAmount), burned: formatEther(sparkEvent.totalBurned),
    note: 'never executed on the public testnet: the budget never reached the 5 USDC minimum there',
  });

  // ---- 7. The 5%: buy the token for rewards, then pay a batch -----------------------------------
  const [, , rewards] = await read(launch, launchAbi, 'terms', [token]);
  const pendingNative = await read(rewards, rewardsAbi, 'pendingNative');
  assert(pendingNative >= parseEther('5'), `rewards budget below the 5 USDC minimum: ${formatEther(pendingNative)}`);
  const purchase = await viaKeeper(executor, rewards, rewardsAbi, 'buyOwnToken', [pendingNative, 1n, await now() + 60n]);
  const purchased = parseEventLogs({ abi: rewardsAbi, eventName: 'RewardPurchased', logs: purchase.logs })[0].args;
  const available = await read(rewards, rewardsAbi, 'available');
  assert(available >= parseEther('1000'), `not enough bought for one batch of 100: ${formatEther(available)}`);

  // Synthetic recipients: ascending, distinct, and nobody's real wallet.
  const recipients = Array.from({ length: 100 }, (_, i) =>
    getAddress(`0x${(BigInt('0x1000000000000000000000000000000000000000') + BigInt(i + 1)).toString(16).padStart(40, '0')}`));
  const totalPaid = await read(rewards, rewardsAbi, 'totalPaid');
  const paid = await viaKeeper(executor, rewards, rewardsAbi, 'distribute', [totalPaid, recipients]);
  const payouts = parseEventLogs({ abi: rewardsAbi, eventName: 'RewardPaid', logs: paid.logs });
  assert.equal(payouts.length, 100);
  for (const recipient of recipients) assert.equal(await read(token, erc20Abi, 'balanceOf', [recipient]), parseEther('10'));
  record('5% bought and a 100-address batch distributed', {
    spentUsdc: formatEther(purchased.nativeAmount), bought: formatEther(purchased.tokensBought),
    recipients: payouts.length, perRecipient: '10',
    note: 'never executed on the public testnet; these recipients are synthetic, not users',
  });

  // ---- 8. Satisfaction: one Approved round and one Rejected round -------------------------------
  // The whole SPARK supply sits in the pool at launch, so the voters have to buy theirs.
  for (const voter of [voterOne, voterTwo]) {
    await send(voter, launch, launchAbi, 'trade', [spark, true, parseEther('500'), 1n, await now() + 600n], parseEther('500'));
    const held = await read(spark, erc20Abi, 'balanceOf', [voter.address]);
    assert(held >= parseEther('3000'), `voter holds only ${formatEther(held)} SPARK`);
    // Unbounded: the same wallet stakes again in the second round after withdrawing the first.
    await send(voter, spark, erc20Abi, 'approve', [vault, 2n ** 256n - 1n]);
  }

  // Each round's pot is the 1% platform share collected since the last one, so every round needs
  // its own trading. Without this the second round opens empty and settles Void.
  const earnPlatformFees = async () => {
    for (let i = 0; i < 2; i++) {
      await send(trader, launch, launchAbi, 'trade', [token, true, parseEther('5000'), 1n, await now() + 600n], parseEther('5000'));
    }
    await send(deployer, launch, launchAbi, 'collectFees', [token]);
  };

  const rounds = [];
  for (const [label, satisfiedStake, notSatisfiedStake] of [['Approved', parseEther('3000'), parseEther('1000')],
    ['Rejected', parseEther('1000'), parseEther('3000')]]) {
    await earnPlatformFees();
    const round = await read(vault, vaultAbi, 'currentRound');
    const votingStart = await read(vault, vaultAbi, 'votingStart', [round]);
    await warp(Number(votingStart - await now()) + 1);
    await send(deployer, vault, vaultAbi, 'openVoting');
    const [pot] = await read(vault, vaultAbi, 'rounds', [round]);
    assert(pot > 0n, `round ${round} opened with an empty pot`);

    await send(voterOne, vault, vaultAbi, 'vote', [true, satisfiedStake, `0x${'11'.repeat(32)}`]);
    await send(voterTwo, vault, vaultAbi, 'vote', [false, notSatisfiedStake, `0x${'22'.repeat(32)}`]);

    const roundEnd = await read(vault, vaultAbi, 'roundEnd', [round]);
    await warp(Number(roundEnd - await now()) + 1);
    const [, sparkBudgetBefore] = await read(launch, launchAbi, 'tokens', [spark]);
    const teamCreditBefore = await read(vault, vaultAbi, 'teamCredit');
    const settled = await send(deployer, vault, vaultAbi, 'settle', [round]);
    const outcome = parseEventLogs({ abi: vaultAbi, eventName: 'Settled', logs: settled.logs })[0].args;
    const [, sparkBudgetAfter] = await read(launch, launchAbi, 'tokens', [spark]);
    const teamShare = pot / 10n;

    // The winning side is paid the same 90% either way; only the team's 10% differs.
    const [winner, loser] = label === 'Approved' ? [voterOne, voterTwo] : [voterTwo, voterOne];
    assert.equal(outcome.outcome, label === 'Approved' ? 1 : 2);
    assert.equal(await read(vault, vaultAbi, 'teamCredit') - teamCreditBefore,
      label === 'Approved' ? teamShare : 0n, 'the team is paid only on Approved');
    assert.equal(sparkBudgetAfter - sparkBudgetBefore, label === 'Approved' ? 0n : teamShare,
      'the team share becomes a buyback only on Rejected');
    assert.equal(await read(vault, vaultAbi, 'payoutOf', [round, winner.address]), pot - teamShare,
      'the only winning voter is owed the whole 90%');
    assert.equal(await read(vault, vaultAbi, 'payoutOf', [round, loser.address]), 0n, 'the losing side is owed nothing');
    const before = await client.getBalance({ address: winner.address });
    const vaultBalanceBefore = await client.getBalance({ address: vault });
    const receipt = await send(winner, vault, vaultAbi, 'withdraw', [round, winner.address]);
    const spent = receipt.gasUsed * receipt.effectiveGasPrice;
    const withdrawn = parseEventLogs({ abi: vaultAbi, eventName: 'Withdrawn', logs: receipt.logs })[0].args;
    assert.equal(withdrawn.payout, pot - teamShare, 'the Withdrawn event must carry the full 90%');
    assert.equal(vaultBalanceBefore - await client.getBalance({ address: vault }), pot - teamShare,
      'the vault must part with exactly the winning side\'s 90%');
    assert.equal(await client.getBalance({ address: winner.address }), before + (pot - teamShare) - spent,
      'and the winner must actually receive it');
    // The stake always comes back, whichever way the round went.
    for (const voter of [voterOne, voterTwo]) {
      const [stake, , , withdrawn] = await read(vault, vaultAbi, 'positions', [round, voter.address]);
      if (!withdrawn) await send(voter, vault, vaultAbi, 'withdraw', [round, voter.address]);
      assert.equal(await read(spark, erc20Abi, 'balanceOf', [voter.address]) >= stake, true);
    }
    rounds.push({ round: round.toString(), outcome: label, potUsdc: formatEther(pot),
      teamShareUsdc: formatEther(teamShare), winnerPaidUsdc: formatEther(pot - teamShare),
      teamShareWentTo: label === 'Approved' ? 'team credit' : 'SPARK buyback budget' });
  }
  record('satisfaction settled both ways, winning side paid the same 90%', { rounds });

  // ---- 9. Nothing leaked: the factory still owns every wei it says it does ----------------------
  const accountedFor = await read(launch, launchAbi, 'nativeAccounted');
  const heldByLaunch = await client.getBalance({ address: launch });
  assert.equal(heldByLaunch, accountedFor, 'the factory holds exactly what it has accounted for');
  record('funds conserved', { nativeAccountedUsdc: formatEther(accountedFor), balanceUsdc: formatEther(heldByLaunch) });

  status = 'passed';
} catch (error) {
  failure = error.shortMessage ?? error.message;
  console.error(`\n✘ ${failure}\n${error.stack ?? ''}`);
} finally {
  anvil.kill('SIGTERM');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({
    what: 'End-to-end run of the SingleSpark stack against a fork of Arc mainnet, on mainnet\'s own Uniswap v4 deployment.',
    caveat: 'A fork is not mainnet. Every balance here was conjured by Anvil and is test funding, never revenue. '
      + 'The distribution recipients and the voters are synthetic addresses, not users. This does not replace an external audit.',
    status, failure, ranAt: new Date().toISOString(), forkRpc: FORK_RPC, forkBlock: FORK_BLOCK, chainId: CHAIN_ID,
    uniswapV4: V4, satisfaction: { roundSeconds: ROUND_SECONDS, votingSeconds: VOTING_SECONDS }, steps,
  }, null, 2)}\n`);
  console.log(`\n${status === 'passed' ? 'PASSED' : 'FAILED'} — ${outPath}`);
  process.exit(status === 'passed' ? 0 : 1);
}
