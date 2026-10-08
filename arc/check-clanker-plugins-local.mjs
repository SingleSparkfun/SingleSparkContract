// Fixture for the Rust native plugin integration check. Every signer is a controlled local test account.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {createPublicClient,createWalletClient,http,keccak256,toHex,parseAbi,parseAbiParameters,encodeAbiParameters,encodeFunctionData,erc20Abi} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {base} from 'viem/chains';
if(process.argv[2]==='--api'){await checkApi();process.exit(0);}
const path=process.argv[2];
assert.ok(path?.includes('clanker-plugin-proof-'));
const proof=JSON.parse(readFileSync(path,'utf8'));
const alreadyWarm=!!proof.candidates;
const c=createPublicClient({chain:base,transport:http('http://127.0.0.1:8548',{timeout:60000}),cacheTime:0});
assert.equal(await c.getChainId(),8453);
assert.equal((await c.request({method:'anvil_nodeInfo'})).forkConfig.forkBlockNumber,52245507);
const journalPath=path+'.transactions.json';
const journal=existsSync(journalPath)?JSON.parse(readFileSync(journalPath,'utf8')):{};
const save=()=>writeFileSync(journalPath,JSON.stringify(journal,null,2)+'\n');
const owner=privateKeyToAccount(keccak256(toHex('singlespark/local-plugin-trader/'+proof.token)));
const wallet=createWalletClient({chain:base,account:owner,transport:http('http://127.0.0.1:8548')});
const WETH='0x4200000000000000000000000000000000000006', LOCKER='0xffA37784D619F228D8B379d287a4D7282e500762';
const abi=parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct Rewards { address token; PoolKey poolKey; uint256 positionId; uint256 numPositions; uint16[] rewardBps; address[] rewardAdmins; address[] rewardRecipients; }',
  'function tokenRewards(address token) view returns (Rewards)',
  'function deposit() payable','function approve(address token,address spender,uint160 amount,uint48 expiration)',
  'function execute(bytes commands,bytes[] inputs,uint256 deadline) payable',
]);
const permit='0x000000000022D473030F116dDEE9F6B43aC78BA3',router='0x6ff5693b99212da76ad316178a184ab56d299b43';
const send=async(name,to,data,value=0n)=>{
  if(!journal[name]){
    const raw=await wallet.signTransaction(await wallet.prepareTransactionRequest({...(to?{to}:{}),data,value,gas:5_000_000n}));
    journal[name]={hash:keccak256(raw),raw};save();
  }
  let r=await c.getTransactionReceipt({hash:journal[name].hash}).catch(()=>null);
  if(!r){await c.sendRawTransaction({serializedTransaction:journal[name].raw});r=await c.waitForTransactionReceipt({hash:journal[name].hash});}
  assert.equal(r.status,'success',name);return r;
};
if(!journal.funded){await c.request({method:'anvil_setBalance',params:[owner.address,toHex(10n**18n)]});journal.funded=true;save();}
const artifact=JSON.parse(readFileSync('SingleSparkContract/arc/out/NativeRevenueDistributor.sol/NativeRevenueDistributor.json','utf8'));
const deployed=await send('distributor',null,artifact.bytecode.object);
proof.distributor=deployed.contractAddress;
assert.equal(keccak256(await c.getCode({address:proof.distributor})),readFileSync('SingleSparkBackend/api/src/native_distributor_hash.txt','utf8').trim());
const rewards=await c.readContract({address:LOCKER,abi,functionName:'tokenRewards',args:[proof.token]});
await send('wrap',WETH,encodeFunctionData({abi,functionName:'deposit'}),5_000_000_000_000_000n);
await send('ordinary-transfer',WETH,encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[proof.address,12345n]}));
const approve=async(asset,amount,label)=>{
  await send(label+'-approve',asset,encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[permit,amount]}));
  await send(label+'-permit',permit,encodeFunctionData({abi,functionName:'approve',args:[asset,router,amount,Number((await c.getBlock()).timestamp)+86400]}));
};
const swap=async(label,input,output,amount)=>{
  const params=[encodeAbiParameters(parseAbiParameters('((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)'),[{poolKey:rewards.poolKey,zeroForOne:input.toLowerCase()<output.toLowerCase(),amountIn:amount,amountOutMinimum:1n,hookData:'0x'}]),
    encodeAbiParameters(parseAbiParameters('address,uint256'),[input,amount]),encodeAbiParameters(parseAbiParameters('address,uint256'),[output,1n])];
  // Fixture trades only. The Rust worker uses historical price checks and a nontrivial minimum output.
  await send(label,router,encodeFunctionData({abi,functionName:'execute',args:['0x10',[encodeAbiParameters(parseAbiParameters('bytes,bytes[]'),['0x060c0f',params])],(await c.getBlock()).timestamp+86400n]}));
};
await approve(WETH,4_000_000_000_000_000n,'buy');
await swap('buy-1',WETH,proof.token,2_000_000_000_000_000n);
await swap('buy-2',WETH,proof.token,2_000_000_000_000_000n);
if(!journal.sellAmount){journal.sellAmount=(await c.readContract({address:proof.token,abi:erc20Abi,functionName:'balanceOf',args:[owner.address]})/2n).toString();save();}
await approve(proof.token,BigInt(journal.sellAmount),'sell');
await swap('sell',proof.token,WETH,BigInt(journal.sellAmount));
// One block with real transactions from 100 controlled signers; these are test candidates, not real users.
const lastCandidate=await c.getTransactionReceipt({hash:journal['candidate-'+(journal.round??0)+'-99']?.hash??journal['candidate-99']?.hash??'0x'+'00'.repeat(32)}).catch(()=>null);
if(!journal.candidates || lastCandidate && (await c.getBlockNumber())-lastCandidate.blockNumber>20n){
  if(journal.candidates){journal.round=(journal.round??0)+1;save();}
  const prefix='candidate-'+(journal.round??0)+'-';
  await c.request({method:'anvil_setBlockTimestampInterval',params:[1]});
  await c.request({method:'evm_setAutomine',params:[false]});
  await c.request({method:'evm_setIntervalMining',params:[0]});
  try{
    const fees=await c.estimateFeesPerGas();const addresses=[];
    for(let i=0;i<100;i++){
      const a=privateKeyToAccount(keccak256(toHex('singlespark/local-plugin-candidate/'+proof.token+'/'+i)));
      addresses.push(a.address);
      if(!journal[prefix+i]){
        await c.request({method:'anvil_setBalance',params:[a.address,toHex(10n**16n)]});
        const raw=await a.signTransaction({chainId:8453,type:'eip1559',nonce:await c.getTransactionCount({address:a.address}),to:a.address,value:0n,gas:21000n,...fees});
        journal[prefix+i]={hash:keccak256(raw),raw};save();
      }
      if(!await c.getTransactionReceipt({hash:journal[prefix+i].hash}).catch(()=>null)) await c.sendRawTransaction({serializedTransaction:journal[prefix+i].raw});
    }
    await c.request({method:'anvil_mine',params:['0x1']});
    for(let i=0;i<100;i++)assert.equal((await c.getTransactionReceipt({hash:journal[prefix+i].hash})).status,'success');
    journal.candidates=addresses;save();
  }finally{
    await c.request({method:'evm_setAutomine',params:[true]});
    await c.request({method:'evm_setIntervalMining',params:[2]});
    await c.request({method:'anvil_removeBlockTimestampInterval'});
  }
}
if(!alreadyWarm)await c.request({method:'evm_increaseTime',params:[700]});
await c.request({method:'anvil_mine',params:['0x3']});
proof.candidates=journal.candidates;
proof.trader=owner.address;
if(!journal.preBalances){journal.preBalances={[owner.address.toLowerCase()]:(await c.readContract({address:proof.token,abi:erc20Abi,functionName:'balanceOf',args:[owner.address]})).toString()};save();}
proof.preBalances=journal.preBalances;
proof.ordinaryTransferRaw='12345';
proof.fixtureTransactions=Object.fromEntries(Object.entries(journal).filter(([,v])=>v?.hash).map(([k,v])=>[k,v.hash]));
writeFileSync(path,JSON.stringify(proof,null,2)+'\n');
console.log('Prepared controlled fork trades and 100 finalized sender candidates. No public transactions.');

