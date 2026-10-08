// Current ARC testnet only. Funder signs bounded test actions; the API remains the only keeper signer.
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdirSync,openSync,closeSync,unlinkSync,writeFileSync} from 'node:fs';
import {createPublicClient,defineChain,http,erc20Abi,parseEther,formatEther,encodeFunctionData,parseEventLogs,
  parseTransaction,recoverTransactionAddress,keccak256} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {artifact} from './deploy.mjs';
import {persist,stringify} from './runtime.mjs';

const d=JSON.parse(readFileSync('SingleSparkContract/arc/deployments/arc-current-testnet.json')).deployment;
assert.equal(d.chainId,5042002);assert.equal(d.launch.toLowerCase(),'0xf21c9709ab0dc8363b57060c1a9ce81499f11741');
const dir='SingleSparkContract/arc/data/current-readiness-20260917', publicPath='SingleSparkContract/arc/deployments/current-readiness-20260917.json';
mkdirSync(dir,{recursive:true,mode:0o700});
const account=privateKeyToAccount(JSON.parse(readFileSync('SingleSparkContract/arc/data/jet-test-wallets-20260916/wallets.json')).wallets[1].privateKey);
assert.equal(account.address.toLowerCase(),'0x0ca76906cef08981717f81dfa1519b5a3cecca57');
const rpc='https://rpc.testnet.arc.network';
const chain=defineChain({id:5042002,name:'Arc Testnet',nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18},rpcUrls:{default:{http:[rpc]}}});
const c=createPublicClient({chain,transport:http(rpc,{timeout:15000,retryCount:2,retryDelay:1500}),cacheTime:0,pollingInterval:1500});
const abi=artifact('ArcLaunchV2').abi, rewardsAbi=artifact('ArcRewards').abi;
const read=(address,abi,functionName,args=[],blockNumber)=>c.readContract({address,abi,functionName,args,blockNumber});
const factory=(name,args=[],block)=>read(d.launch,abi,name,args,block);
const same=(a,b)=>assert.equal(a.toLowerCase(),b.toLowerCase());
const pause=ms=>new Promise(r=>setTimeout(r,ms));
assert.equal(await c.getChainId(),5042002);
assert.equal(keccak256(await c.getCode({address:d.launch})),d.launchCodeHash);
same(await factory('keeper'),d.keeper);same(await factory('platformToken'),d.platformToken);same(await factory('operations'),d.operations);assert.equal(await factory('minBuyback'),parseEther('5'));
const api=async path=>{const r=await fetch('http://127.0.0.1:8090'+path);assert(r.ok,`API ${r.status}`);return r.json();};
const snapshot=await api('/api/arc/snapshot');same(snapshot.launch,d.launch);
const previous=existsSync(publicPath)?JSON.parse(readFileSync(publicPath)):null;
const projects=previous?.projects||snapshot.tokens.map(p=>({token:p.token,symbol:p.symbol,rewards:p.rewards,community:p.community}));
const meme=projects.find(p=>p.token.toLowerCase()==='0x8203158de8dd9e31485570def32d5c70afaa04d0');assert(meme);
const report=previous||{chainId:5042002,launch:d.launch,funder:account.address,projects,
  scope:'Current deployed factory; unchanged 5 USDC minimum; test assets only',transactions:{},startedAt:new Date().toISOString()};
