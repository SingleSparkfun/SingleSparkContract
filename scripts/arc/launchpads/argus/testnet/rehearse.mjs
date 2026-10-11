// Real public-testnet dependencies, local deployment rehearsal; never sends to public RPC.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPublicClient, http, parseEther, toHex } from 'viem';
import { context, deployAll } from './deploy.mjs';
import { dir } from './build.mjs';
const port = 18649, rpc = `http://127.0.0.1:${port}`;
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '5042002', '--fork-url', 'https://rpc.testnet.arc.io', '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = ''; anvil.stderr.on('data', chunk => stderr += chunk);
try {
  const client = createPublicClient({ transport: http(rpc, { retryCount: 0, timeout: 2000 }) });
  let ready = false;
  for (let i = 0; i < 45; i++) {
    try { assert.equal(await client.getChainId(), 5042002); ready = true; break; } catch {}
    assert(anvil.exitCode === null, stderr.slice(-1000));
    await new Promise(r => setTimeout(r, 1000));
  }
  assert(ready, 'Anvil testnet fork unavailable');
  const wallets = JSON.parse(readFileSync(resolve(dir, 'wallets.json')));
  assert.equal(await client.getTransactionCount({ address: wallets.deployer.address }), 0, 'Run rehearsal before public deployment');
  await client.request({ method: 'anvil_setBalance', params: [wallets.deployer.address, toHex(parseEther('20'))] });
  const storageDir = mkdtempSync(join(tmpdir(), 'argus-testnet-rehearsal-'));
  const c = await context({ rpc, storageDir });
  process.argv.push('--broadcast');
  await deployAll(c);
  const nonce = await c.client.getTransactionCount({ address: wallets.deployer.address });
  await deployAll(c);
  assert.equal(await c.client.getTransactionCount({ address: wallets.deployer.address }), nonce, 'Resume must not redeploy');
  await assert.rejects(() => c.client.call({ to: c.report.addresses.usdcOnly, data: '0x12345678' }));
  assert.equal(c.report.publicTransactions, false);
  console.log(JSON.stringify({ status: 'passed', publicTransactions: false, checks: ['all constructors and deployed runtimes', 'real Portal token launch', 'USDC-only fail-closed', 'journal replay without extra transactions'], report: join(storageDir, 'report.json') }));
} finally { anvil.kill('SIGTERM'); }
