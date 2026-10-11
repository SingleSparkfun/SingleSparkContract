// Public testnet state, loopback-only transactions and a separate durable journal.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, http, parseEther, toHex } from 'viem';
import { context, QUOTE } from './deploy.mjs';
import { deployClaim } from './deploy-claim.mjs';
import { verifyClaim } from './verify-claim.mjs';
const rpc='http://127.0.0.1:18653';
const anvil=spawn('anvil',['--host','127.0.0.1','--port','18653','--chain-id','5042002','--fork-url','https://rpc.testnet.arc.io','--fork-block-number','66440020','--compute-units-per-second','40','--silent'],{stdio:['ignore','ignore','pipe']});
let stderr='';anvil.stderr.on('data',chunk=>stderr+=chunk);
try {
  const client=createPublicClient({transport:http(rpc,{retryCount:0,timeout:2000}),cacheTime:0});
  let ready=false;
  for(let i=0;i<30;i++) {
    try {assert.equal(await client.getChainId(),5042002);ready=true;break;} catch {}
    assert(anvil.exitCode===null,stderr.slice(-1000));await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert(ready,'Local fork unavailable');
  const storageDir=mkdtempSync(join(tmpdir(),'argus-weighted-rehearsal-'));
  const c=await context({version:3,rpc,storageDir});
  for(const account of Object.values(c.accounts))await client.request({method:'anvil_setBalance',params:[account.address,toHex(parseEther('30'))]});
  // Anvil cannot execute ARC's native-USDC precompile. This fixture tests its ERC20 surface only.
  const quote=JSON.parse(readFileSync(new URL('../../../../../chains/arc/out/ArgusGovernance.t.sol/ArgusTestQuote.json',import.meta.url)));
  await client.request({method:'anvil_setCode',params:[QUOTE,quote.deployedBytecode.object]});
  const wallet=createWalletClient({account:c.accounts.deployer,chain:c.client.chain,transport:http(rpc)});
  const mint=await wallet.writeContract({address:QUOTE,abi:quote.abi,functionName:'mint',args:[c.accounts.deployer.address,30000000n]});
  assert.equal((await client.waitForTransactionReceipt({hash:mint})).status,'success');
  c.report.quotePrecompile='Explicit test ERC20 mock; native USDC/gas mirroring and ARC blocklist are not emulated';c.save();
  process.argv.push('--broadcast');
  await deployClaim(c);
  await verifyClaim(c);
  const fa=c.a.factory.abi,va=c.a.implementation.abi,factory=c.report.addresses.factory,vault=c.report.projects[1].vault;
  const relative=[3,1,1];
  const waiting=await c.read(vault,va,'unallocatedPluginBudget'),claimBalance=await c.read(vault,va,'claimBudget');
  await c.call('schedule-weights','admin',factory,fa,'schedulePluginWeights',[vault,3,relative]);
  const readyAt=await c.read(factory,fa,'readyAt');
  const early=()=>assert.rejects(()=>client.simulateContract({address:factory,abi:fa,functionName:'executePluginWeights',args:[vault,3,relative],account:c.accounts.deployer.address}),error=>Boolean(error.walk?.(e=>e.name==='ContractFunctionRevertedError'||e.name==='ExecutionRevertedError')));
  await early();
  await client.request({method:'evm_setNextBlockTimestamp',params:[Number(readyAt)-1]});await client.request({method:'evm_mine',params:[]});
  await early();
  await client.request({method:'evm_setNextBlockTimestamp',params:[Number(readyAt)]});await client.request({method:'evm_mine',params:[]});
  await c.call('execute-weights','deployer',factory,fa,'executePluginWeights',[vault,3,relative]);
  assert.equal(await c.read(vault,va,'unallocatedPluginBudget'),0n);
  assert.deepEqual((await c.read(vault,va,'ledger'))[0],[waiting*3n/4n,0n,waiting-waiting*3n/4n,0n,0n]);
  assert.equal(await c.read(vault,va,'claimBudget'),claimBalance);
  const before=await client.getTransactionCount({address:c.accounts.deployer.address});
  await deployClaim(c);await verifyClaim(c);
  assert.equal(await client.getTransactionCount({address:c.accounts.deployer.address}),before);
  assert.equal(c.report.publicTransactions,false);
  c.report.rehearsal={publicTransactions:false,oneSecondEarlyRejected:true,after600SecondsExecuted:true,allOffFundsAllocated:true,replayWithoutExtraTransactions:true};c.save();
  console.log(JSON.stringify({status:'passed',report:c.reportPath,rehearsal:c.report.rehearsal}));
} catch (error) { console.error(error.shortMessage ?? error.message); if (stderr) console.error(stderr.slice(-1200)); process.exitCode=1; }
finally {anvil.kill('SIGTERM');}
