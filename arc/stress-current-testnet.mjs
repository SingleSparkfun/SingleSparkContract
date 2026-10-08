// Controlled testnet wallets only. One durable pending transaction per wallet; never auto-refill.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, openSync, writeFileSync, appendFileSync, closeSync, unlinkSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPublicClient, defineChain, http, custom, erc20Abi, parseEther, formatEther,
  encodeFunctionData, decodeFunctionData, parseEventLogs, parseTransaction, recoverTransactionAddress, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { artifact } from './deploy.mjs';
import { persist, stringify } from './runtime.mjs';

const direction = draw => draw % 2 === 1;
const group = index => index <= 10 ? 0 : 1 + Math.floor((index - 11) / 30);
const noTradePossible=(buyBlocked,sellBlocked,tokens)=>buyBlocked&&(sellBlocked||tokens===0n);
const shares = native => {
  const amounts = [83n, 7n, 5n, 4n].map(n => native * n / 100n);
  return [...amounts, native - amounts.reduce((a,b) => a+b, 0n)];
};
if (process.argv.includes('--self-check')) {
  assert.deepEqual([1,2,3,4].map(direction), [true,false,true,false]);
  assert.deepEqual([1,10,11,40,41,70,71,100].map(group), [0,0,1,1,2,2,3,3]);
  for (const n of [0n, 1n, 99n, 100n, parseEther('0.123456789')]) assert.equal(shares(n).reduce((a,b) => a+b), n);
  assert.equal(noTradePossible(false,true,10n),false);assert.equal(noTradePossible(true,false,10n),false);
  assert.equal(noTradePossible(true,true,10n),true);assert.equal(noTradePossible(true,false,0n),true);
  console.log('PASS: odd buys/even sells, wallet groups, integer allocations, both sides checked before stopping'); process.exit(0);
}
process.loadEnvFile('SingleSparkContract/arc/.env.testnet.local');
process.loadEnvFile('SingleSparkContract/arc/.env.postgres.local');
const deployment = JSON.parse(readFileSync('SingleSparkContract/arc/deployments/arc-current-testnet.json')).deployment;
const batchDir = 'SingleSparkContract/arc/data/spark-test-wallets-20260917-gpEgqt';
const dir = `${batchDir}/stress-${deployment.launch.slice(2,10)}`;
mkdirSync(dir, { recursive: true, mode: 0o700 });
if(process.argv.includes('--pause')) {
  const pid=Number(readFileSync(`${dir}/run.lock`,'utf8'));assert(Number.isInteger(pid)&&pid>1);
  process.kill(pid,process.argv.includes('--now')?'SIGKILL':'SIGTERM');console.log('Paused test submissions; saved signed transactions remain recoverable.');process.exit(0);
}
const abi = artifact('ArcLaunchV2').abi, pmAbi = artifact('PoolManager').abi, rewardAbi = artifact('ArcRewards').abi;
const plan = JSON.parse(readFileSync(`${batchDir}/wallets.json`));
assert(plan.synthetic && plan.chainId === 5042002 && plan.wallets.length === 100);
assert.equal(new Set(plan.wallets.map(w => w.address.toLowerCase())).size, 100);
const source = privateKeyToAccount(process.env.ARC_DEPLOYER_PRIVATE_KEY);
assert.equal(source.address, plan.fundingAddress);
assert.equal(process.env.ARC_LAUNCH_ADDRESS.toLowerCase(), deployment.launch.toLowerCase());
for (const w of plan.wallets) assert.equal(privateKeyToAccount(w.privateKey).address, w.address);
const rpcUrl = 'https://rpc.drpc.testnet.arc.network';
const chain = defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const rpc = http(rpcUrl, { timeout: 20000, retryCount: 0 })({ chain });
const initialInterval=Number(process.argv.find(s=>s.startsWith('--interval='))?.split('=')[1]||80);
assert(Number.isInteger(initialInterval)&&initialInterval>=40&&initialInterval<=1000,'RPC pacing must be 40–1000 ms');
let queue = Promise.resolve(), nextRequest = 0, interval = initialInterval, rpcCount = 0, rpcErrors = 0, activeRpc = 0, peakRpc = 0, lastBackoff=0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const transport = custom({ request: async args => {
  for (let attempt = 0; ; attempt++) {
    const turn = queue.then(async () => { await sleep(Math.max(0, nextRequest - Date.now())); nextRequest = Date.now() + interval; });
    queue = turn.catch(() => {}); await turn; rpcCount++; activeRpc++; peakRpc = Math.max(peakRpc, activeRpc);
    try { return await rpc.request(args); }
    catch (e) {
      rpcErrors++;
      const detail=String(e.details||e.shortMessage||e.message).replace(/0x[0-9a-fA-F]{130,}/g,'[redacted]').slice(0,300);
      appendFileSync(`${dir}/rpc-errors.jsonl`,stringify({at:new Date().toISOString(),method:args.method,detail})+'\n',{mode:0o600});
      if (attempt >= 4 || !/rate limit|limit exceeded|429|timeout|timed out|fetch failed|ECONNRESET|503|502/i.test(detail)) throw e;
      if(Date.now()-lastBackoff>5000){interval=Math.min(350,interval+20);lastBackoff=Date.now();}
      nextRequest = Math.max(nextRequest, Date.now() + 2000 * (attempt + 1));
    } finally { activeRpc--; }
  }
} }, { retryCount: 0 });
const client = createPublicClient({ chain, transport, cacheTime: 0 });
const read = (address, abi, functionName, args = [], blockNumber) => client.readContract({ address, abi, functionName, args, blockNumber });
const factory = (name, args = [], block) => read(deployment.launch, abi, name, args, block);
const same = (a,b) => assert.equal(a.toLowerCase(), b.toLowerCase());
const events = (receipt, name) => parseEventLogs({ abi, eventName: name, logs: receipt.logs }).filter(e => e.address.toLowerCase() === deployment.launch.toLowerCase());
const api = async (path, body, token) => {
  const response = await fetch('http://127.0.0.1:8090' + path, { method: body == null ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body == null ? {} : { body: stringify(body) }), signal: AbortSignal.timeout(15000) });
  assert(response.ok, `API ${path}: ${response.status}`); return response.json();
};
const reportPath = `${dir}/report.json`;
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath)) : { chainId: chain.id, launch: deployment.launch,
  synthetic: true, startedAt: new Date().toISOString(), status: 'preparing', projects: [], wallets: [], directionRule: 'Uniform random integer: odd buy, even sell. Unaffordable/empty sides skip.', initialBudgetUSDC: '50' };
