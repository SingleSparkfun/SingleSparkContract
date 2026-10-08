// Builds the committed city table the Spark Globe backend snaps launch locations to.
//
// Downloads GeoNames' cities15000 dump (cities with population >= 15,000, updated daily) to the
// OS temp directory, keeps only rows with population >= 100,000, and writes two small TSV files
// into the repository: the city table and the list of country names it references. No secrets or
// env files are touched; this script only reads a public GeoNames export and writes into
// SingleSparkBackend/api/geo/.
//
// It rewrites countries.tsv with two columns only; run build-geo-anchors.mjs afterwards so that
// countries with no 100k city get their capital back as a country-level place.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const SOURCE_URL = 'https://download.geonames.org/export/dump/cities15000.zip';
const MIN_POPULATION = 100_000;
const OUT_DIR = resolve(import.meta.dirname, '../../SingleSparkBackend/api/geo');

async function download(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${url} -> HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  writeFileSync(destPath, bytes);
}

function unzip(zipPath, destDir) {
  const result = spawnSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`unzip failed (exit ${result.status}): ${result.stderr.trim() || result.stdout.trim()}`);
}

/** Parses one tab-separated GeoNames row into the fields we keep. Throws on any malformed row
 * instead of skipping it, so a format change in the upstream dump is never silently ignored. */
function parseCityRow(line, lineNumber) {
  const fields = line.split('\t');
  if (fields.length < 15) {
    throw new Error(`Malformed GeoNames row at line ${lineNumber}: expected >= 15 tab-separated fields, got ${fields.length}`);
  }
  const geonameid = fields[0];
  const asciiname = fields[2];
  const latitude = fields[4];
  const longitude = fields[5];
  const countryCode = fields[8];
  const population = fields[14];
  if (!/^\d+$/.test(geonameid)) throw new Error(`Malformed GeoNames row at line ${lineNumber}: geonameid "${geonameid}" is not an integer`);
  if (!asciiname) throw new Error(`Malformed GeoNames row at line ${lineNumber}: empty asciiname`);
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new Error(`Malformed GeoNames row at line ${lineNumber}: countryCode "${countryCode}" is not a 2-letter code`);
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error(`Malformed GeoNames row at line ${lineNumber}: latitude "${latitude}" out of range`);
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error(`Malformed GeoNames row at line ${lineNumber}: longitude "${longitude}" out of range`);
  if (!/^\d+$/.test(population)) throw new Error(`Malformed GeoNames row at line ${lineNumber}: population "${population}" is not an integer`);
  return { geonameid: BigInt(geonameid), asciiname, countryCode, lat, lon, population: Number(population) };
}

function buildCityTable(rawText) {
  const lines = rawText.split('\n').filter(line => line.length > 0);
  const rows = lines.map((line, index) => parseCityRow(line, index + 1));
  const kept = rows.filter(row => row.population >= MIN_POPULATION);
  kept.sort((a, b) => (a.geonameid < b.geonameid ? -1 : a.geonameid > b.geonameid ? 1 : 0));
  return { totalRows: rows.length, kept };
}

function buildCountryTable(cities) {
  const codes = [...new Set(cities.map(city => city.countryCode))].sort();
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  return codes.map(code => {
    const name = names.of(code);
    if (!name || name === code) throw new Error(`No English display name for country code "${code}"`);
    return { code, name };
  });
}

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), 'arc-geo-cities-'));
  try {
    const zipPath = join(workDir, 'cities15000.zip');
    console.log(`Downloading ${SOURCE_URL} ...`);
    await download(SOURCE_URL, zipPath);
    unzip(zipPath, workDir);
    const txtPath = join(workDir, 'cities15000.txt');
    const rawText = readFileSync(txtPath, 'utf8');

    const { totalRows, kept } = buildCityTable(rawText);
    const countries = buildCountryTable(kept);

    const cityLines = kept.map(city => [city.geonameid.toString(), city.asciiname, city.countryCode, city.lat, city.lon, city.population].join('\t'));
    const countryLines = countries.map(country => `${country.code}\t${country.name}`);

    writeFileSync(join(OUT_DIR, 'cities100k.tsv'), cityLines.join('\n') + '\n');
    writeFileSync(join(OUT_DIR, 'countries.tsv'), countryLines.join('\n') + '\n');

    console.log(`GeoNames rows read: ${totalRows}`);
    console.log(`Cities kept (population >= ${MIN_POPULATION}): ${kept.length}`);
    console.log(`Countries referenced: ${countries.length}`);
    console.log('Next: node SingleSparkContract/arc/build-geo-anchors.mjs (countries without a 100k city need their anchor).');

    const sample = name => kept.find(city => city.asciiname === name);
    for (const name of ['Shanghai', 'Tokyo', 'New York City', 'Lagos', 'Sao Paulo']) {
      const city = sample(name);
      if (!city) {
        console.log(`Sanity check: "${name}" NOT FOUND`);
      } else {
        console.log(`Sanity check: ${name} -> ${city.countryCode} (${city.lat}, ${city.lon}), population ${city.population}`);
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || String(error));
  process.exit(1);
});
