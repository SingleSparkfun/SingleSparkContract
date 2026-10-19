import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {test} from 'node:test';

test('archive selection preserves the execution endpoint and rejects the wrong verification chain', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'singlespark-relayer-startup-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  await mkdir(join(directory, 'node_modules/ethers'), {recursive:true});
  await writeFile(join(directory, 'package.json'), '{}');
  await writeFile(join(directory, 'node_modules/ethers/package.json'), '{"main":"index.cjs"}');
  await writeFile(join(directory, 'node_modules/ethers/index.cjs'), `
    const {writeFileSync} = require('node:fs');
    exports.FetchRequest = class {
      constructor(url) { writeFileSync(process.env.TRACE_FILE, JSON.stringify({url, execution:process.env.RPC_URL})); }
    };
    exports.JsonRpcProvider = class {
      async getNetwork() { return {chainId:1n}; }
      destroy() {}
    };
  `);
  const pin = JSON.parse(await readFile(new URL('../../../../chains/robinhood/randomness/openvrf.json', import.meta.url)));
  const report = join(directory, 'deployment.json'), key = join(directory, 'unused-key'), trace = join(directory, 'trace.json');
  await writeFile(report, JSON.stringify({chainId:46630, environment:'testnet', status:'verified', openVrfRevision:pin.revision}));
  await writeFile(key, 'unused-test-fixture', {mode:0o600});
  const entrypoint = fileURLToPath(new URL('../../../../chains/robinhood/randomness/relayer.mjs', import.meta.url));
  for (const [rpc, archive, expected] of [
    ['https://execution.invalid', 'https://archive.invalid', 'https://archive.invalid'],
    ['https://execution.invalid', '', 'https://execution.invalid'],
    ['', 'https://archive.invalid', null],
  ]) {
    await rm(trace, {force:true});
    const failure = await promisify(execFile)(process.execPath, [entrypoint], {env:{...process.env,
      OPENVRF_DIR:directory, RPC_URL:rpc, ARCHIVE_RPC_URL:archive,
      NFT_RANDOM_DEPLOYMENT_FILE:report, RELAYER_KEY_FILE:key, TRACE_FILE:trace,
    }}).then(() => null, error => error);
    assert.equal(failure?.code, 1);
    assert.match(failure.stderr, /ERR_ASSERTION/);
    if (expected) assert.deepEqual(JSON.parse(await readFile(trace)), {url:expected, execution:rpc});
    else assert.equal(existsSync(trace), false);
  }
});
