// Called by verify-argus-fork.mjs --independent-wallets. All writes stay on isolated Anvil.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWalletClient,http,erc20Abi,parseAbi,toHex,zeroAddress} from 'viem';

export async function checkIndependentWallets({env,client,chain,dbUrl,route,router,portalAbi,splitterAbi,trader,send,read,warp,now,mark,steps}) {
  const gasOnly=process.argv.includes('--launch-gas');
  assert.equal(await client.getChainId(),31338);
  const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));
  const port=portServer.address().port;await new Promise(r=>portServer.close(r));
  const base=`http://127.0.0.1:${port}`,dir=mkdtempSync(join(tmpdir(),'argus-independent-'));
  env={...env,ARC_PORT:String(port),ARC_EXPLORER_URL:base,ARC_MEDIA_PUBLIC_BASE:`${base}/api/arc/media`,
    ARC_DATABASE_SCHEMA:`test_argus_wallets_${Date.now()}`,ARC_DATA_DIR:dir,ARC_ARGUS_INDEPENDENT_WALLETS:'true'};
  const sql=statement=>{
    const r=spawnSync('psql',['-X','-A','-t','-v','ON_ERROR_STOP=1'],{input:`SET search_path TO ${env.ARC_DATABASE_SCHEMA}; ${statement}`,
      env:{...process.env,PGHOST:dbUrl.hostname,PGPORT:dbUrl.port||'5432',PGDATABASE:dbUrl.pathname.slice(1),PGUSER:decodeURIComponent(dbUrl.username),PGPASSWORD:decodeURIComponent(dbUrl.password)},encoding:'utf8'});
    assert.equal(r.status,0,'Isolated test SQL failed');return r.stdout.trim().replace(/^SET\n/,'');
  };
  let api,logs='';
  const pause=()=>new Promise(r=>setTimeout(r,1000));
  const request=async(path,init={})=>{
    const r=await fetch(base+path,{...init,headers:{'Content-Type':'application/json',...init.headers},signal:AbortSignal.timeout(30000)});
    return {status:r.status,body:await r.json()};
  };
  const until=async(check,label,seconds=180)=>{
    for(let i=0;i<seconds;i++){const value=await check();if(value)return value;await pause();}
    throw Error(`Timed out: ${label}; ${logs.slice(-2000)}`);
  };
  const start=async()=>{
    api=spawn('SingleSparkBackend/api/target/debug/jet-arc-backend',[],{env,stdio:['ignore','pipe','pipe']});
    api.stdout.on('data',b=>logs+=b);api.stderr.on('data',b=>logs+=b);
    await until(async()=>{if(api.exitCode!==null)throw Error(logs.slice(-2000));try{return (await request('/api/arc/snapshot')).status===200;}catch{return false;}},'HTTP ready');
  };
  const stop=async()=>{if(api?.exitCode===null){const done=new Promise(r=>api.once('exit',r));api.kill('SIGTERM');await done;}};
  const quote='0x3600000000000000000000000000000000000000',portal=env.ARC_LAUNCH_ADDRESS;
  try {
    await start();
    const nonce=await request(`/api/auth/nonce?address=${trader.address}&chainId=31338`);assert.equal(nonce.status,200);
    const login=await request('/api/auth/login',{method:'POST',body:JSON.stringify({message:nonce.body.message,signature:await trader.signMessage({message:nonce.body.message}),chainId:31338})});assert.equal(login.status,200);
    const headers={Authorization:`Bearer ${login.body.token}`},projects=[];
    const uploaded=await request('/api/arc/media',{method:'POST',headers:{...headers,'Content-Type':'image/png'},body:readFileSync('SingleSparkFront/front/static/assets/brands/singlespark-ring-v1-still.png')});assert.equal(uploaded.status,201);
    for(const symbol of ['IWONE','IWTWO']) {
      const draft={requestId:`independent-${symbol}`,name:`Independent ${symbol}`,symbol,imageUri:uploaded.body.publicUrl,description:'Isolated independent wallet proof',channels:{},startFdv:'2500',bondFdv:'1000000',buyTaxBps:100,sellTaxBps:100};
      const posted=await request('/api/arc/argus/launch',{method:'POST',headers,body:JSON.stringify(draft)});assert.equal(posted.status,200,JSON.stringify(posted.body)+logs.slice(-2000));assert(posted.body.revenueAccount);
      const retried=await request('/api/arc/argus/launch',{method:'POST',headers,body:JSON.stringify(draft)});assert.equal(retried.body.revenueAccount,posted.body.revenueAccount);
      assert(!/private|seed|encrypted/i.test(JSON.stringify(posted.body)));
      const waiting=await until(async()=> { const j=(await request(`/api/arc/argus/launch?requestId=${draft.requestId}`,{headers})).body; return j.status==='funding_required'&&j.gasQuote&&j; },'unfunded wallet receives gas estimate');
      assert.equal(waiting.gasQuote.chainId,31338);assert(waiting.gasQuote.expiresAt>Date.now()/1000);
      assert(BigInt(waiting.gasQuote.maxCost)>0n&&BigInt(waiting.gasQuote.maxCost)<10n**18n,'No fixed 1 USDC reserve');
      assert.equal(await client.getBalance({address:posted.body.revenueAccount}),0n);
      projects.push({draft,wallet:posted.body.revenueAccount,gasQuote:waiting.gasQuote});
    }
    assert.notEqual(projects[0].wallet,projects[1].wallet);assert(projects.every(p=>p.wallet.toLowerCase()!==env.ARC_ARGUS_CUSTODY_ADDRESS.toLowerCase()));
    // The synthetic creator pays exactly the live estimate on isolated Anvil; no public-chain wallet.
    const creatorWallet=createWalletClient({account:trader,chain,transport:http(env.ARC_RPC_URL)});
    for(const p of projects) {
      p.paymentHash=await creatorWallet.sendTransaction({to:p.wallet,value:BigInt(p.gasQuote.maxCost)});
      assert.equal((await client.waitForTransactionReceipt({hash:p.paymentHash})).status,'success');
    }
    for(const p of projects) {
      const job=await until(async()=>{const j=(await request(`/api/arc/argus/launch?requestId=${p.draft.requestId}`,{headers})).body;assert.notEqual(j.status,'failed',JSON.stringify(j));return j.status==='confirmed'&&j;},'confirmed independent launch');
      p.token=job.token;p.transactionHash=job.transactionHash;
      const receipt=await client.getTransactionReceipt({hash:job.transactionHash});assert.equal(receipt.from.toLowerCase(),p.wallet.toLowerCase());assert.equal(receipt.status,'success');
      const state=await read(portal,portalAbi,'launches',[p.token]);assert.equal(state[0].toLowerCase(),p.wallet.toLowerCase());p.locker=state[3];p.splitter=state[5];
      assert.equal((await read(p.splitter,splitterAbi,'creator')).toLowerCase(),p.wallet.toLowerCase());
      p.actualGas=(receipt.gasUsed*receipt.effectiveGasPrice).toString();
      assert(BigInt(p.actualGas)<=BigInt(p.gasQuote.maxCost));
      if(!gasOnly) {
        // Separate synthetic fuel for the rest of the plugin test, not part of launch cost.
        await client.request({method:'anvil_setBalance',params:[p.wallet,toHex(10000n*10n**18n)]});
        p.treasury=await until(async()=>{const t=await read(route,router.abi,'community',[p.token]);return t!==zeroAddress&&t;},'independent treasury registration');
        assert.equal((await read(route,router.abi,'projectOf',[p.wallet])).toLowerCase(),p.token.toLowerCase());
      }
      const row=JSON.parse(sql(`SELECT row_to_json(r) FROM (SELECT chain_id,token,token_name,address FROM native_launch_accounts WHERE chain_id=31338 AND lower(token)=lower('${p.token}')) r;`));
      assert.equal(row.token_name,p.draft.name);assert.equal(row.address.toLowerCase(),p.wallet.toLowerCase());
    }
    mark('two independent encrypted project wallets bound by chainId and CA',{projects:projects.map(p=>({name:p.draft.name,token:p.token,wallet:p.wallet,transactionHash:p.transactionHash}))});
    if(gasOnly) {
      await stop();await start();
      for(const p of projects) {
        const job=(await request(`/api/arc/argus/launch?requestId=${p.draft.requestId}`,{headers})).body;
        assert.equal(job.status,'confirmed');assert.equal(job.transactionHash,p.transactionHash);assert.equal(job.gasQuote,undefined);
        assert.equal(sql(`SELECT count(*) FROM argus_launch_requests WHERE request_id='${p.draft.requestId}'`),'1');
      }
      writeFileSync('SingleSparkContract/arc/deployments/argus-launch-gas-local-20261007.json',JSON.stringify({status:'passed_launch_gas_local_fork',generatedAt:new Date().toISOString(),chainId:31338,publicTransactions:false,
        scope:'Synthetic creator pays live launch estimate only. Mock ERC20 USDC and separate native gas on isolated Anvil; not public Arc gas accounting.',projects,steps},null,2)+'\n');
      return;
    }
    assert.equal((await request(`/api/arc/treasury?chainId=8453&token=${projects[0].token}`)).status,404);
    const recipients=Array.from({length:100},(_,i)=>toHex(0x510000n+BigInt(i),{size:20}));
    for(const [functionName,args] of [
      ['fundTreasury',[projects[1].token,false,1n]],
      ['buyAndBurn',[projects[1].token,1n,1n,(await now())+30n]],
      ['distribute',[projects[1].token,0n,recipients]],
    ]) await assert.rejects(()=>client.simulateContract({account:projects[0].wallet,address:route,abi:router.abi,functionName,args}));
    mark('cross-project router actions and wrong-chain API rejected');
    await stop();await start();
    for(const p of projects){const job=(await request(`/api/arc/argus/launch?requestId=${p.draft.requestId}`,{headers})).body;assert.equal(job.status,'confirmed');assert.equal(job.revenueAccount.toLowerCase(),p.wallet.toLowerCase());}
    mark('database and project wallets survive backend restart');
    await send(trader,quote,erc20Abi,'approve',[route,100000n*10n**6n]);
    for(const p of projects){
      await send(trader,route,router.abi,'trade',[p.token,true,10000n*10n**18n,1n,(await now())+120n]);
      const held=await read(p.token,erc20Abi,'balanceOf',[trader.address]);assert(held>0n);
      await send(trader,p.token,erc20Abi,'approve',[route,held/10n]);
      await send(trader,route,router.abi,'trade',[p.token,false,held/10n,10n**12n,(await now())+120n]);
      await send(trader,p.locker,parseAbi(['function collect() returns(uint256,uint256)']),'collect');
      await send(trader,p.splitter,splitterAbi,'distribute');
      // Allow the Rust worker to sign claim, buyback, reward purchase and treasury funding itself.
    }
    await stop();
    const runOnce=()=>new Promise((resolve,reject)=>{
      const child=spawn('SingleSparkBackend/api/target/debug/jet-arc-backend',['--once'],{env,stdio:['ignore','ignore','pipe']});
      let error='';child.stderr.on('data',b=>error+=b);
      const timer=setTimeout(()=>child.kill('SIGTERM'),120000);
      child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error(error.slice(-2000)));});
    });
    for(let i=0;i<100;i++){
      await warp(181);await runOnce();
      const rows=JSON.parse(sql("SELECT coalesce(json_agg(r),'[]') FROM (SELECT source,kind,sender FROM argus_actions WHERE status='applied') r;"));
      if(projects.every(p=>['claim','own','spark','rewards','community','operations'].every(kind=>rows.some(r=>r.source.toLowerCase()===p.token.toLowerCase()&&r.kind===kind&&r.sender.toLowerCase()===p.wallet.toLowerCase())))) break;
      if(i===99)throw Error(`Missing independent keeper actions: ${JSON.stringify(rows)}; ${logs.slice(-2000)}`);
    }
    await start();
    const snapshot=await until(async()=>{const s=(await request('/api/arc/snapshot?chainId=31338')).body;return projects.every(p=>s.tokens?.some(t=>t.token.toLowerCase()===p.token.toLowerCase()&&BigInt(t.totalBurned)>0n))&&s;},'finalized project balances');
    for(const p of projects){
      const token=snapshot.tokens.find(t=>t.token.toLowerCase()===p.token.toLowerCase());assert.equal(token.independentWallet,true);assert.equal(token.revenueAccount.toLowerCase(),p.wallet.toLowerCase());
      const block=BigInt(snapshot.blockNumber);
      assert.equal(BigInt(token.executionQuoteBalance),(await client.readContract({address:quote,abi:erc20Abi,functionName:'balanceOf',args:[p.wallet],blockNumber:block}))*10n**12n);
      assert.equal(BigInt(token.executionTokenBalance),await client.readContract({address:p.token,abi:erc20Abi,functionName:'balanceOf',args:[p.wallet],blockNumber:block}));
    }
    const index=JSON.parse(sql("SELECT value FROM kv WHERE key='index';"));
    for(const p of projects){const b=index.custody.budgets[p.token.toLowerCase()];assert(BigInt(b.received)>0n);assert.equal(BigInt(b.received)+BigInt(b.returned),['own','spark','rewards','community','operations','executed'].reduce((s,k)=>s+BigInt(b[k]),0n));}
    mark('independent Rust signatures claim real fees and execute all five allocations',{publicTransactions:false,
      projects:projects.map(p=>({token:p.token,wallet:p.wallet,budget:index.custody.budgets[p.token.toLowerCase()]})),
      actions:JSON.parse(sql("SELECT coalesce(json_agg(r),'[]') FROM (SELECT source,kind,amount,sender,tx_hash FROM argus_actions WHERE status='applied' ORDER BY id) r;"))});
    const proof={status:'passed_independent_wallets_local_fork',generatedAt:new Date().toISOString(),chainId:31338,publicTransactions:false,
      scope:'Isolated Arc fork; mock ERC20 USDC; explicit synthetic native gas. Existing services and wallets untouched.',steps};
    writeFileSync('SingleSparkContract/arc/deployments/argus-independent-wallets-local-20261006.json',JSON.stringify(proof,null,2)+'\n');
  } finally {await stop();}
}
