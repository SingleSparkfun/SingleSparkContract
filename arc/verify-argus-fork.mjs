// Real Portal V7 and V4 contracts on an isolated mainnet fork. No public-network write.
// Standard Anvil lacks Arc's USDC precompile: only its ERC20 surface is replaced by an explicit mock.
import assert from 'node:assert/strict';
import { spawn,spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync,writeFileSync,mkdirSync,mkdtempSync,existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createPublicClient,createWalletClient,defineChain,http,parseEventLogs,parseAbi,erc20Abi,keccak256,toHex,getCreate2Address,encodeAbiParameters,parseAbiParameters,zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { artifact } from './deploy.mjs';
const PORTAL='0xB021Be536808f551b31789422Fd28a6c9c6e97Da',QUOTE='0x3600000000000000000000000000000000000000',DEAD='0x000000000000000000000000000000000000dEaD';
const checkPlugins=process.argv.includes('--plugins');
const serve=process.argv.includes('--serve');
const independent=process.argv.includes('--independent-wallets')||process.argv.includes('--launch-gas');
assert(!(serve&&independent));
const serveDir=resolve('SingleSparkContract/arc/data/argus-local-fork');
if(serve)mkdirSync(serveDir,{recursive:true,mode:0o700});
const portalAbi=JSON.parse(readFileSync(new URL('./abi/argus-portal-v7.json',import.meta.url)));
const splitterAbi=JSON.parse(readFileSync(new URL('./abi/argus-splitter-v7.json',import.meta.url)));
const router=artifact('ArgusCustodyRouter'),gov=artifact('ArgusGovernance','ArgusSatisfaction'),project=artifact('ArgusGovernance','ArgusProjectTreasury');
const custody=privateKeyToAccount(keccak256(toHex('singlespark/argus-fork/custody'))),trader=privateKeyToAccount(keccak256(toHex('singlespark/argus-fork/trader')));
const reserve=createServer();await new Promise(r=>reserve.listen(serve?8547:0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const url=`http://127.0.0.1:${port}`;
const chain=defineChain({id:serve||independent?31338:5042,name:'Argus isolated fork',nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18},rpcUrls:{default:{http:[url]}}});
const client=createPublicClient({chain,pollingInterval:independent?200:4000,transport:http(url,{timeout:180000,retryCount:2}),cacheTime:0});
const wallet=a=>createWalletClient({account:a,chain,transport:http(url,{timeout:180000,retryCount:0})});
const anvil=spawn('anvil',['--fork-url',process.env.ARC_MAINNET_RPC??'https://rpc.mainnet.arc.io','--fork-block-number',process.env.ARC_MAINNET_FORK_BLOCK??'23563119','--port',String(port),'--chain-id',String(chain.id),'--gas-limit','60000000','--silent','--slots-in-an-epoch','1','--timeout',serve?'15000':'180000','--retries',serve?'2':'10',...(serve?['--state',resolve(serveDir,'anvil-state.json'),'--preserve-historical-states','--max-persisted-states','10000','--block-time','2']:independent?['--preserve-historical-states','--block-time','1']:['--prune-history','10000'])],{stdio:['ignore','ignore','pipe']});
let err='';anvil.stderr.on('data',b=>err+=b);const steps=[];let failure,api;
const receipt=async hash=>{const r=await client.waitForTransactionReceipt({hash,timeout:180000});assert.equal(r.status,'success');return r;};
const send=async(a,address,abi,functionName,args=[])=>{console.log(`RUN ${functionName} ${address}`);return receipt(await wallet(a).writeContract({address,abi,functionName,args,nonce:await client.getTransactionCount({address:a.address,blockTag:'pending'}),gas:25_000_000n,maxFeePerGas:1000000000n,maxPriorityFeePerGas:1n}));};
const read=(address,abi,functionName,args=[])=>client.readContract({address,abi,functionName,args});
const deploy=async artifact=>{console.log('RUN deploy');const r=await receipt(await wallet(custody).deployContract({abi:artifact.abi,bytecode:artifact.bytecode.object,args:artifact.args,nonce:await client.getTransactionCount({address:custody.address,blockTag:'pending'}),gas:25_000_000n,maxFeePerGas:1000000000n,maxPriorityFeePerGas:1n}));assert(r.contractAddress);return r.contractAddress;};
const now=async()=>(await client.getBlock()).timestamp;
const warp=async seconds=>{await client.request({method:'evm_setNextBlockTimestamp',params:[Number(await now())+seconds]});await client.request({method:'evm_mine',params:[]});};
const mark=(name,data={})=>{steps.push({name,...data});console.log(`PASS ${name}`);};
async function launch(name,symbol,token0) {
  for(let attempt=0;attempt<20;attempt++){
    const salt=keccak256(toHex(`argus-fork/${symbol}/${attempt}`));
    const splitter=await read(PORTAL,portalAbi,'predictSplitter',[custody.address,salt]);
    const bytecodeHash=await read(PORTAL,portalAbi,'hookInitCodeHash',[splitter,100,100,QUOTE]);
    let hookSalt,hook;
    for(let n=0n;n<1_000_000n;n++){
      const candidate=toHex(n,{size:32});const scoped=keccak256(encodeAbiParameters(parseAbiParameters('address,bytes32'),[custody.address,candidate]));
      const address=getCreate2Address({from:PORTAL,salt:scoped,bytecodeHash});
      if((BigInt(address)&0x3fffn)===0x2044n){hookSalt=candidate;hook=address;break;}
    }
    assert(hookSalt);const token=await read(PORTAL,portalAbi,'predictToken',[custody.address,salt,hook,QUOTE]);
    if(token0!=null&&(BigInt(token)<BigInt(QUOTE))!==token0)continue;
    const p={name,symbol,totalSupply:10n**27n,startFdvUsdc6:2500n*10n**6n,bondFdvUsdc6:1000000n*10n**6n,buyTaxBps:100,sellTaxBps:100,
      creatorBps:10000,burnBps:0,dividendBps:0,liquidityBps:0,devBuyQuote:0n,quoteAsset:QUOTE,expectConvert:1};
    const meta={imageURI:'https://singlespark.fun/assets/brands/singlespark-ring-v1-still.png',website:'https://singlespark.fun',twitter:'',telegram:'',description:'Isolated synthetic fork verification'};
    const r=await send(custody,PORTAL,portalAbi,'launch',[p,meta,salt,hookSalt]);
    const events=parseEventLogs({abi:portalAbi,eventName:'TokenCreated',logs:r.logs.filter(l=>l.address.toLowerCase()===PORTAL.toLowerCase())});
    assert.equal(events.length,1);assert.equal(events[0].args.token.toLowerCase(),token.toLowerCase());assert.equal(events[0].args.creator.toLowerCase(),custody.address.toLowerCase());
    const state=await read(PORTAL,portalAbi,'launches',[token]);assert.equal(state[10].toLowerCase(),QUOTE);assert.equal(state[7],100);
    assert.equal(await read(splitter,splitterAbi,'converts'),false);assert.equal(await read(splitter,splitterAbi,'rewardTracker'),zeroAddress);
    mark(`launch ${symbol}`,{token,splitter,hook,transactionHash:r.transactionHash,tokenIsToken0:BigInt(token)<BigInt(QUOTE)});
    return {token,splitter,locker:state[3],launchReceipt:r,name,symbol,imageURI:meta.imageURI};
  }throw Error('Could not cover token ordering');
}
const qAbi=parseAbi(['function mint(address,uint256)','function balanceOf(address) view returns(uint256)','function approve(address,uint256) returns(bool)']);
async function serveBackend(env) {
  assert.equal(env.ARC_CHAIN_ID,'31338');assert.equal(env.ARC_RPC_URL,url);
  assert.equal(await client.getChainId(),31338);
  assert((await client.getCode({address:env.ARC_ARGUS_PLATFORM_TOKEN}))?.length>2,'Saved fork state is missing; do not reuse its database');
  writeFileSync(resolve(serveDir,'runtime.env'),Object.entries(env).filter(([k])=>k.startsWith('ARC_')).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600});
  writeFileSync(resolve(serveDir,'frontend.json'),JSON.stringify({url:'http://127.0.0.1:8092',chainId:31338,keyId:'argus-local-fork',signer:privateKeyToAccount(env.ARC_CONFIG_SIGNING_KEY).address}));
  const frontendEnv='.env.arc.local';
  let frontend=existsSync(frontendEnv)?readFileSync(frontendEnv,'utf8'):'';
  const set=(key,update,fallback)=>{
    const line=frontend.split('\n').find(line=>line.startsWith(`${key}=`));
    const next=`${key}=${JSON.stringify(update(line?JSON.parse(line.slice(key.length+1)):fallback))}`;
    frontend=line?frontend.replace(line,next):`${frontend}\n${next}\n`;
  };
  set('VITE_CHAIN_CONFIG_SIGNERS',signers=>({...signers,'argus-local-fork':privateKeyToAccount(env.ARC_CONFIG_SIGNING_KEY).address}),{});
  set('VITE_BACKENDS',backends=>[...backends.filter(b=>b.chainId!==31338),{url:'http://127.0.0.1:8092',signers:['argus-local-fork'],chainId:31338}],[]);
  writeFileSync(frontendEnv,frontend);
  api=spawn('SingleSparkBackend/api/target/debug/jet-arc-backend',[],{env,stdio:['ignore','inherit','inherit']});
  api.on('exit',code=>{if(code!==null&&code!==0){console.error(`Local Argus backend exited ${code}`);anvil.kill('SIGTERM');process.exitCode=1;}});
  console.log('Argus LOCAL FORK: RPC 127.0.0.1:8547, API 127.0.0.1:8092, chain 31338; explicit Mock USDC.');
  await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);api.once('exit',resolve);anvil.once('exit',resolve);});
}
try{
  for(let i=0;;i++){if(anvil.exitCode!==null)throw Error(err);try{await client.getChainId();break;}catch(e){if(i>100)throw e;await new Promise(r=>setTimeout(r,300));}}
  if(serve&&existsSync(resolve(serveDir,'runtime.env'))){
    const saved=Object.fromEntries(readFileSync(resolve(serveDir,'runtime.env'),'utf8').trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
    await serveBackend({...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ARC_'))),...saved});
  }else{
  await client.request({method:'anvil_setNextBlockBaseFeePerGas',params:['0x0']});
  await client.request({method:'evm_mine',params:[]});
  mark('fork ready',{gasLimit:(await client.getBlock()).gasLimit.toString()});
  for(const a of [custody,trader]){
    assert.equal((await client.getCode({address:a.address}))??'0x','0x');
    await client.request({method:'anvil_setBalance',params:[a.address,toHex(10000n*10n**18n)]});
  }
  await client.request({method:'anvil_setCode',params:[QUOTE,artifact('ArgusGovernance.t','ArgusTestQuote').deployedBytecode.object]});
  await send(custody,QUOTE,qAbi,'mint',[trader.address,100000n*10n**6n]);
  await send(custody,QUOTE,qAbi,'mint',[custody.address,1000n*10n**6n]); // separately labelled governance/test fuel, never counted as fees
  const spark=await launch('SingleSpark','SPARK');const a=independent?null:await launch('Fork Ember','FEMBR',true);const b=independent?null:await launch('Fork Frog','FFROG',false);
  const vault=await deploy({...gov,args:[custody.address,604800n,601200n,10000000n*10n**18n]});
  // Keep the production constructor's Arc restriction; only local bootstrap uses its source chain ID.
  if(serve||independent){await client.request({method:'anvil_setChainId',params:[5042]});chain.id=5042;}
  const route=await deploy({...router,args:[custody.address,spark.token,vault,true]});
  if(serve||independent){await client.request({method:'anvil_setChainId',params:[31338]});chain.id=31338;}
  await send(custody,vault,gov.abi,'configure',[route]);
  for(const l of [a,b].filter(Boolean))await send(custody,route,router.abi,'register',[l.token,trader.address]);
  mark('single custody and governance binding',{custody:custody.address,router:route,platformVault:vault});
  if(serve||independent){
    const dbUrl=new URL(readFileSync('SingleSparkContract/arc/.env.postgres.local','utf8').split('\n').find(l=>l.startsWith('ARC_TEST_DATABASE_URL=')).slice('ARC_TEST_DATABASE_URL='.length));
    assert(dbUrl.pathname.endsWith('_test'));
    const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ARC_'))),
      ARC_CHAIN_ID:'31338',ARC_CHAIN_NAME:'Argus Local Fork',ARC_NATIVE_NAME:'Test USDC',ARC_NATIVE_SYMBOL:'USDC',ARC_NATIVE_DECIMALS:'18',ARC_TESTNET:'true',
      ARC_LAUNCH_PROTOCOL:'argus-v7-custody',ARC_LAUNCH_ADDRESS:PORTAL,ARC_RPC_URL:url,ARC_PUBLIC_RPC_URL:url,ARC_HOST:'127.0.0.1',ARC_PORT:'8092',
      ARC_WEB_ORIGIN:'http://127.0.0.1:5176',ARC_EXPLORER_URL:'http://127.0.0.1:8092',ARC_MEDIA_PUBLIC_BASE:'http://127.0.0.1:8092/api/arc/media',
      ARC_QUOTER_ADDRESS:'0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94',ARC_FROM_BLOCK:spark.launchReceipt.blockNumber.toString(),
      ARC_DATABASE_URL:dbUrl.href,ARC_DATABASE_SCHEMA:`argus_local_fork_31338_${Date.now()}`,ARC_DATA_DIR:resolve(serveDir,'runtime'),
      ARC_CONFIG_SIGNING_KEY:`0x${randomBytes(32).toString('hex')}`,ARC_CONFIG_KEY_ID:'argus-local-fork',ARC_KEEPER_PRIVATE_KEY:keccak256(toHex('singlespark/argus-fork/custody')),
      ARC_TREASURY_ENCRYPTION_KEY:randomBytes(32).toString('hex'),ARC_ARGUS_CUSTODY_ADDRESS:custody.address,ARC_ARGUS_PLATFORM_TOKEN:spark.token,
      ARC_ARGUS_ROUTER_ADDRESS:route,ARC_ARGUS_ROUTER_CODE_HASH:keccak256(await client.getCode({address:route})),ARC_ARGUS_LAUNCH_ENABLED:'true',
      ARC_SATISFACTION_ADDRESS:vault,ARC_SATISFACTION_FROM_BLOCK:spark.launchReceipt.blockNumber.toString(),ARC_RPC_MAX_RPS:'100',ARC_RPC_BURST:'100',
      ARC_MAX_GAS_PER_TX:'10000000'};
    if(independent){
      const {checkIndependentWallets}=await import('./check-argus-independent.mjs');
      await checkIndependentWallets({env,client,chain,dbUrl,route,router,portalAbi,splitterAbi,trader,send,read,warp,now,mark,steps});
    }else{
    writeFileSync(resolve(serveDir,'deployment.json'),JSON.stringify({chainId:31338,publicTransactions:false,quote:'explicit mock ERC20; separate native gas balance',portal:PORTAL,platformToken:spark.token,router:route,vault,steps},null,2));
    await serveBackend(env);
    }
  }else{
  await send(trader,QUOTE,erc20Abi,'approve',[route,100000n*10n**6n]);
  await send(custody,QUOTE,erc20Abi,'approve',[route,1000n*10n**6n]);
  const balances=async l=>read(l.token,erc20Abi,'balanceOf',[trader.address]);
  const lockerAbi=parseAbi(['function collect() returns(uint256,uint256)']);
  let revenues=[];
  for(const l of [spark,a,b]){
    const bought=await send(trader,route,router.abi,'trade',[l.token,true,20000n*10n**18n,1n,(await now())+120n]);
    const held=await balances(l);assert(held>10000000n*10n**18n);
    await send(trader,l.token,erc20Abi,'approve',[route,held/10n]);
    await send(trader,route,router.abi,'trade',[l.token,false,held/10n,10n**12n,(await now())+120n]);
    await send(trader,l.locker,lockerAbi,'collect');
    const before=await read(QUOTE,qAbi,'balanceOf',[custody.address]);
    const split=await send(trader,l.splitter,splitterAbi,'distribute');
    const claim=await send(trader,l.splitter,splitterAbi,'claim',[custody.address]); // third party is allowed; beneficiary stays custody
    const after=await read(QUOTE,qAbi,'balanceOf',[custody.address]);
    const income=[...split.logs,...claim.logs].filter(log=>log.address.toLowerCase()===l.splitter.toLowerCase());
    const paid=parseEventLogs({abi:splitterAbi,logs:income}).filter(e=>['Paid','Claimed'].includes(e.eventName)&&e.args.to?.toLowerCase()===custody.address.toLowerCase()&&e.args.currency?.toLowerCase()===QUOTE);
    const sum=paid.reduce((s,e)=>s+e.args.amount,0n);assert.equal(after-before,sum);assert(sum>0n);
    revenues.push({token:l.token,receivedUsdc6:sum.toString(),events:paid.length});mark('real buy sell collect distribute claim',{token:l.token,receivedUsdc6:sum.toString(),buyTx:bought.transactionHash});
    await warp(181);
    const [,cap]=await read(route,router.abi,'keeperSwapState',[l.token]);const amount=cap<5000000n?cap:5000000n;assert(amount>0n);
    const deadBefore=await read(l.token,erc20Abi,'balanceOf',[DEAD]);const supply=await read(l.token,erc20Abi,'totalSupply');
    await send(custody,route,router.abi,'buyAndBurn',[l.token,amount,1n,(await now())+30n]);
    assert((await read(l.token,erc20Abi,'balanceOf',[DEAD]))>deadBefore);assert.equal(await read(l.token,erc20Abi,'totalSupply'),supply);
    mark('buy and burn by dead transfer',{token:l.token,quoteUsdc6:amount.toString()});
  }
  await warp(181);
  await send(custody,route,router.abi,'trade',[a.token,true,1n*10n**18n,2000n*10n**18n,(await now())+30n]);
  assert((await read(a.token,erc20Abi,'balanceOf',[custody.address]))>=2000n*10n**18n);
  mark('custody reward purchase',{token:a.token,quoteUsdc6:'1000000'});
  await send(custody,a.token,erc20Abi,'approve',[route,2000n*10n**18n]);
  const recipients=Array.from({length:200},(_,i)=>toHex(0x100000n+BigInt(i),{size:20}));
  for(let i=0;i<2;i++)await send(custody,route,router.abi,'distribute',[a.token,BigInt(i*100),recipients.slice(i*100,(i+1)*100)]);
  assert.equal(await read(route,router.abi,'totalPaid',[a.token]),200n);for(const r of recipients)assert.equal(await read(a.token,erc20Abi,'balanceOf',[r]),10n*10n**18n);
  let replayFailed=false;try{await client.simulateContract({account:custody.address,address:route,abi:router.abi,functionName:'distribute',args:[a.token,0n,recipients.slice(0,100)]});}catch{replayFailed=true;}assert(replayFailed);mark('two gas batches and replay rejected',{syntheticRecipients:200});
  await warp(181);await send(custody,route,router.abi,'buyAndBurn',[spark.token,5000000n,1n,(await now())+30n]);
  mark('cross-project SPARK buyback',{quoteUsdc6:'5000000'});
  const treasury=await read(route,router.abi,'community',[a.token]);await send(custody,route,router.abi,'fundTreasury',[a.token,false,300000000n]);
  const proposed=await send(trader,treasury,project.abi,'propose',[0,299n*10n**18n,keccak256(toHex('isolated synthetic checkout quote'))]);
  await send(trader,a.token,erc20Abi,'approve',[treasury,10000000n*10n**18n]);await send(trader,treasury,project.abi,'vote',[1n,true,10000000n*10n**18n]);
  await warp(604801);await send(trader,treasury,project.abi,'settle',[1n]);const before=await read(QUOTE,qAbi,'balanceOf',[custody.address]);
  await send(custody,treasury,project.abi,'claim',[1n]);assert.equal((await read(QUOTE,qAbi,'balanceOf',[custody.address]))-before,299000000n);
  await send(trader,treasury,project.abi,'withdrawStake',[1n]);mark('project governance approved exact payout',{treasury,proposalTx:proposed.transactionHash,testFundingUsdc6:'300000000'});
  mark('receipt totals',{revenues});
  // The real Rust signer and PostgreSQL ledger now replay these actual receipts and execute their own budgets.
  const dbUrl=new URL(readFileSync('SingleSparkContract/arc/.env.postgres.local','utf8').split('\n').find(l=>l.startsWith('ARC_TEST_DATABASE_URL=')).slice('ARC_TEST_DATABASE_URL='.length));
  assert(dbUrl.pathname.endsWith('_test'));
  const schema=`test_argus_${Date.now()}`;
  const pgEnv={...process.env,PGPASSWORD:decodeURIComponent(dbUrl.password)};
  const sql=statement=>{
    const r=spawnSync('psql',['-X','-h',dbUrl.hostname,'-p',dbUrl.port||'5432','-d',dbUrl.pathname.slice(1),'-U',decodeURIComponent(dbUrl.username),'-A','-t','-v','ON_ERROR_STOP=1'],{input:statement,env:pgEnv,encoding:'utf8'});
    if(r.status!==0)throw Error('Isolated test SQL failed');return r.stdout.trim();
  };
  const literal=v=>"'"+String(v).replaceAll("'","''")+"'";
  sql(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}; CREATE TABLE argus_launch_requests (
    id BIGSERIAL PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL, draft TEXT NOT NULL, metadata_uri TEXT NOT NULL,
    salt TEXT NOT NULL UNIQUE, hook_salt TEXT, predicted_token TEXT, tx_hash TEXT, token TEXT,status TEXT NOT NULL DEFAULT 'queued',error TEXT,created_at TEXT NOT NULL,UNIQUE(owner,request_id));`);
  for(const l of [a,b]){
    const draft={requestId:l.symbol,name:l.name,symbol:l.symbol,imageUri:l.imageURI,description:'Isolated synthetic fork verification',channels:{},startFdv:'2500',bondFdv:'1000000',buyTaxBps:100,sellTaxBps:100};
    sql(`SET search_path TO ${schema}; INSERT INTO argus_launch_requests(owner,request_id,draft,metadata_uri,salt,tx_hash,token,status,created_at) VALUES
      (${literal(trader.address)},${literal(l.symbol)},${literal(JSON.stringify(draft))},'',${literal(keccak256(toHex(l.symbol)))},${literal(l.launchReceipt.transactionHash)},${literal(l.token)},'confirmed',${literal(new Date().toISOString())});`);
  }
  const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ARC_'))),ARC_CHAIN_ID:'5042',ARC_LAUNCH_PROTOCOL:'argus-v7-custody',
    ARC_LAUNCH_ADDRESS:PORTAL,ARC_RPC_URL:url,ARC_PUBLIC_RPC_URL:url,ARC_WEB_ORIGIN:'http://127.0.0.1:5197',ARC_EXPLORER_URL:'https://explorer.arc.io',
    ARC_QUOTER_ADDRESS:'0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94',ARC_FROM_BLOCK:spark.launchReceipt.blockNumber.toString(),
    ARC_DATABASE_URL:dbUrl.href,ARC_DATABASE_SCHEMA:schema,ARC_DATA_DIR:mkdtempSync(resolve(tmpdir(),'argus-backend-fork-')),
    ARC_CONFIG_SIGNING_KEY:keccak256(toHex('singlespark/argus-fork/config')),ARC_KEEPER_PRIVATE_KEY:keccak256(toHex('singlespark/argus-fork/custody')),
    ARC_ARGUS_CUSTODY_ADDRESS:custody.address,ARC_ARGUS_PLATFORM_TOKEN:spark.token,ARC_ARGUS_ROUTER_ADDRESS:route,
    ARC_ARGUS_ROUTER_CODE_HASH:keccak256(await client.getCode({address:route})),ARC_ARGUS_LAUNCH_ENABLED:'false',
    ARC_SATISFACTION_ADDRESS:vault,ARC_SATISFACTION_FROM_BLOCK:spark.launchReceipt.blockNumber.toString(),ARC_RPC_MAX_RPS:'1000',ARC_RPC_BURST:'1000',ARC_MAX_GAS_PER_TX:'5000000'};
  const runBackend=flag=>new Promise((ok,no)=>{
    const child=spawn('SingleSparkBackend/api/target/debug/jet-arc-backend',[flag],{env,stdio:['ignore','pipe','pipe']});let out='',error='';
    const timer=setTimeout(()=>child.kill('SIGTERM'),180000);child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>error+=b);
    child.on('error',no);child.on('exit',code=>{clearTimeout(timer);if(code!==0)no(Error(`Isolated backend failed: ${error.slice(-2000)}`));else try{ok(JSON.parse(out.trim().split('\n').at(-1)));}catch(e){no(e);}});
  });
  const checkpoint=()=>JSON.parse(sql(`SET search_path TO ${schema}; SELECT value FROM kv WHERE key='index';`).split('\n').at(-1));
  await client.request({method:'anvil_mine',params:['0x8']});
  let view=await runBackend('--resume-only');assert.equal(view.tokens.length,3,`Indexed ${view.blockNumber}, latest ${(await client.getBlock()).number}`);assert.equal(view.tokens[0].token.toLowerCase(),spark.token.toLowerCase());
  let index=checkpoint();
  for(const l of [spark,a,b]){
    const budget=index.custody.budgets[l.token.toLowerCase()];assert(budget,`Missing budget ${l.symbol}`);
    const gross=BigInt(budget.received);assert(gross>0n);
    const amounts=index.custody.receipts.filter(r=>r.token.toLowerCase()===l.token.toLowerCase()&&r.allocated).map(r=>BigInt(r.amount));
    assert.equal(BigInt(budget.own),amounts.reduce((n,x)=>n+x*(l===spark?94n:83n)/100n,0n));
    assert.equal(BigInt(budget.community),l===spark?0n:amounts.reduce((n,x)=>n+x*4n/100n,0n));
  }
  const beforeReplay=JSON.stringify(index.custody);await runBackend('--resume-only');assert.equal(JSON.stringify(checkpoint().custody),beforeReplay);
  mark('Rust finalized receipt replay and budget allocation',{schema,projects:3,duplicateReplay:true});
  for(let i=0;i<30;i++){
    await warp(181);await client.request({method:'anvil_mine',params:['0x8']});view=await runBackend('--once');index=checkpoint();
    console.log(`RUN backend cycle ${i+1}`);
    const done=sql(`SET search_path TO ${schema}; SELECT DISTINCT kind FROM argus_actions WHERE status='applied';`).split('\n');
    if(['own','spark','rewards','community','operations'].every(k=>done.includes(k))&&Object.values(index.custody.budgets).some(b=>BigInt(b.reward_tokens)>0n))break;
  }
  await client.request({method:'anvil_mine',params:['0x8']});await runBackend('--resume-only');index=checkpoint();
  const kinds=sql(`SET search_path TO ${schema}; SELECT DISTINCT kind FROM argus_actions WHERE status='applied' ORDER BY kind;`).split('\n').filter(k=>k!=='SET');
  for(const kind of ['own','spark','rewards','community','operations'])assert(kinds.includes(kind),`Missing finalized keeper path: ${kind}`);
  for(const budget of Object.values(index.custody.budgets))assert.equal(BigInt(budget.received)+BigInt(budget.returned),
    ['own','spark','rewards','community','operations'].reduce((n,k)=>n+BigInt(budget[k]),0n)+BigInt(budget.executed));
  mark('Rust signed keeper funding closed loop',{kinds,actions:sql(`SET search_path TO ${schema}; SELECT count(*) FROM argus_actions WHERE status='applied';`).split('\n').at(-1),budgets:index.custody.budgets});

  // Real finalized sender discovery, using controlled test accounts rather than inventing queue entries.
  sql(`SET search_path TO ${schema}; UPDATE keeper_tokens SET paused=true WHERE token<>${literal(b.token.toLowerCase())};`);
  assert(BigInt(index.custody.budgets[b.token.toLowerCase()].reward_tokens)>=1000n*10n**18n);
  const senders=Array.from({length:100},(_,i)=>privateKeyToAccount(keccak256(toHex(`singlespark/argus-fork/sender/${i}`))));
  await client.request({method:'evm_setAutomine',params:[false]});
  await Promise.all(senders.map(async a=>{
    await client.request({method:'anvil_setBalance',params:[a.address,toHex(10n**18n)]});
    return wallet(a).sendTransaction({to:trader.address,value:0n,nonce:0,gas:21000n,maxFeePerGas:1000000000n,maxPriorityFeePerGas:1n});
  }));
  await client.request({method:'evm_mine',params:[]});await client.request({method:'evm_setAutomine',params:[true]});
  for(let i=0;i<20;i++){
    await warp(181);await client.request({method:'anvil_mine',params:['0x2']});await runBackend('--once');index=checkpoint();
    console.log(`RUN sender distribution cycle ${i+1}`);
    if(index.custody.payouts.some(p=>p.token.toLowerCase()===b.token.toLowerCase()))break;
  }
  await client.request({method:'anvil_mine',params:['0x8']});await runBackend('--resume-only');index=checkpoint();
  const payouts=index.custody.payouts.filter(p=>p.token.toLowerCase()===b.token.toLowerCase());
  assert(payouts.length>=100,'No finalized automatic distribution');
  assert.equal(new Set(payouts.map(p=>p.recipient.toLowerCase())).size,payouts.length);
  assert.equal(await read(route,router.abi,'totalPaid',[b.token]),BigInt(payouts.length));
  for(const a of senders)assert.equal(await read(b.token,erc20Abi,'balanceOf',[a.address]),10n*10n**18n);
  const paidBeforeReplay=JSON.stringify(index.custody.payouts);await runBackend('--resume-only');assert.equal(JSON.stringify(checkpoint().custody.payouts),paidBeforeReplay);
  mark('Rust finalized sender discovery and automatic distribution',{controlledSenders:100,recipients:payouts.length,duplicateReplay:true});

  const queued={requestId:'backend-launch',name:'Fork Queued',symbol:'FQUEUE',imageUri:a.imageURI,description:'Queued launch integration fixture',
    channels:{website:'https://singlespark.fun'},startFdv:'2500',bondFdv:'1000000',buyTaxBps:100,sellTaxBps:200,plugins:{buyback:true,distribution:false,revision:0}};
  sql(`SET search_path TO ${schema}; INSERT INTO argus_launch_requests(owner,request_id,draft,metadata_uri,salt,created_at) VALUES
    (${literal(trader.address)},${literal(queued.requestId)},${literal(JSON.stringify(queued))},'https://singlespark.fun/api/arc/media/fork-fixture.json',${literal(keccak256(toHex(queued.requestId)))},${literal(new Date().toISOString())});`);
  env.ARC_ARGUS_LAUNCH_ENABLED='true';
  for(let i=0;i<6;i++){
    await client.request({method:'anvil_mine',params:['0x8']});view=await runBackend('--once');
    console.log(`RUN queued launch cycle ${i+1}`);
    if(sql(`SET search_path TO ${schema}; SELECT status FROM argus_launch_requests WHERE request_id='backend-launch';`).split('\n').at(-1)==='confirmed')break;
  }
  const job=JSON.parse(sql(`SET search_path TO ${schema}; SELECT row_to_json(r) FROM (SELECT status,token,tx_hash,error FROM argus_launch_requests WHERE request_id='backend-launch') r;`).split('\n').at(-1));
  assert.equal(job.status,'confirmed',JSON.stringify(job));
  await client.request({method:'anvil_mine',params:['0x8']});view=await runBackend('--once');
  const created=await read(PORTAL,portalAbi,'launches',[job.token]);assert.equal(created[0].toLowerCase(),custody.address.toLowerCase());assert.equal(created[7],200);
  assert.notEqual(await read(route,router.abi,'community',[job.token]),zeroAddress);
  mark('Rust queued launch signing, finalized receipt and treasury binding',{token:job.token,transactionHash:job.tx_hash,initiator:trader.address,custody:custody.address});
  if(checkPlugins){
    // Public read and SIWE authorization through the actual HTTP API, with no signer in this server.
    const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const apiPort=reserve.address().port;await new Promise(r=>reserve.close(r));
    const apiEnv={...env,ARC_PORT:String(apiPort),ARC_ARGUS_LAUNCH_ENABLED:'false'};delete apiEnv.ARC_KEEPER_PRIVATE_KEY;
    api=spawn('SingleSparkBackend/api/target/debug/jet-arc-backend',[],{env:apiEnv,stdio:['ignore','ignore','pipe']});let apiErr='';api.stderr.on('data',b=>apiErr+=b);
    const base=`http://127.0.0.1:${apiPort}`,path=`/api/arc/plugins?token=${b.token}`;
    const request=async(path,init={})=>{const r=await fetch(base+path,{...init,headers:{'Content-Type':'application/json',...init.headers},signal:AbortSignal.timeout(30000)});return {status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};};
    for(let i=0;;i++){try{const r=await request(path);if(r.status===200)break;}catch{}assert(i<120&&api.exitCode===null,`Plugin API startup failed: ${apiErr.slice(-1200)}`);await new Promise(r=>setTimeout(r,250));}
    const publicRead=await request(path);assert.equal(publicRead.body.canManage,false);assert.equal(publicRead.body.locked,true);assert.equal(publicRead.cache,'private, no-store');
    const changes={buyback:false,distribution:true,revision:publicRead.body.settings.revision};
    assert.equal((await request(path,{method:'POST',body:JSON.stringify(changes)})).status,401);
    const login=async account=>{const n=await request(`/api/auth/nonce?address=${account.address}&chainId=5042`);assert.equal(n.status,200);
      const signature=await account.signMessage({message:n.body.message});const r=await request('/api/auth/login',{method:'POST',body:JSON.stringify({message:n.body.message,signature,chainId:5042})});assert.equal(r.status,200);return {Authorization:`Bearer ${r.body.token}`};};
    const outsider=privateKeyToAccount(keccak256(toHex('singlespark/argus-fork/outsider'))),ordinary=await login(outsider);
    assert.equal((await request(path,{headers:ordinary})).body.canManage,false);
    assert.equal((await request(path,{method:'POST',headers:ordinary,body:JSON.stringify(changes)})).status,403);
    const dev=await login(trader),official=await login(custody);
    assert.equal((await request(path,{headers:dev})).body.canManage,false);
    assert.equal((await request(path,{headers:official})).body.canManage,false);
    for(const headers of [dev,official])assert.equal((await request(path,{method:'POST',headers,body:JSON.stringify(changes)})).status,409);
    assert.deepEqual((await request(path,{headers:dev})).body.settings,publicRead.body.settings);
    const history=await request(`/api/arc/rewards/payouts?token=${b.token}`),status=await request(`/api/arc/rewards?token=${b.token}`);
    assert.equal(history.status,200);assert.equal(status.status,200);assert.equal(status.body.contract.toLowerCase(),history.body.rewardContract.toLowerCase());
    assert(history.body.total>=100);const live=await request('/api/arc/snapshot');assert.equal(live.body.launchProtocol,'argus-v7-custody');
    mark('plugin HTTP public reads and immutable creation choices',{anonymousPost:401,ordinaryPost:403,devAndTeamPost:409,confirmedRecipients:history.body.total});
    for(const headers of [ordinary,dev,official])assert.equal((await request('/api/auth/logout',{method:'POST',headers})).status,200);
  }

  }}
}catch(e){failure=e.message;console.error(e.message);if(err)console.error(err.slice(-2000));}finally{
  api?.kill('SIGTERM');anvil.kill('SIGTERM');mkdirSync('SingleSparkContract/arc/deployments',{recursive:true});
  if(!serve&&!independent)
  writeFileSync(checkPlugins?'SingleSparkContract/arc/deployments/arc-revenue-plugins-immutable-fork-20261005.json':'SingleSparkContract/arc/deployments/argus-custody-fork-20260930.json',JSON.stringify({status:failure?'failed':'passed',failure,generatedAt:new Date().toISOString(),chainId:5042,forkBlock:process.env.ARC_MAINNET_FORK_BLOCK??'23563119',publicTransactions:false,
    quotePrecompile:'explicit test ERC20 mock; native USDC/gas sharing and Arc blocklist not emulated',distributionRecipients:'synthetic fixtures',governanceFunding:'explicit test funding, not trading fees',steps},null,2)+'\n');
}
if(failure)process.exitCode=1;
