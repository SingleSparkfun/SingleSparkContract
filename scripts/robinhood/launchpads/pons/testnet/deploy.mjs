import assert from 'node:assert/strict';
import { openSync, closeSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeDeployData, encodeFunctionData, getContractAddress, getCreate2Address, keccak256, toHex, concatHex, parseAbi, formatEther } from 'viem';
import { context } from './transactions.mjs';

export function maskImmutables(code, references) {
  let value = code.replace(/^0x/, '').toLowerCase();
  for (const positions of Object.values(references ?? {})) for (const { start, length } of positions)
    value = value.slice(0, start * 2) + '0'.repeat(length * 2) + value.slice((start + length) * 2);
  return value;
}

export function executableCode(code, references) {
  const value = maskImmutables(code, references);
  // Only Solidity's complete IPFS/compiler CBOR footer; never strip executable bytes.
  assert(/a2646970667358221220[\da-f]{64}64736f6c6343[\da-f]{6}0033$/.test(value), 'Unrecognized Solidity metadata');
  return value.slice(0, -106);
}

export async function reuse(c) {
  const a = c.build.artifacts, pins = c.config.reuse;
  for (const [name, pin] of Object.entries(pins.contracts)) {
    const code = await c.client.getCode({ address: pin.address });
    assert.equal(keccak256(code), pin.codeHash, `${name}: existing deployment changed`);
    assert.equal(executableCode(code, a[name].runtime.immutableReferences), executableCode(a[name].runtime.object, a[name].runtime.immutableReferences), `${name}: executable code differs from verified source`);
    c.report.addresses[name] = pin.address; c.report.codeHashes[name] = pin.codeHash;
  }
  const addresses = c.report.addresses, factory = addresses.factory;
  const links = { owner: pins.owner, feeEscrow: addresses.escrow, memeHook: addresses.hook, buybackVault: addresses.buyback,
    locker: addresses.locker, launchDeployer: addresses.deployer, graduationExecutor: addresses.graduation, graduationGuard: pins.graduationGuard,
    ...Object.fromEntries(Object.entries(c.config.dependencies).filter(([name]) => name !== 'create2').map(([name, pin]) => [name, pin.address])) };
  for (const [name, value] of Object.entries(links)) assert.equal((await c.read(factory, a.factory.abi, name)).toLowerCase(), value.toLowerCase(), `factory.${name}`);
  for (const name of ['hook', 'buyback', 'locker', 'deployer', 'graduation'])
    assert.equal((await c.read(addresses[name], a[name].abi, 'factory')).toLowerCase(), factory.toLowerCase(), `${name}.factory`);
  for (const [name, field, target] of [['hook', 'feeEscrow', addresses.escrow], ['hook', 'buybackVault', addresses.buyback], ['hook', 'poolManager', links.poolManager], ['buyback', 'feeEscrow', addresses.escrow], ['buyback', 'feePolicy', addresses.hook], ['locker', 'positionManager', links.positionManager], ['graduation', 'locker', addresses.locker], ['graduation', 'positionManager', links.positionManager], ['graduation', 'permit2', links.permit2]])
    assert.equal((await c.read(addresses[name], a[name].abi, field)).toLowerCase(), target.toLowerCase(), `${name}.${field}`);
  assert.equal(JSON.stringify(await c.read(factory, a.factory.abi, 'getLaunchConfig', [0n]), (_, v) => typeof v === 'bigint' ? String(v) : v), JSON.stringify(c.config.launchConfig));
  for (const [field, value] of Object.entries({ launchFee: c.config.launchFeeWei, maxCreatorTaxBps: c.config.maxCreatorTaxBps, snipeTaxStartBps: c.config.snipeTaxStartBps, snipeTaxSeconds: c.config.snipeTaxSeconds }))
    assert.equal(String(await c.read(factory, a.factory.abi, field)), String(value), `factory.${field}`);
  assert(await c.read(factory, a.factory.abi, 'canLaunch', [c.account.address]), 'Existing factory is not open to this wallet');
  const guard = await c.client.getCode({ address: pins.graduationGuard });
  assert.equal(executableCode(guard, a.PonsV2GraduationGuard.runtime.immutableReferences), executableCode(a.PonsV2GraduationGuard.runtime.object, a.PonsV2GraduationGuard.runtime.immutableReferences));
  Object.assign(c.report, { independentDeployment: false, reusedDeployment: true, administrator: pins.owner });
  c.report.addresses.graduationGuard = pins.graduationGuard;
  if (!c.report.verification) c.report.status = 'existing_contracts_verified_pending_acceptance';
  c.save();
  return c.report;
}

export function hookAddress(proxy, bytecode) {
  const bytecodeHash = keccak256(bytecode);
  for (let i = 0; i < 1_000_000; i++) {
    const salt = toHex(i, { size: 32 });
    const address = getCreate2Address({ from: proxy, salt, bytecodeHash });
    // beforeInitialize, afterSwap, afterSwapReturnDelta from the verified hook.
    if ((BigInt(address) & 0x3fffn) === 0x2044n) return { address, salt };
  }
  throw new Error('No valid hook salt found');
}

export async function preflight(c) {
  for (const [name, pin] of Object.entries(c.config.dependencies)) {
    const code = await c.client.getCode({ address: pin.address });
    assert(code && code !== '0x', `${name}: dependency missing`);
    assert.equal(keccak256(code), pin.codeHash, `${name}: dependency bytecode changed`);
  }
  const pool = await c.read(c.config.dependencies.positionManager.address, parseAbi(['function poolManager() view returns(address)']), 'poolManager');
  assert.equal(pool.toLowerCase(), c.config.dependencies.poolManager.address.toLowerCase());
}

