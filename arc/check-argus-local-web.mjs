// Exercises the same authenticated queue used by /create, only on the local fork.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createPublicClient,http,parseAbi,keccak256,toHex,zeroAddress} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
const checkPlugins=process.argv.includes('--plugins');
const base='http://127.0.0.1:8092',client=createPublicClient({transport:http('http://127.0.0.1:8547')});
assert.equal(await client.getChainId(),31338);
const deployment=JSON.parse(readFileSync('SingleSparkContract/arc/data/argus-local-fork/deployment.json','utf8'));
const request=async(path,init={})=>{const r=await fetch(base+path,{...init,headers:{'Content-Type':'application/json',...init.headers},signal:AbortSignal.timeout(30000)});return {status:r.status,body:await r.json()};};
const account=privateKeyToAccount(keccak256(toHex('singlespark/argus-fork/trader')));
const draft={requestId:checkPlugins?'local-web-plugins-20261005':'local-web-image-20261005',name:'Argus Web Test',symbol:'AWTEST',imageUri:'',description:'Local fork test only',channels:{},startFdv:'10000',bondFdv:'20000',buyTaxBps:100,sellTaxBps:200,...(checkPlugins?{plugins:{buyback:false,distribution:true,revision:0}}:{})};
assert.equal((await request('/api/arc/argus/launch',{method:'POST',body:JSON.stringify(draft)})).status,401);
const nonce=await request(`/api/auth/nonce?address=${account.address}&chainId=31338`);assert.equal(nonce.status,200);
const login=await request('/api/auth/login',{method:'POST',body:JSON.stringify({message:nonce.body.message,signature:await account.signMessage({message:nonce.body.message}),chainId:31338})});assert.equal(login.status,200);
const headers={Authorization:`Bearer ${login.body.token}`};
try{
  const uploaded=await request('/api/arc/media',{method:'POST',headers:{...headers,'Content-Type':'image/png'},body:readFileSync('SingleSparkFront/front/static/assets/brands/singlespark-ring-v1-still.png')});assert.equal(uploaded.status,201);
  draft.imageUri=uploaded.body.publicUrl;
  const submitted=await request('/api/arc/argus/launch',{method:'POST',headers,body:JSON.stringify(draft)});assert.equal(submitted.status,200);
  let job;
  for(let i=0;i<120;i++){
    const r=await request(`/api/arc/argus/launch?requestId=${draft.requestId}`,{headers});assert.equal(r.status,200);job=r.body;
    if(job.status==='confirmed'||job.status==='failed')break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.equal(job.status,'confirmed',JSON.stringify(job));
  const receipt=await client.getTransactionReceipt({hash:job.transactionHash});assert.equal(receipt.status,'success');
  const abi=parseAbi(['function initiator(address) view returns(address)','function community(address) view returns(address)']);
  let treasury=zeroAddress;
  for(let i=0;i<210;i++){
    treasury=await client.readContract({address:deployment.router,abi,functionName:'community',args:[job.token]});if(treasury!==zeroAddress)break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.notEqual(treasury,zeroAddress);
  assert.equal((await client.readContract({address:deployment.router,abi,functionName:'initiator',args:[job.token]})).toLowerCase(),account.address.toLowerCase());
  let token;
  for(let i=0;i<30;i++){
    const snapshot=await request('/api/arc/snapshot');assert.equal(snapshot.body.chainId,31338);assert.equal(snapshot.body.launchProtocol,'argus-v7-custody');
    token=snapshot.body.tokens.find(t=>t.token.toLowerCase()===job.token.toLowerCase());if(token)break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert(token,'Confirmed launch must appear in the frontend snapshot');assert.equal(token.name,draft.name);assert.equal(token.symbol,draft.symbol);assert.equal(token.imageUrl,draft.imageUri);
  const plugins=await request(`/api/arc/plugins?token=${job.token}`);assert.equal(plugins.status,200);assert.equal(plugins.body.settings.buyback,!checkPlugins);assert.equal(plugins.body.settings.distribution,true);
  assert.equal(plugins.body.canManage,false);assert.equal(plugins.body.locked,true);
  assert.equal((await request(`/api/arc/plugins?token=${job.token}`,{method:'POST',headers,body:JSON.stringify({buyback:true,distribution:false,revision:0})})).status,409);
  assert.deepEqual((await request(`/api/arc/plugins?token=${job.token}`)).body.settings,plugins.body.settings);
  assert.deepEqual(token.plugins,plugins.body.settings);
  const proof={status:'passed_local_fork_web_api',generatedAt:new Date().toISOString(),chainId:31338,publicTransactions:false,scope:'Local Argus mainnet fork; explicit mock ERC20 USDC and separate native test gas',token:job.token,transactionHash:job.transactionHash,initiator:account.address,treasury,anonymousPost:401,postLaunchChanges:409,indexed:true,imageUrl:draft.imageUri,plugins:plugins.body.settings};
  writeFileSync(checkPlugins?'SingleSparkContract/arc/deployments/argus-plugin-creation-local-20261005.json':'SingleSparkContract/arc/deployments/argus-local-web-test-20261005.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
}finally{await request('/api/auth/logout',{method:'POST',headers});}
