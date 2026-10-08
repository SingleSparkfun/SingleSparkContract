import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicClient,http,erc20Abi,parseEther,formatEther } from 'viem';
import { arcAbi } from '../../SingleSparkFront/front/web3/arcAbi.ts';
import { artifact } from './deploy.mjs';
import { persist } from './runtime.mjs';

const report=JSON.parse(readFileSync('SingleSparkContract/arc/deployments/jet-rewards-200-wallets.json'));
assert.equal(report.status,'transactions_confirmed');
const count=report.testWalletCount??200;
const wallets=report.wallets.slice(0,count);
for(const prefix of ['buy-','sell-','approve-'])assert.equal(Object.keys(report.transactions).filter(k=>k.startsWith(prefix)).length,count);
const d=JSON.parse(readFileSync('SingleSparkContract/arc/deployments/jet-rewards-testnet-verification.json')).deployment;
const client=createPublicClient({transport:http('https://rpc.testnet.arc.network',{timeout:15000,retryCount:3,retryDelay:5000}),cacheTime:0});
assert.equal(await client.getChainId(),5042002);
const snapshot=await(await fetch('http://127.0.0.1:8090/api/arc/snapshot')).json();
const block=BigInt(snapshot.blockNumber);
assert(Object.values(report.transactions).every(tx=>BigInt(tx.block)<=block),'Indexer must catch up before validation');
const token=snapshot.tokens.find(t=>t.token.toLowerCase()===d.platformToken.toLowerCase());assert(token);
const events=[],rewardLogs=[];
for(let from=BigInt(d.fromBlock);from<=block;from+=1000n){
 const to=from+999n<block?from+999n:block;
 events.push(...await client.getContractEvents({address:d.launch,abi:arcAbi,fromBlock:from,toBlock:to,strict:true}));
 rewardLogs.push(...await client.getContractEvents({address:d.rewards,abi:artifact('ArcRewards').abi,eventName:'RewardPaid',fromBlock:from,toBlock:to,strict:true}));
}
const trades=events.filter(e=>e.eventName==='Traded');
const paid=[];
for(const event of rewardLogs){assert.equal(event.args.amount,parseEther('10'));paid.push({address:event.args.recipient.toLowerCase(),amount:event.args.amount});}
assert.equal(new Set(paid.map(p=>p.address)).size,paid.length,'Duplicate reward recipient across rounds');
const addresses=new Set([d.keeper.toLowerCase(),...wallets.map(w=>w.address.toLowerCase()),...paid.map(p=>p.address)]);
const balanceAtBlock=new Map();
const all=[...addresses];for(let start=0;start<all.length;start+=4){const results=await Promise.all(all.slice(start,start+4).map(async address=>[address,await client.readContract({address:d.platformToken,abi:erc20Abi,functionName:'balanceOf',args:[address],blockNumber:block})]));for(const[address,balance]of results)balanceAtBlock.set(address,balance);}
for(const w of wallets){
 const walletTrades=trades.filter(e=>e.args.trader.toLowerCase()===w.address.toLowerCase());
 assert.equal(walletTrades.length,2);const buy=walletTrades.find(e=>e.args.buy),sell=walletTrades.find(e=>!e.args.buy);
 assert.equal(buy.transactionHash,w.buyHash);assert.equal(sell.transactionHash,w.sellHash);
 assert.equal(buy.args.amountIn,BigInt(w.buyRaw));assert.equal(sell.args.amountIn,BigInt(w.soldRaw));
 const rewards=paid.filter(p=>p.address===w.address.toLowerCase()).reduce((v,p)=>v+p.amount,0n);
 assert.equal(balanceAtBlock.get(w.address.toLowerCase()),buy.args.amountOut-sell.args.amountIn+rewards,`Wallet balance mismatch ${w.index}`);
 assert.equal(await client.readContract({address:d.platformToken,abi:erc20Abi,functionName:'allowance',args:[w.address,d.launch],blockNumber:block}),0n,'Exact sell approvals must be consumed');
}
const excluded=new Set(snapshot.holderExcludedAddresses.map(a=>a.toLowerCase()));
const holders=[...balanceAtBlock].filter(([address,balance])=>balance>0n&&!excluded.has(address)).length;
assert.equal(token.holders,holders,'Backend holders disagree with actual balances at snapshot block');
const burns=events.filter(e=>e.eventName==='Burned');
const burned=burns.reduce((v,e)=>v+e.args.totalBurned,0n);
const buyback=burns.reduce((v,e)=>v+e.args.nativeAmount,0n);
const rewardFunding=burns.reduce((v,e)=>v+e.args.bought/10n,0n);
for(const e of burns){assert.equal(e.args.totalBurned,e.args.bought-e.args.bought/10n+e.args.feeTokens);assert(snapshot.records.some(r=>r.transactionHash===e.transactionHash),'Burn missing from API');}
const supply=await client.readContract({address:d.platformToken,abi:erc20Abi,functionName:'totalSupply',blockNumber:block});
assert.equal(10n**27n-supply,burned);assert.equal(BigInt(token.totalBurned),burned);assert.equal(BigInt(token.totalBuyback),buyback);assert.equal(BigInt(token.totalSupply),supply);
const available=await client.readContract({address:d.rewards,abi:artifact('ArcRewards').abi,functionName:'available',blockNumber:block});
const reserved=await client.readContract({address:d.rewards,abi:artifact('ArcRewards').abi,functionName:'reserved',blockNumber:block});
const rewardBalance=await client.readContract({address:d.platformToken,abi:erc20Abi,functionName:'balanceOf',args:[d.rewards],blockNumber:block});
assert.equal(rewardBalance,available+reserved);assert.equal(rewardFunding,available+reserved+BigInt(paid.length)*parseEther('10'));
const data={status:'passed',chainId:5042002,checkedAt:new Date().toISOString(),blockNumber:String(block),syntheticWallets:count,
 trades:count*2,confirmedTransactions:Object.keys(report.transactions).length,holders,burnCycles:burns.length,burnedJET:formatEther(burned),buybackUSDC:formatEther(buyback),
 rewardRecipients:paid.length,availableJET:formatEther(available),reservedJET:formatEther(reserved),totalSupply:String(supply),
 checks:[`${count} wallet balances + exact allowances`,`${count*2} chain trades vs transaction receipts`,'indexed holder count vs balances at one block','burn totals + total supply','buyback reward allocation conservation','cross-round recipient deduplication']};
persist('SingleSparkContract/arc/deployments/jet-rewards-200-wallets-validation.json',data);console.log(JSON.stringify(data));
