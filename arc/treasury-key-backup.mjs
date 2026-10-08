// Backs up, and proves it can restore, the one key that opens every community treasury: the backend's
// ARC_TREASURY_ENCRYPTION_KEY. Each treasury's private key is sealed with it in PostgreSQL
// (`community_treasuries`, AES-256-GCM, see SingleSparkBackend/api/src/treasury.rs); lose this key and every
// treasury's funds stay where they are, unspendable.
//
//   node SingleSparkContract/arc/treasury-key-backup.mjs verify --env <runtime.env>
//       Opens every sealed treasury with the env's key and checks each opened key is that row's address.
//   node SingleSparkContract/arc/treasury-key-backup.mjs export --env <runtime.env> --out <backup.json>
//       Writes the key sealed under a passphrase (scrypt + AES-256-GCM), file mode 0600.
//   node SingleSparkContract/arc/treasury-key-backup.mjs check --env <runtime.env> --backup <backup.json>
//       The restore drill: opens the backup with the passphrase and proves the recovered key opens every
//       treasury. Only the env's database and schema are used, never its key.
//
// The passphrase is read from the terminal (never echoed), or from ARC_BACKUP_PASSPHRASE for automation.
// Nothing prints a key, a private key or the passphrase. Reads the database only; never writes to it.
// Keep the backup file and the passphrase apart and off this machine (e.g. file on offline media, passphrase
// in a password manager); either alone is useless, both together restore every treasury.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { privateKeyToAccount } from 'viem/accounts';

const KDF = { name: 'scrypt', N: 2 ** 17, r: 8, p: 1, keyLength: 32 };
const [command] = process.argv.slice(2);
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const fail = message => { console.error(message); process.exit(1); };

function loadEnv(path) {
  if (!path) fail('Missing --env <runtime.env>');
  const env = parseEnv(readFileSync(path, 'utf8'));
  const url = process.env.ARC_DATABASE_URL
    || parseEnv(readFileSync(new URL('.env.postgres.local', import.meta.url), 'utf8')).ARC_DATABASE_URL;
  if (!url) fail('Missing ARC_DATABASE_URL');
  const schema = env.ARC_DATABASE_SCHEMA || 'singlespark';
  if (!/^[a-z0-9_]{1,63}$/.test(schema)) fail('Invalid ARC_DATABASE_SCHEMA');
  return { env, url: new URL(url), schema };
}

function rows({ url, schema }) {
  const out = execFileSync('psql', ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'], {
    env: { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: url.pathname.slice(1),
      PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) }, encoding: 'utf8',
    input: `SET search_path TO "${schema}";
      SELECT COALESCE(json_agg(json_build_object('chainId', chain_id, 'creator', creator, 'requestId', request_id,
        'address', address, 'nonce', encode(nonce, 'hex'), 'sealed', encode(encrypted_key, 'hex'))), '[]')
      FROM community_treasuries;\n`,
  }).trim();
  return JSON.parse(out);
}

/** The associated data treasury.rs binds each sealed key to: chain, creator, request and address. */
const aad = row => `community-v1:${row.chainId}:${row.creator.toLowerCase()}:${row.requestId}:${row.address.toLowerCase()}`;

function openAll(key, list) {
  let opened = 0;
  for (const row of list) {
    const sealed = Buffer.from(row.sealed, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.nonce, 'hex'));
    decipher.setAAD(Buffer.from(aad(row)));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    let secret;
    try { secret = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]); }
    catch { fail(`The key does not open treasury ${row.address}`); }
    const address = privateKeyToAccount(`0x${secret.toString('hex')}`).address.toLowerCase();
    secret.fill(0);
    if (address !== row.address.toLowerCase()) fail(`Treasury ${row.address} opens to a different address`);
    opened += 1;
  }
  return opened;
}

const fingerprint = key => createHash('sha256').update('singlespark-treasury-key-fingerprint:').update(key).digest('hex').slice(0, 16);

