import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, posix, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, data, compile, hash, json, readJson } from './build.mjs';

export function gameplayPaths(deploymentId = '') {
  assert(!deploymentId || /^[a-z0-9][a-z0-9-]{0,63}$/.test(deploymentId), 'Invalid testnet deployment ID');
  const journalDirectory = resolve(data, 'testnet/gameplay', ...(deploymentId ? ['redeployments', deploymentId] : []));
  const outputDirectory = deploymentId ? journalDirectory : data;
  return { journal: resolve(journalDirectory, 'transactions.json'), output: resolve(outputDirectory, 'gameplay-build.json'),
    compilerInput: resolve(outputDirectory, 'gameplay-compiler-input.json') };
}
export function buildGameplay(deploymentId = '', automaticActivation = false) {
  assert(!automaticActivation || deploymentId, 'Automatic activation requires a separate --deployment-id; preserve existing journals');
  const paths = gameplayPaths(deploymentId);
  const sources = {};
  const remappings = { '@openzeppelin/': 'arc/lib/openzeppelin-contracts/', '@uniswap/v4-core/': 'arc/lib/v4-core/', 'solmate/': 'arc/lib/solmate/' };
  function visit(path) {
    assert(!path.startsWith('../') && !posix.isAbsolute(path));
    if (sources[path]) return;
    // Preserve frozen compiler source keys after relocating the vendored dependencies.
    const content = readFileSync(sourcePath(path), 'utf8'); sources[path] = { content };
    for (const match of content.matchAll(/import\s+(?:[^;]*?from\s*)?["']([^"']+)["']\s*;/g)) {
      let target = match[1];
      if (target.startsWith('.')) target = posix.normalize(posix.join(posix.dirname(path), target));
      else for (const [prefix, replacement] of Object.entries(remappings)) if (target.startsWith(prefix)) { target = replacement + target.slice(prefix.length); break; }
      visit(target);
    }
  }
  const owned = {
    factory: ['chains/robinhood/launchpads/pons/PonsVaultFactory.sol', 'PonsVaultFactory'],
    vault: ['chains/robinhood/launchpads/pons/PonsHookVault.sol', 'PonsHookVault'],
    adapter: ['chains/robinhood/launchpads/pons/PonsSwapAdapter.sol', 'PonsSwapAdapter'],
    buyback: ['chains/evm/hooks/RevenueHooks.sol', 'BuybackHook'],
    distribution: ['chains/evm/hooks/RevenueHooks.sol', 'DistributionHook'],
  };
  if (automaticActivation) {
    owned.factory = ['chains/robinhood/launchpads/pons/PonsDelayedVaultFactory.sol', 'PonsDelayedVaultFactory'];
    owned.vault = ['chains/robinhood/launchpads/pons/PonsDelayedVault.sol', 'PonsDelayedVault'];
  }
  for (const [path] of Object.values(owned)) visit(path);
  const productionSourcesSha256 = hash(sources);
  if (existsSync(paths.journal))
    assert.equal(readJson(paths.output).productionSourcesSha256, productionSourcesSha256, 'Public gameplay build is frozen; preserve its journal and use a separate --deployment-id');
  const factory = sources['chains/evm/hooks/HookVaultFactory.sol'];
  assert.equal(factory.content.split('DELAY = 48 hours').length, 2);
  factory.content = factory.content.replace('DELAY = 48 hours', 'DELAY = 10 minutes');
  assert(sources['chains/robinhood/launchpads/pons/PonsVaultFactory.sol'].content.includes('block.chainid != 46630'));
  const input = { language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true,
    evmVersion: 'cancun', metadata: { bytecodeHash: 'none' }, remappings: Object.entries(remappings).map(([a,b]) => `${a}=${b}`),
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'] } } } };
  const compiled = compile(input, '0.8.26');
  const artifacts = Object.fromEntries(Object.entries(owned).map(([name,[file,contract]]) => {
    const a = compiled[file][contract]; assert(a.evm.deployedBytecode.object.length / 2 <= 24576);
    return [name, { abi: a.abi, bytecode: `0x${a.evm.bytecode.object}`, runtime: a.evm.deployedBytecode }];
  }));
  const build = { chainId: 46630, policyDelaySeconds: 600, payoutPolicy: 'repeat', ...(automaticActivation ? { policyActivation: 'timestamp', initialPluginActivation: true } : {}), productionSourcesSha256, artifacts,
    testnetChanges: ['Isolated Robinhood Testnet controller: 10 minutes. Production source remains 48 hours.'] };
  mkdirSync(dirname(paths.output), { recursive: true });
  writeFileSync(paths.compilerInput, json(input)); writeFileSync(paths.output, json(build));
  return build;
}
export function sourcePath(path) {
  assert(!path.startsWith('../') && !posix.isAbsolute(path));
  const target = resolve(root, path.startsWith('arc/lib/') ? `chains/${path}` : path);
  assert(relative(root, target).startsWith('chains/'), 'Source must belong to chains/');
  return target;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--deployment-id');
  assert(index < 0 || process.argv[index + 1], 'Missing --deployment-id');
  console.log(json({ ...buildGameplay(index < 0 ? '' : process.argv[index + 1], process.argv.includes('--automatic-policy-activation')), artifacts: 'saved locally' }));
}
