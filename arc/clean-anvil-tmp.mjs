// Removes the temp state Anvil leaves in ~/.foundry/anvil/tmp. Anvil spills chain state there while it runs and
// does not remove it when it is stopped; each 1,000-pool capacity run left 7-15 GB, and on 2026-09-22 152 GB of
// them filled the disk and crashed PostgreSQL.
//
// Only directories created before the oldest Anvil still running are removed: none of those can belong to a live
// node. With no Anvil running, every directory goes.
//
//   node SingleSparkContract/arc/clean-anvil-tmp.mjs          (npm run clean:anvil)
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const dir = resolve(homedir(), '.foundry/anvil/tmp');
if (!existsSync(dir)) { console.log('No Anvil temp directory'); process.exit(0); }

let pids = [];
try { pids = execFileSync('pgrep', ['-x', 'anvil'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch {}
// `ps -o lstart=` is local time in a fixed format; Date parses it.
const oldest = pids.length
  ? Math.min(...pids.map(pid => Date.parse(execFileSync('ps', ['-o', 'lstart=', '-p', pid], { encoding: 'utf8' }).trim())))
  : Infinity;

let removed = 0, kept = 0, bytes = 0;
const size = path => { try { return Number(execFileSync('du', ['-sk', path], { encoding: 'utf8' }).split('\t')[0]) * 1024; } catch { return 0; } };
for (const name of readdirSync(dir)) {
  const path = resolve(dir, name);
  const created = statSync(path).birthtimeMs;
  if (created >= oldest) { kept += 1; continue; }
  bytes += size(path);
  rmSync(path, { recursive: true, force: true });
  removed += 1;
}
console.log(`Removed ${removed} Anvil temp directories (${(bytes / 2 ** 30).toFixed(1)} GiB); kept ${kept} that a running Anvil may own (${pids.length} running)`);
