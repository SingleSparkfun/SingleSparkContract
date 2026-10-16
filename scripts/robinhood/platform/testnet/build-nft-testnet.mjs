import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, posix } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export function testnetNftSource(path, content) {
  if (['PlatformRandomNftFactory.sol', 'PlatformNftRevenueVault.sol', 'PlatformNftSalesVault.sol'].some(name => path.endsWith(`/${name}`))) {
    assert.equal(content.split('DELAY = 48 hours').length, 2, 'Production delay changed');
    const delayed = content.replace('DELAY = 48 hours', 'DELAY = 10 minutes');
    if (path.endsWith('/PlatformNftRevenueVault.sol')) {
      assert.equal(delayed.split('EPOCH_DURATION = 7 days').length, 2, 'Production settlement changed');
      return delayed.replace('EPOCH_DURATION = 7 days', 'EPOCH_DURATION = 4 hours');
    }
    return delayed;
  }
  return content;
}
export function buildNftTestnet(output) {
  const names = ['PlatformRandomNftFactory', 'PlatformRandomNft', 'PlatformRandomNftRevenueVault', 'PlatformNftSalesVault'];
  const sources = {}, original = {};
  function visit(path) {
    assert(!path.startsWith('../') && !posix.isAbsolute(path)); if (sources[path]) return;
    const content = readFileSync(resolve(root, path), 'utf8'); original[path] = { content }; sources[path] = { content: testnetNftSource(path, content) };
    for (const match of content.matchAll(/import\s+(?:[^;]*?from\s*)?["']([^"']+)["']\s*;/g)) {
      const target = match[1].startsWith('.') ? posix.normalize(posix.join(posix.dirname(path), match[1])) : match[1].replace('@openzeppelin/', 'chains/arc/lib/openzeppelin-contracts/');
      visit(target);
    }
  }
  for (const name of names) visit(`chains/robinhood/platform/${name}.sol`);
  assert(sources['chains/robinhood/platform/PlatformRandomNftFactory.sol'].content.includes('block.chainid != 46630'));
  const paths = [process.env.SOLC_0_8_26, resolve(homedir(), 'Library/Application Support/svm/0.8.26/solc-0.8.26'), resolve(homedir(), '.svm/0.8.26/solc-0.8.26')].filter(Boolean);
  const compiler = paths.find(existsSync); assert(compiler, 'solc 0.8.26 is required');
  const input = { language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:'cancun',metadata:{bytecodeHash:'none'},
    remappings:['@openzeppelin/=chains/arc/lib/openzeppelin-contracts/'],outputSelection:{'*':{'*':['abi','evm.bytecode','evm.deployedBytecode']}}} };
  const run = spawnSync(compiler,['--standard-json'],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:32e6});assert.equal(run.status,0,run.stderr);
  const compiled = JSON.parse(run.stdout);assert.deepEqual((compiled.errors??[]).filter(e=>e.severity==='error'),[]);
  const artifacts = Object.fromEntries(names.map(name=>{const a=compiled.contracts[`chains/robinhood/platform/${name}.sol`][name];
    assert(a.evm.deployedBytecode.object.length/2<=24576);return [name,{abi:a.abi,bytecode:{object:`0x${a.evm.bytecode.object}`},deployedBytecode:{...a.evm.deployedBytecode,object:`0x${a.evm.deployedBytecode.object}`}}];}));
  const build = {chainId:46630,policyDelaySeconds:600,epochDurationSeconds:14400,productionSourcesSha256:createHash('sha256').update(JSON.stringify(original)).digest('hex'),artifacts};
  mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(build,null,2));return build;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){assert(process.argv[2],'Pass an isolated output path');const b=buildNftTestnet(resolve(process.argv[2]));console.log(JSON.stringify({...b,artifacts:'saved locally'}));}
