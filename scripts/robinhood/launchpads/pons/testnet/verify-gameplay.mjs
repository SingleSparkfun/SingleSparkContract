import assert from 'node:assert/strict';
import { openSync, closeSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeDeployData, encodeFunctionData, decodeFunctionData, encodeAbiParameters, parseEventLogs, parseAbi,
  zeroAddress, toHex, keccak256, erc20Abi, getAddress, hashTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { root, readJson, json } from './build.mjs';
import { context } from './transactions.mjs';
import { deploy, maskImmutables } from './deploy.mjs';
import { poolMinimum } from './quote.mjs';
import { gameplayPaths } from './build-gameplay.mjs';
import { claimTypedData } from './claim-authorization.mjs';

const index = process.argv.indexOf('--wallet'); assert(index >= 0, 'Pass an owner-only testnet --wallet');
const walletPath = resolve(process.argv[index + 1]);
const deploymentIndex = process.argv.indexOf('--deployment-id');
assert(deploymentIndex < 0 || process.argv[deploymentIndex + 1], 'Missing --deployment-id');
const deploymentId = deploymentIndex < 0 ? '' : process.argv[deploymentIndex + 1];
const foundation = await context({ walletPath }); await deploy(foundation);
const build = readJson(gameplayPaths(deploymentId).output);
assert.equal(build.chainId, 46630); assert.equal(build.policyDelaySeconds, 600);
const roles = readJson(resolve(root, 'chains/robinhood/deployments/testnet/pons/vault-config.json'));
const c = await context({ walletPath, broadcast: process.argv.includes('--broadcast'), deploymentName: 'gameplay', deploymentId, artifacts: { ...build, roles } });
if (!c.broadcast) { console.log(json({ status: 'prepared', chainId:46630, policyDelaySeconds:600, name:'SingleSpark',symbol:'SPARK',
  maximumCostWei:c.config.maximumTotalCostWei, isolatedTestnet:true, mainnet:false })); process.exit(0); }
mkdirSync(c.storageDir, {recursive:true,mode:0o700});
const lockPath = resolve(c.storageDir, 'run.lock'), lock = openSync(lockPath, 'wx', 0o600);
try {
  const a = build.artifacts, source = foundation.report.addresses.factory, upstream = foundation.build.artifacts;
  const call = (label,address,abi,functionName,args=[],value=0n,role='deployer') => c.send(label,{to:address,data:encodeFunctionData({abi,functionName,args}),value},role);
  const same = (a,b) => assert.equal(a.toLowerCase(),b.toLowerCase());
  async function create(name,args) {
    const receipt = await c.send(`deploy-${name}`,{data:encodeDeployData({abi:a[name].abi,bytecode:a[name].bytecode,args})});
    const address = receipt.contractAddress, code = await c.client.getCode({address});
    assert.equal(maskImmutables(code,a[name].runtime.immutableReferences),maskImmutables(a[name].runtime.object,a[name].runtime.immutableReferences));
    c.report.addresses[name] = address; c.report.codeHashes[name] = keccak256(code); c.save(); return address;
  }
  const factory = await create('factory',[roles.admin,roles.authorizer,roles.treasury,source]);
  const vaultImpl = await c.read(factory,a.factory.abi,'implementation');
  const implCode = await c.client.getCode({address:vaultImpl});
  assert.equal(maskImmutables(implCode,a.vault.runtime.immutableReferences),maskImmutables(a.vault.runtime.object,a.vault.runtime.immutableReferences));
  c.report.addresses.vaultImplementation = vaultImpl; c.report.codeHashes.vaultImplementation = keccak256(implCode); c.save();
  for (const [field,expected] of Object.entries({admin:roles.admin,authorizer:roles.authorizer,treasury:roles.treasury,pons:source,escrow:foundation.report.addresses.escrow})) same(await c.read(factory,a.factory.abi,field),expected);
  assert.equal(await c.read(factory,a.factory.abi,'DELAY'),600n);
  if(build.policyActivation==='timestamp')assert.equal(await c.read(factory,a.factory.abi,'automaticPolicyActivation'),true);
  if (build.payoutPolicy === 'repeat') assert.equal(await c.read(vaultImpl,a.vault.abi,'permanentPayoutDeduplication'),false);
  const buyback = await create('buyback',[]), distribution = await create('distribution',[]), adapter = await create('adapter',[factory,source]);
  const ids = ['buyback-burn@1','platform-buyback@1','distribution@1'].map(name=>keccak256(toHex(name)));
  const wallets = readJson(walletPath);
  const authorizer = privateKeyToAccount(wallets.executor.privateKey); same(authorizer.address,roles.authorizer);
  async function sign(request) {
    const payload = claimTypedData(project.vault, request);
    assert.equal(await c.read(project.vault,a.vault.abi,'claimDigest',[request]),hashTypedData(payload),'RPC Claim digest mismatch');
    return authorizer.signTypedData(payload);
  }
  same(wallets.admin.address,roles.admin);
  if (!c.journal.steps['fund-admin'] && await c.client.getBalance({address:roles.admin}) < 100_000_000_000_000n)
    await c.send('fund-admin',{to:roles.admin,value:200_000_000_000_000n});
  async function launch(label,name,symbol) {
    const saved=c.journal.steps[label];
    const draft=saved ? decodeFunctionData({abi:a.factory.abi,data:saved.transaction.data}).args[0] : {
      name,symbol,logo:'https://singlespark.fun/assets/navigation/launch-still.png',description:'Robinhood Testnet gameplay verification. No real value.',
      socials:{twitter:'',telegram:'',discord:'',website:'https://singlespark.fun',farcaster:''},creatorFeeRecipient:zeroAddress,
      creatorTaxBps:200,buybackEnabled:false,expectedEconomics:await c.read(source,upstream.factory.abi,'previewLaunchEconomics',[0n,zeroAddress]),
      salt:keccak256(toHex(`SingleSpark:Robinhood:gameplay:20261011:${symbol}`)) };
    assert.equal(draft.name,name); assert.equal(draft.symbol,symbol);
    const receipt=await call(label,factory,a.factory.abi,'launch',[draft]);
    const events=parseEventLogs({abi:a.factory.abi,eventName:'ProjectLaunched',logs:receipt.logs}).filter(log=>log.address.toLowerCase()===factory.toLowerCase());
    assert.equal(events.length,1); const project=events[0].args;
    same(project.owner,c.account.address); same(await c.read(project.vault,a.vault.abi,'projectToken'),project.token);
    same((await c.read(source,upstream.factory.abi,'getLaunchedToken',[project.token])).creatorFeeRecipient,project.vault);
    c.report[label]={...project,blockNumber:String(receipt.blockNumber)}; c.save(); return project;
  }
  const platform=await launch('platform-token','SingleSpark','SPARK');
  const project=await launch('gameplay-project','SingleSpark Gameplay Test','SSPLAY');
  const operations=[];
  for (const [i,implementation] of [buyback,buyback,distribution].entries()) {
    const receipt=await call(`schedule-plugin-${i}`,factory,a.factory.abi,'schedulePlugin',[ids[i],implementation],0n,'admin');
    operations.push(parseEventLogs({abi:a.factory.abi,eventName:'Scheduled',logs:receipt.logs})[0].args);
  }
  const scheduled=await call('schedule-adapter',factory,a.factory.abi,'scheduleAdapter',[adapter],0n,'admin');
  operations.push(parseEventLogs({abi:a.factory.abi,eventName:'Scheduled',logs:scheduled.logs})[0].args);
  const now=(await c.client.getBlock()).timestamp;
  const latest=operations.reduce((m,o)=>o.readyAt>m?o.readyAt:m,0n);
  if(now<latest) {
    await assert.rejects(c.client.simulateContract({address:factory,abi:a.factory.abi,functionName:'executeAdapter',args:[adapter],account:c.account.address}));
    c.report.status='registry_timelock_pending'; c.report.readyAt=String(latest); c.save(); console.log(json({status:c.report.status,readyAt:String(latest),platformToken:platform.token,project:project.token})); process.exitCode=0;
  } else {
    for(const[i,implementation]of[buyback,buyback,distribution].entries())await call(`activate-plugin-${i}`,factory,a.factory.abi,'executePlugin',[ids[i],implementation]);
    await call('activate-adapter',factory,a.factory.abi,'executeAdapter',[adapter]);
    const policyFor = (p) => ids.map((id,i)=>({id,weight:1,targetAsset:i===1?platform.token:p.token,adapter,maxSpend:100_000_000_000n,
      route:encodeAbiParameters([{type:'tuple',components:[{name:'currency0',type:'address'},{name:'currency1',type:'address'},{name:'fee',type:'uint24'},{name:'tickSpacing',type:'int24'},{name:'hooks',type:'address'}]},{type:'uint160'}],
        [{currency0:zeroAddress,currency1:i===1?platform.token:p.token,fee:0,tickSpacing:200,hooks:foundation.report.addresses.hook},0n]),
      rules:i===2?encodeAbiParameters([{type:'uint256'},{type:'uint256'}],[10n**19n,100n]):'0x'}));
    const policies=policyFor(project),platformPolicies=policyFor(platform);
    c.report.policies=policies; c.report.platformPolicies=platformPolicies; c.save();
    const policySchedules=[];
    for(const[label,p,selected]of[['project',project,policies],['platform',platform,platformPolicies]]) {
      const receipt=await call(`schedule-policy-${label}`,factory,a.factory.abi,build.policyActivation==='timestamp'?'activatePlugins':'schedulePolicy',[p.vault,selected],0n,build.policyActivation==='timestamp'?'deployer':'admin');
      policySchedules.push(parseEventLogs({abi:a.factory.abi,eventName:'Scheduled',logs:receipt.logs})[0].args);
    }
    const ready=policySchedules.reduce((m,o)=>o.readyAt>m?o.readyAt:m,0n);
    if((await c.client.getBlock()).timestamp<ready) {
      await assert.rejects(c.client.simulateContract({address:factory,abi:a.factory.abi,functionName:'executePolicy',args:[project.vault,policies],account:c.account.address}));
      c.report.status='policy_timelock_pending';c.report.readyAt=String(ready);c.save();console.log(json({status:c.report.status,readyAt:String(ready)}));
    } else {
      if(build.policyActivation==='timestamp') {
        for(const p of [project,platform])for(const id of ids)
          assert.equal((await c.read(p.vault,a.vault.abi,'policy',[id])).weight,1,'Settings must be effective before any second transaction');
      }else{
        await call('activate-policy-project',factory,a.factory.abi,'executePolicy',[project.vault,policies]);
        await call('activate-policy-platform',factory,a.factory.abi,'executePolicy',[platform.vault,platformPolicies]);
      }
      const value=1_000_000_000_000n;
      const funded=await call('deposit-native',project.vault,a.vault.abi,'deposit',[value],value);
      const at = (functionName,args=[],blockNumber=funded.blockNumber)=>c.client.readContract({address:project.vault,abi:a.vault.abi,functionName,args,blockNumber});
      assert.equal(await at('platformBudget'),value/10n);assert.equal(await at('claimBudget'),value/200n);assert.equal(await at('unallocated'),0n);
      assert.equal(await at('budget',[ids[0]])+await at('budget',[ids[1]])+await at('budget',[ids[2]]),value*8950n/10000n);
      assert.equal(await c.client.readContract({address:platform.vault,abi:a.vault.abi,functionName:'received',blockNumber:funded.blockNumber}),0n);
      async function claim(label,id,amount,data='0x',reward) {
        const saved=c.journal.steps[label]; let args;
        if(saved) args=decodeFunctionData({abi:a.vault.abi,data:saved.transaction.data}).args;
        else {
          const block=await c.client.getBlock();
          let minimumOutput=0n;
          if(amount>0n) {
            const target=policies.find(p=>p.id===id).targetAsset;
            const launch=await c.read(source,upstream.factory.abi,'getLaunchedToken',[target]);
            if(await c.read(launch.curve,upstream.PonsV2BondingCurve.abi,'graduated')) {
              const route=policies.find(p=>p.id===id).route;
              const pool=keccak256(`0x${route.slice(2,322)}`);
              const slot=keccak256(encodeAbiParameters([{type:'bytes32'},{type:'uint256'}],[pool,6n]));
              const manager=await c.read(source,upstream.factory.abi,'poolManager');
              const state=await c.read(manager,parseAbi(['function extsload(bytes32 slot) view returns(bytes32)']),'extsload',[slot]);
              const sqrt=BigInt(state)&((1n<<160n)-1n);assert(sqrt>0n);
              minimumOutput=poolMinimum(amount,sqrt);
            } else {
              const [q,t]=await c.read(launch.curve,upstream.PonsV2BondingCurve.abi,'getReserves');
              const net=amount*9700n/10000n;minimumOutput=net*t/(q+net)*95n/100n;
              assert.equal(await c.read(launch.curve,upstream.PonsV2BondingCurve.abi,'currentSnipeTaxBps',[project.vault]),0n);
            }
            assert(minimumOutput>0n);
          }
          const available=await c.read(project.vault,a.vault.abi,'claimBudget')-await c.read(project.vault,a.vault.abi,'reservedClaim');
          reward ??= id===ids[2]?0n:amount*50n/8950n;
          reward=reward>available?available:reward;
          const request={caller:c.account.address,pluginId:id,amount,minimumOutput,reward,deadline:block.timestamp+300n,
            nonce:await c.read(project.vault,a.vault.abi,'nonce'),policyRevision:await c.read(project.vault,a.vault.abi,'revision'),
            registryRevision:await c.read(factory,a.factory.abi,'revision'),dataHash:keccak256(data)};
          const signature=await sign(request);args=[request,data,signature];
          await assert.rejects(c.client.simulateContract({address:project.vault,abi:a.vault.abi,functionName:'claim',args,account:roles.admin}));
          await assert.rejects(c.client.simulateContract({address:platform.vault,abi:a.vault.abi,functionName:'claim',args,account:c.account.address}));
          if(amount>0n) {
            const adverse={...request,minimumOutput:10n**40n};
            const signed=await sign(adverse);
            await assert.rejects(c.client.simulateContract({address:project.vault,abi:a.vault.abi,functionName:'claim',args:[adverse,data,signed],account:c.account.address}));
          }
          await c.client.simulateContract({address:project.vault,abi:a.vault.abi,functionName:'claim',args,account:c.account.address});
        }
        const receipt=await call(label,project.vault,a.vault.abi,'claim',args);
        const event=parseEventLogs({abi:a.vault.abi,eventName:'Executed',logs:receipt.logs.filter(l=>l.address.toLowerCase()===project.vault.toLowerCase())});
        assert.equal(event.length,1);assert.equal(event[0].args.reward,args[0].reward);
        await assert.rejects(c.client.simulateContract({address:project.vault,abi:a.vault.abi,functionName:'claim',args,account:c.account.address}));
        return receipt;
      }
      await claim('own-buyback',ids[0],100_000_000_000n);
      await claim('platform-buyback',ids[1],100_000_000_000n);
      await claim('distribution-acquire',ids[2],100_000_000_000n);
      const recipients=Array.from({length:100},(_,i)=>getAddress(toHex(0x100000+i,{size:20})));
      const payoutData=encodeAbiParameters([{type:'address[]'}],[recipients]);
      const inv=await c.read(project.vault,a.vault.abi,'inventory',[ids[2]]),heldReward=await c.read(project.vault,a.vault.abi,'inventoryReward',[ids[2]]);
      const payoutReward=c.journal.steps['distribution-payout']?0n:heldReward*(100n*10n**19n)/inv;
      if(!c.journal.steps['distribution-payout'])assert(inv>=100n*10n**19n);
      await claim('distribution-payout',ids[2],0n,payoutData,payoutReward);
      for(let start=0;start<recipients.length;start+=10)await Promise.all(recipients.slice(start,start+10).map(async (recipient,offset)=>{
        assert.equal(await c.read(project.vault,a.vault.abi,'paid',[recipient]),build.payoutPolicy!=='repeat');
        assert.equal(await c.read(project.token,erc20Abi,'balanceOf',[recipient]),(c.journal.steps['distribution-payout-repeat']&&start+offset<50?3n:1n)*10n**19n);
      }));
      if(build.payoutPolicy==='repeat') {
        const inventory=await c.read(project.vault,a.vault.abi,'inventory',[ids[2]]);
        const held=await c.read(project.vault,a.vault.abi,'inventoryReward',[ids[2]]);
        if(!c.journal.steps['distribution-payout-repeat']) assert(inventory>=100n*10n**19n,'Fund a full repeated payout before acceptance');
        const repeatedData=encodeAbiParameters([{type:'address[]'}],[recipients.slice(0,50).flatMap(recipient=>[recipient,recipient])]);
        await claim('distribution-payout-repeat',ids[2],0n,repeatedData,c.journal.steps['distribution-payout-repeat']?0n:held*(100n*10n**19n)/inventory);
        for(const [i,recipient] of recipients.entries()) assert.equal(await c.read(project.token,erc20Abi,'balanceOf',[recipient]),(i<50?3n:1n)*10n**19n);
      }
      const paidRequest={caller:c.account.address,pluginId:ids[2],amount:0n,minimumOutput:0n,reward:0n,deadline:(await c.client.getBlock()).timestamp+300n,
        nonce:await c.read(project.vault,a.vault.abi,'nonce'),policyRevision:await c.read(project.vault,a.vault.abi,'revision'),
        registryRevision:await c.read(factory,a.factory.abi,'revision'),dataHash:keccak256(payoutData)};
      if(build.payoutPolicy!=='repeat') {
        const paidSignature=await sign(paidRequest);
        await assert.rejects(c.client.simulateContract({address:project.vault,abi:a.vault.abi,functionName:'claim',args:[paidRequest,payoutData,paidSignature],account:c.account.address}));
      }
      assert(await c.read(project.token,erc20Abi,'balanceOf',['0x000000000000000000000000000000000000dEaD'])>0n);
      assert(await c.read(platform.token,erc20Abi,'balanceOf',['0x000000000000000000000000000000000000dEaD'])>0n);
      assert.equal(await c.client.getBalance({address:adapter}),0n);
      await call('collect-creator-revenue',project.vault,a.vault.abi,'collectRevenue');
      assert(await c.read(project.vault,a.vault.abi,'received')>value);
      const crossingBuy=BigInt(c.config.launchConfig.graduationThreshold)*2n;
      await call('graduate-project-buy',project.curve,upstream.PonsV2BondingCurve.abi,'buy',[crossingBuy,1n,c.account.address],crossingBuy);
      let launched=await c.read(source,upstream.factory.abi,'getLaunchedToken',[project.token]);
      if(launched.phase===0 || c.journal.steps['graduate-project'])await call('graduate-project',source,upstream.factory.abi,'graduate',[project.token]);
      launched=await c.read(source,upstream.factory.abi,'getLaunchedToken',[project.token]);
      if(launched.phase===1 || c.journal.steps['create-project-pool'])await call('create-project-pool',source,upstream.factory.abi,'createGraduatedPool',[project.token]);
      assert.equal((await c.read(source,upstream.factory.abi,'getLaunchedToken',[project.token])).phase,2);
      await claim('v4-own-buyback',ids[0],100_000_000_000n);
      const ordinaryReceived=await c.read(project.vault,a.vault.abi,'received');
      await call('collect-platform-revenue',platform.vault,a.vault.abi,'collectRevenue');
      assert(await c.read(platform.vault,a.vault.abi,'received')>0n);
      assert.equal(await c.read(project.vault,a.vault.abi,'received'),ordinaryReceived);
      for(const id of ids)assert(await c.read(platform.vault,a.vault.abi,'budget',[id])>0n);
      const finalized=await c.client.getBlock({blockTag:'finalized'});
      c.report.finalizedThroughBlock=String(finalized.number);
      c.report.finalityComplete=Object.values(c.report.transactions).every(tx=>BigInt(tx.blockNumber)<=finalized.number);
      c.report.status='gameplay_verified';c.report.verification={checks:['native ETH funding','10% / 0.5% / 89.5% weighted budgets','separate project and platform revenue / budgets','own-token buyback and burn','Robinhood SingleSpark platform-token buyback and burn','distribution inventory and 100 test-fixture payouts','Claim ETH rewards',build.payoutPolicy==='repeat'?'repeated recipients within and across batches':'fresh-nonce permanent payout deduplication','Claim nonce / caller / cross-Vault / slippage rejection','Pons graduation and native V4 buyback','10-minute on-chain registry and policy waits'],platformToken:platform.token,production:false};
      c.report.sourcePons={addresses:foundation.report.addresses,codeHashes:foundation.report.codeHashes};c.save();console.log(json({status:c.report.status,addresses:c.report.addresses,platformToken:platform.token,verification:c.report.verification}));
    }
  }
} finally { closeSync(lock);unlinkSync(lockPath); }