same(report.launch, deployment.launch);
const save = () => persist(reportPath, report);
const contexts = new Map();
const context = (index, account, project) => {
  const path = `${dir}/wallet-${index}.json`;
  const state = existsSync(path) ? JSON.parse(readFileSync(path)) : { address: account.address, index, sequence: 0, draws: 0, skipped: 0, status: 'ready', gas: '0' };
  same(state.address, account.address);
  const c = { index, account, project, state, path };
  contexts.set(index, c); return c;
};
let stopped = false;
process.on('SIGINT', () => { stopped = true; }); process.on('SIGTERM', () => { stopped = true; });
const safeError = e => String(e.shortMessage || e.message || e).replace(/0x[0-9a-fA-F]{130,}/g, '[redacted transaction]').slice(0, 250);
let feeCache, feeAt = 0;
let blockCache, blockAt = 0;
async function headBlock() {
  if (!blockCache || Date.now() - blockAt > 2000) { blockAt = Date.now(); blockCache = client.getBlock(); }
  return blockCache;
}
async function fees() {
  if (!feeCache || Date.now() - feeAt > 5000) { feeAt = Date.now(); feeCache = headBlock().then(block=>client.estimateFeesPerGas({block})); }
  return feeCache;
}
async function settle(c, fresh = false) {
  const p = c.state.pending;
  assert(p && keccak256(p.raw) === p.hash);
  const tx = parseTransaction(p.raw);
  assert.equal(tx.chainId, chain.id); same(await recoverTransactionAddress({ serializedTransaction: p.raw }), c.account.address);
  same(tx.to, p.to); assert.equal(tx.data, p.data); assert.equal(tx.value || 0n, BigInt(p.value));
  assert(BigInt(tx.gas) * tx.maxFeePerGas <= parseEther(c.index === 0 ? '0.5' : '0.025'));
  const decoded = decodeFunctionData({ abi: p.kind === 'approve' ? erc20Abi : abi, data: tx.data });
  assert.equal(decoded.functionName, p.kind);
  if (c.index > 0) {
    same(p.kind === 'approve' ? tx.to : decoded.args[0], c.project.token);
    if (p.kind === 'approve') { same(decoded.args[0], deployment.launch); assert.equal(decoded.args[1], parseEther('1000000000')); }
    else { assert.equal(p.kind, 'trade'); same(tx.to, deployment.launch); assert.equal(decoded.args[1], direction(p.draw)); assert(decoded.args[3] > 0n); assert.equal(tx.value || 0n, decoded.args[1] ? decoded.args[2] : 0n); }
  }
  let receipt;
  if (!fresh) try { receipt = await client.getTransactionReceipt({ hash: p.hash }); } catch (e) { if (e.name !== 'TransactionReceiptNotFoundError') throw e; }
  if (!receipt) {
    try { same(await client.sendRawTransaction({ serializedTransaction: p.raw }), p.hash); }
    catch (e) { if (!/already known|nonce too low/i.test(e.message)) throw e; }
    const until=Date.now()+120000;
    while(!receipt) {
      await sleep(1500);
      try { receipt = await client.getTransactionReceipt({ hash:p.hash }); }
      catch(e) { if(e.name!=='TransactionReceiptNotFoundError')throw e; }
      if(!receipt&&Date.now()>until)throw new Error('Receipt timeout; signed transaction retained for reconciliation');
    }
  }
  const row = { wallet: c.index, hash: p.hash, kind: p.kind, token: c.project?.token, draw: p.draw,
    confirmedAt: new Date().toISOString(), submittedAt: p.createdAt, block: String(receipt.blockNumber), status: receipt.status,
    gas: String(receipt.gasUsed * receipt.effectiveGasPrice), gasUsed: String(receipt.gasUsed) };
  if (receipt.status === 'success' && p.kind === 'trade') {
    const found = events(receipt, 'Traded'); assert.equal(found.length, 1);
    const actual = found[0].args; same(actual.trader, c.account.address); same(actual.token, c.project.token);
    assert.equal(actual.buy, decoded.args[1]); assert.equal(actual.amountIn, decoded.args[2]); assert(actual.amountOut >= decoded.args[3]);
    const swaps = parseEventLogs({ abi: pmAbi, eventName: 'Swap', logs: receipt.logs }).filter(e => e.address.toLowerCase() === deployment.poolManager.toLowerCase());
    assert.equal(swaps.length, 1); assert.equal(swaps[0].args.fee, actual.buy ? c.project.buyFee : c.project.sellFee);
    Object.assign(row, { buy: actual.buy, amountIn: String(actual.amountIn), amountOut: String(actual.amountOut), appliedFee: swaps[0].args.fee });
  }
  appendFileSync(`${dir}/receipts.jsonl`, stringify(row) + '\n', { mode: 0o600, flush: true });
  c.state.gas = String(BigInt(c.state.gas) + BigInt(row.gas)); c.state.sequence++;
  c.state.last = row; c.state.pending = null; c.state.nonce = tx.nonce + 1;
  c.state.status = 'running'; persist(c.path, c.state);
  return receipt;
}
async function send(c, kind, to, contractAbi, args, value = 0n, draw) {
  if (c.state.pending) return settle(c);
  if(kind==='trade')args[4]=(await headBlock()).timestamp+115n;
  let data = encodeFunctionData({ abi: contractAbi, functionName: kind, args });
  // Estimate only: passing a local signer makes viem also fill nonce/fees and probe eth_fillTransaction.
  const [estimated, f, balance] = await Promise.all([client.estimateGas({ account: c.account.address, prepare:false, to, data, value }), fees(), client.getBalance({ address: c.account.address })]);
  const gas = estimated * 120n / 100n;
  assert(gas * f.maxFeePerGas <= parseEther(c.index === 0 ? '0.5' : '0.025'), 'Per-transaction gas budget exceeded');
  if (value + gas * f.maxFeePerGas > balance) return null;
  if (c.state.nonce == null) {
    const [latest, pending] = await Promise.all(['latest','pending'].map(blockTag => client.getTransactionCount({ address: c.account.address, blockTag })));
    assert.equal(latest, pending, 'Untracked pending transaction'); c.state.nonce = latest;
  }
  if(kind==='trade') {args[4]=(await headBlock()).timestamp+115n;data=encodeFunctionData({abi:contractAbi,functionName:kind,args});}
  const raw = await c.account.signTransaction({ chainId:chain.id, to, data, value, nonce: c.state.nonce, gas, ...f, type: 'eip1559' });
  c.state.pending = { raw, hash: keccak256(raw), to, data, value: String(value), kind, draw, createdAt: new Date().toISOString() };
  persist(c.path, c.state); return settle(c, true);
}
const quote = async (p, buy, amount) => (await client.simulateContract({ address: deployment.quoter, abi: artifact('V4Quoter').abi,
  functionName: 'quoteExactInputSingle', args: [{ poolKey: p.poolKey, zeroForOne: buy, exactAmount: amount, hookData: '0x' }] })).result[0];