async function checkApi(){
  const api='http://127.0.0.1:8092';
  const request=async(path,init={})=>{const r=await fetch(api+path,{...init,headers:{'Content-Type':'application/json',...init.headers},signal:AbortSignal.timeout(125000)});return{status:r.status,body:await r.json()};};
  const config=await request('/api/launch/config');assert.equal(config.body.clanker.adapter,'clanker-v4-abi');assert.equal(config.body.clanker.testnet,true);
  const account=privateKeyToAccount(keccak256(toHex('singlespark/clanker-fork/web-test-only')));
  const nonce=await request('/api/auth/nonce?address='+account.address+'&chainId=31338');assert.equal(nonce.status,200);
  const login=await request('/api/auth/login',{method:'POST',body:JSON.stringify({message:nonce.body.message,signature:await account.signMessage({message:nonce.body.message}),chainId:31338})});assert.equal(login.status,200);
  const headers={Authorization:'Bearer '+login.body.token};
  try{
    const body={requestId:'clanker-plugin-policy-web-20261006',draft:{name:'Plugin Policy Check',symbol:'PPOLICY',plugins:{buybackBps:8300,distributionBps:500}}};
    const post=(value,headers)=>request('/api/launch/clanker',{method:'POST',headers,body:JSON.stringify(value)});
    assert.equal((await post(body)).status,401);
    const first=await post(body,headers);assert.equal(first.status,200);assert.equal(first.body.status,'funding_required');
    const changed=await post({...body,draft:{...body.draft,plugins:{buybackBps:8000,distributionBps:500}}},headers);assert.equal(changed.status,409);
    const fees=await request('/api/launch/clanker/fees?requestId='+body.requestId,{headers});assert.equal(fees.status,200);assert.deepEqual(fees.body.plugins,body.draft.plugins);assert.equal(fees.body.token,null);assert.deepEqual(fees.body.history,[]);
    const legacy=await request('/api/launch/clanker/fees?requestId=clanker-abi-image-web-20261006',{headers});assert.equal(legacy.status,200);assert.equal(legacy.body.plugins,null);assert.equal(legacy.body.pluginExecution,'not-configured');assert.equal(legacy.body.history.length,4);
    const proof={status:'passed_local_plugin_policy_api',publicTransactions:false,api,anonymous:401,changedPolicy:409,requestId:body.requestId,policy:fees.body.plugins,launchStatus:first.body.status,legacyPolicy:legacy.body.plugins,legacyActionCount:legacy.body.history.length};
    writeFileSync('SingleSparkContract/arc/deployments/clanker-plugins-local-web-check-20261006.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
  }finally{await request('/api/auth/logout',{method:'POST',headers});}
}
