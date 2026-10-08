import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, encodeFunctionData, keccak256, zeroAddress, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcAbi, quoterAbi, positionManagerAbi } from '../../SingleSparkFront/front/web3/arcAbi.ts';

export const stringify = (value) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);

export function persist(path, value) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, stringify(value), { mode: 0o600 });
  const file = openSync(temporary, 'r');
  try { fsyncSync(file); } finally { closeSync(file); }
  renameSync(temporary, path);
  const directory = openSync(resolve(path, '..'), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export async function createRuntime(config) {
  if (![5042002, 5042].includes(config.chainId)) throw new Error('Only Arc is supported');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.rpcUrl).hostname);
  const chain = defineChain({ id: config.chainId, name: local ? 'Arc Local' : config.chainId === 5042 ? 'Arc' : 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } });
  const client = createPublicClient({ chain, transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 1 }) });
  if (await client.getChainId() !== config.chainId) throw new Error('RPC chain ID mismatch');
  for (const address of [config.launch, config.quoter]) {
    if (!await client.getCode({ address })) throw new Error(`No contract at ${address}`);
  }
  const read = (functionName, args = [], blockNumber) => client.readContract({ address: config.launch, abi: arcAbi, functionName, args, blockNumber });
  const [splitter, platformToken, minBuyback, keeper, operations, positionManager] = await Promise.all([
    read('feeSplitter'), read('platformToken'), read('minBuyback'), read('keeper'), read('operations'), read('positionManager'),
  ]);
  if ([splitter, platformToken].includes(zeroAddress)) throw new Error('Complete strategy/platform setup before starting');
  const poolManagerAbi = [{ type: 'function', name: 'poolManager', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }];
  const [pool, quoterPool] = await Promise.all([positionManager, config.quoter].map(address => client.readContract({ address, abi: poolManagerAbi, functionName: 'poolManager' })));
  if (pool.toLowerCase() !== quoterPool.toLowerCase()) throw new Error('Quoter and PositionManager belong to different pools');
  const account = config.keeperKey ? privateKeyToAccount(config.keeperKey) : null;
  if (account && account.address.toLowerCase() !== keeper.toLowerCase()) throw new Error('Keeper key does not match the contract');
  const wallet = account ? createWalletClient({ account, chain, transport: http(config.rpcUrl, { retryCount: 0 }) }) : null;
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const statePath = resolve(config.dataDir, 'state.json');
  const journalPath = resolve(config.dataDir, 'transaction.json');
  const identity = `${config.chainId}:${config.launch.toLowerCase()}:${config.fromBlock}`;
  let state = { identity, cursor: String(BigInt(config.fromBlock) - 1n), blockHash: null, launches: [], records: [] };
  try {
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    if (saved.identity !== identity) throw new Error('Use a separate data directory for this deployment');
    state = saved;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let journal = null;
  try { journal = JSON.parse(readFileSync(journalPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (journal && journal.identity !== identity) throw new Error('Transaction journal deployment mismatch');
  if (journal && keccak256(journal.raw) !== journal.hash) throw new Error('Transaction journal hash mismatch');
  let snapshot = null;
  let lastError = null;
  const tokenState = async (token, blockNumber) => {
    const values = await read('tokens', [token], blockNumber);
    return Object.fromEntries(['positionId', 'pendingNative', 'pendingTokens', 'lastBurnAt', 'totalBuyback', 'totalBurned', 'cycles'].map((key, i) => [key, values[i]]));
  };
  const quote = async (token, buy, amount) => {
    if (amount <= 0n || amount > (1n << 127n) - 1n) throw new Error('Invalid quote amount');
    const state = await tokenState(token);
    if (state.positionId === 0n) throw new Error('Unknown platform token');
    const [poolKey] = await client.readContract({ address: positionManager, abi: positionManagerAbi, functionName: 'getPoolAndPositionInfo', args: [state.positionId] });
    const result = await client.simulateContract({ address: config.quoter, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{
      poolKey,
      zeroForOne: buy, exactAmount: amount, hookData: '0x',
    }] });
    return result.result[0];
  };

  async function index() {
    const head = await client.getBlock();
    if (state.blockHash && (BigInt(state.cursor) > head.number || (await client.getBlock({ blockNumber: BigInt(state.cursor) })).hash !== state.blockHash)) {
      state = { identity, cursor: String(BigInt(config.fromBlock) - 1n), blockHash: null, launches: [], records: [] };
    }
    for (let from = BigInt(state.cursor) + 1n; from <= head.number; from += 1000n) {
      const to = from + 999n < head.number ? from + 999n : head.number;
      const logs = await client.getContractEvents({ address: config.launch, abi: arcAbi, fromBlock: from, toBlock: to, strict: true });
      const timestamps = new Map();
      const launches = [...state.launches];
      const records = [...state.records];
      for (const log of logs) {
        if (log.eventName === 'Launched') launches.push({ ...log.args, transactionHash: log.transactionHash });
        if (log.eventName === 'Burned') {
          if (!timestamps.has(log.blockNumber)) timestamps.set(log.blockNumber, (await client.getBlock({ blockNumber: log.blockNumber })).timestamp.toString());
          records.push({ ...log.args, transactionHash: log.transactionHash, timestamp: timestamps.get(log.blockNumber) });
        }
      }
      // ponytail: retain the latest 1,000 burn records; use a database when full-history pagination is needed.
      const next = { ...state, launches, records: records.slice(-1000), cursor: to.toString(), blockHash: (await client.getBlock({ blockNumber: to })).hash };
      persist(statePath, next);
      state = next;
    }
    // Read stats at the indexed block so totals and receipts describe the same chain state.
    const tokens = [];
    for (const launch of state.launches) tokens.push({ ...launch, ...await tokenState(launch.token, head.number) });
    snapshot = { chainId: config.chainId, networkName: chain.name, launch: config.launch, platformToken, splitter, keeper, operations, positionManager,
      minBuyback, interval: 180, nativeDecimals: 18, blockNumber: head.number, syncedAt: new Date().toISOString(),
      keeperEnabled: !!wallet, tokens, records: [...state.records].reverse() };
    return snapshot;
  }

  async function resume() {
    if (!journal) return;
    if (!wallet) throw new Error('Pending keeper transaction requires its signing key');
    if (journal.sender.toLowerCase() !== account.address.toLowerCase()) throw new Error('Journal sender mismatch');
    let receipt;
    try { receipt = await client.getTransactionReceipt({ hash: journal.hash }); }
    catch (error) { if (error.name !== 'TransactionReceiptNotFoundError') throw error; }
    if (!receipt) {
      try { await client.sendRawTransaction({ serializedTransaction: journal.raw }); }
      catch (error) {
        // Still wait for the exact hash after an ambiguous RPC response; never re-sign with another nonce.
        if (!/already known|nonce too low|known transaction/i.test(error.message)) throw error;
      }
      receipt = await client.waitForTransactionReceipt({ hash: journal.hash, timeout: 30_000, confirmations: 1 });
    }
    journal = null;
    persist(journalPath, null);
    if (receipt.status !== 'success') throw new Error(`Keeper transaction reverted: ${receipt.transactionHash}`);
  }

  async function send(address, abi, functionName, args = []) {
    await resume();
    const [latest, pending] = await Promise.all([
      client.getTransactionCount({ address: account.address, blockTag: 'latest' }),
      client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    ]);
    if (latest !== pending) throw new Error('Keeper has an external pending transaction; use a dedicated wallet');
    await client.simulateContract({ address, abi, functionName, args, account });
    const request = await wallet.prepareTransactionRequest({ to: address, data: encodeFunctionData({ abi, functionName, args }), nonce: pending });
    const cost = request.gas * (request.maxFeePerGas ?? request.gasPrice);
    if (await client.getBalance({ address: account.address }) < cost + config.gasReserve) throw new Error('Keeper needs native USDC for gas');
    const raw = await wallet.signTransaction(request);
    journal = { identity, sender: account.address, hash: keccak256(raw), raw };
    persist(journalPath, journal);
    await resume();
  }

  // ponytail: one sequential keeper process per wallet; shard wallets if token volume outgrows this loop.
  async function cycle() {
    await resume();
    await index();
    if (!wallet) return;
    const failures = [];
    for (const token of snapshot.tokens) {
      try {
        const collection = await client.simulateContract({ address: config.launch, abi: arcAbi, functionName: 'collectFees', args: [token.token], account });
        if (collection.result.some(amount => amount > 0n)) await send(config.launch, arcAbi, 'collectFees', [token.token]);
        const state = await tokenState(token.token);
        const now = (await client.getBlock()).timestamp;
        if (now < state.lastBurnAt + 180n) continue;
        const amount = state.pendingNative >= minBuyback ? state.pendingNative : 0n;
        if (amount === 0n && state.pendingTokens === 0n) continue;
        const out = amount ? await quote(token.token, true, amount) : 0n;
        const minimum = out * BigInt(10_000 - config.slippageBps) / 10_000n;
        if (amount && minimum === 0n) continue;
        await send(config.launch, arcAbi, 'executeBurn', [token.token, amount, minimum, now + 120n]);
      } catch (error) {
        lastError = error.shortMessage || error.message;
        failures.push(lastError);
        console.error(`ARC keeper ${token.token}: ${lastError}`);
        if (journal) throw error;
      }
    }
    const ops = await read('operationsCredit');
    if (ops >= parseUnits('1', 18)) await send(config.launch, arcAbi, 'claimOperations');
    await index();
    lastError = failures.length ? failures.join('; ') : null;
  }
  return { client, chain, read, quote, index, cycle, tokenState, resume, get snapshot() { return snapshot; },
    get error() { return lastError; }, get pendingHash() { return journal?.hash ?? null; } };
}
