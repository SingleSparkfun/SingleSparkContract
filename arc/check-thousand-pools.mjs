// Real local EVM deployments + production Rust/PostgreSQL paths. Never sends to public RPC.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir, cpus, totalmem } from 'node:os';
import { createPublicClient, createWalletClient, defineChain, http, parseEther, parseEventLogs, zeroAddress, toFunctionSelector } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { artifact, deployArc } from './deploy.mjs';
import { testDatabase, testRows, testSql, localApiLimits, localRpcLimits } from './test-database.mjs';

const count = Number(process.env.ARC_CAPACITY_POOLS || 1000);
assert(Number.isInteger(count) && count >= 20 && count <= 1000);
const delayMs = Number(process.env.ARC_CAPACITY_RPC_DELAY_MS || 20);
const dir = mkdtempSync(resolve(tmpdir(), 'spark-thousand-'));
const pause = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { const s = createServer(); await new Promise(r => s.listen(0,'127.0.0.1',r)); const p=s.address().port; await new Promise(r=>s.close(r)); return p; };
const rpc = `http://127.0.0.1:${await freePort()}`;
assert.equal(new URL(rpc).hostname, '127.0.0.1');
const anvil = spawn('anvil', ['--host','127.0.0.1','--port',new URL(rpc).port,'--chain-id','5042002','--accounts','110','--balance','100000','--silent'], {stdio:'ignore'});
const chain = defineChain({id:5042002,name:'Isolated capacity EVM',nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18},rpcUrls:{default:{http:[rpc]}}});
const client = createPublicClient({chain,transport:http(rpc,{retryCount:0}),cacheTime:0,pollingInterval:50});
const mnemonic = 'test test test test test test test test test test test junk';
const account = mnemonicToAccount(mnemonic, {addressIndex:0});
const keeper = mnemonicToAccount(mnemonic, {addressIndex:1});
const wallet = createWalletClient({account,chain,transport:http(rpc)});
const keeperKey = `0x${Buffer.from(keeper.getHdKey().privateKey).toString('hex')}`;
assert.equal(privateKeyToAccount(keeperKey).address, keeper.address);
const abi=artifact('ArcLaunchV2').abi;
let api, apiBase, env, hangUntil=0, hangCalls=0, rewardAddress='', faultCalls=0, calls=0, inFlight=0, peakInFlight=0;
const methods={}, metrics=[], expected=new Map();
const diagnostic=process.env.ARC_CAPACITY_SKIP_SWEEP==='1';
const reportPath=process.env.ARC_CAPACITY_REPORT || `SingleSparkContract/arc/deployments/capacity-${diagnostic?'diagnostic':'1000'}-20260917.json`;
const report={startedAt:new Date().toISOString(),environment:'isolated local Anvil + singlespark_test PostgreSQL',
  runtime:{node:process.version,undici:process.versions.undici},
  actualDeployedPools:count,rpcDelayMs:delayMs,keeperBatchSize:100,hardware:{cpu:cpus()[0]?.model,cores:cpus().length,memoryGiB:totalmem()/2**30},
  caveat:'Real contract execution on local EVM with synthetic wallets; not 1,000 public ARC pools or a public RPC throughput guarantee.'};
const proxy=createServer(async(req,res)=>{
  inFlight++; peakInFlight=Math.max(peakInFlight,inFlight);
  try {
    let body='';for await(const chunk of req)body+=chunk;
    const call=JSON.parse(body);calls++;methods[call.method]=(methods[call.method]||0)+1;
    if(call.method==='eth_call' && (!rewardAddress || (call.params[0].to||'').toLowerCase()===rewardAddress.toLowerCase())
      && (call.params[0].data||call.params[0].input||'').startsWith(toFunctionSelector('available()')) && Date.now()<hangUntil){
      rewardAddress=call.params[0].to;
      hangCalls++;await pause(30000);
    }
    if(faultCalls>0 && call.method==='eth_getLogs'){
      faultCalls--;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:call.id,error:{code:-32005,message:'injected rate limit exceeded'}}));return;
    }
    await pause(delayMs);
    const r=await fetch(rpc,{method:'POST',headers:{'Content-Type':'application/json'},body});
    res.setHeader('Content-Type','application/json');res.end(await r.text());
  }catch(e){if(!res.destroyed){res.statusCode=502;res.end(String(e));}}
  finally{inFlight--;}
});
const until=async(check,ms,label)=>{const start=Date.now();while(Date.now()-start<ms){const result=await check();if(result)return result;await pause(500);}throw Error(`Timeout: ${label}`);};
const snapshot=async()=>{try{const r=await fetch(apiBase+'/api/arc/snapshot');return r.ok?await r.json():null;}catch{return null;}};
// Since 2026-09-21 the snapshot embeds only the newest 25 trades; each token's `market.trades` is its
// full indexed count and `GET /api/arc/trades` pages through the trades themselves (newest first).
const tradeCount=s=>s.tokens.reduce((sum,t)=>sum+Number(t.market?.trades??0),0);
const tokenTrades=async token=>{const items=[];let before;do{
  const r=await fetch(`${apiBase}/api/arc/trades?token=${token}&limit=100${before?`&before=${before}`:''}`);
  assert.equal(r.status,200,`trades page for ${token}`);const page=await r.json();items.push(...page.items);before=page.nextBefore;
  assert(items.length<=page.total,'trade pages must not overlap');}while(before);return items;};