async function setup() {
  assert.equal(await client.getChainId(), chain.id);
  assert.equal(keccak256(await client.getCode({ address: deployment.launch })), deployment.launchCodeHash);
  const snapshot = await api('/api/arc/snapshot'); same(snapshot.launch, deployment.launch); same(snapshot.platformToken, deployment.platformToken);
  if (!report.projects.length) { report.fromBlock = String(await client.getBlockNumber()); report.projects.push({ symbol: 'SPARK', name: 'SingleSpark', token: deployment.platformToken, buyFee: 30000, sellFee: 30000 }); save(); }
  const plans = [['Stress Ember', 'TEMBR', 10000, 50000], ['Stress Frog', 'TFROG', 30000, 30000], ['Stress Comet', 'TCOMET', 50000, 10000]];
  const c = context(0, source);
  const challenge = await api(`/api/auth/nonce?address=${source.address}&chainId=5042002`);
  const session = await api('/api/auth/login', { message: challenge.message, signature: await source.signMessage({ message: challenge.message }), chainId: chain.id });
  for (const [name, symbol, buyFee, sellFee] of plans) {
    let p = report.projects.find(p => p.symbol === symbol);
    if (!p) {
      const treasury = await api('/api/arc/treasury', { requestId: `stress100-${deployment.launch}-${symbol}` }, session.token);
      p = { name, symbol, buyFee, sellFee, community: treasury.address }; report.projects.push(p); save();
    }
    if (!p.token) {
      // Recover a confirmed launch if the process stopped between its receipt and saving the project.
      let receipt = c.state.last?.kind === 'launch' ? await client.getTransactionReceipt({ hash: c.state.last.hash }) : null;
      let launched = receipt && events(receipt, 'Launched').find(e => e.args.symbol === symbol);
      if (!launched) {
        receipt = await send(c, 'launch', deployment.launch, abi, [name, symbol, '', buyFee, sellFee, p.community]);
        assert(receipt?.status === 'success', 'Launch failed'); launched = events(receipt, 'Launched')[0];
      }
      assert.equal(launched.args.symbol, symbol); same(launched.args.creator, source.address);
      p.token = launched.args.token; p.launchHash = receipt.transactionHash; save();
      console.log(stringify({ created: symbol, token: p.token, buyFee, sellFee }));
    }
  }
  for (const p of report.projects) {
    const [terms, actualFees, state] = await Promise.all([factory('terms',[p.token]),factory('tradeFees',[p.token]),factory('tokens',[p.token])]);
    assert.deepEqual(actualFees, [p.buyFee,p.sellFee]); p.rewards = terms[2]; p.community = terms[1]; p.positionId = String(state[0]);
    [p.poolKey] = await read(deployment.positionManager, artifact('PositionManager').abi, 'getPoolAndPositionInfo', [state[0]]);
    same(p.poolKey.hooks,deployment.strategy); assert.equal(p.poolKey.fee,0x800000); save();
  }
  assert.equal(new Set(report.projects.map(p => p.rewards.toLowerCase())).size, 4);
  for (const w of plan.wallets) {
    const c = context(w.index, privateKeyToAccount(w.privateKey), report.projects[group(w.index)]);
    if (c.state.initialBalance == null) { c.state.initialBalance = String(await client.getBalance({ address: w.address })); assert.equal(c.state.initialBalance, String(parseEther('0.5'))); persist(c.path,c.state); }
    if(process.argv.includes('--finish-residuals') && c.state.status==='exhausted') {c.state.status='ready';delete c.state.stopReason;persist(c.path,c.state);}
  }
}

