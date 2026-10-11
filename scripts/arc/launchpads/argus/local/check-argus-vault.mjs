// Local-fork integration only: real Argus/V4, explicit mock USDC, synthetic recipients.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWalletClient,http,erc20Abi,keccak256,toHex,getCreate2Address,encodeAbiParameters,parseAbiParameters,parseEventLogs,zeroAddress,parseEther} from 'viem';
import {deployArgusVaults} from '../production/deploy-argus-vault.mjs';
mkdirSync('SingleSparkContract/chains/arc/deployments/local/argus', { recursive: true });
const artifact=name=>JSON.parse(readFileSync(new URL(`../../../../../chains/arc/out/${name}.sol/${name}.json`,import.meta.url)));
export async function checkVaults({env,client,chain,dbUrl,route,router,portalAbi,splitterAbi,trader,custody,send,read,warp,now,mark,steps}) {
  const dir=mkdtempSync(join(tmpdir(),'argus-vault-'));
  await client.request({method:'anvil_setChainId',params:[5042]});chain.id=5042;
  const wallet=createWalletClient({account:custody,chain,transport:http(env.ARC_RPC_URL,{retryCount:0})});
  const options={client,wallet,router:route,routerCodeHash:keccak256(await client.getCode({address:route})),admin:trader.address,executor:custody.address,budget:parseEther('1'),journalPath:join(dir,'deployment.json')};
  const plan=await deployArgusVaults(options);assert.equal(plan.status,'reviewable_plan');
  const deployment=await deployArgusVaults({...options,broadcast:true});
  assert.equal(deployment.ARC_ARGUS_VAULT_FACTORY.toLowerCase(),plan.factory.toLowerCase());
  assert.deepEqual(await deployArgusVaults({...options,broadcast:true}),deployment,'Deployment must resume without another transaction');
  await client.request({method:'anvil_setChainId',params:[31338]});chain.id=31338;
  const factory=deployment.ARC_ARGUS_VAULT_FACTORY,fa=artifact('ArgusVaultFactory').abi,va=artifact('ArgusRevenueVault').abi;
  mark('vault deployment journal and immutable 48-hour controller verified',deployment);
  env={...env,ARC_DATA_DIR:dir,ARC_DATABASE_SCHEMA:`test_argus_vault_${Date.now()}`,ARC_ARGUS_INDEPENDENT_WALLETS:'true',
    ...Object.fromEntries(Object.entries(deployment).filter(([k])=>k.startsWith('ARC_')))};
  const sql=statement=>{
    const r=spawnSync('psql',['-X','-A','-t','-v','ON_ERROR_STOP=1'],{input:`SET search_path TO ${env.ARC_DATABASE_SCHEMA}; ${statement}`,
      env:{...process.env,PGHOST:dbUrl.hostname,PGPORT:dbUrl.port||'5432',PGDATABASE:dbUrl.pathname.slice(1),PGUSER:decodeURIComponent(dbUrl.username),PGPASSWORD:decodeURIComponent(dbUrl.password)},encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);return r.stdout.trim().replace(/^SET\n/,'');
  };
  const runOnce=()=>new Promise((resolve,reject)=>{
    const child=spawn('SingleSparkBackend/api/target/debug/jet-arc-backend',['--once'],{env,stdio:['ignore','pipe','pipe']});let out='',error='';
    child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>error+=b);
    const timer=setTimeout(()=>child.kill('SIGTERM'),90000);child.on('error',reject);
    child.on('exit',code=>{clearTimeout(timer);if(code!==0)return reject(Error(error.slice(-3000)));try{resolve(JSON.parse(out.trim().split('\n').at(-1)));}catch{reject(Error(out.slice(-500)+error.slice(-2000)));}});
  });
  const portal=env.ARC_LAUNCH_ADDRESS,quote='0x3600000000000000000000000000000000000000',projects=[];
  for(let i=0;i<2;i++) {
    const salt=keccak256(toHex(`contract-vault/${i}`)),vault=await read(factory,fa,'predictVault',[trader.address,salt]);
    const splitter=await read(portal,portalAbi,'predictSplitter',[vault,salt]);
    const bytecodeHash=await read(portal,portalAbi,'hookInitCodeHash',[splitter,200,200,quote]);
    let hookSalt;
    for(let n=0n;n<1000000n;n++) {
      const candidate=toHex(n,{size:32}),scoped=keccak256(encodeAbiParameters(parseAbiParameters('address,bytes32'),[vault,candidate]));
      if((BigInt(getCreate2Address({from:portal,salt:scoped,bytecodeHash}))&0x3fffn)===0x2044n){hookSalt=candidate;break;}
    }
    assert(hookSalt);
    const p={name:`Vault ${i}`,symbol:`VLT${i}`,totalSupply:10n**27n,startFdvUsdc6:2500n*10n**6n,bondFdvUsdc6:45000n*10n**6n,
      buyTaxBps:200,sellTaxBps:200,creatorBps:10000,burnBps:0,dividendBps:0,liquidityBps:0,devBuyQuote:0n,quoteAsset:quote,expectConvert:1};
    const meta={imageURI:'',website:'',twitter:'',telegram:'',description:'Contract vault fork test'};
    const receipt=await send(trader,factory,fa,'launch',[p,meta,salt,hookSalt,7,'']);
    const event=parseEventLogs({abi:fa,eventName:'VaultLaunched',logs:receipt.logs})[0];assert(event);
    const token=event.args.token,launch=await read(portal,portalAbi,'launches',[token]);
    assert.equal(launch[0].toLowerCase(),vault.toLowerCase());assert.equal((await read(splitter,splitterAbi,'creator')).toLowerCase(),vault.toLowerCase());
    assert.equal(await client.getBalance({address:vault}),0n,'No vault gas funding');
    projects.push({token,vault,splitter,locker:launch[3]});
  }
  assert.notEqual(projects[0].vault,projects[1].vault);
  await warp(2);let snapshot=await runOnce();
  for(const p of projects) {
    const view=snapshot.tokens.find(t=>t.token.toLowerCase()===p.token.toLowerCase());assert(view,JSON.stringify(snapshot.worker));
    assert.equal(view.revenueVault.toLowerCase(),p.vault.toLowerCase());assert.equal(view.independentWallet,false);
    assert.equal(view.pluginPolicy.delaySeconds,172800);assert.equal(view.initiator.toLowerCase(),trader.address.toLowerCase());
  }
  assert.equal(sql("SELECT count(*) FROM native_launch_accounts WHERE platform='argus'"),'0');
  mark('two real Portal creators are isolated contract vaults; index and restart need no project keys',{projects});
  await send(trader,quote,erc20Abi,'approve',[route,100000n*10n**6n]);
  for(const p of projects) {
    await send(trader,route,router.abi,'trade',[p.token,true,1000n*10n**18n,1n,(await now())+120n]);
    // A labelled donation covers all plugin thresholds while genuine collected fees remain separately indexed.
    await send(trader,quote,erc20Abi,'transfer',[p.vault,100n*10n**6n]);
  }
  const recipients=Array.from({length:100},(_,i)=>toHex(0x510000n+BigInt(i),{size:20}));
  const head=await client.getBlock({blockTag:'finalized'});
  for(const p of projects) {
    const queue=JSON.stringify({addresses:recipients,fromBlock:Number(head.number),toBlock:Number(head.number),blockHash:head.hash});
    sql(`INSERT INTO kv(key,value) VALUES('argus:${p.token.toLowerCase()}:candidates','${queue}') ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);
  }
  let actions=[];
  for(let i=0;i<70;i++) {
    await warp(181);snapshot=await runOnce();
    actions=JSON.parse(sql("SELECT coalesce(json_agg(r),'[]') FROM (SELECT source,kind,sender,target,tx_hash FROM argus_actions WHERE status='applied' ORDER BY id) r"));
    if(projects.every(p=>['collect','own','spark','rewards','payout','community','operations'].every(kind=>actions.some(a=>a.source.toLowerCase()===p.token.toLowerCase()&&a.kind===kind))))break;
    if(i===69)throw Error(`Missing vault actions ${JSON.stringify(actions)}; worker=${JSON.stringify(snapshot.worker)}`);
  }
  for(const p of projects) {
    const view=snapshot.tokens.find(t=>t.token.toLowerCase()===p.token.toLowerCase());
    assert(BigInt(view.creatorFeesTotal)>0n);assert(BigInt(view.vaultIncome)*10n**12n>BigInt(view.creatorFeesTotal),'Donations must not be reported as creator fees');
    assert(BigInt(view.totalBurned)>0n);assert.equal(await read(p.vault,va,'totalPaid'),100n);
    for(const action of actions.filter(a=>a.source.toLowerCase()===p.token.toLowerCase())) {
      assert.equal(action.sender.toLowerCase(),custody.address.toLowerCase());assert.equal(action.target.toLowerCase(),p.vault.toLowerCase());
    }
  }
  mark('Rust journal executes collection, burns, reward buys, 100-recipient payouts and treasury buckets through vaults',{actions});
  await send(trader,factory,fa,'pause',[zeroAddress,7]);await warp(2);snapshot=await runOnce();
  for(const p of projects){const view=snapshot.tokens.find(t=>t.token.toLowerCase()===p.token.toLowerCase());assert.equal(view.pluginPolicy.paused,7);assert.equal(view.plugins.buyback,false);}
  await send(trader,factory,fa,'scheduleResume',[7]);
  await assert.rejects(()=>client.simulateContract({address:factory,abi:fa,functionName:'executeResume',args:[7],account:trader.address}));
  await warp(172801);await send(trader,factory,fa,'executeResume',[7]);await warp(2);snapshot=await runOnce();
  for(const p of projects)assert.equal(snapshot.tokens.find(t=>t.token.toLowerCase()===p.token.toLowerCase()).pluginPolicy.paused,0);
  mark('global pause and delayed resume survive backend restarts');
  const previousTarget=env.ARC_ARGUS_PLATFORM_TOKEN,nextTarget=projects[1].token;
  await send(trader,factory,fa,'schedulePlatformToken',[nextTarget]);
  await assert.rejects(()=>client.simulateContract({address:factory,abi:fa,functionName:'executePlatformToken',args:[nextTarget],account:trader.address}));
  await warp(172801);await send(trader,factory,fa,'executePlatformToken',[nextTarget]);
  const changedAt=await client.getBlockNumber();
  await assert.rejects(async()=>client.simulateContract({address:projects[0].vault,abi:va,functionName:'buyPlatform',
    args:[previousTarget,1n,1n,(await now())+30n,await read(projects[0].vault,va,'nonce')],account:custody.address}));
  for(const p of projects)await send(trader,quote,erc20Abi,'transfer',[p.vault,100n*10n**6n]);
  let updatedBurn;
  for(let i=0;i<50;i++) {
    await warp(181);snapshot=await runOnce();
    updatedBurn=snapshot.records.find(r=>r.sourceToken?.toLowerCase()===projects[0].token.toLowerCase()
      && r.token.toLowerCase()===nextTarget.toLowerCase()&&BigInt(r.blockNumber)>changedAt);
    if(updatedBurn)break;
  }
  assert(updatedBurn,'The journal must verify a platform burn using the new shared target');
  for(const p of projects){
    const view=snapshot.tokens.find(t=>t.token.toLowerCase()===p.token.toLowerCase());
    assert.equal(view.pluginPolicy.platformToken.toLowerCase(),nextTarget.toLowerCase());
    assert.equal(view.revenueVault.toLowerCase(),p.vault.toLowerCase());
    assert.equal((await read(p.vault,va,'token')).toLowerCase(),p.token.toLowerCase());
  }
  mark('one delayed platform target update reaches both unchanged vaults and stale intents fail',{previousTarget,nextTarget,updatedBurn});
  mkdirSync('SingleSparkContract/chains/arc/deployments/local/argus',{recursive:true});
  writeFileSync('SingleSparkContract/chains/arc/deployments/local/argus/argus-vault-local.json',JSON.stringify({status:'passed',generatedAt:new Date().toISOString(),publicTransactions:false,
    limitations:'Anvil mock ERC20 USDC; native USDC precompile/blocklist not emulated; synthetic recipient fixture',steps},null,2)+'\n');
}