export async function deploy(c) {
  await preflight(c);
  if (c.config.reuse) return reuse(c);
  const balance = await c.client.getBalance({ address: c.account.address });
  if (!c.broadcast) return { status: 'reviewable_plan', chainId: 46630, deployer: c.account.address, balanceETH: formatEther(balance),
    contracts: ['escrow', 'hook', 'buyback', 'locker', 'factory', 'deployer', 'graduation'], maximumTotalCostETH: formatEther(BigInt(c.config.maximumTotalCostWei)), testnetDifferences: c.config.testnetDifferences };
  mkdirSync(c.storageDir, { recursive: true, mode: 0o700 });
  const lockPath = resolve(c.storageDir, 'run.lock'), lock = openSync(lockPath, 'wx', 0o600);
  try {
    const a = c.build.artifacts, owner = c.account.address;
    const dep = Object.fromEntries(Object.entries(c.config.dependencies).map(([key, pin]) => [key, pin.address]));
    async function create(name, args, create2 = false) {
      const artifact = a[name];
      const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args });
      let address;
      if (create2) {
        const mined = hookAddress(dep.create2, data); address = mined.address;
        await c.send(name, { to: dep.create2, data: concatHex([mined.salt, data]) });
      } else {
        const nonce = c.journal.steps[name]?.nonce ?? await c.client.getTransactionCount({ address: owner, blockTag: 'pending' });
        address = getContractAddress({ from: owner, nonce: BigInt(nonce) });
        const receipt = await c.send(name, { data });
        assert.equal(receipt.contractAddress.toLowerCase(), address.toLowerCase());
      }
      const code = await c.client.getCode({ address });
      assert.equal(maskImmutables(code, artifact.runtime.immutableReferences), maskImmutables(artifact.runtime.object, artifact.runtime.immutableReferences), `${name}: runtime differs from reproduced build`);
      c.report.addresses[name] = address; c.report.codeHashes[name] = keccak256(code); c.save();
      return address;
    }
    const escrow = await create('escrow', []);
    const hook = await create('hook', [dep.poolManager, escrow, owner, owner], true);
    const buyback = await create('buyback', [owner, hook, escrow]);
    const locker = await create('locker', [owner, dep.positionManager]);
    const factory = await create('factory', [owner, dep.poolManager, dep.positionManager, dep.permit2, locker, hook, escrow, buyback, BigInt(c.config.launchFeeWei)]);
    const deployer = await create('deployer', [factory]);
    const graduation = await create('graduation', [dep.positionManager, dep.permit2, locker, factory]);
    const call = (label, name, functionName, args) => c.send(label, { to: c.report.addresses[name], data: encodeFunctionData({ abi: a[name].abi, functionName, args }) });
    await call('hook-factory', 'hook', 'setFactory', [factory]);
    await call('hook-buyback', 'hook', 'setBuybackVault', [buyback]);
    await call('buyback-factory', 'buyback', 'setFactory', [factory]);
    await call('locker-factory', 'locker', 'setFactory', [factory]);
    await call('factory-deployer', 'factory', 'setLaunchDeployer', [deployer]);
    await call('factory-graduation', 'factory', 'setGraduationExecutor', [graduation]);
    const cfg = { ...c.config.launchConfig };
    for (const key of ['supply', 'curveFeeBps', 'phantomQuote', 'graduationThreshold']) cfg[key] = BigInt(cfg[key]);
    await call('launch-config', 'factory', 'addLaunchConfig', [cfg]);
    await call('creator-tax-cap', 'factory', 'setMaxCreatorTaxBps', [BigInt(c.config.maxCreatorTaxBps)]);
    await call('snipe-tax', 'factory', 'setSnipeTaxStartBps', [BigInt(c.config.snipeTaxStartBps)]);
    await call('snipe-window', 'factory', 'setSnipeTaxSeconds', [BigInt(c.config.snipeTaxSeconds)]);
    await call('launch-enabled', 'factory', 'setLaunchEnabled', [true]);
    const expected = { ...dep, locker, memeHook: hook, feeEscrow: escrow, buybackVault: buyback, launchDeployer: deployer, graduationExecutor: graduation };
    delete expected.create2;
    for (const [name, address] of Object.entries(expected)) assert.equal((await c.read(factory, a.factory.abi, name)).toLowerCase(), address.toLowerCase());
    assert.deepEqual(await c.read(factory, a.factory.abi, 'getLaunchConfig', [0n]), cfg);
    assert(await c.read(factory, a.factory.abi, 'canLaunch', [owner]));
    c.report.addresses.graduationGuard = await c.read(factory, a.factory.abi, 'graduationGuard');
    c.report.status = 'deployed_pending_acceptance';
    if (!c.local) {
      const finalized = await c.client.getBlock({ blockTag: 'finalized' });
      c.report.finalizedThroughBlock = String(finalized.number);
      if (Object.values(c.report.transactions).some(tx => BigInt(tx.blockNumber) > finalized.number)) c.report.status = 'deployed_pending_finality';
    }
    c.save();
    return c.report;
  } finally { closeSync(lock); unlinkSync(lockPath); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  try {
    assert(option('--wallet'), 'Pass --wallet with an owner-only deployment wallet file');
    const c = await context({ walletPath: resolve(option('--wallet')), rpc: option('--rpc'), storageDir: option('--storage'), local: process.argv.includes('--local'), broadcast: process.argv.includes('--broadcast') });
    console.log(JSON.stringify(await deploy(c), null, 2));
  } catch (error) { console.error(error.shortMessage ?? error.message); process.exitCode = 1; }
}