async function worker(c) {
  let failures = 0,buyBlocked=false,sellBlocked=false;
  while (!stopped && c.state.status !== 'exhausted') {
    try {
      if (c.state.pending) { await settle(c); continue; }
      const [native, tokens, f] = await Promise.all([client.getBalance({ address: c.account.address }), read(c.project.token,erc20Abi,'balanceOf',[c.account.address]), fees()]);
      c.state.native = String(native); c.state.tokens = String(tokens);
      // Reserve for both directions, so a buy does not strand tokens by consuming sell gas.
      const reserve = 500000n * f.maxFeePerGas;
      if (native < 21000n * f.maxFeePerGas) { c.state.status = 'exhausted'; c.state.stopReason = 'below minimum transaction gas'; persist(c.path,c.state); break; }
      if (tokens > 0n && !c.state.approved) {
        if (await read(c.project.token,erc20Abi,'allowance',[c.account.address,deployment.launch]) >= parseEther('100000000')) c.state.approved = true;
        else { const receipt = await send(c,'approve',c.project.token,erc20Abi,[deployment.launch,parseEther('1000000000')]); if (!receipt) { c.state.status='exhausted'; c.state.stopReason='cannot afford approval'; persist(c.path,c.state); break; } assert.equal(receipt.status,'success'); c.state.approved=true; }
      }
      const draw = randomInt(1, 2147483647), buy = direction(draw); c.state.draws++;
      let amount = buy ? (native > reserve * 2n ? (native - reserve * 2n) * BigInt(randomInt(60,96)) / 100n : 0n)
        : tokens * BigInt(native < reserve * 2n ? 100 : randomInt(60,101)) / 100n;
      if(buy && !amount) {
        const tiny=1000000000n,q=await quote(c.project,true,tiny),block=await headBlock();
        const data=encodeFunctionData({abi,functionName:'trade',args:[c.project.token,true,tiny,q*99n/100n,block.timestamp+115n]});
        const gas=await client.estimateGas({account:c.account.address,prepare:false,to:deployment.launch,data,value:tiny});
        const needed=gas*f.maxFeePerGas*120n/100n;
        if(native>needed+tiny)amount=(native-needed)*BigInt(randomInt(20,71))/100n;
        else buyBlocked=true;
      }
      if(noTradePossible(buyBlocked,sellBlocked,tokens)){c.state.status='exhausted';c.state.stopReason='cannot afford either trade direction';persist(c.path,c.state);break;}
      if (!amount) {
        c.state.skipped++;
        // Small remaining balances can still fund a sell; wait for an even draw.
        await sleep(250); continue;
      }
      const [q, block] = await Promise.all([quote(c.project,buy,amount),headBlock()]);
      assert(q > 0n);
      const receipt = await send(c,'trade',deployment.launch,abi,[c.project.token,buy,amount,q*99n/100n,block.timestamp+115n],buy?amount:0n,draw);
      if (!receipt) {
        if(buy)buyBlocked=true;else sellBlocked=true;
        if(noTradePossible(buyBlocked,sellBlocked,tokens)){c.state.status='exhausted';c.state.stopReason='cannot afford either trade direction';persist(c.path,c.state);break;}
        c.state.skipped++; await sleep(250); continue;
      }
      failures = 0;buyBlocked=false;sellBlocked=false;c.state.error = null;
    } catch(e) {
      if(!c.state.pending && /insufficient funds/i.test(e.message)) { c.state.status='exhausted';c.state.stopReason='cannot afford estimated transaction cost';persist(c.path,c.state);break; }
      c.state.error=safeError(e); c.state.status='retrying'; persist(c.path,c.state); failures++;
      if (e.code==='ERR_ASSERTION' || failures >= 10) { stopped=true; report.status='needs_attention'; report.error={wallet:c.index,message:c.state.error}; save(); }
      await sleep(Math.min(10000,failures*1000));
    }
  }
}

