// Independent public-testnet artifacts; production sources and deployment guards stay intact.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { getContractAddress } from 'viem';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const dir = resolve(root, 'data/argus-public-testnet');
export const v2dir = resolve(root, 'data/argus-public-testnet-v2');
export const claimDir = resolve(root, 'data/argus-public-testnet-claim');
export const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v, 2);
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const sortedSources = sources => Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)));
export function compile(input, version) {
  const candidates = [process.env[`SOLC_${version.replaceAll('.', '_')}`],
    resolve(homedir(), `Library/Application Support/svm/${version}/solc-${version}`),
    resolve(homedir(), `.svm/${version}/solc-${version}`)].filter(Boolean);
  const compiler = candidates.find(existsSync);
  assert(compiler, `Install solc ${version} or set SOLC_${version.replaceAll('.', '_')}`);
  const result = spawnSync(compiler, ['--standard-json'], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 64e6 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual((output.errors ?? []).filter(e => e.severity === 'error').map(e => e.formattedMessage), []);
  return output.contracts;
}
const selection = { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'] } };
export function artifact(contracts, file, name) {
  const a = contracts[file][name];
  assert(a.evm.deployedBytecode.object.length / 2 <= 24576, `${name}: EIP-170`);
  return { abi: a.abi, bytecode: a.evm.bytecode, runtime: a.evm.deployedBytecode };
}
export function maskLinks(code, references) {
  let out = code.replace(/^0x/, '');
  for (const refs of Object.values(references ?? {})) for (const positions of Object.values(refs))
    for (const { start, length } of positions) out = out.slice(0, start * 2) + '0'.repeat(length * 2) + out.slice((start + length) * 2);
  return out;
}
export async function build({ version = 1 } = {}) {
  assert([1, 2, 3].includes(version));
  const outputDir = version === 3 ? claimDir : version === 2 ? v2dir : dir;
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const manifest = JSON.parse(readFileSync(resolve(root, 'testnet/sources.json')));
  const wallets = JSON.parse(readFileSync(resolve(dir, 'wallets.json')));
  const portal = getContractAddress({ from: wallets.deployer.address, nonce: 8n });
  const artifacts = {}, provenance = {};
  for (const [name, pin] of Object.entries(manifest.upstream)) {
    const cache = resolve(dir, `${name}-source.json`);
    let bundle;
    if (existsSync(cache)) bundle = JSON.parse(readFileSync(cache));
    else {
      const response = await fetch(`https://sourcify.dev/server/v2/contract/5042/${pin.address}?fields=sources,compilation,creationBytecode`, { signal: AbortSignal.timeout(30000) });
      assert(response.ok, `${name}: source fetch ${response.status}`);
      bundle = await response.json();
      writeFileSync(cache, json(bundle));
    }
    assert.equal(hash(sortedSources(bundle.sources)), pin.sourcesSha256, `${name}: source pin`);
    assert.equal(hash(bundle.compilation), pin.compilationSha256, `${name}: compiler pin`);
    assert(['match', 'exact_match'].includes(bundle.runtimeMatch), `${name}: verified runtime required`);
    const input = { language: 'Solidity', sources: bundle.sources, settings: { ...bundle.compilation.compilerSettings, outputSelection: selection } };
    const compiled = compile(input, '0.8.24');
    const [file, contract] = bundle.compilation.fullyQualifiedName.split(':');
    const a = artifact(compiled, file, contract);
    assert.equal(maskLinks(a.bytecode.object, a.bytecode.linkReferences), maskLinks(bundle.creationBytecode.recompiledBytecode, a.bytecode.linkReferences), `${name}: reproduce verified creation code`);
    artifacts[name] = a;
    provenance[name] = { ...pin, contract, verifiedCompilationReproduced: true };
    if (name === 'portal') for (const library of ['ArgusV4Curve', 'ArgusV4DevBuyERC20']) artifacts[library] = artifact(compiled, `src/libraries/${library}.sol`, library);
    if (name === 'tokenImpl') artifacts.launchConfig = artifact(compiled, 'src/ArgusV4LaunchConfig.sol', 'ArgusV4LaunchConfig');
    writeFileSync(resolve(outputDir, `${name}-compiler-input.json`), json(input));
  }
  const remappings = { '@openzeppelin/': 'lib/openzeppelin-contracts/', '@uniswap/v4-core/': 'lib/v4-core/', '@uniswap/v4-periphery/': 'lib/v4-periphery/', 'solmate/': 'lib/solmate/', 'solady/': 'lib/solady/src/', 'permit2/': 'lib/permit2/' };
  const sources = {};
  function visit(path) {
    const localPath = relative(resolve(root, '..'), resolve(root, path));
    assert(!posix.isAbsolute(path) && localPath !== '..' && !localPath.startsWith('../'));
    if (sources[path]) return;
    const content = readFileSync(resolve(root, path), 'utf8');
    sources[path] = { content };
    for (const match of content.matchAll(/import\s+(?:[^;]*?from\s*)?["']([^"']+)["']\s*;/g)) {
      let target = match[1];
      if (target.startsWith('.')) target = posix.normalize(posix.join(posix.dirname(path), target));
      else for (const [prefix, replacement] of Object.entries(remappings)) if (target.startsWith(prefix)) { target = replacement + target.slice(prefix.length); break; }
      visit(target);
    }
  }
  const owned = { router: ['../chains/arc/launchpads/argus/ArgusCustodyRouter.sol', 'ArgusCustodyRouter'], implementation: ['../chains/arc/launchpads/argus/ArgusRevenueVault.sol', 'ArgusRevenueVault'], factory: ['../chains/arc/launchpads/argus/ArgusVaultFactory.sol', 'ArgusVaultFactory'], stateView: ['lib/v4-periphery/src/lens/StateView.sol', 'StateView'], usdcOnly: ['../chains/arc/launchpads/argus/testnet/UsdcOnly.sol', 'UsdcOnly'] };
  for (const [file] of Object.values(owned)) visit(file);
  const productionSourcesSha256 = hash(sortedSources(sources));
  if (existsSync(resolve(outputDir, 'transactions.json'))) {
    assert.equal(productionSourcesSha256, JSON.parse(readFileSync(resolve(outputDir, 'build.json'))).productionSourcesSha256,
      'Public deployment artifacts are frozen. Use a separate reviewed deployment for changed contracts; preserve the original journal and build.');
  }
  for (const file of ['../chains/arc/launchpads/argus/ArgusCustodyRouter.sol', '../chains/arc/launchpads/argus/ArgusVaultFactory.sol']) {
    assert.equal(sources[file].content.split('block.chainid != 5042').length, 2);
    sources[file].content = sources[file].content.replace('block.chainid != 5042', 'block.chainid != 5042002');
  }
  const routerSource = sources['../chains/arc/launchpads/argus/ArgusCustodyRouter.sol'];
  const factorySource = sources['../chains/arc/launchpads/argus/ArgusVaultFactory.sol'];
  assert.equal(factorySource.content.split('DELAY = 48 hours').length, 2);
  if (version === 3) factorySource.content = factorySource.content.replace('DELAY = 48 hours', 'DELAY = 10 minutes');
  assert.equal(routerSource.content.split(manifest.upstream.portal.address).length, 2);
  routerSource.content = routerSource.content.replace(manifest.upstream.portal.address, portal);
  const input = { language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun', metadata: { bytecodeHash: 'none' }, remappings: Object.entries(remappings).map(([a, b]) => `${a}=${b}`), outputSelection: selection } };
  const compiled = compile(input, '0.8.26');
  for (const [name, [file, contract]] of Object.entries(owned)) artifacts[name] = artifact(compiled, file, contract);
  writeFileSync(resolve(outputDir, 'local-compiler-input.json'), json(input));
  const result = { chainId: 5042002, portal, deployer: wallets.deployer.address, artifacts, provenance, productionSourcesSha256, policyDelaySeconds: version === 3 ? 600 : 172800,
    testnetChanges: ['Router and Vault Factory deployment chain guard: 5042002', 'Router Portal constant: predicted independent testnet Portal', 'Other quote assets and conversions disabled by UsdcOnly; upstream USDC execution unchanged',
      ...(version === 3 ? ['Claim testnet controller delay: 10 minutes; production source remains 48 hours'] : [])] };
  writeFileSync(resolve(outputDir, 'build.json'), json(result));
  console.log(json({ status: 'compiled', portal, contracts: Object.keys(artifacts), provenance, testnetChanges: result.testnetChanges }));
  return result;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await build({version: process.argv.includes('--claim') ? 3 : process.argv.includes('--v2') ? 2 : 1});
