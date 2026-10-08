// Synthetic test wallets: legacy stress run, or --v2 for 20 wallets across four projects.
// ARC testnet only; no faucet farming or mainnet activity.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { createPublicClient, createWalletClient, defineChain, http, custom, parseEther, formatEther, erc20Abi,
  encodeFunctionData, decodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, parseEventLogs, zeroAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { persist, stringify } from './runtime.mjs';
import { arcAbi, quoterAbi, positionManagerAbi } from '../../SingleSparkFront/front/web3/arcAbi.ts';
import { artifact } from './deploy.mjs';

const v2 = process.argv.includes('--v2');
const capacity = v2 ? 20 : 200;
const funding = parseEther(v2 ? '0.5' : '0.03');
const reserve = parseEther(v2 ? '50' : '0.2');
const dir = v2 ? 'SingleSparkContract/arc/data/economics-v2-random-wallets' : 'SingleSparkContract/arc/data/rewards-200-wallets';
mkdirSync(dir,{recursive:true,mode:0o700});
const planPath = `${dir}/wallets.json`;
if (!existsSync(planPath)) {
  const wallets = Array.from({length:capacity},(_,index)=>{
    const privateKey=generatePrivateKey();
    const row = {index,address:privateKeyToAccount(privateKey).address,privateKey,
      buyRaw: String(BigInt(randomInt(6000,12001))*10n**12n),sellBps:index%4===0?10000:randomInt(2500,9001)};
    if (v2) {
      const projects = [0, 1, 2, 3];
      for (let i = 3; i > 0; i--) { const j = randomInt(i + 1); [projects[i], projects[j]] = [projects[j], projects[i]]; }
      row.trades = projects.slice(0, 2).map(project => ({ project, buyRaw: String(BigInt(randomInt(150000, 200001)) * 10n**12n), sellBps: index % 4 === 0 ? 10000 : randomInt(2500, 9001) }));
    }
    return row;
  });
  // Shuffle once; the persisted plan fixes all amounts and execution order across retries.
  for(let i=wallets.length-1;i>0;i--) {const j=randomInt(i+1);[wallets[i],wallets[j]]=[wallets[j],wallets[i]];}
  persist(planPath,{chainId:5042002,createdAt:new Date().toISOString(),synthetic:true,wallets});
}
const plan=JSON.parse(readFileSync(planPath));assert.equal(plan.chainId,5042002);assert.equal(plan.wallets.length,capacity);
const countArg=process.argv.find(arg=>arg.startsWith('--count='));
const count=countArg?Number(countArg.slice(8)):capacity;
assert(Number.isInteger(count)&&count>=1&&count<=capacity,`--count must be between 1 and ${capacity}`);
const activeWallets=plan.wallets.slice(0,count);
assert.equal(new Set(plan.wallets.map(w=>w.address)).size,capacity);
for(const w of plan.wallets) assert.equal(privateKeyToAccount(w.privateKey).address,w.address);
if (v2) for (const w of plan.wallets) {
  assert.equal(w.trades.length, 2); assert.equal(new Set(w.trades.map(t => t.project)).size, 2);
  for (const t of w.trades) { assert(Number.isInteger(t.project) && t.project >= 0 && t.project < 4);
    assert(BigInt(t.buyRaw) >= parseEther('0.15') && BigInt(t.buyRaw) <= parseEther('0.2'));
    assert(Number.isInteger(t.sellBps) && t.sellBps >= 2500 && t.sellBps <= 10000); }
}
if (!v2) { process.loadEnvFile('SingleSparkContract/arc/.env.testnet.local'); assert.equal(Number(process.env.ARC_CHAIN_ID),5042002); }
const verification=JSON.parse(readFileSync(v2 ? 'SingleSparkContract/arc/deployments/arc-economics-v2-testnet.json' : 'SingleSparkContract/arc/deployments/jet-rewards-testnet-verification.json'));
assert.equal(verification.status,'passed');const d=verification.deployment;
const funderKey=v2 || process.argv.includes('--faucet-funded')
  ? JSON.parse(readFileSync('SingleSparkContract/arc/data/jet-test-wallets-20260916/wallets.json')).wallets[1].privateKey
  : process.env.ARC_DEPLOYER_PRIVATE_KEY;
