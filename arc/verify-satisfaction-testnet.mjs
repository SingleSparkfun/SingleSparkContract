// Public-testnet acceptance of the satisfaction vault, its three settlement branches and the
// keeper-through-executor buyback. Resumable: every transaction is simulated, signed and persisted
// before it is broadcast, and a re-run reuses the confirmed receipt instead of paying twice.
//
// Nothing here is platform revenue: every pot is TEST FUNDING (a direct transfer from the funder
// plus whatever operations credit the factory had accrued), and the three voters are controlled
// synthetic wallets, not users.
//
// Sub-commands (no flag = preflight, which sends nothing):
//   --prepare                 create/fund the three test wallets, buy SPARK, approve the vault
//   --round approved|rejected|void   run one scenario inside the current voting window
//   --settle <round>          settle, claim the team share, withdraw every stake
//   --return-funds            sweep the test wallets back to the funder
//   --verify                  read-only: re-derive everything at one finalized block, write the report
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, defineChain, http, parseEther, formatEther, erc20Abi,
  keccak256, stringToHex, encodeFunctionData, parseEventLogs, parseTransaction, recoverTransactionAddress,
  toFunctionSelector, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { artifact } from './deploy.mjs';
import { persist, stringify } from './runtime.mjs';

const dir = process.env.ARC_DEPLOYMENT_DIR || 'SingleSparkContract/arc/data/spark-satisfaction-testnet-20260919';
const reportPath = process.env.ARC_DEPLOYMENT_REPORT || 'SingleSparkContract/arc/deployments/spark-satisfaction-testnet-20260919.json';
const outputPath = process.env.ARC_ACCEPTANCE_REPORT || 'SingleSparkContract/arc/deployments/spark-satisfaction-testnet-acceptance.json';
const base = process.env.ARC_ACCEPTANCE_API_BASE || 'http://127.0.0.1:8090';
assert.equal(new URL(base).hostname, '127.0.0.1');
const walletsPath = `${dir}/satisfaction-wallets.json`;
const journalPath = `${dir}/satisfaction-acceptance-journal.json`;
const statePath = `${dir}/satisfaction-acceptance-state.json`;

process.loadEnvFile(`${dir}/runtime.env`);
const record = JSON.parse(readFileSync(reportPath));
const d = record.deployment;
// The committed record is the only source of truth for the addresses this script may touch.
assert.equal(d.chainId, 5042002);
assert.equal(d.launch.toLowerCase(), '0xd6a56abcddc83d4b780ef4cbfb8f6b7fc093ecf4');
assert.equal(d.satisfaction.toLowerCase(), '0xda3702f1ba6c367ca3dc7fffa3c936232774bddb');
assert.equal(d.keeperExecutor.toLowerCase(), '0xc5dbbbf37097f2539c7ac69775bf11f858409cd4');
assert.equal(d.platformToken.toLowerCase(), '0x6d8a5595a57749b1ae725c66a258bb730166073c');
assert.equal(d.satisfaction.toLowerCase(), d.operations.toLowerCase());
assert.equal(d.keeperExecutor.toLowerCase(), d.keeper.toLowerCase());

const launchAbi = artifact('ArcLaunchV2').abi;
const vaultAbi = artifact('ArcSatisfaction').abi;
const executorAbi = artifact('ArcKeeperExecutor').abi;
const quoterAbi = artifact('V4Quoter').abi;
const positionManagerAbi = artifact('PositionManager').abi;

const chain = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL] } } });
const transport = http(process.env.ARC_RPC_URL, { timeout: 20000, retryCount: 2 });
const client = createPublicClient({ chain, transport, cacheTime: 0 });

const funder = privateKeyToAccount(process.env.ARC_DEPLOYER_PRIVATE_KEY);
assert.equal(funder.address.toLowerCase(), '0x0ca76906cef08981717f81dfa1519b5a3cecca57');
const reserve = parseEther(process.env.ARC_DEPLOYER_RESERVE_USDC || '50');
const maxGasCost = parseEther('0.2');

const wallets = existsSync(walletsPath) ? JSON.parse(readFileSync(walletsPath)) : {};
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath)) : { rounds: {}, opinions: {}, notes: [] };
const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath)) : {};
const saveState = () => persist(statePath, state);

const VOTERS = ['yesVoter', 'noEarly', 'noLate'];
const SPARK_TARGET = { yesVoter: parseEther('2000'), noEarly: parseEther('2500'), noLate: parseEther('3500') };
const FUND_PER_WALLET = parseEther('0.5');
const POT_FUNDING = parseEther('1');
const ALLOWANCE = parseEther('100000');
// Stakes. Approved: Yes early with the smaller raw stake, No late with the larger one (the snipe).
const STAKE = { approved: { yesVoter: parseEther('1500'), noLate: parseEther('3000') },
  rejected: { noEarly: parseEther('2000'), noLate: parseEther('3000') },
  void: { noEarly: parseEther('800'), yesVoter: parseEther('700') } };
const LATE_MARGIN = Number(process.env.ARC_ACCEPTANCE_LATE_MARGIN || 75);

const accountOf = name => privateKeyToAccount(wallets[name].privateKey);
const signerOf = name => (name === 'funder' ? funder : accountOf(name));
const addressOf = name => (name === 'funder' ? funder.address : getAddress(wallets[name].address));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = (address, abi, functionName, args = [], blockNumber) =>
  client.readContract({ address, abi, functionName, args, ...(blockNumber === undefined ? {} : { blockNumber }) });
const vault = (functionName, args = [], blockNumber) => read(d.satisfaction, vaultAbi, functionName, args, blockNumber);
const factory = (functionName, args = [], blockNumber) => read(d.launch, launchAbi, functionName, args, blockNumber);
const sparkOf = (holder, blockNumber) => read(d.platformToken, erc20Abi, 'balanceOf', [holder], blockNumber);
const now = async () => Number((await client.getBlock()).timestamp);
const roundOf = async (index, blockNumber) => {
  const [pot, yes, no, yesStake, noStake, opened, settled, outcome] = await vault('rounds', [BigInt(index)], blockNumber);
  return { pot, yes, no, yesStake, noStake, opened, settled, outcome };
};

