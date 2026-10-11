// Verify the deployed HTTP flow with the dedicated test wallet; never export its session token.
import assert from 'node:assert/strict';
import { openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { erc20Abi, encodeFunctionData } from 'viem';
import { context, QUOTE } from './deploy.mjs';

const c = await context({ version: 3 });
assert.equal(c.report.status, 'passed');
assert(c.report.platformProject, 'Launch the platform project before application verification');
assert(process.argv.includes('--broadcast'));
const base = 'https://singlespark.fun';
let session;
async function api(path, body) {
  const started = Date.now();
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(180000),
    headers: { Origin: base, ...(body ? {'Content-Type':'application/json'} : {}), ...(session ? {Authorization:`Bearer ${session}`} : {}) },
    ...(body ? {body:JSON.stringify(body)} : {}),
  });
  console.log(JSON.stringify({path:path.split('?')[0],status:response.status,seconds:(Date.now()-started)/1000}));
  assert(response.ok, `${path.split('?')[0]}: HTTP ${response.status}`);
  return response.json();
}
const lockPath = resolve(c.storageDir, 'run.lock'), lock = openSync(lockPath, 'wx', 0o600);
try {
  const config = await api('/api/v2/chain-config');
  const network = config.payload.chains.find(x => x.chainId === 5042002);
  assert(network && network.testnet);
  assert.equal(network.argusVaultCodeHashes.factory, c.report.codeHashes.factory);
  assert.equal(network.argusVaultCodeHashes.implementation, c.report.codeHashes.implementation);
  const list = await api('/api/arc/argus/claim');
  assert.equal(list.status, 'ready');
  for (const project of c.report.projects) assert(list.projects.some(x => x.id.toLowerCase() === project.token.toLowerCase()));
  assert(!list.projects.some(x => x.id.toLowerCase() === c.report.platformProject.token.toLowerCase()));
  const owner = c.accounts.deployer.address;
  const challenge = await api(`/api/auth/nonce?address=${owner}&chainId=5042002`);
  assert.equal(challenge.chainId, 5042002);
  const login = await api('/api/auth/login', { message:challenge.message, signature:await c.accounts.deployer.signMessage({message:challenge.message}), chainId:5042002 });
  assert.equal(login.address.toLowerCase(), owner.toLowerCase()); session = login.token;
  const project = c.report.projects[1];
  // One micro-USDC keeps total labelled trades and donations below the existing seven-USDC reserve.
  await c.call('app-sync-donation', 'deployer', QUOTE, erc20Abi, 'transfer', [project.vault, 1n]);
  if (!c.journal.steps['app-user-sync']) {
    const plan = await api(`/api/arc/argus/claim/plan?token=${project.token}&owner=${owner}`);
    assert.equal(plan.next?.operation, 'sync');
    const job = await api('/api/arc/argus/claim/prepare', {token:project.token, operation:'sync'});
    assert.equal(job.chainId, 5042002); assert.equal(job.owner.toLowerCase(), owner.toLowerCase());
    assert.equal(job.vault.toLowerCase(), project.vault.toLowerCase()); assert.equal(job.value, '0');
    assert.equal(job.data, encodeFunctionData({abi:c.a.implementation.abi,functionName:'sync'}));
    assert.equal(job.rewardRaw, '0'); assert(BigInt(job.gas) <= 5000000n);
    await c.send('app-user-sync', 'deployer', async () => ({to:project.vault,data:job.data,value:0n,gas:BigInt(job.gas)}));
  } else {
    await c.send('app-user-sync', 'deployer', () => {throw Error('Recovery must reuse signed transaction');});
  }
  assert.equal(await c.read(project.vault,c.a.implementation.abi,'accounted'), await c.read(QUOTE,erc20Abi,'balanceOf',[project.vault]));
  c.report.applicationAcceptance = { url:base, deploymentPinsMatch:true, ordinaryProjectsListed:true, platformExcludedFromUserClaim:true,
    authenticatedPreparation:true, disabledPluginsAllowAccounting:true, userPaidGas:true,
    transaction:c.report.transactions['app-user-sync'].hash, browserWalletSigningVerified:false };
  c.report.acceptance.applicationRolloutVerified = true; c.save();
  console.log(JSON.stringify(c.report.applicationAcceptance));
} finally {
  if (session) await api('/api/auth/logout', {}).catch(() => {});
  closeSync(lock); unlinkSync(lockPath);
}