const exec = promisify(execFile);
const dbUrl = new URL(process.env.ARC_DATABASE_URL), schema = process.env.ARC_DATABASE_SCHEMA;
assert(/^[a-z0-9_]+$/.test(schema));
const pgEnv = { ...process.env, PGHOST:dbUrl.hostname,PGPORT:dbUrl.port||'5432',PGUSER:decodeURIComponent(dbUrl.username),PGPASSWORD:decodeURIComponent(dbUrl.password),PGDATABASE:dbUrl.pathname.slice(1),PGOPTIONS:'-c statement_timeout=5000' };
const sql = async query => JSON.parse((await exec('psql',['-X','-A','-t','-q','-v','ON_ERROR_STOP=1','-c',query],{env:pgEnv,timeout:10000,maxBuffer:20000000})).stdout.trim());
const receiptRows = () => existsSync(`${dir}/receipts.jsonl`) ? [...new Map(readFileSync(`${dir}/receipts.jsonl`,'utf8').trim().split('\n').filter(Boolean).map(s=>{const r=JSON.parse(s);return[r.hash,r];})).values()] : [];
let monitoring = false;
const seen = new Set(existsSync(`${dir}/index-latency.jsonl`)?readFileSync(`${dir}/index-latency.jsonl`,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s).hash):[]);
async function monitor() {
  if (monitoring) return; monitoring=true;
  try {
    // Take the RPC head first: request queue time must not inflate the API/database lag sample.
    const head=await client.getBlockNumber();
    const start=performance.now(), snapshot=await api('/api/arc/snapshot'), latency=performance.now()-start;
    const [db,ps] = await Promise.all([sql(`SELECT json_build_object('cursor',value::json->>'cursor','trades',(SELECT count(*) FROM "${schema}".market_history WHERE kind='trade'),'bytes',octet_length(value),'payouts',(SELECT count(*) FROM "${schema}".reward_payouts),'commits',(SELECT xact_commit FROM pg_stat_database WHERE datname=current_database()),'deadlocks',(SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()),'wal',pg_current_wal_lsn()::text) FROM "${schema}".kv WHERE key='index'`), exec('ps',['-axo','pid,ppid,%cpu,rss,comm'])]);
    const rows=receiptRows(), trades=rows.filter(r=>r.kind==='trade'&&r.status==='success');
    // Since 2026-09-21 the snapshot embeds only the newest 25 trades across all tokens. Page each
    // project's trades (newest first) back to the oldest block among trades not yet seen.
    const indexed=new Set(), unseen=trades.filter(t=>!seen.has(t.hash));
    if(unseen.length){
      const floor=unseen.reduce((m,t)=>BigInt(t.block)<m?BigInt(t.block):m,BigInt(unseen[0].block));
      for(const p of report.projects) if(p.token) {
        let before;
        do {
          const page=await api(`/api/arc/trades?token=${p.token}&limit=100${before?`&before=${before}`:''}`);
          for(const item of page.items) indexed.add(item.transactionHash.toLowerCase());
          before=page.items.length&&BigInt(page.items.at(-1).blockNumber)>=floor?page.nextBefore:null;
        } while(before);
      }
    }
    for(const t of trades) if(indexed.has(t.hash.toLowerCase())&&!seen.has(t.hash)) { seen.add(t.hash); appendFileSync(`${dir}/index-latency.jsonl`,stringify({hash:t.hash,upperBoundMs:Date.now()-Date.parse(t.confirmedAt),observedAt:new Date().toISOString()})+'\n',{mode:0o600}); }
    const pid=readFileSync(`${process.env.ARC_DATA_DIR}/keeper.lock`,'utf8').trim().split('\n')[1];
    const processes=ps.stdout.trim().split('\n').filter(l=>l.includes('postgres')||l.trim().startsWith(pid+' ')||l.trim().startsWith(process.pid+' '));
    report.wallets=[...contexts.values()].filter(c=>c.index>0).map(c=>({index:c.index,address:c.account.address,token:c.project.token,...Object.fromEntries(['status','sequence','draws','skipped','native','tokens','gas','stopReason','error'].map(k=>[k,c.state[k]]))}));
    const sample={at:new Date().toISOString(),measurementVersion:2,trades:trades.length,buys:trades.filter(t=>t.buy).length,sells:trades.filter(t=>!t.buy).length,reverted:rows.filter(t=>t.status!=='success').length,
      gasUSDC:formatEther(rows.filter(r=>r.wallet>0).reduce((s,r)=>s+BigInt(r.gas),0n)),active:report.wallets.filter(w=>w.status!=='exhausted').length,exhausted:report.wallets.filter(w=>w.status==='exhausted').length,
      rpc:{requests:rpcCount,errors:rpcErrors,peakInFlight:peakRpc,intervalMs:interval},head:String(head),snapshotBlock:snapshot.blockNumber,lagBlocks:String(head>BigInt(snapshot.blockNumber)?head-BigInt(snapshot.blockNumber):0n),dbLagBlocks:String(head>BigInt(db.cursor)?head-BigInt(db.cursor):0n),apiMs:+latency.toFixed(2),indexMatched:trades.filter(t=>seen.has(t.hash)).length,
      worker:snapshot.worker,db,processes,tokens:snapshot.tokens.filter(t=>report.projects.some(p=>p.token?.toLowerCase()===t.token.toLowerCase())).map(t=>({token:t.token,symbol:t.symbol,totalBurned:t.totalBurned,totalBuyback:t.totalBuyback,pendingNative:t.pendingNative,pendingTokens:t.pendingTokens,cycles:t.cycles}))};
    report.latest=sample;save();persist(`${dir}/snapshot.json`,snapshot);appendFileSync(`${dir}/metrics.jsonl`,stringify(sample)+'\n',{mode:0o600});
    console.log(stringify({monitor:sample.at,trades:sample.trades,buys:sample.buys,sells:sample.sells,reverted:sample.reverted,active:sample.active,gasUSDC:sample.gasUSDC,lagBlocks:sample.lagBlocks,dbTrades:db.trades,payouts:db.payouts,rpcErrors,workerError:snapshot.worker.error}));
  } catch(e) { console.log(stringify({monitorError:safeError(e)})); } finally { monitoring=false; }
}