// ------------------------------------------------------------------ journaled send
async function send(label, name, to, data, value = 0n, gasHeadroomPercent = 0) {
  const signer = signerOf(name);
  const wallet = createWalletClient({ account: signer, chain, transport });
  let step = journal[label];
  if (!step) {
    const nonce = await client.getTransactionCount({ address: signer.address });
    assert.equal(nonce, await client.getTransactionCount({ address: signer.address, blockTag: 'pending' }),
      `${label}: ${name} has an external pending transaction`);
    const request = await wallet.prepareTransactionRequest({ to, data, value, nonce });
    if (gasHeadroomPercent) request.gas = request.gas * BigInt(100 + gasHeadroomPercent) / 100n;
    const maxCost = request.gas * (request.maxFeePerGas ?? request.gasPrice);
    assert(maxCost <= maxGasCost, `${label}: per-transaction gas budget (${formatEther(maxCost)} USDC)`);
    const balance = await client.getBalance({ address: signer.address });
    if (name === 'funder') assert(balance >= reserve + value + maxCost, `${label}: keep the ${formatEther(reserve)} USDC funder reserve`);
    else assert(balance >= value + maxCost, `${label}: ${name} is short of gas`);
    await client.call({ to, data, value, account: signer.address });
    const raw = await wallet.signTransaction(request);
    step = { raw, hash: keccak256(raw), from: signer.address, label };
    journal[label] = step;
    persist(journalPath, journal);
  }
  const decoded = parseTransaction(step.raw);
  assert.equal(decoded.chainId, chain.id);
  assert.equal(decoded.to.toLowerCase(), to.toLowerCase());
  assert.equal(decoded.data ?? '0x', data);
  assert.equal(decoded.value ?? 0n, value);
  assert.equal(keccak256(step.raw), step.hash);
  assert.equal((await recoverTransactionAddress({ serializedTransaction: step.raw })).toLowerCase(), signer.address.toLowerCase());
  let receipt;
  try { receipt = await client.getTransactionReceipt({ hash: step.hash }); }
  catch (error) { if (error.name !== 'TransactionReceiptNotFoundError') throw error; }
  if (!receipt) {
    try { await client.sendRawTransaction({ serializedTransaction: step.raw }); }
    catch (error) { if (!/already known|nonce too low|known transaction/i.test(error.message)) throw error; }
    receipt = await client.waitForTransactionReceipt({ hash: step.hash, timeout: 180000 });
  }
  assert.equal(receipt.status, 'success', label);
  console.log(stringify({ step: label, from: name, hash: step.hash, block: String(receipt.blockNumber) }));
  return receipt;
}

// ------------------------------------------------------------------ opinions through the API
const login = async name => {
  const signer = signerOf(name);
  const challenge = await (await fetch(`${base}/api/auth/nonce?address=${signer.address}&chainId=5042002`)).json();
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: challenge.message, chainId: 5042002, signature: await signer.signMessage({ message: challenge.message }) }) });
  assert.equal(response.status, 200, `login ${name}: ${response.status}`);
  return (await response.json()).token;
};
// Returns the reason hash to vote with. The API is the product path; if it refuses, the failure is
// recorded and the vote still uses the local hash of the same text, so the round is not lost.
const opinion = async (name, round, text) => {
  const key = `${round}:${name}`;
  const local = keccak256(stringToHex(text));
  if (state.opinions[key]?.posted) return state.opinions[key].reasonHash;
  let entry = { name, round, text, reasonHash: local, posted: false, voter: addressOf(name) };
  try {
    const token = await login(name);
    const response = await fetch(`${base}/api/arc/satisfaction/opinions`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ text }) });
    const body = await response.text();
    if (response.status === 200) {
      const parsed = JSON.parse(body);
      assert.equal(parsed.reasonHash, local, 'The API must hash the trimmed text');
      entry = { ...entry, posted: true, id: parsed.id, apiRound: parsed.round, reasonHash: parsed.reasonHash };
    } else entry.error = `${response.status} ${body.slice(0, 200)}`;
  } catch (error) { entry.error = error.message.slice(0, 200); }
  state.opinions[key] = entry;
  saveState();
  if (!entry.posted) console.error(`opinion ${key} not posted: ${entry.error}`);
  return entry.reasonHash;
};

// ------------------------------------------------------------------ window helpers
const genesis = Number(await vault('genesis'));
const roundDuration = Number(await vault('roundDuration'));
const votingDuration = Number(await vault('votingDuration'));
const quorum = await vault('quorum');
const weightFloor = quorum * BigInt(votingDuration) / 2n;
const windowOf = index => ({ start: genesis + roundDuration * (index + 1) - votingDuration, end: genesis + roundDuration * (index + 1) });
const iso = seconds => new Date(seconds * 1000).toISOString().replace('.000', '');

assert.equal(await client.getChainId(), 5042002);
assert.equal((await vault('factory')).toLowerCase(), d.launch.toLowerCase());
assert.equal((await vault('token')).toLowerCase(), d.platformToken.toLowerCase());
assert.equal((await factory('operations')).toLowerCase(), d.satisfaction.toLowerCase());
assert.equal((await factory('keeper')).toLowerCase(), d.keeperExecutor.toLowerCase());
assert.equal((await read(d.keeperExecutor, executorAbi, 'factory')).toLowerCase(), d.launch.toLowerCase());
// `keeperOperator` is the operator at deployment (it signed the accepted burn); after a rotation the record's
// history names the current one as the entry that has a start and no end.
const currentOperator = d.keeperOperatorHistory?.find(entry => entry.since && !entry.until)?.address ?? d.keeperOperator;
assert.equal((await read(d.keeperExecutor, executorAbi, 'operator')).toLowerCase(), currentOperator.toLowerCase());

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const valueOf = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

