// Local HTTP snapshot reads plus isolated PostgreSQL writes. These are not on-chain TPS.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { testDatabase } from './test-database.mjs';

const dir = mkdtempSync(resolve(tmpdir(), 'spark-capacity-'));
const database = testDatabase(dir);
const url = new URL(database.ARC_DATABASE_URL);
const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: url.pathname.slice(1),
  PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) };
const sql = input => execFileSync('psql', ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'], { env, input, encoding: 'utf8' }).trim();
const report = { measuredAt: new Date().toISOString(), hardware: { cpu: cpus()[0]?.model, cores: cpus().length, memoryGiB: totalmem() / 2 ** 30 },
  http: [], database: [], caveat: 'Load generator and server share this machine. Snapshot reads are cached; isolated one-row commits are not chain ingestion or swap TPS.' };
report.method = { httpSecondsPerStage: 3, databaseSecondsPerStage: 5 };
// ARC_CHECK_API points this at another backend (e.g. a throwaway local stack from
// SingleSparkContract/arc/local-preview-stack.mjs). Since 2026-09-21 every API route, the snapshot included, is
// charged to a per-client budget (SingleSparkBackend/api/src/limits.rs): from one loopback address this load
// only measures the backend itself when that backend runs with the local check limits
// (test-database.mjs `localApiLimits`); against a backend with production budgets a 429 stops it.
const base = process.env.ARC_CHECK_API || 'http://127.0.0.1:8090';
report.api = base;
const first = await fetch(base + '/api/arc/snapshot'); assert(first.ok);
const payload = await first.text();
const view = JSON.parse(payload);
// The snapshot no longer carries the full trade list: `trades` is the newest 25 across all tokens and
// each token's `market.trades` is its indexed total.
report.snapshot = { bytes: Buffer.byteLength(payload), tokens: view.tokens.length, recentTrades: view.trades.length,
  indexedTrades: view.tokens.reduce((sum, token) => sum + Number(token.market?.trades ?? 0), 0) };
const measure = async (label, path, stages) => {
  for (const concurrency of stages) {
    const latency = [], statuses = {};
    const start = performance.now(), until = start + 3000;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (performance.now() < until) {
        const at = performance.now();
        try {
          const r = await fetch(base + path, { signal: AbortSignal.timeout(10000) }); await r.arrayBuffer();
          statuses[r.status] = (statuses[r.status] || 0) + 1;
        } catch { statuses.error = (statuses.error || 0) + 1; }
        latency.push(performance.now() - at);
      }
    }));
    const duration = (performance.now() - start) / 1000;
    latency.sort((a,b) => a-b);
    const row = { path: label, concurrency, requests: latency.length, rps: Math.round((statuses[200] || 0) / duration),
      p95Ms: +latency[Math.floor(latency.length * 0.95)].toFixed(2), statuses };
    report.http.push(row); console.log(JSON.stringify({ http: row }));
    assert.equal(Object.keys(statuses).join(','), '200', 'Stop if the API cannot handle the load');
  }
};
await measure('/api/arc/snapshot', '/api/arc/snapshot', [1, 10, 25, 50, 100, 200]);
// The chart and activity history left the snapshot for these paged routes; a page view now reads
// them too, so they are measured the same way (the platform token's newest page of each).
const platform = view.platformToken;
await measure('/api/arc/candles', `/api/arc/candles?token=${platform}&interval=1m&basis=mcap&limit=500`, [1, 10, 50, 100]);
await measure('/api/arc/trades', `/api/arc/trades?token=${platform}&limit=20`, [1, 10, 50, 100]);
const schema = database.ARC_DATABASE_SCHEMA;
try {
  report.postgresSettings = JSON.parse(sql("SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN ('fsync','full_page_writes','synchronous_commit','max_connections');"));
  sql(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".preflight(token bigint PRIMARY KEY, block bigint NOT NULL, native text NOT NULL);
    INSERT INTO "${schema}".preflight SELECT i,0,'500000000000000000' FROM generate_series(1,1000) i;`);
  const file = resolve(dir, 'write.sql');
  writeFileSync(file, `\\set token random(1,1000)\nUPDATE "${schema}".preflight SET block=block+1,native='500000000000000000' WHERE token=:token;\n`);
  for (const concurrency of [1, 8, 32]) {
    const out = execFileSync('pgbench', ['-n', '-M', 'prepared', '-c', String(concurrency), '-j', String(Math.min(concurrency,8)), '-T', '5', '-f', file], { env, encoding: 'utf8', timeout: 20000 });
    const row = { connections: concurrency, tps: +out.match(/tps = ([\d.]+)/)[1], meanLatencyMs: +out.match(/latency average = ([\d.]+)/)[1],
      failed: +(out.match(/number of failed transactions: (\d+)/)?.[1] || '0') };
    report.database.push(row); console.log(JSON.stringify({ database: row })); assert.equal(row.failed,0);
  }
  sql(`CREATE TABLE "${schema}".kv(key text PRIMARY KEY,value text NOT NULL); INSERT INTO "${schema}".kv VALUES('index','{}');`);
  report.checkpointWrites = [];
  for (const bytes of [2048, 1048576]) {
    const payload = randomBytes(bytes / 2).toString('hex');
    const sample = JSON.stringify({ synthetic: true, randomPayload: payload });
    const file = resolve(dir, `checkpoint-${bytes}.sql`);
    writeFileSync(file, `UPDATE "${schema}".kv SET value=json_build_object('synthetic',true,'randomPayload','${payload}','cursor',floor(random()*1000000000))::text WHERE key='index';\n`);
    const out = execFileSync('pgbench', ['-n', '-M', 'prepared', '-c', '1', '-j', '1', '-T', '5', '-f', file], { env, encoding: 'utf8', timeout: 20000 });
    const row = { payloadBytes: Buffer.byteLength(sample), connections: 1, tps: +out.match(/tps = ([\d.]+)/)[1],
      meanLatencyMs: +out.match(/latency average = ([\d.]+)/)[1], failed: +(out.match(/number of failed transactions: (\d+)/)?.[1] || '0') };
    assert.equal(row.failed, 0); report.checkpointWrites.push(row); console.log(JSON.stringify({ checkpoint: row }));
  }
  report.checkpointCaveat = 'Single connection replacing a text JSON checkpoint with a new cursor and random synthetic payload; includes PostgreSQL WAL/TOAST, excludes Rust serialization and RPC.';
} finally { sql(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`); }
const path = process.env.ARC_CAPACITY_REPORT || 'SingleSparkContract/arc/deployments/local-capacity-20260917.json';
writeFileSync(path, JSON.stringify(report,null,2)+'\n');
console.log(`Report: ${path}`);
