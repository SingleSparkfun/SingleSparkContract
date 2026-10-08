// Gives every inhabited country a place on the Spark Globe, including the ones with no city of
// 100,000 people in the committed table (SingleSparkBackend/api/geo/cities100k.tsv). Those countries used to
// have no coordinates at all, so a launch from them could only be recorded as unknown.
//
// For each such country this writes an anchor, the capital (GeoNames feature code PPLC) or, when
// the dump names no capital, the most populous place, as two extra columns on its row in
// SingleSparkBackend/api/geo/countries.tsv: `code, name, lat, lon`. A launch there is still shown at country
// level only; the anchor is where the country's spark is drawn, not a claim about the launcher's
// town. Countries that already have a 100k city keep their two-column row, and the city table is
// read, never rewritten, so no stored city id can move.
//
// Reads two public GeoNames exports (countryInfo.txt, cities500.zip) into the OS temp directory.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const COUNTRY_INFO_URL = 'https://download.geonames.org/export/dump/countryInfo.txt';
const CITIES_URL = 'https://download.geonames.org/export/dump/cities500.zip';
const GEO_DIR = resolve(import.meta.dirname, '../../SingleSparkBackend/api/geo');

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${url} -> HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Inhabited ISO codes from countryInfo.txt; comment lines start with `#`. */
function inhabitedCodes(text) {
  const codes = new Set();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('\t');
    const code = fields[0];
    const population = Number(fields[7]);
    if (!/^[A-Z]{2}$/.test(code)) throw new Error(`Malformed countryInfo row: "${line.slice(0, 40)}"`);
    if (Number.isFinite(population) && population > 0) codes.add(code);
  }
  return codes;
}

/** Capital, else the most populous place, per country code. */
function anchorsFrom(citiesText) {
  const best = new Map();
  citiesText.split('\n').forEach((line, index) => {
    if (!line) return;
    const fields = line.split('\t');
    if (fields.length < 15) throw new Error(`Malformed GeoNames row at line ${index + 1}`);
    const [, , asciiname, , latitude, longitude, , featureCode, countryCode] = fields;
    const population = Number(fields[14]);
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!/^[A-Z]{2}$/.test(countryCode) || !Number.isFinite(lat) || !Number.isFinite(lon)
      || lat < -90 || lat > 90 || lon < -180 || lon > 180 || !Number.isFinite(population)) {
      throw new Error(`Malformed GeoNames row at line ${index + 1}`);
    }
    const candidate = { name: asciiname, lat, lon, population, capital: featureCode === 'PPLC' };
    const current = best.get(countryCode);
    const better = !current
      || (candidate.capital && !current.capital)
      || (candidate.capital === current.capital && candidate.population > current.population);
    if (better) best.set(countryCode, candidate);
  });
  return best;
}

async function main() {
  const cityCodes = new Set(readFileSync(join(GEO_DIR, 'cities100k.tsv'), 'utf8')
    .split('\n').filter(Boolean).map(line => line.split('\t')[2]));
  const existing = new Map(readFileSync(join(GEO_DIR, 'countries.tsv'), 'utf8')
    .split('\n').filter(Boolean).map(line => { const [code, name] = line.split('\t'); return [code, name]; }));

  const workDir = mkdtempSync(join(tmpdir(), 'arc-geo-anchors-'));
  try {
    const countryInfo = new TextDecoder().decode(await fetchBytes(COUNTRY_INFO_URL));
    writeFileSync(join(workDir, 'cities500.zip'), await fetchBytes(CITIES_URL));
    const unzip = spawnSync('unzip', ['-o', '-q', join(workDir, 'cities500.zip'), '-d', workDir], { encoding: 'utf8' });
    if (unzip.status !== 0) throw new Error(`unzip failed: ${unzip.stderr.trim()}`);
    const anchors = anchorsFrom(readFileSync(join(workDir, 'cities500.txt'), 'utf8'));
    const names = new Intl.DisplayNames(['en'], { type: 'region' });

    const rows = new Map();
    for (const [code, name] of existing) {
      if (!cityCodes.has(code)) throw new Error(`countries.tsv lists ${code}, which has no 100k city; rebuild it from build-geo-cities.mjs first`);
      rows.set(code, `${code}\t${name}`);
    }
    const added = [];
    const missing = [];
    for (const code of [...inhabitedCodes(countryInfo)].sort()) {
      if (cityCodes.has(code)) continue;
      const anchor = anchors.get(code);
      if (!anchor) { missing.push(code); continue; }
      const name = names.of(code);
      if (!name || name === code) throw new Error(`No English display name for country code "${code}"`);
      rows.set(code, `${code}\t${name}\t${anchor.lat}\t${anchor.lon}`);
      added.push(`${code} ${name}: ${anchor.name}${anchor.capital ? ' (capital)' : ' (largest place)'}`);
    }
    const lines = [...rows.keys()].sort().map(code => rows.get(code));
    writeFileSync(join(GEO_DIR, 'countries.tsv'), lines.join('\n') + '\n');
    console.log(`Countries with a 100k city: ${existing.size}`);
    console.log(`Countries given an anchor: ${added.length}`);
    for (const line of added) console.log(`  ${line}`);
    if (missing.length) console.log(`Inhabited but no place in cities500 (still unknown): ${missing.join(', ')}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || String(error));
  process.exit(1);
});