// ------------------------------------------------------------------ preflight
if (argv.length === 0) {
  const timestamp = await now();
  const index = Number(await vault('currentRound'));
  const w = windowOf(index);
  const phase = timestamp < w.start ? 'accumulating' : 'voting';
  const upcoming = [];
  for (let i = index; upcoming.length < 5; i++) {
    const next = windowOf(i);
    if (next.end > timestamp) upcoming.push({ round: i, votingStartsAt: iso(next.start), roundEndsAt: iso(next.end) });
  }
  const funderBalance = await client.getBalance({ address: funder.address });
  const spend = FUND_PER_WALLET * 3n + POT_FUNDING * 3n;
  console.log(stringify({
    mode: 'preflight', chainId: chain.id, factory: d.launch, vault: d.satisfaction, executor: d.keeperExecutor,
    platformToken: d.platformToken, team: d.satisfactionParams.team, operator: d.keeperOperator,
    genesis: iso(genesis), roundDuration, votingDuration, quorumSPARK: formatEther(quorum), weightFloor: weightFloor.toString(),
    chainTime: iso(timestamp), currentRound: index, phase, secondsToWindow: Math.max(0, w.start - timestamp),
    upcomingWindows: upcoming,
    funder: funder.address, funderBalanceUSDC: formatEther(funderBalance), reserveUSDC: formatEther(reserve),
    plannedDirectSpendUSDC: formatEther(spend), plannedTaxRunPrincipalUSDC: '40 (recycled, ~7 USDC of tax not recovered)',
    headroomAfterReserveUSDC: formatEther(funderBalance - reserve),
    wallets: Object.fromEntries(VOTERS.map(name => [name, wallets[name]?.address ?? 'not created'])),
    sparkHeld: Object.fromEntries(await Promise.all(VOTERS.map(async name =>
      [name, wallets[name] ? formatEther(await sparkOf(addressOf(name))) : '0']))),
    operationsClaimableUSDC: formatEther(await factory('operationsClaimable')),
    vaultBalanceUSDC: formatEther(await client.getBalance({ address: d.satisfaction })),
    reservedUSDC: formatEther(await vault('reserved')), teamCreditUSDC: formatEther(await vault('teamCredit')),
    plan: ['--prepare', '--round approved', '--settle <r>', '--round void', '--round rejected (its openVoting proves the rollover)',
      '--settle <r>', '--return-funds', '--verify'],
    funding: 'Pots are TEST FUNDING: direct transfers plus the factory gas-seed remainder, not platform revenue.',
  }, null, 2));
  assert(funderBalance - reserve > spend + parseEther('45'), 'The funder cannot cover the plan above the reserve');
  process.exit(0);
}

// ------------------------------------------------------------------ prepare
if (flag('--prepare')) {
  for (const name of VOTERS) {
    if (!wallets[name]) {
      const key = generatePrivateKey();
      wallets[name] = { address: privateKeyToAccount(key).address, privateKey: key, createdAt: new Date().toISOString(),
        purpose: 'synthetic satisfaction-vote acceptance wallet' };
      persist(walletsPath, wallets);
    }
  }
  console.log(stringify({ wallets: Object.fromEntries(VOTERS.map(name => [name, addressOf(name)])) }));
  for (const name of VOTERS) {
    if (await client.getBalance({ address: addressOf(name) }) < FUND_PER_WALLET) {
      await send(`fund-${name}`, 'funder', addressOf(name), '0x', FUND_PER_WALLET);
    }
  }
  const [positionId] = await factory('tokens', [d.platformToken]);
  const [poolKey] = await read(d.positionManager, positionManagerAbi, 'getPoolAndPositionInfo', [positionId]);
  for (const name of VOTERS) {
    for (let attempt = 0; await sparkOf(addressOf(name)) < SPARK_TARGET[name]; attempt++) {
      assert(attempt < 4, `${name}: could not buy ${formatEther(SPARK_TARGET[name])} SPARK within budget`);
      const spend = parseEther('0.05') * (3n ** BigInt(attempt));
      const { result: [quoted] } = await client.simulateContract({ address: d.quoter, abi: quoterAbi,
        functionName: 'quoteExactInputSingle', args: [{ poolKey, zeroForOne: true, exactAmount: spend, hookData: '0x' }] });
      const deadline = BigInt(await now()) + 100n;
      await send(`buy-spark-${name}-${attempt}`, name, d.launch, encodeFunctionData({ abi: launchAbi, functionName: 'trade',
        args: [d.platformToken, true, spend, quoted * 99n / 100n, deadline] }), spend);
    }
    if (await read(d.platformToken, erc20Abi, 'allowance', [addressOf(name), d.satisfaction]) < ALLOWANCE) {
      await send(`approve-${name}`, name, d.platformToken, encodeFunctionData({ abi: erc20Abi, functionName: 'approve',
        args: [d.satisfaction, ALLOWANCE] }));
    }
  }
  state.prepared = { at: new Date().toISOString(), wallets: Object.fromEntries(VOTERS.map(name => [name, addressOf(name)])),
    spark: Object.fromEntries(await Promise.all(VOTERS.map(async name => [name, formatEther(await sparkOf(addressOf(name)))]))) };
  saveState();
  console.log(stringify({ prepared: state.prepared }));
}