async function audit() {
  const block=await client.getBlock({blockTag:'finalized'}), end=block.number;
  // dRPC rejected even 500-block filtered ranges; use the backend's working log endpoint.
  const logClient=createPublicClient({chain,transport:http('https://rpc.testnet.arc.network',{timeout:20000,retryCount:3}),cacheTime:0});
  assert.equal(await logClient.getChainId(),chain.id);
  assert.equal((await logClient.getBlock({blockNumber:end})).hash,block.hash);
  const logs=[];
  const auditEvents=[...abi,...rewardAbi].filter(e=>e.type==='event'&&['FeesAllocated','Burned','FeesConverted','RewardPaid','RewardPurchased'].includes(e.name));
  for(const address of [deployment.launch,...report.projects.map(p=>p.rewards)])
    for(let from=BigInt(report.fromBlock);from<=end;from+=2000n) {logs.push(...await logClient.getLogs({address,events:auditEvents,fromBlock:from,toBlock:from+1999n>end?end:from+1999n}));await sleep(350);}
  const parsed=parseEventLogs({abi:[...abi,...rewardAbi],logs});
  const allocations=parsed.filter(e=>e.eventName==='FeesAllocated');
  for(const e of allocations) {
    const a=e.args, expected=shares(a.nativeAmount);
    assert.deepEqual([a.ownBuyback,a.jetBuyback,a.distributions,a.community,a.platform],expected);
  }
  const rows=receiptRows().filter(r=>BigInt(r.block)<=end), trades=rows.filter(r=>r.kind==='trade'&&r.status==='success');
  for(const t of trades) assert.equal(t.buy,direction(t.draw));
  // The checkpoint no longer holds trades or burns: they live in market_history (kind, ordinal).
  const indexed=await sql(`SELECT json_build_object('cursor',value::json->>'cursor','trades',(SELECT COALESCE(json_agg(data::json ORDER BY ordinal),'[]') FROM "${schema}".market_history WHERE kind='trade'),'records',(SELECT COALESCE(json_agg(data::json ORDER BY ordinal),'[]') FROM "${schema}".market_history WHERE kind='burn'),'fees',value::json->'fees','payouts',(SELECT count(*) FROM "${schema}".reward_payouts)) FROM "${schema}".kv WHERE key='index'`);
  const hashes=new Set(indexed.trades.map(t=>t.transactionHash.toLowerCase()));
  const result={synthetic:true,chainId:chain.id,launch:deployment.launch,at:new Date().toISOString(),finalizedBlock:String(end),status:report.status,
    transactions:rows.length,trades:trades.length,buys:trades.filter(t=>t.buy).length,sells:trades.filter(t=>!t.buy).length,reverted:rows.filter(r=>r.status!=='success').length,
    walletGasUSDC:formatEther(rows.filter(r=>r.wallet>0).reduce((s,r)=>s+BigInt(r.gas),0n)),launchGasUSDC:formatEther(rows.filter(r=>r.wallet===0).reduce((s,r)=>s+BigInt(r.gas),0n)),
    indexed:{cursor:indexed.cursor,matched:trades.filter(t=>hashes.has(t.hash.toLowerCase())).length,missing:trades.filter(t=>!hashes.has(t.hash.toLowerCase())).map(t=>t.hash),payoutRows:indexed.payouts},projects:[],wallets:[]};
  const paid=parsed.filter(e=>e.eventName==='RewardPaid');
  for(const p of report.projects) {
    const scoped=parsed.filter(e=>e.args.token?.toLowerCase()===p.token.toLowerCase()), rewardEvents=parsed.filter(e=>e.address.toLowerCase()===p.rewards.toLowerCase());
    const sums=name=>scoped.filter(e=>e.eventName===name), burns=sums('Burned'), feeEvents=sums('FeesAllocated'), conversions=sums('FeesConverted');
    const payouts=rewardEvents.filter(e=>e.eventName==='RewardPaid'), purchases=rewardEvents.filter(e=>e.eventName==='RewardPurchased');
    for(const e of payouts) assert.equal(e.args.amount,parseEther('10'));
    assert.equal(new Set(payouts.map(e=>e.args.recipient.toLowerCase())).size,payouts.length,'Duplicate recipient across reward batches');
    const batches=[...new Set(payouts.map(e=>e.transactionHash))].map(hash=>({hash,recipients:payouts.filter(e=>e.transactionHash===hash).length}));
    for(const b of batches) assert(b.recipients>=100);
    const [state,communityCredit,conversionTokens,available,pendingNative,totalPaid]=await Promise.all([
      factory('tokens',[p.token],end),factory('communityCredit',[p.token],end),factory('conversionTokens',[p.token],end),
      read(p.rewards,rewardAbi,'available',[],end),read(p.rewards,rewardAbi,'pendingNative',[],end),read(p.rewards,rewardAbi,'totalPaid',[],end)]);
    const sum=(events,key)=>events.reduce((s,e)=>s+e.args[key],0n);
    assert.equal(totalPaid,BigInt(payouts.length),'Payout log completeness');
    assert.equal(state[5],sum(burns,'bought')+sum(burns,'feeTokens'),'Burn log completeness');
    assert.equal(state[4],sum(burns,'nativeAmount'),'Buyback spending');
    const rewardCredits=feeEvents.reduce((s,e)=>s+e.args.tokenAmount*5n/100n,0n);
    assert.equal(available,rewardCredits+sum(purchases,'tokensBought')-sum(payouts,'amount'),'Reward token conservation');
    assert.equal(pendingNative,sum(feeEvents,'distributions')-sum(purchases,'nativeAmount'),'Reward native conservation');
    const burnCredits=feeEvents.reduce((s,e)=>s+e.args.tokenAmount*(p.token.toLowerCase()===deployment.platformToken.toLowerCase()?90n:83n)/100n,0n);
    assert.equal(state[2],burnCredits-sum(burns,'feeTokens'),'Pending fee burns');
    assert.equal(conversionTokens,sum(feeEvents,'tokenAmount')-burnCredits-rewardCredits-sum(conversions,'tokenAmount'),'Fee conversion conservation');
    let nativeCredit=sum(feeEvents,'ownBuyback');
    if(p.token.toLowerCase()===deployment.platformToken.toLowerCase()) {
      nativeCredit+=sum(allocations,'jetBuyback');
      nativeCredit+=parsed.filter(e=>e.eventName==='FeesConverted'&&e.args.token.toLowerCase()!==deployment.platformToken.toLowerCase()).reduce((s,e)=>s+e.args.nativeAmount*7n/12n,0n);
    }
    assert.equal(state[1],nativeCredit-sum(burns,'nativeAmount'),'Own and cross-project platform buyback budgets');
    const pt=trades.filter(t=>t.token.toLowerCase()===p.token.toLowerCase());
    result.projects.push({...p,walletCount:plan.wallets.filter(w=>group(w.index)===report.projects.indexOf(p)).length,
      buys:pt.filter(t=>t.buy).length,sells:pt.filter(t=>!t.buy).length,
      uncollectedLpFeeEstimate:{atIndexBlock:indexed.cursor,nativeUSDC:formatEther(BigInt(indexed.fees?.[p.token.toLowerCase()]?.native||0)),tokens:formatEther(BigInt(indexed.fees?.[p.token.toLowerCase()]?.token||0))},
      collectedNativeFeesUSDC:formatEther(sum(feeEvents,'nativeAmount')),collectedTokenFees:formatEther(sum(feeEvents,'tokenAmount')),
      allocation:Object.fromEntries(['ownBuyback','jetBuyback','distributions','community','platform'].map(k=>[k,formatEther(sum(feeEvents,k))])),
      buybackUSDC:formatEther(sum(burns,'nativeAmount')),boughtAndBurnedTokens:formatEther(sum(burns,'bought')),directFeeBurnTokens:formatEther(sum(burns,'feeTokens')),
      burnTransactions:burns.map(e=>e.transactionHash),totalBurnedTokens:formatEther(state[5]),pendingBuybackUSDC:formatEther(state[1]),pendingBurnTokens:formatEther(state[2]),
      conversionTokens:formatEther(conversionTokens),convertedTokens:formatEther(sum(conversions,'tokenAmount')),conversionProceedsUSDC:formatEther(sum(conversions,'nativeAmount')),
      communityCreditUSDC:formatEther(communityCredit),rewards:{availableTokens:formatEther(available),pendingNativeUSDC:formatEther(pendingNative),totalPaid:String(totalPaid),observedRecipients:payouts.length,batches,
        purchasedTokens:formatEther(sum(purchases,'tokensBought')),purchaseUSDC:formatEther(sum(purchases,'nativeAmount'))}});
  }
  // Fixed finalized block avoids misattributing simultaneous trades to pre-block quotes.
  for(const w of plan.wallets) {
    const p=report.projects[group(w.index)], own=rows.filter(r=>r.wallet===w.index), t=own.filter(r=>r.kind==='trade'&&r.status==='success');
    const [native,tokens]=await Promise.all([client.getBalance({address:w.address,blockNumber:end}),read(p.token,erc20Abi,'balanceOf',[w.address],end)]);
    const expectedNative=parseEther('0.5')-own.reduce((s,r)=>s+BigInt(r.gas),0n)+t.reduce((s,r)=>s+(r.buy?-BigInt(r.amountIn):BigInt(r.amountOut)),0n);
    const rewards=paid.filter(e=>e.address.toLowerCase()===p.rewards.toLowerCase()&&e.args.recipient.toLowerCase()===w.address.toLowerCase()).reduce((s,e)=>s+e.args.amount,0n);
    const expectedTokens=t.reduce((s,r)=>s+(r.buy?BigInt(r.amountOut):-BigInt(r.amountIn)),0n)+rewards;
    assert.equal(native,expectedNative,`Wallet ${w.index} native balance mismatch`);assert.equal(tokens,expectedTokens,`Wallet ${w.index} token balance mismatch`);
    result.wallets.push({index:w.index,address:w.address,token:p.token,remainingUSDC:formatEther(native),remainingTokens:formatEther(tokens),trades:t.length,gasUSDC:formatEther(own.reduce((s,r)=>s+BigInt(r.gas),0n))});
  }
  result.remainingUSDC=formatEther(result.wallets.reduce((s,w)=>s+parseEther(w.remainingUSDC),0n));
  let distributionGas=0n;
  for(const p of result.projects){let gas=0n;for(const b of p.rewards.batches){const receipt=await client.getTransactionReceipt({hash:b.hash});assert.equal(receipt.status,'success');b.gasUSDC=formatEther(receipt.gasUsed*receipt.effectiveGasPrice);gas+=receipt.gasUsed*receipt.effectiveGasPrice;}p.rewards.gasUSDC=formatEther(gas);distributionGas+=gas;}
  result.distributionGasUSDC=formatEther(distributionGas);
  const metrics=readFileSync(`${dir}/metrics.jsonl`,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const percentile=(values,q)=>values.sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*q))];
  const observations=new Map();
  const firstVisible=new Map();
  if(existsSync(`${dir}/index-latency.jsonl`))for(const line of readFileSync(`${dir}/index-latency.jsonl`,'utf8').trim().split('\n').filter(Boolean)){const r=JSON.parse(line);observations.set(r.hash,Math.min(observations.get(r.hash)??Infinity,r.upperBoundMs));firstVisible.set(r.hash,Math.min(firstVisible.get(r.hash)??Infinity,Date.parse(r.observedAt)));}
  const latencies=[...observations.values()];
  const chainLatencies=indexed.trades.filter(t=>firstVisible.has(t.transactionHash)).map(t=>firstVisible.get(t.transactionHash)-Number(t.timestamp)*1000);
  const tradeHashes=new Set(trades.map(t=>t.hash));
  const times=indexed.trades.filter(t=>tradeHashes.has(t.transactionHash)).map(t=>Number(t.timestamp)).sort((a,b)=>a-b);
  let left=0,peakMinute=0;for(let right=0;right<times.length;right++){while(times[right]-times[left]>=60)left++;peakMinute=Math.max(peakMinute,right-left+1);}
  const preciseMetrics=metrics.filter(m=>m.measurementVersion===2);
  const keeperPid=readFileSync(`${process.env.ARC_DATA_DIR}/keeper.lock`,'utf8').trim().split('\n')[1];
  const backendSamples=metrics.flatMap(m=>m.processes.filter(p=>p.trim().split(/\s+/)[0]===keeperPid).map(p=>p.trim().split(/\s+/)));
  const wal=s=>s.split('/').reduce((n,x)=>n*4294967296n+BigInt('0x'+x),0n);
  result.performance={samples:metrics.length,apiP95Ms:percentile(metrics.map(m=>m.apiMs),0.95),indexLagP95Blocks:percentile(metrics.map(m=>Number(m.lagBlocks)),0.95),indexLagMaxBlocks:Math.max(...metrics.map(m=>Number(m.lagBlocks))),
    observedIndexP95UpperBoundMs:percentile(latencies,0.95),observedIndexSamples:latencies.length,checkpointMaxBytes:Math.max(...metrics.map(m=>m.db.bytes)),
    inclusionToIndexP95UpperBoundMs:percentile(chainLatencies,0.95),peakOnchainTradesPerMinute:peakMinute,peakMinuteMeanTPS:peakMinute/60,dbLagP95Blocks:percentile(preciseMetrics.map(m=>Number(m.dbLagBlocks)),0.95),dbLagMaxBlocks:Math.max(0,...preciseMetrics.map(m=>Number(m.dbLagBlocks))),
    backendMaxCpuPercent:Math.max(...backendSamples.map(p=>Number(p[2]))),backendMaxRssMiB:Math.max(...backendSamples.map(p=>Number(p[3])/1024)),
    postgresMaxCpuPercent:Math.max(...metrics.map(m=>m.processes.filter(p=>p.includes('postgres')).reduce((sum,p)=>sum+Number(p.trim().split(/\s+/)[2]),0))),
    clusterWalMiB:Number(wal(metrics.at(-1).db.wal)-wal(metrics[0].db.wal))/1048576,
    caveat:'100 wallet workers; RPC pacing limits network concurrency. Early head/API samples were not simultaneous; dbLag uses corrected version-2 samples. Visibility latencies are sampled upper bounds. CPU and WAL include shared-machine/database activity.'};
  result.operationsCreditUSDC=formatEther(await factory('operationsCredit',[],end));
  result.keeperBalanceUSDC=formatEther(await client.getBalance({address:deployment.keeper,blockNumber:end}));
  result.keeperReserveUSDC=process.env.ARC_GAS_RESERVE_USDC;
  result.validation={oddBuyEvenSell:true,directionalFees:true,integerAllocations:true,walletBalances:true,rewardConservation:true,burnAndConversionConservation:true,crossProjectPlatformCredits:true,allTestTradesIndexed:result.indexed.missing.length===0,
    nativeBuybackExecuted:result.projects.some(p=>parseEther(p.buybackUSDC)>0n),rewardNativePurchaseExecuted:result.projects.some(p=>parseEther(p.rewards.purchaseUSDC)>0n)};
  persist(`${dir}/audit.json`,result);
  console.log(stringify({audit:`${dir}/audit.json`,trades:result.trades,indexed:result.indexed,remainingUSDC:result.remainingUSDC,projects:result.projects.map(p=>({symbol:p.symbol,buys:p.buys,sells:p.sells,buybackUSDC:p.buybackUSDC,burned:p.totalBurnedTokens,rewards:p.rewards}))}));
}

