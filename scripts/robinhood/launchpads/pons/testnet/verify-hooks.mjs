import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, defineChain, http, keccak256, toHex } from 'viem';
import { root, readJson, json } from './build.mjs';
import { gameplayPaths } from './build-gameplay.mjs';
import { maskImmutables } from './deploy.mjs';
import { requireTestnet, persist } from './transactions.mjs';

export async function verifyHooks(deploymentId) {
  const config = readJson(resolve(root, 'chains/robinhood/deployments/testnet/pons/config.json'));
  const build = readJson(gameplayPaths(deploymentId).output);
  const pins = readJson(resolve(root, '../SingleSparkBackend/api/src/chains/robinhood/launchpads/pons/deployment.json'));
  const frontendPins = readJson(resolve(root, '../SingleSparkFront/front/chains/robinhood/launchpads/pons/deployment.json'));
  assert.deepEqual(frontendPins, pins, 'Frontend/backend Pons bindings differ');
  assert.equal(build.chainId, 46630); assert.equal(build.policyDelaySeconds, 600);
  assert.equal(pins.payoutPolicy, 'repeat');
  const chain = defineChain({ id:46630, name:'Robinhood Testnet', nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18}, rpcUrls:{default:{http:[config.rpc]}} });
  const client = createPublicClient({chain, transport:http(config.rpc,{batch:true,retryCount:1,timeout:30000})});
  requireTestnet(config, await client.getChainId());
  const block = await client.getBlock();
  const finalized = await client.getBlock({blockTag:'finalized'});
  assert(BigInt(pins.deploymentBlock) <= finalized.number, 'Factory deployment is not finalized');
  const ownActivation = resolve(root, `chains/robinhood/deployments/testnet/pons/gameplay-${deploymentId}.json`);
  const isNewDeployment = existsSync(ownActivation);
  const activation = readJson(isNewDeployment ? ownActivation : resolve(root, 'chains/robinhood/deployments/testnet/pons/gameplay-revenue-claim-fix-20261014.json'));
  assert.equal(activation.status, 'revenue_registry_verified');
  assert.equal(activation.addresses.vaultFactory.toLowerCase(), pins.vaultFactory);
  for (const transaction of Object.values(activation.transactions)) {
    const number = BigInt(transaction.blockNumber);
    assert(number <= finalized.number, 'Registry activation is not finalized');
    assert.equal((await client.getBlock({blockNumber:number})).hash, transaction.blockHash, 'Deployment or registry activation was reorganized');
    const receipt = await client.getTransactionReceipt({hash:transaction.hash});
    assert.equal(receipt.status, 'success');assert.equal(receipt.blockHash, transaction.blockHash);
  }
  const codeAt = address => client.getCode({address,blockNumber:block.number});
  for (const pin of Object.values(pins.contracts))
    assert.equal(keccak256(await codeAt(pin.address)),pin.codeHash,'Reviewed current/historical executable changed');
  const names={factory:[build.policyActivation === 'timestamp' ? 'PonsDelayedVaultFactory' : 'PonsVaultFactory',pins.vaultFactory],vault:[build.policyActivation === 'timestamp' ? 'PonsDelayedVault' : 'PonsHookVault',pins.vaultImplementation],
    adapter:['PonsSwapAdapter',pins.swapAdapter],buyback:['BuybackHook',pins.buybackPlugin],distribution:['DistributionHook',pins.distributionPlugin]};
  const contracts={};
  for(const [key,[name,address]] of Object.entries(names)) {
    const artifact=build.artifacts[key];const code=await codeAt(address);
    assert.equal(maskImmutables(code,artifact.runtime.immutableReferences),maskImmutables(artifact.runtime.object,artifact.runtime.immutableReferences),`${name}: runtime differs from Hook build`);
    contracts[name]={address,codeHash:keccak256(code),runtimeVerified:true};
  }
  const read=(address,abi,functionName,args=[])=>client.readContract({address,abi,functionName,args,blockNumber:block.number});
  const roles=readJson(resolve(root,`chains/robinhood/deployments/testnet/pons/${deploymentId}-roles.json`));
  for(const field of ['admin','authorizer','treasury']) assert.equal((await read(pins.vaultFactory,build.artifacts.factory.abi,field)).toLowerCase(),roles[field].toLowerCase());
  assert.equal(await read(pins.vaultFactory,build.artifacts.factory.abi,'DELAY'),600n);
  if (build.policyActivation === 'timestamp') {
    assert.equal(pins.policyActivation,'timestamp');
    assert.equal(await read(pins.vaultFactory,build.artifacts.factory.abi,'automaticPolicyActivation'),true);
  }
  assert.equal((await read(pins.vaultFactory,build.artifacts.factory.abi,'implementation')).toLowerCase(),pins.vaultImplementation);
  assert.equal(await read(pins.vaultImplementation,build.artifacts.vault.abi,'permanentPayoutDeduplication'),false);
  for(const [id,address] of [['buyback-burn@1',pins.buybackPlugin],['platform-buyback@1',pins.buybackPlugin],['distribution@1',pins.distributionPlugin]])
    assert.equal((await read(pins.vaultFactory,build.artifacts.factory.abi,'plugin',[keccak256(toHex(id))])).toLowerCase(),address);
  await read(pins.vaultFactory,build.artifacts.factory.abi,'checkAdapter',[pins.swapAdapter]);
  await read(pins.vaultFactory,build.artifacts.factory.abi,'checkPons');
  const report={status:isNewDeployment?'hooks_verified_new_testnet_deployment':'hooks_verified_existing_testnet_deployment',chainId:46630,contracts,productionSourcesSha256:build.productionSourcesSha256,
    stateBlock:String(block.number),finalizedThroughBlock:String(finalized.number),factoryDeploymentFinalized:true,finalityComplete:true,policyDelaySeconds:600,
    platformToken:pins.platformToken,legacyFactories:pins.legacyFactories,reusedDeployment:!isNewDeployment,transactionsBroadcast:isNewDeployment?Object.keys(activation.transactions).length:0,verifiedAt:new Date().toISOString()};
  persist(resolve(root,`chains/robinhood/deployments/testnet/pons/${deploymentId}.json`),report);
  return report;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const at=process.argv.indexOf('--deployment-id');assert(at>=0&&process.argv[at+1],'Pass --deployment-id');
  console.log(json(await verifyHooks(process.argv[at+1])));
}