const funder=privateKeyToAccount(funderKey);
if (v2) assert.equal(funder.address, verification.funder);
const rpcUrl = v2 ? 'https://rpc.drpc.testnet.arc.network' : process.env.ARC_RPC_URL;
const chain=defineChain({id:5042002,name:'Arc Testnet',nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18},rpcUrls:{default:{http:[rpcUrl]}}});
const rpc=http(rpcUrl,{timeout:15000,retryCount:0})({chain});
let queue=Promise.resolve(),nextRequest=0;
const transport=custom({request:async args=>{
  for(let attempt=0;;attempt++){
    const slot=queue.then(async()=>{await new Promise(r=>setTimeout(r,Math.max(0,nextRequest-Date.now())));nextRequest=Date.now()+350;});
    queue=slot.catch(()=>{});await slot;
    try{return await rpc.request(args);}catch(error){
      if(!/rate limit|limit exceeded|timed out|timeout|fetch failed|ECONNRESET/i.test(error.message)||attempt>=3)throw error;
      nextRequest=Math.max(nextRequest,Date.now()+(attempt+1)*5000);
    }
  }
}},{retryCount:0});
const client=createPublicClient({chain,transport,cacheTime:0});
assert.equal(await client.getChainId(),5042002);
assert.equal(keccak256(await client.getCode({address:d.launch})),d.launchCodeHash);
const reportPath=v2 ? 'SingleSparkContract/arc/deployments/arc-v2-random-wallets.json' : 'SingleSparkContract/arc/deployments/jet-rewards-200-wallets.json';
const report=existsSync(reportPath)?JSON.parse(readFileSync(reportPath)):{chainId:5042002,synthetic:true,launch:d.launch,token:d.platformToken,
  fundingPerWalletUSDC:formatEther(funding),funder:funder.address,wallets:plan.wallets.map(({privateKey,...w})=>w),transactions:{},startedAt:new Date().toISOString()};
assert.equal(report.launch,d.launch);assert.equal(report.token,d.platformToken);
assert.equal(report.funder,funder.address);
assert.equal(report.fundingPerWalletUSDC, formatEther(funding));
report.testWalletCount=count;
const log=v=>console.log(stringify(v));
if(!process.argv.includes('--broadcast')) {log({mode:'preflight',wallets:count,fundingUSDC:formatEther(BigInt(count)*funding),chainId:5042002,
  funderBalanceUSDC:formatEther(await client.getBalance({address:funder.address})),token:d.platformToken,
  totalBuyUSDC:formatEther(activeWallets.reduce((v,w)=>v+(v2 ? w.trades.reduce((sum,t)=>sum+BigInt(t.buyRaw),0n) : BigInt(w.buyRaw)),0n)),
  minimumFunderReserveUSDC:formatEther(reserve), plannedBuySellTrades:count * (v2 ? 4 : 2)});process.exit(0);}
