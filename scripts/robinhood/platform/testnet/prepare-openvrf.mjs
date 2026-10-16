import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const pin = JSON.parse(readFileSync(resolve(root, 'chains/robinhood/randomness/openvrf.json')));
const data = resolve(root, 'chains/robinhood/data/openvrf');
const source = resolve(data, pin.revision);
mkdirSync(data, { recursive: true, mode: 0o700 });
for (const entry of [pin, ...pin.dependencies]) {
  const archive = resolve(data, `${entry.revision}.tar.gz`);
  if (!existsSync(archive)) {
    const url = entry.repository.replace('https://github.com/', 'https://codeload.github.com/') + `/tar.gz/${entry.revision}`;
    execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--max-time', '120', url, '-o', archive], { stdio: 'inherit' });
  }
  assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), entry.archiveSha256, `Dependency archive mismatch: ${entry.repository}`);
  const target = entry.directory ? resolve(source, entry.directory) : source;
  mkdirSync(target, { recursive: true, mode: 0o700 });
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', target]);
}
execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: source, stdio: 'inherit' });
execFileSync('forge', ['build'], { cwd: source, stdio: 'inherit' });
mkdirSync(resolve(source, 'singlespark'), { recursive: true });
for (const file of ['relayer.mjs', 'finalized-code.mjs', 'openvrf.json', 'start-relayer.sh']) {
  copyFileSync(resolve(root, 'chains/robinhood/randomness', file), resolve(source, 'singlespark', file));
}
console.log(`Pinned OpenVRF prepared at ${source}`);
