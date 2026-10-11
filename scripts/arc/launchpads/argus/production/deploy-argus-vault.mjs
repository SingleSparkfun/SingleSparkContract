// Existing ARC/Argus router + new project vaults. No broadcast unless explicitly selected.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { createPublicClient, createWalletClient, defineChain, http, encodeDeployData, getContractAddress, keccak256, parseTransaction, recoverTransactionAddress, parseEther, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
const artifact = name => JSON.parse(readFileSync(new URL(`../../../../../chains/arc/out/${name}.sol/${name}.json`,import.meta.url)));
const stringify = value => JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v,2);
function persist(path,value) {
  const temp=`${path}.tmp`;writeFileSync(temp,stringify(value),{mode:0o600});
  const fd=openSync(temp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);
  const dir=openSync(resolve(path,'..'),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
}
export async function deployArgusVaults({client,wallet,router,routerCodeHash,admin,executor,budget,journalPath,broadcast=false}) {
  assert.equal(await client.getChainId(),5042);assert.equal(wallet.chain.id,5042);
  assert(admin!==zeroAddress&&executor!==zeroAddress&&admin.toLowerCase()!==executor.toLowerCase());
  assert(budget>0n&&budget<=parseEther('1'),'Explicit deployment budget capped at 1 USDC');
  assert.equal(keccak256(await client.getCode({address:router})),routerCodeHash,'Router code pin changed');
  const routerAbi=artifact('ArgusCustodyRouter').abi;
  assert.equal((await client.readContract({address:router,abi:routerAbi,functionName:'custody'})).toLowerCase(),executor.toLowerCase());
  assert.equal(await client.readContract({address:router,abi:routerAbi,functionName:'independentWallets'}),true,'Vaults require registered project execution');
  const implementationArtifact=artifact('ArgusRevenueVault'),factoryArtifact=artifact('ArgusVaultFactory');
  for(const a of [implementationArtifact,factoryArtifact])assert((a.deployedBytecode.object.length-2)/2<=24576,'EIP-170 size limit');
  const identity=stringify({chainId:5042,deployer:wallet.account.address,router,routerCodeHash,admin,executor,budget,
    implementationCode:keccak256(implementationArtifact.bytecode.object),factoryCode:keccak256(factoryArtifact.bytecode.object)});
  const journal=existsSync(journalPath)?JSON.parse(readFileSync(journalPath,'utf8')):{identity,nonce:await client.getTransactionCount({address:wallet.account.address,blockTag:'pending'}),steps:{}};
  assert.equal(journal.identity,identity,'Keep the original deployment configuration and journal');
  const implementation=getContractAddress({from:wallet.account.address,nonce:BigInt(journal.nonce)});
  const factory=getContractAddress({from:wallet.account.address,nonce:BigInt(journal.nonce+1)});
  const deployments=[['implementation',implementationArtifact,[],implementation],['factory',factoryArtifact,[router,admin,executor,implementation],factory]];
  if(!broadcast)return {status:'reviewable_plan',chainId:5042,router,admin,executor,delaySeconds:172800,implementation,factory,budget:String(budget),publicTransactions:false};
  mkdirSync(resolve(journalPath,'..'),{recursive:true,mode:0o700});
  const lockPath=`${journalPath}.lock`,lock=openSync(lockPath,'wx',0o600);
  try {
    persist(journalPath,journal);
    for(const [i,[name,a,args,address]] of deployments.entries()) {
      const data=encodeDeployData({abi:a.abi,bytecode:a.bytecode.object,args});
      let step=journal.steps[name];
      if(!step) {
        const nonce=journal.nonce+i;
        assert.equal(await client.getTransactionCount({address:wallet.account.address,blockTag:'pending'}),nonce,'Deployer nonce changed');
        const request=await wallet.prepareTransactionRequest({data,nonce,value:0n});
        const maximum=request.gas*(request.maxFeePerGas??request.gasPrice);
        const committed=Object.values(journal.steps).reduce((n,s)=>n+BigInt(s.maximum),0n);
        assert(committed+maximum<=budget,'Deployment gas budget exceeded');
        const raw=await wallet.signTransaction(request);
        step={raw,hash:keccak256(raw),maximum:String(maximum)};journal.steps[name]=step;persist(journalPath,journal);
      }
      const decoded=parseTransaction(step.raw);
      assert.equal(decoded.chainId,5042);assert.equal(decoded.to,undefined);assert.equal(decoded.data,data);assert.equal(decoded.value??0n,0n);
      assert.equal(decoded.nonce,journal.nonce+i);assert.equal(keccak256(step.raw),step.hash);
      assert.equal((await recoverTransactionAddress({serializedTransaction:step.raw})).toLowerCase(),wallet.account.address.toLowerCase());
      let receipt=await client.getTransactionReceipt({hash:step.hash}).catch(e=>{if(e.name!=='TransactionReceiptNotFoundError')throw e;});
      if(!receipt) {
        await client.sendRawTransaction({serializedTransaction:step.raw}).catch(e=>{if(!/already known|nonce too low/i.test(e.message))throw e;});
        receipt=await client.waitForTransactionReceipt({hash:step.hash});
      }
      assert.equal(receipt.status,'success');assert.equal(receipt.contractAddress.toLowerCase(),address.toLowerCase());
      for(let n=0;(await client.getBlock({blockTag:'finalized'})).number<receipt.blockNumber;n++) {assert(n<60,'Finality pending; resume the same journal');await new Promise(r=>setTimeout(r,1000));}
      assert.equal((await client.getBlock({blockNumber:receipt.blockNumber})).hash,receipt.blockHash);
      step.receipt=receipt;persist(journalPath,journal);
    }
    return {status:'deployed',chainId:5042,router,admin,executor,delaySeconds:172800,
      ARC_ARGUS_VAULT_FACTORY:factory,ARC_ARGUS_VAULT_FACTORY_CODE_HASH:keccak256(await client.getCode({address:factory})),
      ARC_ARGUS_VAULT_IMPLEMENTATION_CODE_HASH:keccak256(await client.getCode({address:implementation}))};
  } finally {closeSync(lock);unlinkSync(lockPath);}
}
async function main() {
  const at=process.argv.indexOf('--env');assert(at>=0,'Pass --env <owner-only config>');
  const path=resolve(process.argv[at+1]);assert.equal(statSync(path).mode&0o077,0,'Config must be owner-only');
  const env=parseEnv(readFileSync(path,'utf8'));assert.equal(env.ARC_CHAIN_ID,'5042');
  const chain=defineChain({id:5042,name:'Arc',nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18},rpcUrls:{default:{http:[env.ARC_RPC_URL]}}});
  const client=createPublicClient({chain,transport:http(env.ARC_RPC_URL)});
  const wallet=createWalletClient({chain,account:privateKeyToAccount(env.ARC_DEPLOYER_PRIVATE_KEY),transport:http(env.ARC_RPC_URL,{retryCount:0})});
  console.log(stringify(await deployArgusVaults({client,wallet,router:env.ARC_ARGUS_ROUTER_ADDRESS,routerCodeHash:env.ARC_ARGUS_ROUTER_CODE_HASH,
    admin:env.ARC_ARGUS_VAULT_ADMIN,executor:env.ARC_ARGUS_CUSTODY_ADDRESS,budget:parseEther(env.ARC_DEPLOY_GAS_BUDGET_USDC),
    journalPath:resolve(env.ARC_DATA_DIR,'vault-deployment.json'),broadcast:process.argv.includes('--broadcast')})));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.shortMessage??e.message);process.exitCode=1;});
