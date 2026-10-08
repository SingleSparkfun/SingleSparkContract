// Back up the active local schema and media, restore into a new disposable database.
// Never starts a keeper or sends transactions. Encryption keys stay outside the backup.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { parseEnv } from 'node:util';
import { privateKeyToAccount } from 'viem/accounts';

process.umask(0o077);
const config = parseEnv(readFileSync(process.argv[2], 'utf8'));
const current = JSON.parse(readFileSync('SingleSparkContract/arc/deployments/arc-current-testnet.json')).deployment;
assert.equal(config.ARC_LAUNCH_ADDRESS.toLowerCase(), current.launch.toLowerCase());
const schema = config.ARC_DATABASE_SCHEMA;
assert.equal(schema, `arc_${current.launch.slice(2).toLowerCase()}`);
const url = new URL(config.ARC_DATABASE_URL || parseEnv(readFileSync('SingleSparkContract/arc/.env.postgres.local', 'utf8')).ARC_DATABASE_URL);
assert.equal(url.hostname, '127.0.0.1', 'This restore drill is for the existing local database');
assert.equal(url.pathname, '/singlespark');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = resolve(`SingleSparkContract/arc/data/readiness-${stamp}/backup`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const socket = resolve('SingleSparkContract/arc/data/postgres/socket');
const db = `spark_restore_${randomBytes(6).toString('hex')}_test`;
const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: 'singlespark',
  PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) };
const run = (command, args, extra = {}) => execFileSync(command, args, { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...extra });
const dump = join(directory, 'database.dump');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { startedAt: new Date().toISOString(), factory: current.launch, schema, status: 'running', directory,
  scope: 'Consistent pg_dump snapshot restored into an isolated local database; no keeper started',
  encryptionKeyIncluded: false };
// Compare actual COPY data, independent of dump timestamps, row order and random psql guards.
function fingerprints(path) {
  const sql = run('pg_restore', ['--data-only', '--no-owner', '--no-privileges', '--file=-', path]);
  const tables = {};
  for (const match of sql.matchAll(/^COPY ([^\n]+) FROM stdin;\n([\s\S]*?)^\\\.\n/gm)) {
    const rows = match[2].trimEnd().split('\n').filter(Boolean).sort();
    tables[match[1]] = { rows: rows.length, sha256: sha(rows.join('\n')) };
  }
  assert(Object.keys(tables).length >= 8, 'All application tables must be present');
  return tables;
}
function mediaFiles(directory, root = directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    assert(!entry.isSymbolicLink(), 'Media backup must not follow symlinks');
    return entry.isDirectory() ? mediaFiles(path, root) : [{ path: relative(root, path), sha256: sha(readFileSync(path)) }];
  }).sort((a, b) => a.path.localeCompare(b.path));
}
let created = false;
try {
  run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--schema=${schema}`, `--file=${dump}`]);
  const expected = fingerprints(dump);
  const media = resolve(config.ARC_DATA_DIR, 'media');
  const files = mediaFiles(media);
  cpSync(media, join(directory, 'media'), { recursive: true, errorOnExist: true });
  assert.deepEqual(mediaFiles(join(directory, 'media')), files);
  writeFileSync(join(directory, 'media-manifest.json'), JSON.stringify(files, null, 2) + '\n');
  run('createdb', ['-h', socket, '-U', process.env.USER, '--template=template0', db]);
  created = true;
  run('pg_restore', ['-h', socket, '-U', process.env.USER, '--dbname', db, '--exit-on-error', '--no-owner', '--no-privileges', dump]);
  const restoredDump = join(directory, 'restored.dump');
  run('pg_dump', ['-h', socket, '-U', process.env.USER, '--dbname', db, '--format=custom', '--no-owner', '--no-privileges', `--schema=${schema}`, `--file=${restoredDump}`]);
  assert.deepEqual(fingerprints(restoredDump), expected, 'Every restored table must match the backup byte-for-byte');
  const rows = JSON.parse(run('psql', ['-X', '-A', '-t', '-q', '-h', socket, '-U', process.env.USER, '-d', db, '-v', 'ON_ERROR_STOP=1'], {
    input: `SELECT coalesce(json_agg(row_to_json(t)), '[]') FROM ${schema}.community_treasuries t;\n`,
  }));
  const key = Buffer.from(config.ARC_TREASURY_ENCRYPTION_KEY, 'hex');
  assert.equal(key.length, 32);
  for (const row of rows) {
    const sealed = Buffer.from(row.encrypted_key.slice(2), 'hex');
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.nonce.slice(2), 'hex'));
    cipher.setAAD(Buffer.from(`community-v1:${row.chain_id}:${row.creator}:${row.request_id}:${row.address}`));
    cipher.setAuthTag(sealed.subarray(-16));
    const secret = Buffer.concat([cipher.update(sealed.subarray(0, -16)), cipher.final()]);
    try { assert.equal(privateKeyToAccount(`0x${secret.toString('hex')}`).address.toLowerCase(), row.address.toLowerCase()); }
    finally { secret.fill(0); }
  }
  key.fill(0);
  report.status = 'passed';
  report.tables = expected;
  report.restoredTreasuries = rows.length;
  report.mediaFiles = files.length;
  report.dumpSha256 = sha(readFileSync(dump));
} catch (error) {
  report.status = 'failed';
  // No subprocess stdout, SQL rows, ciphertext or environment values in public output.
  report.error = error.code || error.name;
  process.exitCode = 1;
} finally {
  if (created) run('dropdb', ['-h', socket, '-U', process.env.USER, db]);
  report.completedAt = new Date().toISOString();
  writeFileSync(join(directory, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync('SingleSparkContract/arc/deployments/backup-restore-20260918.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