async function passphrase(confirm) {
  if (process.env.ARC_BACKUP_PASSPHRASE) return process.env.ARC_BACKUP_PASSPHRASE;
  if (!process.stdin.isTTY) fail('Run in a terminal, or set ARC_BACKUP_PASSPHRASE');
  const ask = prompt => new Promise(done => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true); process.stdin.resume();
    let text = '';
    const onData = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); return done(text); }
        if (char === '\u0003') process.exit(130);
        if (char === '\u007f') text = text.slice(0, -1); else text += char;
      }
    };
    process.stdin.on('data', onData);
  });
  const first = await ask('Backup passphrase: ');
  if (confirm) {
    if (first.length < 12) fail('Use a passphrase of at least 12 characters');
    if (await ask('Repeat passphrase: ') !== first) fail('The passphrases differ');
  }
  return first;
}

const envKey = env => {
  const hex = env.ARC_TREASURY_ENCRYPTION_KEY;
  if (!/^[0-9a-fA-F]{64}$/.test(hex || '')) fail('ARC_TREASURY_ENCRYPTION_KEY is missing or not 32 bytes of hex');
  return Buffer.from(hex, 'hex');
};

if (command === 'verify') {
  const target = loadEnv(option('--env'));
  const key = envKey(target.env);
  const opened = openAll(key, rows(target));
  console.log(`ok: the key (fingerprint ${fingerprint(key)}) opens all ${opened} treasuries in schema ${target.schema}`);
} else if (command === 'export') {
  const target = loadEnv(option('--env'));
  const out = option('--out') || fail('Missing --out <backup.json>');
  const key = envKey(target.env);
  const opened = openAll(key, rows(target));
  const salt = randomBytes(16), nonce = randomBytes(12);
  const wrap = scryptSync(await passphrase(true), salt, KDF.keyLength, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 256 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', wrap, nonce);
  cipher.setAAD(Buffer.from(`singlespark-treasury-key-backup-v1:${target.schema}`));
  const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
  writeFileSync(resolve(out), JSON.stringify({
    version: 1, purpose: 'SingleSpark community treasury encryption key (ARC_TREASURY_ENCRYPTION_KEY)',
    schema: target.schema, createdAt: new Date().toISOString(), treasuriesAtBackup: opened, fingerprint: fingerprint(key),
    kdf: { ...KDF, salt: salt.toString('hex') }, cipher: 'aes-256-gcm', nonce: nonce.toString('hex'),
    ciphertext: ciphertext.toString('hex'), tag: cipher.getAuthTag().toString('hex'),
  }, null, 2) + '\n', { mode: 0o600 });
  console.log(`ok: wrote ${out} (fingerprint ${fingerprint(key)}, ${opened} treasuries). Now run "check" on it, then move it off this machine.`);
} else if (command === 'check') {
  const target = loadEnv(option('--env'));
  const backup = JSON.parse(readFileSync(option('--backup') || fail('Missing --backup <backup.json>'), 'utf8'));
  if (backup.version !== 1 || backup.kdf?.name !== 'scrypt' || backup.cipher !== 'aes-256-gcm') fail('Unknown backup format');
  if (backup.schema !== target.schema) fail(`The backup is for schema ${backup.schema}, the env names ${target.schema}`);
  const wrap = scryptSync(await passphrase(false), Buffer.from(backup.kdf.salt, 'hex'), backup.kdf.keyLength,
    { N: backup.kdf.N, r: backup.kdf.r, p: backup.kdf.p, maxmem: 256 * 1024 * 1024 });
  const decipher = createDecipheriv('aes-256-gcm', wrap, Buffer.from(backup.nonce, 'hex'));
  decipher.setAAD(Buffer.from(`singlespark-treasury-key-backup-v1:${backup.schema}`));
  decipher.setAuthTag(Buffer.from(backup.tag, 'hex'));
  let key;
  try { key = Buffer.concat([decipher.update(Buffer.from(backup.ciphertext, 'hex')), decipher.final()]); }
  catch { fail('Wrong passphrase, or the backup file was altered'); }
  if (fingerprint(key) !== backup.fingerprint) fail('The recovered key does not match the fingerprint recorded in the backup');
  const opened = openAll(key, rows(target));
  key.fill(0);
  console.log(`ok: restore drill passed — the key recovered from the backup opens all ${opened} treasuries in ${target.schema}`
    + (opened !== backup.treasuriesAtBackup ? ` (the backup was made when there were ${backup.treasuriesAtBackup})` : ''));
} else {
  fail('Usage: treasury-key-backup.mjs verify|export|check --env <runtime.env> [--out <file>] [--backup <file>]');
}