if(process.argv.includes('--audit')) { await audit();process.exit(0); }
if(process.argv.includes('--observe')) {
  assert(!existsSync(`${dir}/run.lock`),'Use the running test monitor instead');
  for(const w of plan.wallets)context(w.index,privateKeyToAccount(w.privateKey),report.projects[group(w.index)]);
  for(let i=0;i<6;i++){await monitor();if(i<5)await sleep(30000);}process.exit(0);
}
if(process.argv.includes('--probe')) {
  const p=report.projects[0], account=privateKeyToAccount(plan.wallets[0].privateKey);
  console.log(stringify({keeperBalanceUSDC:formatEther(await client.getBalance({address:deployment.keeper})),operationsCreditUSDC:formatEther(await factory('operationsCredit'))}));
  const last=JSON.parse(readFileSync(`${dir}/wallet-1.json`)).last;
  if(last?.status==='reverted'){const tx=await client.getTransaction({hash:last.hash}),b=await client.getBlock({blockNumber:tx.blockNumber}),args=decodeFunctionData({abi,data:tx.input}).args;console.log(stringify({reverted:last.hash,deadline:args[4],minedTimestamp:b.timestamp,expired:args[4]<b.timestamp}));}
  try {const q=await quote(p,true,parseEther('0.001')),b=await headBlock();console.log(stringify({quote:String(q),block:String(b.number),gas:String(await client.estimateContractGas({address:deployment.launch,abi,functionName:'trade',account:account.address,prepare:false,value:parseEther('0.001'),args:[p.token,true,parseEther('0.001'),q*99n/100n,b.timestamp+115n]}))}));}
  catch(e){console.log(stringify({error:safeError(e),details:e.details,cause:e.cause?.details}));}process.exit(0);
}
let lock;
try {
  if(existsSync(`${dir}/run.lock`)) {
    const pid=Number(readFileSync(`${dir}/run.lock`,'utf8'));assert(Number.isInteger(pid)&&pid>1);
    try {process.kill(pid,0);} catch(e) {if(e.code!=='ESRCH')throw e;unlinkSync(`${dir}/run.lock`);}
  }
  lock=openSync(`${dir}/run.lock`,'wx',0o600);writeFileSync(lock,String(process.pid));
  if (!process.argv.includes('--run')) { console.log(stringify({mode:'preflight',launch:deployment.launch,wallets:100,dir,sourceBalance:formatEther(await client.getBalance({address:source.address})),fees:await fees()})); }
  else {
    await setup();report.status='running';delete report.error;report.tradingStartedAt??=new Date().toISOString();
    (report.phases??=[]).push({at:new Date().toISOString(),mode:'direct receipt polling',rpcIntervalMs:interval,measurementVersion:2,buySharePercent:[60,95],sellSharePercent:[60,100],pid:process.pid});save();await monitor();
    const timer=setInterval(()=>void monitor(),20000);
    try { await Promise.all([...contexts.values()].filter(c=>c.index>0).map(worker)); }
    finally {clearInterval(timer);}
    if(!stopped)report.status='wallets_exhausted';else if(report.status!=='needs_attention')report.status='paused';
    report.tradingStoppedAt=new Date().toISOString();await monitor();save();
  }
} catch(e) { report.status='error';report.error=safeError(e);save();console.error(stringify({error:report.error,dir}));process.exitCode=1; }
finally { if(lock!=null){closeSync(lock);unlinkSync(`${dir}/run.lock`);} }
