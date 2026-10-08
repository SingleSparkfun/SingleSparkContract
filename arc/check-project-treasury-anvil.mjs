// A disposable Arc-shaped Anvil chain: real factory fee allocation, seven-day stake vote and exact team payout.
// All keys below are Anvil's public development keys. Nothing here connects to a public RPC.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, erc20Abi, http, keccak256, parseEther, parseEventLogs, stringToHex, zeroAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { artifact, deployArc } from './deploy.mjs';
import { arcAbi } from '../../SingleSparkFront/front/web3/arcAbi.ts';

const key = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
].map(privateKeyToAccount);
const [creator, keeper, yesVoter, team, noVoter] = key;
const proposer = privateKeyToAccount(generatePrivateKey());
const reserve = createServer();
await new Promise(done => reserve.listen(0, '127.0.0.1', done));
const port = reserve.address().port;
await new Promise(done => reserve.close(done));
const rpc = `http://127.0.0.1:${port}`;
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '5042002', '--silent'], { stdio: 'ignore' });
const chain = defineChain({ id: 5042002, name: 'Isolated Arc Anvil', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const client = createPublicClient({ chain, transport: http(rpc, { retryCount: 0 }), cacheTime: 0 });
const wallet = actor => createWalletClient({ account: actor, chain, transport: http(rpc) });
const receipt = async hash => {
  const result = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  assert.equal(result.status, 'success', `Transaction reverted: ${hash}`);
  return result;
};
const send = async (actor, address, abi, functionName, args = [], value = 0n) =>
  receipt(await wallet(actor).writeContract({ address, abi, functionName, args, value }));
const deploy = async (name, args) => {
  const { abi, bytecode } = artifact(name);
  const result = await receipt(await wallet(creator).deployContract({ abi, bytecode: bytecode.object, args }));
  assert(result.contractAddress);
  return result.contractAddress;
};
const reportPath = resolve('SingleSparkContract/arc/deployments/arc-project-treasury-factory-anvil-proof.json');

try {
  for (let i = 0; ; i++) {
    try { await client.getChainId(); break; }
    catch (error) { if (i === 100) throw error; await new Promise(done => setTimeout(done, 100)); }
  }
  const manager = await deploy('PoolManager', [creator.address]);
  const positions = await deploy('PositionManager', [manager, zeroAddress, 100000, zeroAddress, zeroAddress]);
  const deployment = await deployArc(client, wallet(creator), {
    positionManager: positions, keeper: keeper.address, operations: team.address,
    platformName: 'SingleSpark', platformSymbol: 'SPARK', minBuyback: '0.001',
  });
  const vaultAbi = artifact('ArcProjectTreasury').abi;
  const factoryAbi = artifact('ArcLaunchV2').abi;
  const vaultReceipt = await send(creator, deployment.launch, factoryAbi, 'createProjectTreasury', []);
  const vault = parseEventLogs({ abi: factoryAbi, eventName: 'ProjectTreasuryCreated', logs: vaultReceipt.logs })[0].args.treasury;
  const launchReceipt = await send(creator, deployment.launch, factoryAbi, 'launch', ['Governed Test', 'GOV', '', 30_000, 30_000, vault]);
  const project = parseEventLogs({ abi: arcAbi, eventName: 'Launched', logs: launchReceipt.logs })[0].args.token;
  const [, community] = await client.readContract({ address: deployment.launch, abi: factoryAbi, functionName: 'terms', args: [project] });
  assert.equal(community.toLowerCase(), vault.toLowerCase());
  assert.equal((await client.readContract({ address: vault, abi: vaultAbi, functionName: 'token' })).toLowerCase(), project.toLowerCase());
  assert.equal(await client.readContract({ address: vault, abi: vaultAbi, functionName: 'quorum' }), 10_000_000n * 10n ** 18n);
  await receipt(await wallet(creator).sendTransaction({ to: proposer.address, value: parseEther('1') }));

  // Let opening protection finish. These real buys supply the two stake voters and generate real trade tax.
  await client.request({ method: 'evm_increaseTime', params: [4] });
  await client.request({ method: 'evm_mine', params: [] });
  const buy = async actor => {
    const amount = parseEther('500');
    const block = await client.getBlock();
    return send(actor, deployment.launch, factoryAbi, 'trade', [project, true, amount, 1n, block.timestamp + 600n], amount);
  };
  const yesBuy = await buy(yesVoter);
  const noBuy = await buy(noVoter);
  const collectReceipt = await send(proposer, deployment.launch, factoryAbi, 'collectFees', [project]);
  const tradeCredit = await client.readContract({ address: deployment.launch, abi: factoryAbi, functionName: 'communityCredit', args: [project] });
  const tradeAllocations = parseEventLogs({ abi: factoryAbi, eventName: 'FeesAllocated', logs: collectReceipt.logs });
  assert(tradeCredit > 0n && tradeAllocations.length > 0);
  assert.equal(tradeCredit, tradeAllocations.reduce((sum, entry) => sum + entry.args.community, 0n));
  // An explicit local top-up gives the one-time $299 proposal enough budget; it is NOT called trade tax.
  const topUpReceipt = await send(creator, deployment.launch, factoryAbi, 'fundFees', [project], parseEther('7500'));
  const totalCredit = await client.readContract({ address: deployment.launch, abi: factoryAbi, functionName: 'communityCredit', args: [project] });
  assert.equal(totalCredit - tradeCredit, parseEther('300'));
  const claimCommunityReceipt = await send(proposer, deployment.launch, factoryAbi, 'claimCommunity', [project]);
  assert.equal(await client.getBalance({ address: vault }), totalCredit);

  assert.equal(await client.readContract({ address: project, abi: erc20Abi, functionName: 'balanceOf', args: [proposer.address] }), 0n);
  const quoteHash = keccak256(stringToHex('Local test checkout quote for Enhanced Token Info'));
  const proposalReceipt = await send(proposer, vault, vaultAbi, 'propose', [0, parseEther('299'), quoteHash]);
  assert.equal(await client.readContract({ address: vault, abi: vaultAbi, functionName: 'proposalCount' }), 1n);
  const votes = [[yesVoter, true, 6_000_000n * 10n ** 18n], [noVoter, false, 5_000_000n * 10n ** 18n]];
  const voteReceipts = [];
  for (const [actor, support, amount] of votes) {
    assert((await client.readContract({ address: project, abi: erc20Abi, functionName: 'balanceOf', args: [actor.address] })) >= amount);
    await send(actor, project, erc20Abi, 'approve', [vault, amount]);
    voteReceipts.push((await send(actor, vault, vaultAbi, 'vote', [1n, support, amount])).transactionHash);
  }
  await client.request({ method: 'evm_increaseTime', params: [7 * 24 * 60 * 60 + 1] });
  await client.request({ method: 'evm_mine', params: [] });
  const settleReceipt = await send(proposer, vault, vaultAbi, 'settle', [1n]);
  const proposal = await client.readContract({ address: vault, abi: vaultAbi, functionName: 'proposals', args: [1n] });
  assert.equal(proposal[6], true); // settled
  assert.equal(proposal[7], true); // approved
  const teamBefore = await client.getBalance({ address: team.address });
  const payoutReceipt = await send(team, vault, vaultAbi, 'claim', [1n]);
  const payout = parseEventLogs({ abi: vaultAbi, eventName: 'Claimed', logs: payoutReceipt.logs });
  assert.equal(payout.length, 1);
  assert.equal(payout[0].args.amount, parseEther('299'));
  assert.equal(payout[0].args.team.toLowerCase(), team.address.toLowerCase());
  const teamAfter = await client.getBalance({ address: team.address });
  assert(teamAfter > teamBefore); // team pays its own Gas; exact payout is in the Claimed event and vault delta.
  assert.equal(await client.readContract({ address: vault, abi: vaultAbi, functionName: 'infoClaimed' }), true);
  assert.equal(await client.getBalance({ address: vault }), totalCredit - parseEther('299'));
  const withdrawals = [];
  for (const [actor] of votes) withdrawals.push((await send(actor, vault, vaultAbi, 'withdrawStake', [1n])).transactionHash);
  assert.equal(await client.readContract({ address: project, abi: erc20Abi, functionName: 'balanceOf', args: [vault] }), 0n);

  const proof = {
    status: 'passed', scope: 'isolated disposable Anvil chain; not ARC public testnet or production', chainId: 5042002,
    factory: deployment.launch, platformToken: deployment.platformToken, projectToken: project, vault,
    quorumTokens: '10000000', voteDurationSeconds: 604800, yesTokens: '6000000', noTokens: '5000000',
    proposalAmountNativeUSDC: '299', tradeTaxCommunityCreditWei: tradeCredit.toString(), explicitTestFundingCommunityCreditWei: parseEther('300').toString(),
    finalVaultBalanceWei: (totalCredit - parseEther('299')).toString(),
    transactions: { treasuryCreated: vaultReceipt.transactionHash, launch: launchReceipt.transactionHash, yesBuy: yesBuy.transactionHash,
      noBuy: noBuy.transactionHash, collectFees: collectReceipt.transactionHash, explicitTestFunding: topUpReceipt.transactionHash,
      claimCommunity: claimCommunityReceipt.transactionHash, proposal: proposalReceipt.transactionHash, votes: voteReceipts,
      settle: settleReceipt.transactionHash, teamClaim: payoutReceipt.transactionHash, stakeWithdrawals: withdrawals },
    limitations: 'The factory binds a registered vault atomically. DEX checkout and service activation remain off-chain.',
  };
  writeFileSync(reportPath, JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify({ status: proof.status, scope: proof.scope, project, vault, proposal: proof.transactions.proposal, teamClaim: proof.transactions.teamClaim }));
} finally {
  anvil.kill('SIGTERM');
}