const lockPath=`${dir}/run.lock`;const lock=openSync(lockPath,'wx',0o600);
writeFileSync(lock, String(process.pid));
const journalPath=`${dir}/transactions.json`;
const journal=existsSync(journalPath)?JSON.parse(readFileSync(journalPath)):{};
let done=Object.keys(report.transactions).length;
try {
  const fees=async()=>{const f=await client.estimateFeesPerGas();if(f.maxFeePerGas<20_000_000_000n)f.maxFeePerGas=20_000_000_000n;return f;};
  async function sign(label,account,transaction,nonce,gas,fee) {
    if(journal[label])return;
    assert(gas <= (v2 && account.address === funder.address ? 3500000n : 600000n));
    assert(gas*fee.maxFeePerGas<=parseEther(v2 && account.address === funder.address ? '0.1' : '0.03'));
    const wallet=createWalletClient({account,chain,transport});
    const raw=await wallet.signTransaction({...transaction,...fee,nonce,gas,chainId:chain.id,type:'eip1559'});
    journal[label]={raw,hash:keccak256(raw),sender:account.address,to:transaction.to,value:String(transaction.value??0n),data:transaction.data??'0x'};
    persist(journalPath,journal); // Only durable signed bytes are ever broadcast or retried.
  }
  async function confirm(label,account,to,value,abi,functionName,expectedArgs) {
    const step=journal[label];assert(step);const tx=parseTransaction(step.raw);
    assert.equal(keccak256(step.raw),step.hash);assert.equal(tx.chainId,chain.id);assert.equal(tx.to.toLowerCase(),to.toLowerCase());
    assert.equal(tx.value??0n,value);assert.equal((await recoverTransactionAddress({serializedTransaction:step.raw})).toLowerCase(),account.address.toLowerCase());
    if(abi){const decoded=decodeFunctionData({abi,data:tx.data});assert.equal(decoded.functionName,functionName);
      // Exact intent except quote/deadline, which are frozen in the signed transaction.
      expectedArgs.forEach((v,i)=>assert.equal(String(decoded.args[i]).toLowerCase(),String(v).toLowerCase()));
    }else assert.equal(tx.data??'0x','0x');
    let receipt;
    try{receipt=await client.getTransactionReceipt({hash:step.hash});}catch(e){if(e.name!=='TransactionReceiptNotFoundError')throw e;}
    if(!receipt){try{await client.sendRawTransaction({serializedTransaction:step.raw});}catch(e){if(!/already known|nonce too low/i.test(e.message))throw e;}
      receipt=await client.waitForTransactionReceipt({hash:step.hash,timeout:45000});}
    if (receipt.status !== 'success') {
      report.failedTransactions ??= {};
      report.failedTransactions[step.hash] = { label, block: String(receipt.blockNumber), gasUSDC: formatEther(receipt.gasUsed * receipt.effectiveGasPrice) };
      persist(reportPath, report);
      if (v2 && functionName === 'trade') {
        const decoded = decodeFunctionData({ abi, data: tx.data });
        const block = await client.getBlock({ blockNumber: receipt.blockNumber });
        if (block.timestamp > decoded.args[4]) {
          assert((await client.getBlock({ blockTag: 'finalized' })).number >= receipt.blockNumber, 'Wait for failed transaction finality before retrying');
          // A finalized failure consumed this nonce. Preserve it before preparing a fresh trade.
          journal[`${label}-failed-${tx.nonce}`] = step; delete journal[label]; persist(journalPath, journal);
          const error = new Error(`${label}: confirmed deadline expiry; re-quote with a new nonce`); error.code = 'EXPIRED_TRADE'; throw error;
        }
      }
      assert.fail(`${label} reverted ${step.hash}`);
    }
    if(!report.transactions[label]){report.transactions[label]={hash:step.hash,block:String(receipt.blockNumber),gasUSDC:formatEther(receipt.gasUsed*receipt.effectiveGasPrice)};
      persist(reportPath,report);done++;if(done%20===0)log({confirmed:done,latest:label});}
    return receipt;
  }
  // One funder, four consecutive nonces per durable batch. Never extend an unresolved batch.
  // Reconcile previously signed funding before applying a reduced test count; never lose its receipts.
  for(const w of plan.wallets)if(journal[`fund-${w.index}`]&&!report.transactions[`fund-${w.index}`])await confirm(`fund-${w.index}`,funder,w.address,funding);
  for(let start=0;start<count;start+=4){
    const batch=activeWallets.slice(start,start+4);const fresh=batch.filter(w=>!journal[`fund-${w.index}`]);
    if(fresh.length){const nonce=await client.getTransactionCount({address:funder.address,blockTag:'pending'});
      const latest=await client.getTransactionCount({address:funder.address,blockTag:'latest'});assert.equal(nonce,latest,'Resolve previous funding batch first');
      const fee=await fees();
      assert(await client.getBalance({address:funder.address})>=reserve+BigInt(fresh.length)*(funding+21000n*fee.maxFeePerGas));
      for(let i=0;i<fresh.length;i++)await sign(`fund-${fresh[i].index}`,funder,{to:fresh[i].address,value:funding},nonce+i,21000n,fee);
    }
    // Broadcast in nonce order; confirmations may resolve independently.
    for(const w of batch){const step=journal[`fund-${w.index}`];if(report.transactions[`fund-${w.index}`])continue;
      try{await client.sendRawTransaction({serializedTransaction:step.raw});}catch(e){if(!/already known|nonce too low/i.test(e.message))throw e;}}
    const settled=await Promise.allSettled(batch.map(w=>confirm(`fund-${w.index}`,funder,w.address,funding)));
    for(const result of settled)if(result.status==='rejected')throw result.reason;
  }
  log({fundedWallets:Object.keys(report.transactions).filter(k=>k.startsWith('fund-')).length,tradingWallets:count});
  async function transact(w,label,abi,functionName,args,value=0n,token=d.platformToken){
    const account=privateKeyToAccount(w.privateKey);const to=functionName==='approve'?token:d.launch;
    if(!journal[label]){const nonce=await client.getTransactionCount({address:w.address,blockTag:'pending'});
      assert.equal(nonce,await client.getTransactionCount({address:w.address,blockTag:'latest'}));
      let data=encodeFunctionData({abi,functionName,args});const estimate=await client.estimateGas({account,to,data,value});
      const gas=estimate+estimate/5n;const fee=await fees();
      assert(await client.getBalance({address:w.address})>=value+gas*fee.maxFeePerGas+(v2 && w.address === funder.address ? reserve : parseEther('0.002')),'Wallet gas reserve');
      if (v2 && functionName === 'trade') {
        const project = report.projects.find(p => p.token.toLowerCase() === args[0].toLowerCase());
        const [freshQuote, block] = await Promise.all([quote(args[1], args[2], project), client.getBlock()]);
        assert(Math.abs(Date.now() / 1000 - Number(block.timestamp)) < 30, 'RPC latest block is stale; do not sign');
        args[3] = freshQuote * 97n / 100n; args[4] = block.timestamp + 115n;
        data = encodeFunctionData({ abi, functionName, args });
      }
      await sign(label,account,{to,data,value},nonce,gas,fee);
    }
    return confirm(label,account,to,value,abi,functionName,functionName==='trade'?args.slice(0,3):args);
  }
  const factoryAbi = v2 ? artifact('ArcLaunchV2').abi : arcAbi;
  if (v2) {
    const api = async (path, body, bearer) => { const response = await fetch(`http://127.0.0.1:8094${path}`, {
      method: body == null ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      ...(body == null ? {} : { body: stringify(body) }), signal: AbortSignal.timeout(15000) }); assert(response.ok, `${path}: ${response.status}`); return response.json(); };
    assert.equal((await api('/api/arc/snapshot')).launch.toLowerCase(), d.launch.toLowerCase());
    report.baseline ??= await api('/api/arc/snapshot');
    report.projects ??= [{ token: verification.project.token, symbol: 'SPKTEST', buyFee: 10000, sellFee: 50000 },
      { token: d.platformToken, symbol: 'JET', buyFee: 30000, sellFee: 30000 },
      { name: 'Spark Random Test 33', symbol: 'R33', buyFee: 30000, sellFee: 30000 },
      { name: 'Spark Random Test 51', symbol: 'R51', buyFee: 50000, sellFee: 10000 }];
    persist(reportPath,report);
    const challenge = await api(`/api/auth/nonce?address=${funder.address}&chainId=5042002`);
    const session = await api('/api/auth/login', { message: challenge.message, signature: await funder.signMessage({ message: challenge.message }), chainId: 5042002 });
    for (const p of report.projects.slice(2)) {
      if (!p.community) { p.community = (await api('/api/arc/treasury', { requestId: `random-wallets-20260916-${p.symbol}` }, session.token)).address; persist(reportPath, report); }
      const receipt = await transact({ address: funder.address, privateKey: funderKey }, `launch-${p.symbol}`, factoryAbi, 'launch', [p.name, p.symbol, '', p.buyFee, p.sellFee, p.community]);
      const event = parseEventLogs({ abi: factoryAbi, eventName: 'Launched', logs: receipt.logs }).find(e=>e.address.toLowerCase()===d.launch.toLowerCase()).args;
      assert.equal(event.symbol, p.symbol); assert.equal(event.creator.toLowerCase(), funder.address.toLowerCase());
      p.token = event.token; persist(reportPath, report);
    }
    for (const p of report.projects) {
      const state = await client.readContract({ address:d.launch, abi:factoryAbi, functionName:'tokens', args:[p.token] });
      const [poolKey] = await client.readContract({ address:d.positionManager, abi:positionManagerAbi, functionName:'getPoolAndPositionInfo', args:[state[0]] });
      assert.equal(poolKey.hooks.toLowerCase(), d.strategy.toLowerCase()); assert.equal(poolKey.currency1.toLowerCase(), p.token.toLowerCase());
      assert.deepEqual(await client.readContract({ address:d.launch, abi:factoryAbi, functionName:'tradeFees', args:[p.token] }), [p.buyFee,p.sellFee]);
      p.poolKey = poolKey;
    }
    persist(reportPath, report); log({ projects: report.projects.map(p=>({symbol:p.symbol,token:p.token})) });
  }
  async function quote(buy,amount,project){return(await client.simulateContract({address:d.quoter,abi:quoterAbi,functionName:'quoteExactInputSingle',args:[{
    poolKey:project?.poolKey ?? {currency0:zeroAddress,currency1:d.platformToken,fee:2500,tickSpacing:25,hooks:zeroAddress},zeroForOne:buy,exactAmount:amount,hookData:'0x'}]})).result[0];}
  async function trade(w,buy,amount,project,tradeIndex,attempt=0){const label=`${buy?'buy':'sell'}-${w.index}${v2?`-${tradeIndex}`:''}`;
    const token = project?.token ?? d.platformToken;
    const min=journal[label]?0n:await quote(buy,amount,project)*97n/100n;
    const deadline=(await client.getBlock()).timestamp+115n;
    let receipt;
    try { receipt=await transact(w,label,factoryAbi,'trade',[token,buy,amount,min,deadline],buy?amount:0n); }
    catch (error) {
      if (v2 && attempt < 2 && (error.code === 'EXPIRED_TRADE' || (!journal[label] && /execution reverted/i.test(error.message)))) {
        log({ retry:label,reason:error.code ?? 'simulation failed before signing' });
        return trade(w,buy,amount,project,tradeIndex,attempt+1);
      }
      throw error;
    }
    const event=parseEventLogs({abi:factoryAbi,eventName:'Traded',logs:receipt.logs}).find(e=>e.address.toLowerCase()===d.launch.toLowerCase()).args;
    assert.equal(event.trader.toLowerCase(),w.address.toLowerCase());assert.equal(event.buy,buy);assert.equal(event.amountIn,amount);assert(event.amountOut>0n);
    assert.equal(event.token.toLowerCase(),token.toLowerCase());
    if (v2) {
      const swap = parseEventLogs({ abi:artifact('PoolManager').abi, eventName:'Swap', logs:receipt.logs }).filter(e=>e.address.toLowerCase()===d.poolManager.toLowerCase());
      assert.equal(swap.length,1); assert.equal(swap[0].args.fee,buy?project.buyFee:project.sellFee);
    }
    const walletRow=report.wallets.find(row=>row.index===w.index), row=v2?walletRow.trades[tradeIndex]:walletRow;
    row[buy?'boughtRaw':'soldRaw']=String(buy?event.amountOut:amount);
    if (!buy) row.receivedNativeRaw=String(event.amountOut);
    row[buy?'buyHash':'sellHash']=receipt.transactionHash;persist(reportPath,report);return event.amountOut;
  }
  // Four independent wallet writers; each wallet has only one unresolved nonce at a time.
  for(let start=0;start<count;start+=4){const settled=await Promise.allSettled(activeWallets.slice(start,start+4).map(async w=>{
    for (const [i,t] of (v2?w.trades:[w]).entries()) {
      const project=v2?report.projects[t.project]:undefined;
      const bought=await trade(w,true,BigInt(t.buyRaw),project,i);const sell=bought*BigInt(t.sellBps)/10000n;
      await transact(w,`approve-${w.index}${v2?`-${i}`:''}`,erc20Abi,'approve',[d.launch,sell],0n,project?.token);
      await trade(w,false,sell,project,i);
    }
  }));for(const result of settled)if(result.status==='rejected')throw result.reason;}
  delete report.error;report.status='transactions_confirmed';report.completedAt=new Date().toISOString();
  report.gasUSDC=formatEther([...Object.values(report.transactions),...Object.values(report.failedTransactions??{})].reduce((sum,tx)=>sum+parseEther(tx.gasUSDC),0n));
  report.funderBalanceUSDC=formatEther(await client.getBalance({address:funder.address}));
  persist(reportPath,report);log({status:report.status,wallets:count,transactions:Object.keys(report.transactions).length,gasUSDC:report.gasUSDC,reportPath});
} catch (error) {
  persist(`${dir}/last-error.json`, { message: error.message, cause: error.cause?.message, data: error.cause?.data });
  report.status='incomplete';report.error=error.shortMessage || error.message;persist(reportPath,report);
  console.error(report.error);process.exitCode=1;
}finally{closeSync(lock);unlinkSync(lockPath);}