// ------------------------------------------------------------------ one scenario inside a window
const scenarioName = valueOf('--round');
if (scenarioName) {
  assert(['approved', 'rejected', 'void'].includes(scenarioName), 'Unknown scenario');
  assert(state.prepared, 'Run --prepare first');
  const index = Number(await vault('currentRound'));
  const w = windowOf(index);
  let timestamp = await now();
  const entry = state.rounds[scenarioName] ??= {};
  if (entry.round !== undefined && entry.round !== index) {
    assert(!entry.votes || entry.votes.length === 0 || entry.done,
      `${scenarioName} was started in round ${entry.round}; finish or reset it before reusing the name`);
  }
  if (timestamp < w.start) {
    console.log(stringify({ scenario: scenarioName, wait: true, currentRound: index, chainTime: iso(timestamp),
      votingStartsAt: iso(w.start), secondsToWindow: w.start - timestamp, message: `Run again at ${iso(w.start)}` }));
    process.exit(3);
  }
  const needed = scenarioName === 'approved' ? LATE_MARGIN + 60 : scenarioName === 'void' ? LATE_MARGIN + 20 : 90;
  if (timestamp >= w.end - needed) {
    const next = windowOf(index + 1);
    console.log(stringify({ scenario: scenarioName, wait: true, message: `Too late in round ${index}; next window opens ${iso(next.start)}` }));
    process.exit(3);
  }
  entry.round = index;
  entry.window = { votingStartsAt: iso(w.start), roundEndsAt: iso(w.end) };
  saveState();

  // The pot is TEST FUNDING: a direct 1 USDC transfer plus whatever operations credit has accrued.
  const opened = await roundOf(index);
  if (!opened.opened) {
    const vaultBefore = await client.getBalance({ address: d.satisfaction });
    // What is already free in the vault was left there by an earlier Void round: that is the rollover.
    const carried = vaultBefore - await vault('reserved') - await vault('teamCredit');
    const topUp = carried < POT_FUNDING;
    if (topUp) await send(`pot-${scenarioName}-${index}`, 'funder', d.satisfaction, '0x', POT_FUNDING);
    const balanceBefore = await client.getBalance({ address: d.satisfaction });
    const reservedBefore = await vault('reserved');
    const teamBefore = await vault('teamCredit');
    const claimableBefore = await factory('operationsClaimable');
    const receipt = await send(`open-${index}`, 'funder', d.satisfaction,
      encodeFunctionData({ abi: vaultAbi, functionName: 'openVoting' }));
    const after = await roundOf(index);
    assert.equal(after.opened, true, 'openVoting must open the round');
    assert.equal(after.pot, balanceBefore - reservedBefore - teamBefore + claimableBefore,
      'pot must equal the free vault balance plus the claimed operations credit');
    entry.open = { hash: receipt.transactionHash, block: String(receipt.blockNumber), pot: after.pot.toString(),
      potUSDC: formatEther(after.pot), testFundingUSDC: formatEther(topUp ? POT_FUNDING : 0n),
      operationsClaimedUSDC: formatEther(claimableBefore), rolledOverUSDC: formatEther(carried) };
    saveState();
  } else entry.open ??= { note: 'already opened', pot: opened.pot.toString() };

  const castVote = async (name, support, amount, text) => {
    const label = `vote-${scenarioName}-${index}-${name}`;
    const reasonHash = await opinion(name, index, text);
    const receipt = await send(label, name, d.satisfaction, encodeFunctionData({ abi: vaultAbi, functionName: 'vote',
      args: [support, amount, reasonHash] }));
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const minedAt = Number(block.timestamp);
    assert(minedAt < w.end, `${label} was mined after the round ended`);
    const [stake, weight] = await vault('positions', [BigInt(index), addressOf(name)]);
    const vote = { voter: name, address: addressOf(name), support, amountSPARK: formatEther(amount),
      hash: receipt.transactionHash, block: String(receipt.blockNumber), minedAt: iso(minedAt),
      secondsBeforeEnd: w.end - minedAt, weight: weight.toString(), stake: stake.toString(), reasonHash,
      opinionPosted: !!state.opinions[`${index}:${name}`]?.posted };
    entry.votes = [...(entry.votes ?? []).filter(item => item.voter !== name), vote];
    saveState();
    return vote;
  };
  const waitUntil = async target => {
    for (;;) {
      timestamp = await now();
      if (timestamp >= target) return timestamp;
      console.log(stringify({ waiting: scenarioName, chainTime: iso(timestamp), until: iso(target), seconds: target - timestamp }));
      await sleep(Math.min(20000, (target - timestamp) * 1000));
    }
  };

  if (scenarioName === 'approved') {
    await castVote('yesVoter', true, STAKE.approved.yesVoter,
      'Yes: the buyback cadence and the burn record are visible on chain, keep the current split.');
    await waitUntil(w.end - LATE_MARGIN);
    await castVote('noLate', false, STAKE.approved.noLate,
      'No, cast late on purpose: this is the snipe the time weighting is supposed to absorb.');
    const result = await roundOf(index);
    assert(result.noStake > result.yesStake, 'The late voter must hold the larger raw stake');
    assert(result.yes > result.no, 'Time weighting must still put Yes ahead');
    entry.contested = { yes: result.yes.toString(), no: result.no.toString(),
      yesStakeSPARK: formatEther(result.yesStake), noStakeSPARK: formatEther(result.noStake) };
  } else if (scenarioName === 'rejected') {
    await castVote('noEarly', false, STAKE.rejected.noEarly, 'No: hold the treasury for one more cycle.');
    await waitUntil(w.start + Math.floor(votingDuration / 2));
    await castVote('noLate', false, STAKE.rejected.noLate, 'No as well, mid-window, with a different weight.');
    const result = await roundOf(index);
    assert.equal(result.yes, 0n, 'No Yes weight in the Rejected scenario');
    assert(result.noStake >= quorum, 'Raw quorum must be met');
    assert(result.no >= weightFloor, 'The weight floor must be met');
  } else {
    await waitUntil(w.end - LATE_MARGIN);
    await castVote('noEarly', false, STAKE.void.noEarly, 'Last-minute No: too late to carry any weight.');
    await castVote('yesVoter', true, STAKE.void.yesVoter, 'Last-minute Yes: also too late to carry any weight.');
    const result = await roundOf(index);
    assert(result.yesStake + result.noStake >= quorum, 'Raw quorum must be met for a weight-floor Void');
    assert(result.yes + result.no < weightFloor, `The weight floor must be missed (${result.yes + result.no} >= ${weightFloor})`);
    entry.contested = { rawStakeSPARK: formatEther(result.yesStake + result.noStake),
      weight: (result.yes + result.no).toString(), weightFloor: weightFloor.toString() };
  }
  entry.voted = true;
  saveState();
  console.log(stringify({ scenario: scenarioName, round: index, entry }));
}

