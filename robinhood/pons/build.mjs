import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const data = resolve(root, '.data/robinhood/pons');
export const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v, 2);
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const sorted = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

export function validateBundle(bundle, pin) {
  assert.equal(bundle.chainId, '4663');
  assert.equal(bundle.address.toLowerCase(), pin.address.toLowerCase());
  assert(['match', 'exact_match'].includes(bundle.runtimeMatch), 'Verified runtime required');
  assert.equal(hash(sorted(bundle.sources)), pin.sourcesSha256, 'Source version changed');
  assert.equal(hash(bundle.compilation), pin.compilationSha256, 'Compiler settings changed');
  assert.equal(hash(bundle.creationBytecode.recompiledBytecode), pin.creationSha256, 'Creation bytecode changed');
}

function compiler(version) {
  const paths = [process.env[`SOLC_${version.replaceAll('.', '_')}`], resolve(data, 'compiler', `solc-${version}`),
    resolve(homedir(), `Library/Application Support/svm/${version}/solc-${version}`), resolve(homedir(), `.svm/${version}/solc-${version}`)].filter(Boolean);
  const path = paths.find(existsSync);
  assert(path, `Install solc ${version}, or set SOLC_${version.replaceAll('.', '_')}`);
  return path;
}

export function compile(input, version) {
  const result = spawnSync(compiler(version), ['--standard-json'], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 64e6 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual((output.errors ?? []).filter(e => e.severity === 'error').map(e => e.formattedMessage), []);
  return output.contracts;
}

export async function build() {
  mkdirSync(resolve(data, 'sources'), { recursive: true, mode: 0o700 });
  const pins = readJson(resolve(root, 'chains/robinhood/launchpads/pons/sources.json'));
  if (existsSync(resolve(data, 'testnet/transactions.json'))) {
    assert.equal(readJson(resolve(data, 'build.json')).sourcePinsSha256, hash(pins), 'Public deployment build is frozen; preserve the original sources and journal');
  }
  const artifacts = {};
  for (const [name, pin] of Object.entries(pins.contracts)) {
    const path = resolve(data, 'sources', `${name}.json`);
    let bundle;
    if (existsSync(path)) bundle = readJson(path);
    else {
      const response = await fetch(`https://sourcify.dev/server/v2/contract/4663/${pin.address}?fields=all`, { signal: AbortSignal.timeout(30000) });
      assert(response.ok, `${name}: Sourcify ${response.status}`);
      bundle = await response.json();
      validateBundle(bundle, pin);
      writeFileSync(path, json(bundle));
    }
    validateBundle(bundle, pin);
    const [file, contract] = bundle.compilation.fullyQualifiedName.split(':');
    const input = { language: 'Solidity', sources: bundle.sources, settings: { ...bundle.compilation.compilerSettings,
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode'] } } } };
    const contracts = compile(input, pin.compilerVersion);
    const a = contracts[file][contract];
    assert.equal(`0x${a.evm.bytecode.object}`, bundle.creationBytecode.recompiledBytecode, `${name}: reproduce verified creation bytecode`);
    assert(a.evm.deployedBytecode.object.length / 2 <= 24576, `${name}: EIP-170`);
    artifacts[name] = { abi: a.abi, bytecode: `0x${a.evm.bytecode.object}`, runtime: a.evm.deployedBytecode, source: pin };
    // The factory constructs its guard; the deployer constructs the per-launch curve and token.
    if (name === 'factory') for (const child of ['PonsV2GraduationGuard', 'PonsV2BondingCurve', 'PonsV2LauncherToken']) {
      const item = contracts[`contracts/src/v2/${child}.sol`][child];
      artifacts[child] = { abi: item.abi, bytecode: `0x${item.evm.bytecode.object}`, runtime: item.evm.deployedBytecode };
    }
    writeFileSync(resolve(data, 'sources', `${name}-input.json`), json(input));
    console.log(`${name}: verified creation bytecode reproduced (${a.evm.deployedBytecode.object.length / 2} runtime bytes)`);
  }
  const result = { sourcePinsSha256: hash(pins), artifacts };
  writeFileSync(resolve(data, 'build.json'), json(result));
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await build();