same(report.launch,d.launch);
const journalPath=dir+'/journal.json';
const journal=existsSync(journalPath)?JSON.parse(readFileSync(journalPath)):{};
const save=()=>writeFileSync(publicPath,stringify(report)+'\n');
const log=x=>console.log(stringify(x));
const balance=await c.getBalance({address:account.address});
if(!process.argv.some(x=>['--run','--fund-gas','--verify'].includes(x))){
  log({mode:'read-only preflight',balanceUSDC:formatEther(balance),keeperUSDC:formatEther(await c.getBalance({address:d.keeper})),
    plan:{keeperFundingUSDC:'5',recycledTradePrincipalUSDC:'100',maximumRoundTrips:9,platformFundFeesUSDC:'100',minimumFunderReserveUSDC:'10'},
    sufficientForFullRun:balance>=parseEther(journal['keeper-gas']?'165':'170'),fundingAddress:account.address});process.exit(0);
}
const lock=openSync(dir+'/run.lock','wx',0o600);writeFileSync(lock,String(process.pid));
async function state(p,block){
  const s=await factory('tokens',[p.token],block);
  return {pendingNative:s[1],pendingTokens:s[2],totalBuyback:s[4],totalBurned:s[5],
    conversion:await factory('conversionTokens',[p.token],block),community:await factory('communityCredit',[p.token],block),
    available:await read(p.rewards,rewardsAbi,'available',[],block),rewardNative:await read(p.rewards,rewardsAbi,'pendingNative',[],block),
    paid:await read(p.rewards,rewardsAbi,'totalPaid',[],block)};
}
async function send(label,to,build){
  let step=journal[label];
  if(!step){
    let tx=await build();
    const nonce=await c.getTransactionCount({address:account.address});
    assert.equal(nonce,await c.getTransactionCount({address:account.address,blockTag:'pending'}),'Resolve existing funder nonce first');
    const gas=(await c.estimateGas({...tx,to,account:account.address,prepare:false}))*120n/100n;
    const fees=await c.estimateFeesPerGas();
    assert(gas<=5000000n&&gas*fees.maxFeePerGas<=parseEther('0.25'),'Per-action gas bound');
    assert(await c.getBalance({address:account.address})>=(tx.value||0n)+gas*fees.maxFeePerGas+parseEther('10'),'Preserve 10 test USDC');
    // Rebuild trade quote/deadline immediately before signing, then retain these exact bytes.
    tx=await build();
    const raw=await account.signTransaction({...tx,to,nonce,gas,...fees,type:'eip1559',chainId:5042002});
    step={raw,hash:keccak256(raw),to,data:tx.data||'0x',value:String(tx.value||0n)};journal[label]=step;persist(journalPath,journal);
  }
  const tx=parseTransaction(step.raw);
  assert.equal(tx.chainId,5042002);same(tx.to,to);assert.equal(tx.data||'0x',step.data);assert.equal(tx.value||0n,BigInt(step.value));
  same(await recoverTransactionAddress({serializedTransaction:step.raw}),account.address);assert.equal(keccak256(step.raw),step.hash);
  let receipt;
  try{receipt=await c.getTransactionReceipt({hash:step.hash});}catch(e){if(e.name!=='TransactionReceiptNotFoundError')throw e;}
  if(!receipt){try{await c.sendRawTransaction({serializedTransaction:step.raw});}catch(e){if(!/already known|nonce too low/i.test(e.message))throw e;}
    receipt=await c.waitForTransactionReceipt({hash:step.hash,timeout:90000});}
  assert.equal(receipt.status,'success',`${label} reverted; retain journal`);
  report.transactions[label]={hash:step.hash,block:String(receipt.blockNumber),gasUSDC:formatEther(receipt.gasUsed*receipt.effectiveGasPrice),valueUSDC:formatEther(BigInt(step.value))};save();
  log({confirmed:label,hash:step.hash});return receipt;
}
const call=(label,address,contractAbi,name,args,value=0n)=>send(label,address,async()=>({data:encodeFunctionData({abi:contractAbi,functionName:name,args}),value}));
async function verify(){
  const end=await c.getBlock({blockTag:'finalized'}), start=BigInt(report.baselineBlock)+1n;
  const all=[];
  for(let from=start;from<=end.number;from+=500n){
    const logs=await c.getLogs({address:[d.launch,...projects.map(p=>p.rewards)],fromBlock:from,toBlock:from+499n<end.number?from+499n:end.number});
    for(const l of logs){const parsed=parseEventLogs({abi:l.address.toLowerCase()===d.launch.toLowerCase()?abi:rewardsAbi,logs:[l],strict:true});all.push(...parsed);}
  }
  const allocations=all.filter(e=>e.eventName==='FeesAllocated'),sum=(events,k)=>events.reduce((s,e)=>s+e.args[k],0n);
  const result={block:String(end.number),blockHash:end.hash,projects:[],assertions:[]};
  for(const p of projects){
    const own=e=>e.args.token?.toLowerCase()===p.token.toLowerCase();
    const fees=allocations.filter(own),burns=all.filter(e=>e.eventName==='Burned'&&own(e));
    const converted=all.filter(e=>e.eventName==='FeesConverted'&&own(e)),claims=all.filter(e=>e.eventName==='CommunityClaimed'&&own(e));
    const purchases=all.filter(e=>e.eventName==='RewardPurchased'&&e.address.toLowerCase()===p.rewards.toLowerCase());
    const paid=all.filter(e=>e.eventName==='RewardPaid'&&e.address.toLowerCase()===p.rewards.toLowerCase());
    const before=Object.fromEntries(Object.entries(report.baseline[p.token]).map(([k,v])=>[k,BigInt(v)])),after=await state(p,end.number);
    const platform=p.token.toLowerCase()===d.platformToken.toLowerCase();
    const burnCredit=fees.reduce((s,e)=>s+e.args.tokenAmount*(platform?90n:83n)/100n,0n);
    const rewardCredit=fees.reduce((s,e)=>s+e.args.tokenAmount*5n/100n,0n);
    let nativeCredit=sum(fees,'ownBuyback');
    if(platform)nativeCredit+=sum(allocations,'jetBuyback')+all.filter(e=>e.eventName==='FeesConverted'&&e.args.token.toLowerCase()!==p.token.toLowerCase()).reduce((s,e)=>s+e.args.nativeAmount*7n/12n,0n);
    assert.equal(after.pendingNative,before.pendingNative+nativeCredit-sum(burns,'nativeAmount'),`${p.symbol} native budget`);
    assert.equal(after.pendingTokens,before.pendingTokens+burnCredit-sum(burns,'feeTokens'));
    assert.equal(after.totalBuyback,before.totalBuyback+sum(burns,'nativeAmount'));
    assert.equal(after.totalBurned,before.totalBurned+sum(burns,'bought')+sum(burns,'feeTokens'));
    assert.equal(after.conversion,before.conversion+sum(fees,'tokenAmount')-burnCredit-rewardCredit-sum(converted,'tokenAmount'));
    assert.equal(after.available,before.available+rewardCredit+sum(purchases,'tokensBought')-sum(paid,'amount'));
    assert.equal(after.rewardNative,before.rewardNative+sum(fees,'distributions')-sum(purchases,'nativeAmount'));
    assert.equal(after.paid,before.paid+BigInt(paid.length));
    assert.equal(after.community,before.community+sum(fees,'community')+converted.reduce((s,e)=>s+e.args.nativeAmount*4n/(platform?5n:12n),0n)-sum(claims,'amount'));
    for(const e of fees){const a=e.args;assert.equal(a.ownBuyback,a.nativeAmount*83n/100n);assert.equal(a.jetBuyback,a.nativeAmount*7n/100n);
      assert.equal(a.distributions,a.nativeAmount*5n/100n);assert.equal(a.community,a.nativeAmount*4n/100n);
      assert.equal(a.platform,a.nativeAmount-a.ownBuyback-a.jetBuyback-a.distributions-a.community);}
    for(const e of claims)same(e.args.recipient,p.community);
    const batches=[...new Set(paid.map(e=>e.transactionHash))].map(hash=>({hash,recipients:paid.filter(e=>e.transactionHash===hash).length}));
    assert(batches.every(b=>b.recipients>=100));assert(paid.every(e=>e.args.amount===parseEther('10')));
    assert.equal(new Set(paid.map(e=>e.args.recipient.toLowerCase())).size,paid.length,'No duplicate recipients within verification interval');
    result.projects.push({...p,buybackUSDC:formatEther(sum(burns,'nativeAmount')),convertedUSDC:formatEther(sum(converted,'nativeAmount')),
      rewardPurchaseUSDC:formatEther(sum(purchases,'nativeAmount')),communityPaidUSDC:formatEther(sum(claims,'amount')),
      burnTransactions:burns.map(e=>e.transactionHash),conversionTransactions:converted.map(e=>e.transactionHash),rewardPurchaseTransactions:purchases.map(e=>e.transactionHash),
      distributionBatches:batches,confirmedRecipients:paid.length,balances:after});
  }
  result.assertions=['native buyback budgets','direct burns','conversion balances','reward native/tokens','payout count and amounts','community credits','five-way native allocation'];
  const events=name=>all.filter(e=>e.eventName===name), converted=events('FeesConverted');
  const convertedOperations=converted.reduce((n,e)=>{const platform=e.args.token.toLowerCase()===d.platformToken.toLowerCase(),a=e.args.nativeAmount;
    return n+a-(platform?0n:a*7n/12n)-a*4n/(platform?5n:12n);},0n);
  const baseline=BigInt(report.baselineBlock),operations=await factory('operationsCredit',[],end.number),accounted=await factory('nativeAccounted',[],end.number);
  assert.equal(operations,await factory('operationsCredit',[],baseline)+sum(allocations,'platform')+convertedOperations+
    sum(events('KeeperGasFunded'),'amount')-sum(events('KeeperGasPaid'),'amount')-sum(events('OperationsClaimed'),'amount'));
  assert.equal(accounted,await factory('nativeAccounted',[],baseline)+sum(allocations,'nativeAmount')-sum(allocations,'distributions')+
    sum(converted,'nativeAmount')+sum(events('KeeperGasFunded'),'amount')-sum(events('KeeperGasPaid'),'amount')-
    sum(events('OperationsClaimed'),'amount')-sum(events('CommunityClaimed'),'amount')-sum(events('Burned'),'nativeAmount'));
  assert(await c.getBalance({address:d.launch,blockNumber:end.number})>=accounted);
  for(const p of projects){const burned=events('Burned').filter(e=>e.args.token.toLowerCase()===p.token.toLowerCase());
    assert.equal(await read(p.token,erc20Abi,'totalSupply',[],end.number),await read(p.token,erc20Abi,'totalSupply',[],baseline)-sum(burned,'totalBurned'));}
  result.assertions.push('platform credit and gas funding conservation','factory native solvency','token supply decreases by confirmed burns');
  result.operationsCreditUSDC=formatEther(operations);result.nativeAccountedUSDC=formatEther(accounted);
  let distributionGas=0n;result.distributionReceipts=[];
  for(const hash of new Set(result.projects.flatMap(p=>p.distributionBatches.map(b=>b.hash)))){
    const receipt=await c.getTransactionReceipt({hash});assert.equal(receipt.status,'success');assert(receipt.blockNumber<=end.number);
    const gasCost=receipt.gasUsed*receipt.effectiveGasPrice;distributionGas+=gasCost;
    result.distributionReceipts.push({hash,block:String(receipt.blockNumber),gasUsed:String(receipt.gasUsed),gasUSDC:formatEther(gasCost)});
  }
  result.distributionGasUSDC=formatEther(distributionGas);
  result.keeperBalanceUSDC=formatEther(await c.getBalance({address:d.keeper,blockNumber:end.number}));
  result.platformClaims=all.filter(e=>e.eventName==='OperationsClaimed').map(e=>({hash:e.transactionHash,amountUSDC:formatEther(e.args.amount)}));
  result.complete=result.projects.some(p=>p.token.toLowerCase()===d.platformToken.toLowerCase()&&Number(p.buybackUSDC)>0)&&
    result.projects.some(p=>p.token.toLowerCase()===meme.token.toLowerCase()&&Number(p.buybackUSDC)>0)&&result.projects.some(p=>Number(p.convertedUSDC)>0)&&
    result.projects.some(p=>Number(p.rewardPurchaseUSDC)>0)&&result.projects.some(p=>p.confirmedRecipients>=100)&&
    result.projects.some(p=>Number(p.communityPaidUSDC)>0)&&result.platformClaims.length>0;
  assert.equal((await c.getBlock({blockNumber:end.number})).hash,end.hash);
  report.verification=result;report.status=result.complete?'passed':journal['fund-platform-fees']?'pending-execution':'pending-funding';save();log({status:report.status,block:result.block,paths:result.projects.map(({symbol,buybackUSDC,convertedUSDC,rewardPurchaseUSDC,confirmedRecipients})=>({symbol,buybackUSDC,convertedUSDC,rewardPurchaseUSDC,confirmedRecipients}))});
  return result.complete;
}
try{
  if(!report.baseline){const b=await c.getBlock({blockTag:'finalized'});report.baselineBlock=String(b.number);report.baseline={};
    for(const p of projects)report.baseline[p.token]=await state(p,b.number);save();}
  if(process.argv.includes('--verify')){await verify();}
  else{
    await send('keeper-gas',d.keeper,async()=>({value:parseEther('5')}));
    if(process.argv.includes('--run')){
      if(!journal['fund-platform-fees'])assert(await c.getBalance({address:account.address})>=parseEther('165'),'Full test needs additional test USDC; gas funding retained');
      const [poolKey]=await read(d.positionManager,artifact('PositionManager').abi,'getPoolAndPositionInfo',[(await factory('tokens',[meme.token]))[0]]);
      for(let i=0;i<9;i++){
        const prior=await factory('lastConversionAt',[meme.token]);
        if(prior>0n&&!journal[`buy-${i}`])break;
        const quote=async(buy,amount)=>(await c.simulateContract({address:d.quoter,abi:artifact('V4Quoter').abi,functionName:'quoteExactInputSingle',
          args:[{poolKey,zeroForOne:buy,exactAmount:amount,hookData:'0x'}]})).result[0];
        const trade=(label,buy,amount)=>send(label,d.launch,async()=>{const q=await quote(buy,amount),b=await c.getBlock();
          return {value:buy?amount:0n,data:encodeFunctionData({abi,functionName:'trade',args:[meme.token,buy,amount,q*99n/100n,b.timestamp+90n]})};});
        const bought=await trade(`buy-${i}`,true,parseEther('100'));
        const amount=parseEventLogs({abi,eventName:'Traded',logs:bought.logs})[0].args.amountOut;
        await call(`approve-${i}`,meme.token,erc20Abi,'approve',[d.launch,amount]);
        await trade(`sell-${i}`,false,amount);
      }
      await call('fund-platform-fees',d.launch,abi,'fundFees',[d.platformToken],parseEther('100'));
      // Permissionless settlement pays only the factory's immutable platform treasury.
      // This verifies receipt below the keeper's automatic 1-USDC claim threshold.
      if(await factory('operationsClaimable')>0n&&!journal['settle-platform']){
        await call('settle-platform',d.launch,abi,'claimOperations',[]);
        report.platformSettlement='Permissionless test call; not evidence of the automatic claim threshold';
      }
      report.status='funded-awaiting-keeper';save();
      log({status:report.status,note:'Keeper performs swaps and payouts; no second keeper signer is started.'});
    }
  }
}catch(error){report.lastError=error.shortMessage||String(error);save();console.error(report.lastError);process.exitCode=1;}
finally{closeSync(lock);unlinkSync(dir+'/run.lock');}
