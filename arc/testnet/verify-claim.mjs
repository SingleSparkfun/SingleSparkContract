// Bounded public-testnet acceptance. Test donations are labelled separately from creator revenue.
import assert from 'node:assert/strict';
import { openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, erc20Abi, getAddress, keccak256, parseEther, parseEventLogs, toHex } from 'viem';
import { context, launchArgs, QUOTE } from './deploy.mjs';
import { json } from './build.mjs';

export async function verifyClaim(c) {
assert(process.argv.includes('--broadcast'), 'Select --broadcast for public-testnet acceptance');
assert(['deployed_pending_acceptance','acceptance_in_progress','passed'].includes(c.report.status));
const lockPath=resolve(c.storageDir,'run.lock'),lock=openSync(lockPath,'wx',0o600);
const {client,read,call,a,accounts}=c, {factory,router,platformToken}=c.report.addresses;
const va=a.implementation.abi,fa=a.factory.abi,ra=a.router.abi;
const weights=[2984,2983,2983,0,1000,50];
const same=(a,b)=>assert.equal(a.toLowerCase(),b.toLowerCase());
const event=(receipt,name)=>parseEventLogs({abi:va,eventName:name,logs:receipt.logs}).find(e=>e.address.toLowerCase()===c.report.projects[0].vault.toLowerCase());
const deny=async(address,abi,functionName,args,role='deployer')=>assert.rejects(
  ()=>client.simulateContract({address,abi,functionName,args,account:accounts[role].address}),
  error=>Boolean(error.walk?.(e=>e.name==='ContractFunctionRevertedError'||e.name==='ExecutionRevertedError')));
try {
  if(c.report.status==='passed') { console.log(json({status:'already_verified',report:c.reportPath})); }
  else {
    c.report.status='acceptance_in_progress';c.save();
    const projects=[];
    for(const [label,plugins] of [['TCLAIM1',7],['TCLAIM0',0]]) {
      const salt=keccak256(toHex(`SingleSpark/ARC-Testnet/${label}`));
      const vault=await read(factory,fa,'predictVault',[accounts.deployer.address,salt]);
      const receipt=await call(`launch-${label}`,'deployer',factory,fa,'launch',[...await launchArgs(c,vault,label),plugins,'']);
      const launched=parseEventLogs({abi:fa,eventName:'VaultLaunched',logs:receipt.logs}).find(e=>e.address.toLowerCase()===factory.toLowerCase());
      same(launched.args.vault,vault);
      const token=launched.args.token;
      const record=await read(c.build.portal,a.portal.abi,'launches',[token]);
      same(record[0],vault);same(await read(record[5],a.splitterImpl.abi,'creator'),vault);
      assert.deepEqual(await read(vault,va,'revenuePolicy'),weights);
      assert.equal(await read(vault,va,'claimVersion'),1n);
      assert.deepEqual((await read(vault,va,'weightedPolicy')).slice(0,4),[true,[1,1,1],1000,50]);
      projects.push({label,token,vault,plugins,splitter:record[5],locker:record[3]});
    }
    c.report.projects=projects;c.save();
    const {token,vault}=projects[0];
    // The remaining exact allowance supports read-only router quote simulations; clear it after the checks.
    await call('trade-approve','deployer',QUOTE,erc20Abi,'approve',[router,3000000n]);
    await call('trade-buy','deployer',router,ra,'trade',async()=>{
      const deadline=(await client.getBlock()).timestamp+110n;
      const quote=await client.simulateContract({address:router,abi:ra,functionName:'trade',args:[token,true,parseEther('0.5'),1n,deadline],account:accounts.deployer.address});
      return [token,true,parseEther('0.5'),quote.result*97n/100n,deadline];
    });
    const collect=await call('collect-fees','deployer',vault,va,'collect',[]);
    const organic=await read(vault,va,'received',[],collect.blockNumber);
    assert(organic>0n,'Real trade creator fees entered the vault');
    const platformFee=organic*1000n/10000n,claimFee=organic*50n/10000n,net=organic-platformFee-claimFee;
    const expected=[net/3n,net/3n,net-2n*(net/3n),0n,platformFee,claimFee];
    assert.deepEqual((await read(vault,va,'ledger',[],collect.blockNumber))[0],expected.slice(0,5));
    assert.equal(await read(vault,va,'claimBudget',[],collect.blockNumber),expected[5]);
    await call('labelled-test-donation','deployer',QUOTE,erc20Abi,'transfer',[vault,6250000n]);
    const sync=await call('account-donation','deployer',vault,va,'sync',[]);
    assert.equal(await read(projects[1].vault,va,'received',[],sync.blockNumber),0n,'Separate project funds');
    c.report.organicFeeUSDC6=String(organic);c.report.labelledTestDonationUSDC6='6250000';c.save();
    const emptyHash=keccak256(encodeAbiParameters([{type:'address[]'}],[[]]));
    async function claim(label,bucket,recipients=[]) {
      return call(label,'deployer',vault,va,'claim',async()=>{
        const target=bucket===1?platformToken:token;
        let amount=0n,minimum=0n,reward=0n;
        if(bucket!==5) {
          amount=await read(vault,va,'budgets',[BigInt(bucket)]);
          const state=await read(router,ra,'keeperSwapState',[target]);
          amount=amount<state[1]?amount:state[1];
          assert(amount>0n,'Funded executable work');
          const quote=await client.simulateContract({address:router,abi:ra,functionName:'trade',args:[target,true,amount*10n**12n,1n,(await client.getBlock()).timestamp+110n],account:accounts.deployer.address});
          minimum=quote.result*97n/100n;
          if(bucket!==2)reward=await read(vault,va,'claimRewardLimit',[amount]);
        } else {
          const state=await read(vault,va,'claimState'),inventory=await read(vault,va,'rewardTokens');
          assert(inventory>=1000n*10n**18n);reward=state[2]*1000n*10n**18n/inventory;
        }
        const request={caller:accounts.deployer.address,bucket,target,amount,minimum,
          deadline:(await client.getBlock()).timestamp+30n,nonce:await read(vault,va,'nonce'),
          revision:await read(factory,fa,'revision'),implementation:c.report.addresses.implementation,reward,
          recipientsHash:recipients.length?keccak256(encodeAbiParameters([{type:'address[]'}],[recipients])):emptyHash};
        const digest=await read(vault,va,'claimDigest',[request]);
        const signature=await accounts.executor.sign({hash:digest});
        return [request,recipients,signature];
      });
    }
    const own=await claim('claim-own',0);
    assert(event(own,'Claimed').args.reward>0n,'Caller received a bounded execution reward');
    assert(event(own,'Executed').args.output>0n);
    assert.equal(event(own,'PluginExecuted').args.kind,0);
    const dead='0x000000000000000000000000000000000000dEaD';
    assert.equal(await read(token,erc20Abi,'balanceOf',[dead],own.blockNumber)-await read(token,erc20Abi,'balanceOf',[dead],own.blockNumber-1n),event(own,'Executed').args.output);
    const platform=await claim('claim-platform',1);
    assert(event(platform,'Claimed').args.reward>0n);
    assert.equal(event(platform,'PluginExecuted').args.kind,1);
    assert.equal(await read(platformToken,erc20Abi,'balanceOf',[dead],platform.blockNumber)-await read(platformToken,erc20Abi,'balanceOf',[dead],platform.blockNumber-1n),event(platform,'Executed').args.output);
    const inventory=await claim('claim-inventory',2);
    assert.equal(event(inventory,'Claimed').args.reward,0n,'Reward is reserved until distribution');
    assert.equal(event(inventory,'PluginExecuted').args.kind,2);
    await call('trade-approval-clear','deployer',QUOTE,erc20Abi,'approve',[router,0n]);
    const recipients=Array.from({length:100},(_,i)=>getAddress(`0x${keccak256(toHex(`SingleSpark/claim-test/${i}`)).slice(-40)}`)).sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
    const payout=await claim('claim-payout',5,recipients);
    assert(event(payout,'Claimed').args.reward>0n);
    assert.equal(await read(vault,va,'totalPaid',[],payout.blockNumber),100n);
    for(const recipient of [recipients[0],recipients[99]])assert.equal(await read(token,erc20Abi,'balanceOf',[recipient],payout.blockNumber),10n**19n);
    const ownTx=c.journal.steps['claim-own'].transaction;
    await assert.rejects(()=>client.call({account:accounts.deployer.address,to:vault,data:ownTx.data}),
      error=>Boolean(error.walk?.(e=>e.name==='ExecutionRevertedError')));
    await deny(vault,va,'buy',[0,1n,1n,(await client.getBlock()).timestamp+29n,await read(vault,va,'nonce')]);
    await deny(vault,va,'settle',[false,1n]);
    await call('settle-operations','deployer',vault,va,'settle',async()=>[true,await read(vault,va,'budgets',[4n])]);
    assert.equal(await read(vault,va,'accounted'),await read(QUOTE,erc20Abi,'balanceOf',[vault]));
    assert.equal(await read(QUOTE,erc20Abi,'allowance',[vault,router]),0n);
    assert.equal(await read(factory,fa,'DELAY'),600n);
    const disabled=projects[1].vault;
    await call('all-off-test-donation','deployer',QUOTE,erc20Abi,'transfer',[disabled,50000n]);
    await call('all-off-trade-approve','deployer',QUOTE,erc20Abi,'approve',[router,100000n]);
    await call('all-off-trade','deployer',router,ra,'trade',async()=>{
      const deadline=(await client.getBlock()).timestamp+110n;
      const quote=await client.simulateContract({address:router,abi:ra,functionName:'trade',args:[projects[1].token,true,parseEther('0.1'),1n,deadline],account:accounts.deployer.address});
      return [projects[1].token,true,parseEther('0.1'),quote.result*97n/100n,deadline];
    });
    await call('all-off-trade-clear','deployer',QUOTE,erc20Abi,'approve',[router,0n]);
    await call('all-off-collect','deployer',disabled,va,'collect',[]);
    const allOffIncome=await read(disabled,va,'received'),allOffPlatform=allOffIncome/10n,allOffClaim=allOffIncome*50n/10000n;
    assert(allOffIncome>50000n,'All-disabled project still collects organic creator fees');
    assert.equal(await read(disabled,va,'unallocatedPluginBudget'),allOffIncome-allOffPlatform-allOffClaim);
    assert.equal(await read(disabled,va,'claimBudget'),allOffClaim);
    assert.deepEqual((await read(disabled,va,'ledger'))[0],[0n,0n,0n,0n,allOffPlatform]);
    await call('all-off-platform-settlement','deployer',disabled,va,'settle',[true,allOffPlatform]);
    c.report.status='passed';
    c.report.acceptance={weightedAllocation:true,relativeWeights:[1,1,1],fixedFeeBps:1000,claimFeeBps:50,externalPluginContracts:true,realTradeAndCreatorFees:true,independentVaults:true,
      userFundedClaim:true,ownAndPlatformBurn:true,inventoryRewardDeferred:true,distributionRecipients:100,
      syntheticRecipients:true,replayRejected:true,executorOnlyBuyPreserved:true,operationsFixedRecipient:true,
      allOffRetainsUnallocated:true,allOffFixedFeesSettle:true,allowanceCleared:true,policyDelaySeconds:600,applicationRolloutVerified:false};
    c.save();console.log(json({status:'passed',report:c.reportPath,projects,acceptance:c.report.acceptance}));
  }
} finally {closeSync(lock);unlinkSync(lockPath);}

}
if (process.argv[1] === fileURLToPath(import.meta.url)) await verifyClaim(await context({version:3}));