const allTradeHashes=async s=>{const hashes=[];for(const t of s.tokens)if(Number(t.market?.trades??0)>0)
  for(const item of await tokenTrades(t.token))hashes.push(item.transactionHash);return hashes;};
const stop=async child=>{if(!child||child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGTERM');await until(()=>child.exitCode!==null||child.signalCode!==null,90000,'graceful shutdown');};
const startApi=async()=>{
  api=spawn(resolve(process.env.ARC_BACKEND_BINARY||'SingleSparkBackend/api/target/release/jet-arc-backend'),[],{env});
  api.stderr.on('data',b=>appendFileSync(resolve(dir,'backend.log'),b));
  let output='';api.stdout.on('data',b=>{output+=b;});
  await until(()=>{if(api.exitCode!==null)throw Error(`Backend exited ${api.exitCode}; ${dir}/backend.log`);const m=output.match(/listening on (127\.0\.0\.1:\d+)/);if(m){apiBase='http://'+m[1];return true;}},30000,'API startup');
};
const send=async(functionName,args,value=0n,sender=wallet)=>{
  if(functionName==='trade')args[4]=(await client.getBlock()).timestamp+90n;
  const hash=await sender.writeContract({address:report.deployment.launch,abi,functionName,args,value});
  const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success');return receipt;
};
try{
  await until(async()=>{try{return await client.getChainId()===5042002;}catch{return false;}},15000,'Anvil');
  const deploy=async(name,args)=>{const a=artifact(name);const h=await wallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args});const r=await client.waitForTransactionReceipt({hash:h});assert.equal(r.status,'success');return r.contractAddress;};
  const pool=await deploy('PoolManager',[account.address]);
  const pm=await deploy('PositionManager',[pool,zeroAddress,100000,zeroAddress,zeroAddress]);
  report.deployment=await deployArc(client,wallet,{positionManager:pm,keeper:keeper.address,
    operations:mnemonicToAccount(mnemonic,{addressIndex:2}).address,
    platformName:'Capacity Platform',platformSymbol:'CPCT',platformBuyFee:30000,platformSellFee:30000,journalPath:resolve(dir,'deployment.json')});
  rewardAddress=report.deployment.rewards;
  const tokens=[report.deployment.platformToken];
  for(let i=1;i<count;i++){
    const vault=await send('createProjectTreasury',[]);
    const community=parseEventLogs({abi,eventName:'ProjectTreasuryCreated',logs:vault.logs})[0].args.treasury;
    const r=await send('launch',[`Capacity ${i}`,`C${i}`,'',i<100?30000:0,i<100?30000:0,community]);
    tokens.push(parseEventLogs({abi,eventName:'Launched',logs:r.logs})[0].args.token);
    if(i%100===0)console.log(JSON.stringify({phase:'deploying',pools:i+1}));
  }
  writeFileSync(resolve(dir,'tokens.json'),JSON.stringify(tokens));
  report.deploymentBlock=String(await client.getBlockNumber());
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  const proxyUrl=`http://127.0.0.1:${proxy.address().port}`;
  env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ARC_'))),...testDatabase(dir),...localApiLimits, ...localRpcLimits,
    ARC_CHAIN_ID:'5042002',ARC_RPC_URL:proxyUrl,ARC_PUBLIC_RPC_URL:proxyUrl,ARC_EXPLORER_URL:'https://test.invalid',
    ARC_WEB_ORIGIN:'http://127.0.0.1:5176',ARC_HOST:'127.0.0.1',ARC_PORT:'0',ARC_DATA_DIR:dir,
    ARC_LAUNCH_ADDRESS:report.deployment.launch,ARC_QUOTER_ADDRESS:report.deployment.quoter,ARC_FROM_BLOCK:report.deployment.fromBlock,
    ARC_KEEPER_PRIVATE_KEY:keeperKey,ARC_CONFIG_SIGNING_KEY:keeperKey,ARC_CONFIG_KEY_ID:'capacity-only',ARC_GAS_RESERVE_USDC:'1',
    ARC_KEEPER_BATCH_SIZE:'100',ARC_MAX_GAS_PER_TX:'5000000',ARC_REWARDS_ADDRESS:'',ARC_REWARDS_FROM_BLOCK:'',ARC_KEEPER_ADMIN_TOKEN:''};
  const cold=Date.now();await startApi();
  let full=await until(async()=>{const s=await snapshot();return s?.tokens.length===count?s:null;},420000,'all actual pools indexed and cached');
  report.coldStartMs=Date.now()-cold;
  assert.equal(new Set(full.tokens.map(t=>t.token)).size,count);
  assert(full.tokens.every(t=>BigInt(t.positionId)>0n&&t.totalSupply==='1000000000000000000000000000'));
  console.log(JSON.stringify({phase:'all-pools-ready',pools:full.tokens.length,milliseconds:report.coldStartMs}));
  const sweep=Date.now();
  if(!diagnostic)await until(()=>testRows(dir,"SELECT count(*)::int AS n FROM preflight WHERE kind IN ('burn','reward')")[0].n===count*2,480000,'initial keeper checks cover every pool');
  report.initialKeeperSweepSkipped=diagnostic;
  report.initialKeeperSweepMs=Date.now()-sweep;
  report.preflightCoverage=testRows(dir,"SELECT kind,count(*)::int AS checked,count(*) FILTER (WHERE idle)::int AS idle FROM preflight GROUP BY kind ORDER BY kind");
  console.log(JSON.stringify({phase:'all-keeper-checks-ready',milliseconds:report.initialKeeperSweepMs,coverage:report.preflightCoverage}));
  const initialCalls=calls;
  await pause(11000);full=await snapshot();
  report.warmIdle={rpcCallsIn11Seconds:calls-initialCalls,snapshotReads:full.preflight.snapshotReads};
  assert.equal(full.preflight.snapshotReads,0,'Unchanged pools must use cached balances');

  // Force the first reward action to wait beyond the client timeout while fresh trades arrive.
  rewardAddress='';hangUntil=Date.now()+100000;faultCalls=2;
  // Expire one idle check to exercise the normal periodic recheck without funding rewards.
  testSql(dir, `UPDATE preflight SET checked_at=0 WHERE kind='reward' AND token='${tokens[0].toLowerCase()}'`);
  await until(()=>hangCalls>0,65000,'injected reward stall');
  // Anvil automines only on transactions; refresh its block time after the idle sweep.
  await client.request({method:'evm_mine',params:[]});
  const begin=Date.now(), latencies=[], apiLatencies=[], statusErrors=[], workers=20, perWorker=Math.ceil(count/20);
  let observedTimeout=false, done=false;
  // A trade is visible once the published snapshot counts it for its token; the hash itself is then
  // read back from that token's trade page (fetched only when the count changed).
  const counted=new Map();
  const monitor=(async()=>{while(!done){const s=await snapshot();if(s){
    const now=Date.now();
    for(const t of s.tokens){const n=Number(t.market?.trades??0);if(n<=(counted.get(t.token)??0))continue;counted.set(t.token,n);
      // Pages are newest first and may already hold trades published after this snapshot: only
      // the oldest n (the ones this snapshot counted) are credited with this observation time.
      for(const item of (await tokenTrades(t.token)).slice(-n)){const p=expected.get(item.transactionHash);if(p&&!p.visible){p.visible=now;p.delay=now-p.confirmed;latencies.push(p.delay);}}}
    const states=testRows(dir,"SELECT value::json->>'status' AS status,value::json->>'error' AS error FROM kv WHERE key LIKE '%:worker'");
    if(states.some(x=>x.status==='error'&&x.error))observedTimeout=true;
    metrics.push({at:now,indexed:s.blockNumber,trades:tradeCount(s),snapshotReads:s.preflight.snapshotReads,indexer:s.worker.indexer,rpcCalls:calls,rpcInFlight:inFlight,rpcMethods:{...methods}});
  }await pause(1000);}})();
  const readers=(async()=>{for(let round=0;round<10;round++){
    await Promise.all(Array.from({length:100},async(_,reader)=>{const at=performance.now();let response;try{response=await fetch(apiBase+'/api/arc/snapshot',{signal:AbortSignal.timeout(15000)});await response.arrayBuffer();if(!response.ok)statusErrors.push({status:response.status});}catch(e){statusErrors.push({round,reader,stage:response?'body':'headers',status:response?.status,contentLength:response?.headers.get('content-length'),elapsedMs:performance.now()-at,name:e.name,message:e.message,cause:e.cause?.code||e.cause?.message,socket:e.cause?.socket});}apiLatencies.push(performance.now()-at);}));await pause(5000);
  }})();
  await Promise.all(Array.from({length:workers},async(_,w)=>{
    const a=mnemonicToAccount(mnemonic,{addressIndex:10+w}), trader=createWalletClient({account:a,chain,transport:http(rpc)});
    for(let j=0;j<perWorker;j++){
      const token=tokens[(w*perWorker+j)%count];
      const r=await send('trade',[token,true,parseEther('0.1'),1n,BigInt(Math.floor(Date.now()/1000)+100000)],parseEther('0.1'),trader);
      expected.set(r.transactionHash,{confirmed:Date.now(),block:String(r.blockNumber),token});
      await pause(1000);
    }
  }));
  await readers;
  await until(async()=>{const s=await snapshot();return s&&tradeCount(s)===workers*perWorker;},30000,'all trades visible during stalled keeper');
  await until(()=>observedTimeout,45000,'scoped reward timeout persisted');
  hangUntil=0;
  await pause(1500);done=true;await monitor;
  report.load={confirmedTrades:expected.size,concurrentTradingWallets:workers,durationMs:Date.now()-begin,
    tradedPools:new Set([...expected.values()].map(t=>t.token)).size,
    httpClientsPerRound:100,httpRequests:apiLatencies.length,httpErrors:statusErrors.length,httpErrorDetails:statusErrors,
    p95HttpMs:apiLatencies.sort((a,b)=>a-b)[Math.floor(apiLatencies.length*.95)],
    p95IndexVisibilityMs:latencies.sort((a,b)=>a-b)[Math.floor(latencies.length*.95)],maxIndexVisibilityMs:Math.max(...latencies),
    scopedTimeoutPersisted:observedTimeout,injectedRateLimits:2,injectedSlowRewardCalls:hangCalls};
  assert.equal(statusErrors.length,0);assert.equal(latencies.length,expected.size);
  assert(report.load.p95IndexVisibilityMs<15000,'p95 indexing must remain below 15s in this load profile');
  assert(report.load.p95HttpMs<2000,'p95 snapshot HTTP must remain below 2s with 100 concurrent clients');
  const before=await snapshot();const beforeHashes=await allTradeHashes(before);
  assert.equal(beforeHashes.length,tradeCount(before));assert.equal(new Set(beforeHashes).size,beforeHashes.length,'no duplicate trades before restart');
  await stop(api);await startApi();
  const restored=await until(async()=>{const s=await snapshot();return s?.tokens.length===count&&tradeCount(s)===tradeCount(before)?s:null;},60000,'restart without duplicate or missing events');
  const restoredHashes=await allTradeHashes(restored);
  assert.equal(restoredHashes.length,beforeHashes.length,'restart must not duplicate or drop trades');
  assert.deepEqual(new Set(restoredHashes),new Set(beforeHashes));
  report.database=testRows(dir,"SELECT kind,count(*)::int AS rows FROM market_history GROUP BY kind ORDER BY kind");
  report.checkpointBytes=testRows(dir,"SELECT octet_length(value)::int AS bytes FROM kv WHERE key='index'")[0].bytes;
  report.restartPreservedTrades=true;report.rpc={calls,peakInFlight,methods};
  report.status=diagnostic?'diagnostic-passed':'passed';report.completedAt=new Date().toISOString();
}catch(error){report.status='failed';report.error=String(error);throw Error(report.error);}
finally{
  hangUntil=0;
  writeFileSync(resolve(dir,'metrics.json'),JSON.stringify(metrics));
  report.artifacts=dir;report.signedJournalCaveat='Test deployment journal contains public Anvil keys/signed local transactions; no mainnet or testnet private keys used.';
  writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,report:reportPath,artifacts:dir}));
  await stop(api);proxy.closeAllConnections();proxy.close();anvil.kill('SIGTERM');
}
