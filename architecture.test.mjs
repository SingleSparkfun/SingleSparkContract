import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('.', import.meta.url));
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = resolve(dir, entry.name);
  return entry.isDirectory() ? files(path) : [path];
});
const owner = path => /^chains\/([^/]+)(?:\/launchpads\/([^/]+))?\//.exec(path);
function violation(from, to) {
  const a = owner(from), b = owner(to);
  if (!a || !b) return false;
  if ((a[1] === 'solana' || b[1] === 'solana') && a[1] !== b[1]) return true;
  if (a[2] && b[2] && (a[1] !== b[1] || a[2] !== b[2])) return true;
  // The old combined Solana entrypoint composes the split programs for ABI compatibility.
  return !a[2] && !!b[2] && !/\/(test|legacy)\//.test(from);
}

test('contract implementations belong to a chain; build entrypoints contain no duplicate source', () => {
  for (const old of ['src', 'arc/src', 'arc/test', 'solana/src', 'solana/programs/dao/src', 'solana/programs/revenue/src', 'solana/programs/timelock/src']) {
    assert.equal(existsSync(resolve(root, old)), false, old);
  }
  for (const profile of ['solana', 'solana/programs/dao', 'solana/programs/revenue', 'solana/programs/timelock']) {
    const config = readFileSync(resolve(root, profile, 'Cargo.toml'), 'utf8');
    const path = /^path = "([^"]+)"/m.exec(config)?.[1];
    assert(path, profile);
    assert(existsSync(resolve(root, profile, path)), profile);
    assert(relative(root, resolve(root, profile, path)).startsWith('chains/solana/'));
  }
});

test('chain-shared contracts cannot depend on a launchpad; launchpads cannot import each other', () => {
  const failures = [];
  for (const file of files(resolve(root, 'chains')).filter(path => /\.(rs|sol)$/.test(path))) {
    const source = readFileSync(file, 'utf8');
    const imports = file.endsWith('.sol') ? [...source.matchAll(/import\s+(?:[^;]*?from\s*)?["']([^"']+)["']\s*;/g)]
      : [...source.matchAll(/#\[path\s*=\s*"([^"]+)"\]/g)];
    for (const [, path] of imports) {
      if (!path.startsWith('.')) continue;
      const target = resolve(dirname(file), path), from = relative(root, file), to = relative(root, target);
      if (!existsSync(target) || violation(from, to)) failures.push(`${from} -> ${to}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('ownership checks reject cross-chain, cross-platform and reverse shared dependencies', () => {
  assert(violation('chains/solana/launchpads/pump/lib.rs', 'chains/evm/revenue/Revenue.sol'));
  assert(violation('chains/arc/launchpads/argus/Vault.sol', 'chains/arc/launchpads/singlespark/Launch.sol'));
  assert(violation('chains/evm/revenue/Revenue.sol', 'chains/arc/launchpads/argus/Vault.sol'));
  assert.equal(violation('chains/arc/launchpads/argus/Vault.sol', 'chains/evm/governance/Treasury.sol'), false);
  assert.equal(violation('chains/solana/launchpads/pump/lib.rs', 'chains/solana/shared/state.rs'), false);
});

test('operational scripts resolve their imports after organization', () => {
  const failures = [];
  for (const file of files(resolve(root, 'scripts')).filter(path => path.endsWith('.mjs'))) {
    for (const [, path] of readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s+)["'](\.[^"']+)["']/g)) {
      const target = resolve(dirname(file), path);
      // Optional workspace integration tools are not dependencies of a standalone contract checkout.
      if (relative(root, target).startsWith('../')) continue;
      if (!existsSync(target)) failures.push(`${relative(root, file)} -> ${path}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('build roots contain no misplaced browser checks or asset generators', () => {
  for (const entry of readdirSync(resolve(root, 'arc'))) {
    assert(!/^(?:check-.*-ui|build-(?:geo|globe)-.*|render-.*)\.mjs$/.test(entry), entry);
  }
  for (const environment of ['mainnet', 'testnet', 'local']) assert(existsSync(resolve(root, 'deployments', environment)));
});

test('contract documentation links resolve after moving guides', () => {
  const failures = [];
  const guides = [resolve(root, 'README.md'), ...files(resolve(root, 'docs')), resolve(root, 'deployments/README.md'), resolve(root, 'solana/README.md')];
  for (const file of guides.filter(path => path.endsWith('.md'))) {
    for (const [, link] of readFileSync(file, 'utf8').matchAll(/\]\(([^)]+)\)/g)) {
      if (link.startsWith('#') || /^[a-z]+:/i.test(link)) continue;
      const target = resolve(dirname(file), link.split('#')[0]);
      if (!relative(root, target).startsWith('../') && !existsSync(target)) failures.push(`${relative(root, file)} -> ${link}`);
    }
  }
  assert.deepEqual(failures, []);
});
