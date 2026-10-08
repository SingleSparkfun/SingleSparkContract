// Controlled trades on the existing isolated Base fork. Never connects a signer to a public RPC.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, keccak256, toHex, parseAbi, parseAbiParameters, encodeAbiParameters, encodeFunctionData, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
const rpc = 'http://127.0.0.1:8548';
const client = createPublicClient({chain:base,transport:http(rpc,{timeout:60000}),cacheTime:0});
assert.equal(await client.getChainId(),8453);
assert.equal((await client.request({method:'anvil_nodeInfo'})).forkConfig.forkBlockNumber,52245507);
const launch = JSON.parse(readFileSync('SingleSparkContract/arc/deployments/clanker-abi-image-local-web-test-20261006.json','utf8')).launch;
assert.equal(launch.status,'confirmed');
assert.equal((await client.getTransactionReceipt({hash:launch.transactionHash})).status,'success');
const token = launch.token, custody = launch.address;
const WETH = '0x4200000000000000000000000000000000000006';
const LOCKER = '0xffA37784D619F228D8B379d287a4D7282e500762';
const FEES = '0xF3622742b1E446D92e45E22923Ef11C2fcD55D68';
const progressPath = 'SingleSparkContract/arc/data/clanker-sdk-local-fork/fees-check-progress.json';
const progress = existsSync(progressPath) ? JSON.parse(readFileSync(progressPath,'utf8')) : {token,custody,transactions:{}};
assert.equal(progress.token,token); assert.equal(progress.custody,custody);
const save = () => writeFileSync(progressPath,JSON.stringify(progress,null,2)+'\n');
const trader = privateKeyToAccount(keccak256(toHex('singlespark/clanker-fork/fees-trader-only')));
const wallet = createWalletClient({chain:base,account:trader,transport:http(rpc)});
const abi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct Rewards { address token; PoolKey poolKey; uint256 positionId; uint256 numPositions; uint16[] rewardBps; address[] rewardAdmins; address[] rewardRecipients; }',
  'function tokenRewards(address token) view returns (Rewards)',
  'function permit2() view returns (address)', 'function universalRouter() view returns (address)',
  'function availableFees(address feeOwner,address token) view returns (uint256)',
  'function claim(address feeOwner,address token)', 'function deposit() payable',
  'function approve(address token,address spender,uint160 amount,uint48 expiration)',
  'function execute(bytes commands,bytes[] inputs,uint256 deadline) payable',
]);
const read = (address,functionName,args=[]) => client.readContract({address,abi,functionName,args});
const balance = address => client.readContract({address,abi:erc20Abi,functionName:'balanceOf',args:[custody]});
async function send(name,to,data,value=0n) {
  let saved = progress.transactions[name];
  if (!saved) {
    const request = await wallet.prepareTransactionRequest({to,data,value,gas:3_000_000n});
    const raw = await wallet.signTransaction(request);
    saved = {hash:keccak256(raw),raw}; progress.transactions[name] = saved; save();
  }
  let receipt = await client.getTransactionReceipt({hash:saved.hash}).catch(()=>null);
  if (!receipt) {
    await client.sendRawTransaction({serializedTransaction:saved.raw});
    receipt = await client.waitForTransactionReceipt({hash:saved.hash,timeout:90000});
  }
  assert.equal(receipt.status,'success',name); console.log(`${name}: ${saved.hash}`); return receipt;
}
if (process.argv.includes('--prepare')) {
  if (!progress.funded) {
    await client.request({method:'anvil_setBalance',params:[trader.address,'0xde0b6b3a7640000']});
    progress.funded = true; save();
  }
  const rewards = await read(LOCKER,'tokenRewards',[token]);
  assert.equal(rewards.rewardRecipients[0].toLowerCase(),custody);
  const permit = await read(LOCKER,'permit2'), router = await read(LOCKER,'universalRouter');
  await send('wrap',WETH,encodeFunctionData({abi,functionName:'deposit'}),3_000_000_000_000_000n);
  await send('plain-transfer-not-income',WETH,encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[custody,12345n]}));
  const approve = async(asset,amount,label) => {
    await send(`${label}-erc20`,asset,encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[permit,amount]}));
    const deadline = Number((await client.getBlock()).timestamp)+3600;
    await send(`${label}-permit2`,permit,encodeFunctionData({abi,functionName:'approve',args:[asset,router,amount,deadline]}));
  };
  const swap = async(name,input,output,amount) => {
    const params = [
      encodeAbiParameters(parseAbiParameters('((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)'),
        [{poolKey:rewards.poolKey,zeroForOne:input.toLowerCase()<output.toLowerCase(),amountIn:amount,amountOutMinimum:1n,hookData:'0x'}]),
      encodeAbiParameters(parseAbiParameters('address,uint256'),[input,amount]),
      encodeAbiParameters(parseAbiParameters('address,uint256'),[output,1n])];
    const inputs = [encodeAbiParameters(parseAbiParameters('bytes,bytes[]'),['0x060c0f',params])];
    const deadline = (await client.getBlock()).timestamp+3600n;
    // Minimum=1 is only for this controlled fork probe, never a production swap policy.
    await send(name,router,encodeFunctionData({abi,functionName:'execute',args:['0x10',inputs,deadline]}));
  };
  await approve(WETH,2_000_000_000_000_000n,'buy');
  await swap('buy-1',WETH,token,1_000_000_000_000_000n);
  await swap('buy-2',WETH,token,1_000_000_000_000_000n);
  if (!progress.sellAmount) {
    progress.sellAmount = (await client.readContract({address:token,abi:erc20Abi,functionName:'balanceOf',args:[trader.address]})/2n).toString(); save();
  }
  await approve(token,BigInt(progress.sellAmount),'sell');
  await swap('sell',token,WETH,BigInt(progress.sellAmount));
  // The official claim is permissionless but always pays the fixed fee owner. The worker must index it.
  await send('external-claim',FEES,encodeFunctionData({abi,functionName:'claim',args:[custody,WETH]}));
  await approve(WETH,100_000_000_000_000n,'buy-auto');
  await swap('buy-auto',WETH,token,100_000_000_000_000n);
  await client.request({method:'anvil_mine',params:['0x3']});
  progress.prepared = true; save();
  console.log('Prepared real fork trades, ordinary transfer and a permissionless claim. No public transactions.');
} else {
  assert.equal(progress.prepared,true,'Run --prepare before starting the new collector');
  const api = 'http://127.0.0.1:8092';
  const request = async(path,init={}) => {const r=await fetch(api+path,{...init,headers:{'Content-Type':'application/json',...init.headers},signal:AbortSignal.timeout(90000)});return {status:r.status,body:await r.json()};};
  const path = '/api/launch/clanker/fees?requestId=clanker-abi-image-web-20261006';
  assert.equal((await request(path)).status,401);
  const owner = privateKeyToAccount(keccak256(toHex('singlespark/clanker-fork/web-test-only')));
  const nonce = await request(`/api/auth/nonce?address=${owner.address}&chainId=31338`); assert.equal(nonce.status,200);
  const login = await request('/api/auth/login',{method:'POST',body:JSON.stringify({message:nonce.body.message,signature:await owner.signMessage({message:nonce.body.message}),chainId:31338})}); assert.equal(login.status,200);
  const headers={Authorization:`Bearer ${login.body.token}`};
  const beforeRestart = process.argv.includes('--verify-restart') ? JSON.parse(readFileSync('SingleSparkContract/arc/deployments/clanker-fees-local-proof-20261006.json','utf8')) : null;
  try {
    let status;
    const mined = new Set();
    for (let i=0;i<90;i++) {
      const response=await request(path,{headers});
      if (response.status===408) continue;
      assert.equal(response.status,200); status=response.body;
      for (const action of status.history.filter(item=>item.status==='signed')) {
        if (!mined.has(action.transactionHash) && await client.getTransactionReceipt({hash:action.transactionHash}).catch(()=>null)) {
          await client.request({method:'anvil_mine',params:['0x3']}); mined.add(action.transactionHash);
        }
      }
      const totals = Object.fromEntries(status.totals.map(item=>[item.asset,BigInt(item.receivedRaw)]));
      if (totals[WETH.toLowerCase()]>0n && totals[token]>0n
        && status.history.some(item=>item.kind==='collect'&&item.status==='confirmed')
        && status.history.some(item=>item.kind==='claim'&&item.asset===WETH.toLowerCase()&&item.status==='confirmed')
        && !status.history.some(item=>item.status==='signed')
        && await read(FEES,'availableFees',[custody,WETH])===0n && await read(FEES,'availableFees',[custody,token])===0n) break;
      if(i%6===0) console.log(`Waiting for automatic income collection: ${status.history.map(x=>`${x.kind}:${x.status}`).join(', ')}`);
      await new Promise(resolve=>setTimeout(resolve,5000));
    }
    assert(status.receipts.some(item=>item.transactionHash===progress.transactions['external-claim'].hash),'External claim missing');
    for (const asset of [WETH,token]) {
      const total=BigInt(status.totals.find(item=>item.asset===asset.toLowerCase())?.receivedRaw??'0');
      assert(total>0n,'Both reward assets must arrive');
      assert.equal(await balance(asset),total+(asset===WETH?12345n:0n),'Only proven rewards are income');
      assert.equal(await read(FEES,'availableFees',[custody,asset]),0n);
    }
    assert(!status.history.some(item=>item.status!=='confirmed'));
    assert(status.history.some(item=>item.kind==='claim'&&item.asset===WETH.toLowerCase()&&item.status==='confirmed'),'Automatic WETH claim missing');
    const again = await request(path,{headers}); assert.deepEqual(again.body,status);
    if (beforeRestart) assert.deepEqual(status,beforeRestart.income,'Restart changed the saved income or transaction history');
    const proof={status:'passed_local_clanker_fee_collection',generatedAt:new Date().toISOString(),publicTransactions:false,
      funding:'Trader received 1 explicit Anvil test ETH; custody Gas uses previous explicit test funding, not creator income',
      token,custody,ordinaryTransferExcludedRaw:'12345',transactions:Object.fromEntries(Object.entries(progress.transactions).map(([name,value])=>[name,value.hash])),
      income:status,restartVerified:!!beforeRestart,checks:['real buy and sell fees','automatic last-swap LP collection','automatic WETH and token claims','fixed per-token recipient',
        'external permissionless claim indexed','ordinary transfers excluded','finalized receipts','repeat reads do not double credit'],
      notVerified:['public-chain execution','buyback and distribution spending','production Gas policy']};
    writeFileSync('SingleSparkContract/arc/deployments/clanker-fees-local-proof-20261006.json',JSON.stringify(proof,null,2)+'\n');
    console.log(JSON.stringify(proof,null,2));
  } finally { await request('/api/auth/logout',{method:'POST',headers}); }
}
