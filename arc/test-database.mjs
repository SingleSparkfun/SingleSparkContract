// Shared by local Anvil checks; never connect test workers to the application database.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export function testDatabase(directory) {
  const url = process.env.ARC_TEST_DATABASE_URL || parseEnv(readFileSync(new URL('../../SingleSparkBackend/.env.postgres.local', import.meta.url), 'utf8')).ARC_TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test')) throw Error('Anvil checks require ARC_TEST_DATABASE_URL ending in _test');
  return { ARC_DATABASE_URL: url, ARC_DATABASE_SCHEMA: `test_${createHash('sha256').update(directory).digest('hex').slice(0, 24)}` };
}

// Every local check talks to its backend from one loopback address, which the page API's
// per-client budgets (ARC_LIMIT_*, SingleSparkBackend/api/src/limits.rs) would count as a single visitor.
// Those budgets are unit-tested there; a functional or capacity check opens them wide instead of
// pacing around them, so a 429 here always means something other than the budget.
export const localApiLimits = Object.fromEntries(
  ['READ', 'HISTORY', 'MEDIA', 'QUOTE', 'AUTH', 'WRITE', 'LAUNCH', 'ADMIN', 'ANALYTICS', 'OTHER']
    .flatMap(name => [[`ARC_LIMIT_${name}_PER_MINUTE`, '1000000'], [`ARC_LIMIT_${name}_BURST`, '100000']]));

// The RPC governor (ARC_RPC_MAX_RPS / ARC_RPC_BURST, SingleSparkBackend/api/src/rpc.rs) protects free public endpoints at 8
// requests a second. A local Anvil has no such limit, and a cold index of hundreds of pools at 8/s cannot finish in
// a check's time budget, so local checks lift it; checks that test the governor itself set their own values.
export const localRpcLimits = { ARC_RPC_MAX_RPS: '1000', ARC_RPC_BURST: '1000' };

export const sqlString = value => `'${String(value).replaceAll("'", "''")}'`;

export function testSql(directory, sql) {
  const env = testDatabase(directory);
  const url = new URL(env.ARC_DATABASE_URL);
  return execFileSync('psql', ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'], {
    env: { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: url.pathname.slice(1),
      PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) }, encoding: 'utf8',
    input: `SET search_path TO "${env.ARC_DATABASE_SCHEMA}";\n${sql};\n`,
  }).trim();
}

export const testRows = (directory, sql) => JSON.parse(testSql(directory,
  `SELECT COALESCE(json_agg(row_to_json(result)), '[]') FROM (${sql}) result`));