// ------------------------------------------------------------------ settlement
const settleRound = valueOf('--settle');
if (settleRound !== undefined) {
  const index = Number(settleRound);
  const w = windowOf(index);
  const timestamp = await now();
  assert(timestamp >= w.end, `Round ${index} ends at ${iso(w.end)}; ${w.end - timestamp}s to go`);
  const name = Object.keys(state.rounds).find(key => state.rounds[key].round === index);
  assert(name, `No scenario recorded for round ${index}`);
  const entry = state.rounds[name];
  const before = await roundOf(index);
  let settlement = entry.settle;
  // A run that stopped after the settle transaction was mined but before recording it (an RPC error, for
  // example) picks the same journaled transaction up again: `send` reuses its receipt and sends nothing.
  if (!before.settled || (!settlement && journal[`settle-${index}`])) {
    const teamCreditBefore = await vault('teamCredit');
    const reservedBefore = await vault('reserved');
    const receipt = await send(`settle-${index}`, 'funder', d.satisfaction,
      encodeFunctionData({ abi: vaultAbi, functionName: 'settle', args: [BigInt(index)] }));
    settlement = { hash: receipt.transactionHash, block: String(receipt.blockNumber),
      ...(before.settled ? {} : { teamCreditBefore: teamCreditBefore.toString(), reservedBefore: reservedBefore.toString() }) };
  }
  assert(settlement, `Round ${index} was settled outside this script; its settlement transaction is unknown`);
  const result = await roundOf(index);
  assert.equal(result.settled, true);
  const expected = { approved: 1, rejected: 2, void: 3 }[name];
  assert.equal(result.outcome, expected, `round ${index} settled as ${result.outcome}, expected ${expected} (${name})`);
  settlement.outcome = ['none', 'approved', 'rejected', 'void'][result.outcome];
  settlement.potUSDC = formatEther(result.pot);

  if (settlement.hash && !settlement.checked) {
    const receipt = await client.getTransactionReceipt({ hash: settlement.hash });
    const block = receipt.blockNumber;
    const teamShare = name === 'approved' ? result.pot / 10n : 0n;
    assert.equal(await vault('teamCredit', [], block) - await vault('teamCredit', [], block - 1n), teamShare,
      'teamCredit must grow by exactly the 10% of an Approved pot and by nothing otherwise');
    const funded = parseEventLogs({ abi: launchAbi, eventName: 'PlatformBuybackFunded', logs: receipt.logs });
    if (name === 'approved') {
      assert.equal(funded.length, 1, 'Exactly one PlatformBuybackFunded');
      assert.equal(funded[0].args.from.toLowerCase(), d.satisfaction.toLowerCase());
      assert.equal(funded[0].args.amount, result.pot - teamShare);
      // pendingNative at the settlement block against the block before it, net of any burn mined alongside.
      const pendingBefore = (await factory('tokens', [d.platformToken], block - 1n))[1];
      const pendingAfter = (await factory('tokens', [d.platformToken], block))[1];
      const burned = parseEventLogs({ abi: launchAbi, eventName: 'Burned',
        logs: await client.getLogs({ address: d.launch, fromBlock: block, toBlock: block }) })
        .filter(event => event.args.token.toLowerCase() === d.platformToken.toLowerCase())
        .reduce((total, event) => total + event.args.nativeAmount, 0n);
      assert.equal(pendingAfter + burned - pendingBefore, result.pot - teamShare, 'SPARK pendingNative must grow by the 90%');
      settlement.platformBuybackFunded = { amountUSDC: formatEther(funded[0].args.amount), pendingNativeBeforeUSDC: formatEther(pendingBefore),
        pendingNativeAfterUSDC: formatEther(pendingAfter), burnedInSameBlockUSDC: formatEther(burned) };
    } else assert.equal(funded.length, 0, 'Only an Approved round funds the buyback');
    if (name === 'rejected') {
      assert.equal(await vault('reserved', [], block) - await vault('reserved', [], block - 1n), result.pot,
        'A Rejected round reserves its whole pot');
    }
    if (name === 'void') {
      assert.equal(await vault('reserved', [], block), await vault('reserved', [], block - 1n), 'A Void round reserves nothing');
      assert.equal(await vault('teamCredit', [], block), await vault('teamCredit', [], block - 1n), 'A Void round credits nothing');
    }
    settlement.checked = true;
  }

  if (name === 'approved') {
    const teamShare = result.pot / 10n;
    if (await vault('teamCredit') >= teamShare && teamShare > 0n && !settlement.teamClaim) {
      const team = getAddress(d.satisfactionParams.team);
      const balanceBefore = await client.getBalance({ address: team });
      const receipt = await send(`claim-team-${index}`, 'funder', d.satisfaction,
        encodeFunctionData({ abi: vaultAbi, functionName: 'claimTeam' }));
      assert.equal(await client.getBalance({ address: team, blockNumber: receipt.blockNumber })
        - await client.getBalance({ address: team, blockNumber: receipt.blockNumber - 1n }), teamShare,
        'claimTeam must pay the team address exactly the credited share');
      settlement.teamClaim = { hash: receipt.transactionHash, block: String(receipt.blockNumber), team,
        amountUSDC: formatEther(teamShare), teamBalanceBeforeUSDC: formatEther(balanceBefore) };
    }
  }

  settlement.withdrawals ??= [];
  for (const vote of entry.votes ?? []) {
    if (settlement.withdrawals.some(item => item.voter === vote.voter)) continue;
    const [stake, weight, , withdrawn] = await vault('positions', [BigInt(index), vote.address]);
    const payout = await vault('payoutOf', [BigInt(index), vote.address]);
    const expectedPayout = result.outcome === 2 ? result.pot * weight / result.no : 0n;
    assert.equal(payout, expectedPayout, `payoutOf mismatch for ${vote.voter}`);
    if (withdrawn) { settlement.withdrawals.push({ voter: vote.voter, note: 'already withdrawn' }); saveState(); continue; }
    const sparkBefore = await sparkOf(vote.address);
    const nativeBefore = await client.getBalance({ address: vote.address });
    const receipt = await send(`withdraw-${index}-${vote.voter}`, vote.voter, d.satisfaction,
      encodeFunctionData({ abi: vaultAbi, functionName: 'withdraw', args: [BigInt(index), vote.address] }));
    const spent = receipt.gasUsed * receipt.effectiveGasPrice;
    assert.equal(await sparkOf(vote.address) - sparkBefore, stake, `${vote.voter} must recover its whole stake`);
    assert.equal(await client.getBalance({ address: vote.address }) - nativeBefore + spent, expectedPayout,
      `${vote.voter} must receive pot x weight / no`);
    settlement.withdrawals.push({ voter: vote.voter, address: vote.address, hash: receipt.transactionHash,
      block: String(receipt.blockNumber), stakeSPARK: formatEther(stake), weight: weight.toString(),
      payoutUSDC: formatEther(expectedPayout) });
    saveState();
  }
  if (result.outcome === 2) {
    const paid = (entry.votes ?? []).reduce((total, vote) => total + parseEther(
      settlement.withdrawals.find(item => item.voter === vote.voter)?.payoutUSDC ?? '0'), 0n);
    settlement.remainderWei = (result.pot - paid).toString();
    assert(result.pot - paid < BigInt((entry.votes ?? []).length), 'Only rounding dust may stay reserved');
  }
  entry.settle = settlement;
  entry.done = true;
  saveState();
  console.log(stringify({ settled: index, scenario: name, settlement }));
}

