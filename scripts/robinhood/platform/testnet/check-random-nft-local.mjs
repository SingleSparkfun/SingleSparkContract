import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const pin = JSON.parse(readFileSync(resolve(root, 'chains/robinhood/randomness/openvrf.json')));
const upstream = resolve(root, 'chains/robinhood/data/openvrf', pin.revision);
const read = path => JSON.parse(readFileSync(path));
const routerArtifact = read(resolve(upstream, 'out/OpenVRF.sol/OpenVRF.json'));
const artifact = name => read(resolve(root, `chains/robinhood/out/platform/${name}.sol/${name}.json`));
const factoryArtifact = artifact('PlatformRandomNftFactory'), nftArtifact = artifact('PlatformRandomNft');
const vaultArtifact = artifact('PlatformRandomNftRevenueVault');
const fixture = read(resolve(upstream, 'examples/evmnet-round-1000.json'));
const work = mkdtempSync(resolve(tmpdir(), 'singlespark-random-nft-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const socket = createTcpServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const roundTime = 1727521075 + 999 * 3;
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '46630', '--timestamp', String(roundTime - 48 * 3600 - 100), '--silent'], {stdio:'ignore'});
let childError; anvil.on('error', error => { childError = error; });
const postgres = `singlespark-random-nft-${process.pid}`;
let postgresStarted = false, worker, workerOutput = '', workerError;
const beacon = createServer((req, res) => {
  if (!req.url.endsWith('/public/1000')) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({round:1000, signature:fixture.signature.replace(/^0x/, '')}));
});
const keys = Array.from({length:4}, () => generatePrivateKey());
const accounts = keys.map(key => privateKeyToAccount(key));
const [admin, relayer, user, buyer] = accounts;
const rpc = `http://127.0.0.1:${port}`;
const chain = defineChain({id:46630,name:'Isolated Robinhood NFT rehearsal',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpc]}}});
const client = createPublicClient({chain,transport:http(rpc,{retryCount:0}),pollingInterval:100,cacheTime:0});
const wallets = accounts.map(account => createWalletClient({chain,account,transport:http(rpc,{retryCount:0})}));
const send = async (abi, address, functionName, args=[], wallet=wallets[0], value=0n) => {
  const hash = await wallet.writeContract({address,abi,functionName,args,value});
  const receipt = await client.waitForTransactionReceipt({hash}); assert.equal(receipt.status,'success'); return receipt;
};
const call = (abi,address,functionName,args=[]) => client.readContract({address,abi,functionName,args});
const deploy = async (entry,args) => {
  const hash = await wallets[0].deployContract({abi:entry.abi,bytecode:entry.bytecode.object,args});
  const receipt = await client.waitForTransactionReceipt({hash}); assert.equal(receipt.status,'success'); return receipt;
};
async function stopWorker() {
  if (!worker || worker.exitCode !== null) return;
  const ended = once(worker,'exit'); worker.kill('SIGTERM');
  const timer = setTimeout(() => worker.kill('SIGKILL'),10_000);
  try { await ended; } finally { clearTimeout(timer); }
}
try {
  for (let attempt=0; ; attempt++) {
    if (childError) throw childError;
    try { assert.equal(await client.getChainId(),46630); break; }
    catch(error) { if(attempt>=40)throw error; await sleep(100); }
  }
  for (const account of accounts) await client.request({method:'anvil_setBalance',params:[account.address,toHex(10n**19n)]});
  execFileSync('docker',['run','--rm','-d','--name',postgres,'-e','POSTGRES_PASSWORD=test-only','-e','POSTGRES_USER=openvrf','-e','POSTGRES_DB=openvrf',
    '-p','127.0.0.1::5432','postgres:16.3-bookworm@sha256:d0f363f8366fbc3f52d172c6e76bc27151c3d643b870e1062b4e8bfe65baf609'],{stdio:'pipe'});
  postgresStarted = true;
  for (let attempt=0; ; attempt++) {
    try { execFileSync('docker',['exec',postgres,'pg_isready','-h','127.0.0.1','-U','openvrf','-d','openvrf'],{stdio:'pipe'}); break; }
    catch(error) { if(attempt>=40)throw error; await sleep(250); }
  }
  const databasePort = execFileSync('docker',['port',postgres,'5432/tcp'],{encoding:'utf8'}).trim().split(':').at(-1);
  beacon.listen(0,'127.0.0.1'); await once(beacon,'listening');
  const routerDeployment = await deploy(routerArtifact,[admin.address,relayer.address,7n]);
  const router = routerDeployment.contractAddress;
  const odds = [4000,2500,1500,1000,600,300,99,1], weights=[100,200,300,400,500,600,700,800];
  const deployed = await deploy(factoryArtifact,[admin.address,router,odds,weights,Array(8).fill('ipfs://local-test-only-artwork')]);
  const factory = deployed.contractAddress;
  const nft = await call(factoryArtifact.abi,factory,'nft'), vault=await call(factoryArtifact.abi,factory,'vault');
  const authorized = await send(routerArtifact.abi,router,'setConsumerAuthorization',[factory,true]);
  await send(factoryArtifact.abi,factory,'scheduleResume');
  const nonce = toHex(1n,{size:32});
  await client.request({method:'anvil_mine',params:['0x40','0x1']});
  const addresses = {router,factory,nft,vault}, codeHashes={};
  for (const [name,address] of Object.entries(addresses)) codeHashes[name]=keccak256(await client.getCode({address}));
  const report = {chainId:46630,environment:'testnet',status:'verified',openVrfRevision:pin.revision,owner:admin.address,
    relayerAddress:relayer.address,authorizationBlock:String(authorized.blockNumber),routerDeploymentBlock:String(routerDeployment.blockNumber),addresses,codeHashes};
  const reportPath=resolve(work,'deployment.json'),keyPath=resolve(work,'relayer-key');
  // Fresh test-only keys live only in this private temporary directory.
  writeFileSync(reportPath,JSON.stringify(report),{mode:0o600}); writeFileSync(keyPath,keys[1],{mode:0o600});
  const env = {...process.env,RPC_URL:rpc,WS_URL:'',NFT_RANDOM_DEPLOYMENT_FILE:reportPath,RELAYER_KEY_FILE:keyPath,
    DATABASE_URL:`postgresql://openvrf:test-only@127.0.0.1:${databasePort}/openvrf`,
    DRAND_URLS:`http://127.0.0.1:${beacon.address().port}`,RECONCILE_SECONDS:'1',RECEIPT_CONFIRMATIONS:'1',RECEIPT_TIMEOUT_SECONDS:'10',
    MAX_REQUEST_SPEND_ETH:'0.01',MAX_TOTAL_SPEND_ETH:'0.1',MAX_GAS_PRICE_GWEI:'10',RECONCILE_HEAD_LAG_BLOCKS:'0'};
  const startWorker = () => {
    worker=spawn(process.execPath,[resolve(root,'chains/robinhood/randomness/relayer.mjs')],{env,stdio:['ignore','pipe','pipe']});
    worker.on('error',error=>{workerError=error;});
    for(const stream of [worker.stdout,worker.stderr])stream.on('data',data=>{workerOutput+=data;});
  };
  await client.request({method:'evm_setNextBlockTimestamp',params:[roundTime-4]}); await send(factoryArtifact.abi,factory,'resume');
  const granted = await send(factoryArtifact.abi,factory,'scheduleBoxClaim',[user.address,nonce,1]);
  const claim = await call(factoryArtifact.abi,factory,'claims',[await call(factoryArtifact.abi,factory,'claimOperation',[user.address,nonce])]);
  assert.equal(claim[1], (await client.getBlock({blockNumber:granted.blockNumber})).timestamp);
  await client.request({method:'evm_setNextBlockTimestamp',params:[roundTime-2]});
  await client.request({method:'evm_setAutomine',params:[false]});
  const silverHash=await wallets[2].writeContract({address:factory,abi:factoryArtifact.abi,functionName:'requestClaim',args:[nonce,7n],value:7n});
  const price=await call(factoryArtifact.abi,factory,'BOX_PRICE');
  const goldHash=await wallets[3].writeContract({address:factory,abi:factoryArtifact.abi,functionName:'purchaseBox',args:[nonce,7n],value:price+7n});
  await client.request({method:'evm_mine',params:[]});await client.request({method:'evm_setAutomine',params:[true]});
  for(const hash of [silverHash,goldHash])assert.equal((await client.waitForTransactionReceipt({hash})).status,'success');
  const requested = await call(routerArtifact.abi,router,'requests',[1n]); assert.equal(requested[1],1000n);
  assert.equal((await call(routerArtifact.abi,router,'requests',[2n]))[1],1000n);
  await client.request({method:'evm_setNextBlockTimestamp',params:[roundTime]}); await client.request({method:'evm_mine',params:[]});
  const startingBalance=await client.getBalance({address:relayer.address}); startWorker();
  for(let attempt=0;;attempt++) {
    if(workerError)throw workerError;
    if(worker.exitCode!==null)throw Error(`Relayer exited: ${workerOutput}`);
    const result=await call(factoryArtifact.abi,factory,'results',[1n]);
    const gold=await call(factoryArtifact.abi,factory,'results',[2n]);
    if(result[3]&&gold[3])break;
    if(attempt>=150)throw Error(`Relayer callback timed out: ${workerOutput}`);
    await client.request({method:'evm_mine',params:[]}); await sleep(200);
  }
  const fulfilled=await call(routerArtifact.abi,router,'requests',[1n]); assert(fulfilled[3]&&fulfilled[4]);
  const expectedGrade=await call(factoryArtifact.abi,factory,'gradeForBoxWord',[fulfilled[5],1]);
  assert(expectedGrade>=1 && expectedGrade<=4,'Silver key escaped its grade pool');
  assert.equal(await client.getTransactionCount({address:user.address}),1,'Opening required another user transaction');
  assert.equal(await client.getTransactionCount({address:buyer.address}),1,'Buying and opening required another user transaction');
  const userToken=await call(nftArtifact.abi,nft,'tokenOfOwnerByIndex',[user.address,0n]);
  const buyerToken=await call(nftArtifact.abi,nft,'tokenOfOwnerByIndex',[buyer.address,0n]);
  const goldGrade=await call(nftArtifact.abi,nft,'qualityOf',[buyerToken]);assert(goldGrade>=5&&goldGrade<=8);
  assert.equal(await call(nftArtifact.abi,nft,'qualityOf',[userToken]),expectedGrade);
  const sales=await call(factoryArtifact.abi,factory,'salesVault');assert.equal(await client.getBalance({address:sales}),price);
  assert.equal(await client.getBalance({address:vault}),0n,'Sales leaked into staking rewards');
  assert.equal(await call(factoryArtifact.abi,factory,'reservedSupply'),0n);
  assert((await client.getBalance({address:relayer.address}))<startingBalance);
  await stopWorker();
  const beforeRestart=await client.getTransactionCount({address:relayer.address});
  startWorker(); await sleep(2000); assert.equal(worker.exitCode,null,workerOutput); await stopWorker();
  assert.equal(await client.getTransactionCount({address:relayer.address}),beforeRestart,'Restart submitted an extra transaction');
  assert.equal(await call(nftArtifact.abi,nft,'mintedSupply'),2n);
  await send(nftArtifact.abi,nft,'approve',[vault,userToken],wallets[2]);
  await send(vaultArtifact.abi,vault,'stake',[[userToken]],wallets[2]);
  const income=10n**15n;
  const funding=await wallets[0].sendTransaction({to:factory,value:income});
  assert.equal((await client.waitForTransactionReceipt({hash:funding})).status,'success');
  const epoch=await call(vaultArtifact.abi,vault,'currentEpoch');
  const close=await call(vaultArtifact.abi,vault,'epochStart',[epoch+1n]);
  await client.request({method:'evm_setNextBlockTimestamp',params:[Number(close)]});
  await client.request({method:'evm_mine',params:[]});
  await send(vaultArtifact.abi,vault,'claimRewards',[[epoch],user.address],wallets[2]);
  assert.equal(await call(vaultArtifact.abi,vault,'totalNftClaimed'),income/2n);
  assert.equal(await call(vaultArtifact.abi,vault,'ownerCredit'),income/2n);
  await send(vaultArtifact.abi,vault,'claimOwner');
  assert.equal(await client.getBalance({address:vault}),0n);
  await send(vaultArtifact.abi,vault,'unstake',[[userToken],user.address],wallets[2]);
  assert.equal((await call(nftArtifact.abi,nft,'ownerOf',[userToken])).toLowerCase(),user.address.toLowerCase());
  console.log(JSON.stringify({status:'passed',scope:'local-only',chainId:46630,proof:'genuine historical drand round 1000',
    silverGrade:expectedGrade,goldGrade,salesIsolated:true,authenticatedCallback:true,lockedRecipient:true,postgresRestart:true,noDuplicateBroadcast:true,oneUserOpeningTransaction:true,
    staking:true,closedEpochClaim:true,epochTime:'locally advanced',ownerHalfOnly:true,unstaking:true}));
} finally {
  await stopWorker(); beacon.close(); anvil.kill('SIGTERM');
  if(postgresStarted)execFileSync('docker',['rm','-f',postgres],{stdio:'pipe'});
}