// ------------------------------------------------------------------ return the leftovers
if (flag('--return-funds')) {
  const returned = [];
  for (const name of VOTERS) {
    if (!wallets[name]) continue;
    const balance = await client.getBalance({ address: addressOf(name) });
    const request = await createWalletClient({ account: accountOf(name), chain, transport })
      .prepareTransactionRequest({ to: funder.address, value: 1n });
    const cost = request.gas * (request.maxFeePerGas ?? request.gasPrice);
    if (balance <= cost * 2n) { returned.push({ voter: name, address: addressOf(name), skipped: 'dust only' }); continue; }
    const value = balance - cost;
    const receipt = await send(`return-${name}`, name, funder.address, '0x', value);
    returned.push({ voter: name, address: addressOf(name), hash: receipt.transactionHash,
      block: String(receipt.blockNumber), returnedUSDC: formatEther(value) });
  }
  state.returned = returned;
  saveState();
  console.log(stringify({ returned }));
}

// ------------------------------------------------------------------ read-only verification
if (flag('--verify')) {
  const final = await client.getBlock({ blockTag: 'finalized' });
  const at = final.number;
  const items = [];
  const add = (id, status, detail = {}) => items.push({ id, status, ...detail });
  const check = async (id, body) => {
    try { const detail = await body(); add(id, 'passed', detail ?? {}); }
    catch (error) { add(id, 'failed', { evidence: error.message.slice(0, 600) }); console.error(`FAIL ${id}: ${error.message}`); }
  };

  const logs = [];
  for (let from = BigInt(d.fromBlock); from <= at; from += 10000n) {
    logs.push(...await client.getLogs({ address: d.satisfaction, fromBlock: from, toBlock: from + 9999n < at ? from + 9999n : at }));
  }
  const events = parseEventLogs({ abi: vaultAbi, strict: true, logs });
  const of = name => events.filter(event => event.eventName === name);
  const roundNumber = name => state.rounds[name]?.round;

  for (const [name, outcome] of [['approved', 1], ['rejected', 2], ['void', 3]]) {
    await check(name === 'void' ? 'void_and_rollover' : name, async () => {
      const index = roundNumber(name);
      assert(index !== undefined, `${name} scenario never ran`);
      const entry = state.rounds[name];
      const chainRound = await roundOf(index, at);
      assert.equal(chainRound.settled, true, `round ${index} is not settled at the finalized block`);
      assert.equal(chainRound.outcome, outcome, `round ${index} outcome ${chainRound.outcome}`);
      const settled = of('Settled').find(event => Number(event.args.round) === index);
      assert(settled, 'No finalized Settled event');
      assert.equal(settled.args.outcome, outcome);
      const votes = of('Voted').filter(event => Number(event.args.round) === index);
      assert.equal(votes.length, (entry.votes ?? []).length, 'Finalized Voted events must match the votes cast');
      const detail = { round: index, outcome: ['none', 'approved', 'rejected', 'void'][outcome],
        potUSDC: formatEther(chainRound.pot), yesWeight: chainRound.yes.toString(), noWeight: chainRound.no.toString(),
        yesStakeSPARK: formatEther(chainRound.yesStake), noStakeSPARK: formatEther(chainRound.noStake),
        window: entry.window, openTransaction: entry.open?.hash ?? null, settleTransaction: entry.settle?.hash ?? null,
        settledBlock: String(settled.blockNumber),
        potSources: { testFundingUSDC: entry.open?.testFundingUSDC ?? null, operationsCreditUSDC: entry.open?.operationsClaimedUSDC ?? null,
          rolledOverUSDC: entry.open?.rolledOverUSDC ?? null },
        votes: votes.map(event => ({ voter: event.args.voter, support: event.args.support,
          amountSPARK: formatEther(event.args.amount), weight: event.args.weight.toString(),
          reasonHash: event.args.reasonHash, transactionHash: event.transactionHash,
          secondsBeforeEnd: (entry.votes ?? []).find(item => item.address.toLowerCase() === event.args.voter.toLowerCase())?.secondsBeforeEnd ?? null })),
        withdrawals: entry.settle?.withdrawals ?? [] };
      if (name === 'approved') {
        assert(chainRound.noStake > chainRound.yesStake, 'The snipe must hold the larger raw stake');
        assert(chainRound.yes > chainRound.no, 'Time weighting must put Yes ahead');
        const share = chainRound.pot / 10n;
        const funded = parseEventLogs({ abi: launchAbi, eventName: 'PlatformBuybackFunded',
          logs: await client.getLogs({ address: d.launch, fromBlock: BigInt(entry.settle.block), toBlock: BigInt(entry.settle.block) }) })
          .filter(event => event.args.from.toLowerCase() === d.satisfaction.toLowerCase());
        assert.equal(funded.length, 1);
        assert.equal(funded[0].args.amount, chainRound.pot - share);
        assert(entry.settle.teamClaim, 'claimTeam was never executed');
        assert.equal(parseEther(entry.settle.teamClaim.amountUSDC), share);
        const claimed = of('TeamClaimed').find(event => event.transactionHash === entry.settle.teamClaim.hash);
        assert(claimed, 'No finalized TeamClaimed event');
        Object.assign(detail, { teamShareUSDC: formatEther(share), teamClaimTransaction: entry.settle.teamClaim.hash,
          platformBuybackFunded: entry.settle.platformBuybackFunded, buybackFundedTransaction: funded[0].transactionHash });
        for (const vote of entry.votes) assert.equal(await vault('payoutOf', [BigInt(index), vote.address], at), 0n,
          'An Approved round pays no voter');
      }
      if (name === 'rejected') {
        assert.equal(chainRound.yes, 0n);
        const withdrawals = of('Withdrawn').filter(event => Number(event.args.round) === index);
        assert.equal(withdrawals.length, entry.votes.length, 'Every No voter must have withdrawn');
        const paid = withdrawals.reduce((total, event) => total + event.args.payout, 0n);
        assert(paid <= chainRound.pot, 'Payouts may not exceed the pot');
        assert(chainRound.pot - paid < BigInt(entry.votes.length), 'Only per-voter dust may remain');
        for (const event of withdrawals) {
          const [, weight] = await vault('positions', [BigInt(index), event.args.voter], at);
          assert.equal(event.args.payout, chainRound.pot * weight / chainRound.no, 'payout = pot x weight / no');
        }
        Object.assign(detail, { payoutsUSDC: formatEther(paid), remainderWei: (chainRound.pot - paid).toString() });
      }
      if (name === 'void') {
        assert(chainRound.yesStake + chainRound.noStake >= quorum, 'Raw quorum met');
        assert(chainRound.yes + chainRound.no < weightFloor, 'Weight floor missed');
        const next = of('VotingOpened').filter(event => Number(event.args.round) > index)
          .sort((a, b) => Number(a.args.round) - Number(b.args.round))[0];
        assert(next, 'No later round was opened, so the rollover is unproven');
        assert(next.args.pot >= chainRound.pot, `round ${next.args.round} pot ${formatEther(next.args.pot)} does not carry the void pot`);
        Object.assign(detail, { rawStakeSPARK: formatEther(chainRound.yesStake + chainRound.noStake),
          weight: (chainRound.yes + chainRound.no).toString(), weightFloor: weightFloor.toString(),
          rolloverRound: Number(next.args.round), rolloverPotUSDC: formatEther(next.args.pot),
          rolloverTransaction: next.transactionHash });
      }
      return detail;
    });
  }

  await check('keeper_burn_through_executor', async () => {
    const executed = parseEventLogs({ abi: executorAbi, strict: true, eventName: 'Executed',
      logs: await (async () => {
        const collected = [];
        for (let from = BigInt(d.fromBlock); from <= at; from += 10000n) {
          collected.push(...await client.getLogs({ address: d.keeperExecutor, fromBlock: from, toBlock: from + 9999n < at ? from + 9999n : at }));
        }
        return collected;
      })() });
    const selector = toFunctionSelector('executeBurn(address,uint256,uint256,uint256)');
    const burnCalls = executed.filter(event => event.args.selector === selector
      && event.args.target.toLowerCase() === d.launch.toLowerCase());
    assert(burnCalls.length > 0, `No executeBurn through the executor; selectors seen: ${[...new Set(executed.map(e => e.args.selector))].join(',')}`);
    const receipts = [];
    for (const call of burnCalls) {
      const transaction = await client.getTransaction({ hash: call.transactionHash });
      assert.equal(transaction.from.toLowerCase(), d.keeperOperator.toLowerCase(), 'The operator must sign');
      assert.equal(transaction.to.toLowerCase(), d.keeperExecutor.toLowerCase(), 'It must go through the executor');
      const receipt = await client.getTransactionReceipt({ hash: call.transactionHash });
      const burns = parseEventLogs({ abi: launchAbi, eventName: 'Burned', logs: receipt.logs })
        .filter(event => event.args.token.toLowerCase() === d.platformToken.toLowerCase());
      if (!burns.length) continue;
      const supplyBefore = await read(d.platformToken, erc20Abi, 'totalSupply', [], receipt.blockNumber - 1n);
      const supplyAfter = await read(d.platformToken, erc20Abi, 'totalSupply', [], receipt.blockNumber);
      assert.equal(supplyBefore - supplyAfter, burns[0].args.totalBurned, 'SPARK total supply must fall by the burn');
      receipts.push({ transactionHash: call.transactionHash, block: String(receipt.blockNumber), from: transaction.from,
        to: transaction.to, selector: call.args.selector, target: call.args.target,
        spentUSDC: formatEther(burns[0].args.nativeAmount), burnedSPARK: formatEther(burns[0].args.totalBurned),
        supplyBeforeSPARK: formatEther(supplyBefore), supplyAfterSPARK: formatEther(supplyAfter) });
    }
    assert(receipts.length > 0, 'executeBurn ran through the executor but burned nothing');
    const snapshot = await (await fetch(`${base}/api/arc/snapshot`)).json();
    const indexed = receipts.every(row => (snapshot.records ?? []).some(item => item.transactionHash === row.transactionHash));
    assert(indexed, 'The backend snapshot does not list the burn yet');
    return { burns: receipts, indexedByBackend: true };
  });

  await check('conservation', async () => {
    const balance = await client.getBalance({ address: d.satisfaction, blockNumber: at });
    const reserved = await vault('reserved', [], at);
    const teamCredit = await vault('teamCredit', [], at);
    assert(balance >= reserved + teamCredit, `vault balance ${formatEther(balance)} < reserved + teamCredit`);
    const spark = await sparkOf(d.satisfaction, at);
    let outstanding = 0n;
    const highest = Number(await vault('currentRound', [], at));
    for (let index = 0; index <= highest; index++) {
      const row = await roundOf(index, at);
      if (!row.opened) continue;
      for (const event of of('Voted').filter(item => Number(item.args.round) === index)) {
        const [stake, , , withdrawn] = await vault('positions', [BigInt(index), event.args.voter], at);
        if (!withdrawn) outstanding += stake;
      }
    }
    assert.equal(spark, outstanding, 'The vault must hold exactly the un-withdrawn stakes');
    const perRound = [];
    for (const name of ['approved', 'rejected', 'void']) {
      const index = roundNumber(name);
      if (index === undefined) continue;
      const row = await roundOf(index, at);
      const paid = of('Withdrawn').filter(event => Number(event.args.round) === index)
        .reduce((total, event) => total + event.args.payout, 0n);
      assert(paid <= row.pot, `round ${index} paid more than its pot`);
      perRound.push({ round: index, outcome: name, potUSDC: formatEther(row.pot), paidOutUSDC: formatEther(paid),
        remainderWei: (row.pot - paid).toString() });
    }
    return { finalizedBlock: String(at), vaultBalanceUSDC: formatEther(balance), reservedUSDC: formatEther(reserved),
      teamCreditUSDC: formatEther(teamCredit), vaultSparkHeld: formatEther(spark), outstandingStakes: formatEther(outstanding), perRound };
  });

  await check('backend_data', async () => {
    const status = await (await fetch(`${base}/api/arc/satisfaction`)).json();
    const history = await (await fetch(`${base}/api/arc/satisfaction/rounds?limit=20`)).json();
    const outcomes = Object.fromEntries(history.items.map(item => [String(item.round), item.outcome]));
    const expected = {};
    for (const name of ['approved', 'rejected', 'void']) {
      const index = roundNumber(name);
      if (index === undefined) continue;
      expected[index] = name;
      assert.equal(outcomes[String(index)], name, `round ${index} is ${outcomes[String(index)]} in the API, ${name} on chain`);
    }
    assert(BigInt(status.indexedBlock) >= BigInt(status.finalizedBlock) - 1n,
      `indexedBlock ${status.indexedBlock} has not caught up with finalizedBlock ${status.finalizedBlock}`);
    const opinions = [];
    for (const name of ['approved', 'rejected', 'void']) {
      const index = roundNumber(name);
      if (index === undefined) continue;
      const listed = await (await fetch(`${base}/api/arc/satisfaction/opinions?round=${index}`)).json();
      const posted = Object.values(state.opinions).filter(item => item.round === index && item.posted);
      for (const item of posted) {
        const row = listed.items.find(entry => entry.reasonHash === item.reasonHash);
        assert(row, `opinion ${item.reasonHash} of round ${index} is not listed`);
        const event = of('Voted').find(entry => Number(entry.args.round) === index
          && entry.args.voter.toLowerCase() === item.voter.toLowerCase());
        assert(event, 'A listed opinion must have a finalized Voted event');
        assert.equal(row.amount, event.args.amount.toString(), 'Listed amount must equal the chain');
        assert.equal(row.weight, event.args.weight.toString(), 'Listed weight must equal the chain');
        assert.equal(row.support, event.args.support);
        assert.equal(row.text, item.text);
        opinions.push({ round: index, voter: item.voter, reasonHash: item.reasonHash, amountSPARK: formatEther(event.args.amount),
          weight: event.args.weight.toString(), support: event.args.support });
      }
    }
    const unposted = Object.values(state.opinions).filter(item => !item.posted);
    return { indexedBlock: status.indexedBlock, finalizedBlock: status.finalizedBlock, outcomes: expected,
      listedOpinions: opinions, opinionsRefusedByApi: unposted.map(item => ({ round: item.round, voter: item.voter, error: item.error })) };
  });

  // A scenario that was started but could not be completed stays on record; it is never counted as passed.
  const missed = state.rounds.approvedUncontested;
  if (missed) {
    const row = await roundOf(missed.round, at);
    add('approved_snipe_first_attempt', 'not_observed', { round: missed.round, reason: missed.note,
      whatHappened: 'Only the early Yes vote was mined; the round settled Approved without a late No vote, so it proves '
        + 'nothing about sniping. The scenario was repeated in a later round.',
      outcome: ['none', 'approved', 'rejected', 'void'][row.outcome], potUSDC: formatEther(row.pot),
      openTransaction: missed.open?.hash ?? null, settleTransaction: missed.settle?.hash ?? null,
      teamClaimTransaction: missed.settle?.teamClaim?.hash ?? null });
  }

  add('opinion_hiding', 'not_applicable', { reason: 'admin token not configured: the hide endpoint answers 503 on this deployment' });

  const required = items.filter(item => !['opinion_hiding', 'approved_snipe_first_attempt'].includes(item.id));
  const status = required.every(item => item.status === 'passed') ? 'passed' : 'failed';
  const report = {
    status,
    checkedAt: new Date().toISOString(),
    chainId: 5042002,
    finalizedBlock: String(at),
    finalizedBlockTime: iso(Number(final.timestamp)),
    explorer: 'https://testnet.arcscan.app',
    deployment: { factory: d.launch, platformToken: d.platformToken, satisfactionVault: d.satisfaction,
      keeperExecutor: d.keeperExecutor, keeperOperator: d.keeperOperator, team: d.satisfactionParams.team,
      rewards: d.rewards, quoter: d.quoter, deploymentRecord: reportPath },
    parameters: { genesis: iso(genesis), roundDuration, votingDuration, quorumSPARK: formatEther(quorum),
      weightFloor: weightFloor.toString(), teamBps: 1000 },
    testWallets: Object.fromEntries(VOTERS.filter(name => wallets[name]).map(name => [name, addressOf(name)])),
    items,
    funds: state.returned ?? null,
    limits: [
      'Every pot in this acceptance is TEST FUNDING: a direct transfer from the funder plus the remainder of the '
      + "deployment's keeper-gas seed that the factory held as operations credit. None of it is platform revenue.",
      'yesVoter, noEarly and noLate are controlled synthetic wallets created for this run; they are not users and '
      + 'their votes are not evidence of community sentiment.',
      'The testnet parameters (a 10-minute voting window and a 1,000 SPARK quorum) make a late-window snipe cheap and '
      + 'easy to out-weigh. An Approved outcome here is NOT evidence that sniping is prevented on mainnet; the quorum '
      + 'and the window have to be set against real value before any mainnet deployment.',
      'The contracts have not been audited externally.',
    ],
  };
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (status !== 'passed') process.exitCode = 1;
}
