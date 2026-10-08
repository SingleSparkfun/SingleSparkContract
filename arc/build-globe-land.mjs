#!/usr/bin/env node
// Builds SingleSparkFront/front/static/assets/globe/land-points.bin: a deterministic set of
// lat/lon sample points that fall on land, for the dotted-globe visualization.
//
// Source data: world-atlas's `land-110m.json`, a TopoJSON conversion of
// Natural Earth 1:110m land polygons (public domain, no attribution required).
//
// Method:
//  1. Decode the TopoJSON topology into GeoJSON polygons with topojson-client.
//  2. Sample the sphere on an equal-area lat/lon grid: a fixed latitude step
//     (LAT_STEP_DEG), with the number of longitude samples on each latitude
//     ring scaled by cos(lat) so rings near the poles are not over-dense.
//  3. For every sample, run a point-in-polygon test (ray casting) against the
//     land polygons, honoring interior holes (e.g. inland seas) and the
//     antimeridian split that Natural Earth applies to polygons that would
//     otherwise cross +/-180 degrees longitude.
//  4. Write every land sample as little-endian Float32 pairs (lat, lon).
//
// Run: node SingleSparkContract/arc/build-globe-land.mjs
//
// The script is deterministic: the same grid and the same polygon data
// always produce the same output bytes (no randomness anywhere).

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { feature } from "topojson-client";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "front", "static", "assets", "globe");
const OUT_FILE = join(OUT_DIR, "land-points.bin");

// --- Tunable sampling parameters -------------------------------------------
// Fixed latitude step, in degrees, between sample rings (required to be
// equal-area alongside the cos(lat)-scaled longitude count below).
const LAT_STEP_DEG = 1.2;
// Number of longitude samples at the equator; scaled by cos(lat) at every
// other ring. Chosen so the resulting land point count lands in [8000, 14000].
const EQUATOR_LON_SAMPLES = 400;

const TARGET_MIN_POINTS = 8000;
const TARGET_MAX_POINTS = 14000;
const MAX_FILE_BYTES = 120 * 1024;

// --- Load the Natural Earth land polygons -----------------------------------
const topologyPath = require.resolve("world-atlas/land-110m.json");
const topology = JSON.parse(readFileSync(topologyPath, "utf8"));
const landGeometry = feature(topology, topology.objects.land);

/**
 * Normalize a longitude delta into (-180, 180], i.e. take the shortest
 * angular path between two longitudes. This is what lets us treat the
 * Natural Earth antimeridian-split rings (whose closing edge jumps from
 * ~+180 to -180, a raw delta of ~360 degrees but a true geographic
 * distance of ~0) as the short real edges they are.
 */
function shortestLonDelta(lon1, lon2) {
  let delta = lon2 - lon1;
  delta -= 360 * Math.round(delta / 360);
  return delta;
}

/**
 * Preprocess a GeoJSON ring (array of [lon, lat], closed: first === last)
 * into an "unwrapped" longitude sequence where every edge uses its true
 * short angular delta rather than a raw coordinate difference. This removes
 * the antimeridian-seam artifact without altering any other geometry.
 */
function prepareRing(ring) {
  const n = ring.length;
  const lons = new Float64Array(n);
  const lats = new Float64Array(n);
  lons[0] = ring[0][0];
  lats[0] = ring[0][1];
  for (let i = 1; i < n; i++) {
    const delta = shortestLonDelta(ring[i - 1][0], ring[i][0]);
    lons[i] = lons[i - 1] + delta;
    lats[i] = ring[i][1];
  }
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (let i = 0; i < n; i++) {
    if (lons[i] < minLon) minLon = lons[i];
    if (lons[i] > maxLon) maxLon = lons[i];
    if (lats[i] < minLat) minLat = lats[i];
    if (lats[i] > maxLat) maxLat = lats[i];
  }
  return { lons, lats, n, minLon, maxLon, minLat, maxLat };
}

const EPS = 1e-9;

/**
 * Ray-casting point-in-ring test that is aware of the antimeridian seam:
 * the ring's longitudes were unwrapped in prepareRing(), so we try testing
 * the point against the ring at its native longitude and at +/-360 degree
 * shifts, only bothering with a shift when it lands inside the ring's own
 * (unwrapped) longitude bounding box.
 */
function pointInRing(testLat, testLon, ring) {
  if (testLat < ring.minLat - EPS || testLat > ring.maxLat + EPS) return false;
  const { lons, lats, n, minLon, maxLon } = ring;
  for (const shift of [0, -360, 360]) {
    const candidateLon = testLon + shift;
    if (candidateLon < minLon - EPS || candidateLon > maxLon + EPS) continue;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = lats[i];
      const yj = lats[j];
      if (yi > testLat !== yj > testLat) {
        const xCross = lons[i] + ((testLat - yi) / (yj - yi)) * (lons[j] - lons[i]);
        if (xCross > candidateLon) inside = !inside;
      }
    }
    if (inside) return true;
  }
  return false;
}

// Each polygon is [outerRing, ...holeRings] per GeoJSON Polygon convention;
// a MultiPolygon is an array of such polygons.
const polygons = [];
for (const poly of landGeometry.features[0].geometry.coordinates) {
  const outer = prepareRing(poly[0]);
  const holes = poly.slice(1).map(prepareRing);
  polygons.push({ outer, holes });
}

function isLand(lat, lon) {
  for (const { outer, holes } of polygons) {
    if (!pointInRing(lat, lon, outer)) continue;
    let inHole = false;
    for (const hole of holes) {
      if (pointInRing(lat, lon, hole)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

// --- Equal-area lat/lon grid sampling ---------------------------------------
function sampleLandPoints() {
  const points = [];
  const latSteps = Math.round(180 / LAT_STEP_DEG);
  for (let i = 0; i <= latSteps; i++) {
    const lat = -90 + i * LAT_STEP_DEG;
    const latRad = (lat * Math.PI) / 180;
    const nLon = Math.round(EQUATOR_LON_SAMPLES * Math.cos(latRad));
    if (nLon < 1) continue; // poles: cos(lat) ~ 0, no ring to sample
    for (let j = 0; j < nLon; j++) {
      const lon = -180 + (j * 360) / nLon;
      if (isLand(lat, lon)) points.push([lat, lon]);
    }
  }
  return points;
}

const landPoints = sampleLandPoints();

// --- Write the binary asset ---------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true });
const buffer = Buffer.alloc(landPoints.length * 2 * 4);
for (let i = 0; i < landPoints.length; i++) {
  const [lat, lon] = landPoints[i];
  buffer.writeFloatLE(lat, i * 8);
  buffer.writeFloatLE(lon, i * 8 + 4);
}
writeFileSync(OUT_FILE, buffer);

console.log(`land points: ${landPoints.length}`);
console.log(`file size: ${buffer.length} bytes (${(buffer.length / 1024).toFixed(2)} KB)`);
console.log(`latitude step: ${LAT_STEP_DEG} deg, equator longitude samples: ${EQUATOR_LON_SAMPLES}`);

if (landPoints.length < TARGET_MIN_POINTS || landPoints.length > TARGET_MAX_POINTS) {
  throw new Error(
    `land point count ${landPoints.length} is outside the target range [${TARGET_MIN_POINTS}, ${TARGET_MAX_POINTS}]`,
  );
}
if (buffer.length > MAX_FILE_BYTES) {
  throw new Error(`file size ${buffer.length} bytes exceeds the ${MAX_FILE_BYTES} byte budget`);
}

// --- Self-check: known land/ocean reference points --------------------------
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nearestLandDistanceKm(lat, lon) {
  let best = Infinity;
  for (const [pLat, pLon] of landPoints) {
    const d = haversineKm(lat, lon, pLat, pLon);
    if (d < best) best = d;
  }
  return best;
}

const landChecks = [
  { name: "Shanghai", lat: 31.2, lon: 121.5, maxKm: 150 },
  { name: "Paris", lat: 48.9, lon: 2.3, maxKm: 150 },
  { name: "Sao Paulo", lat: -23.5, lon: -46.6, maxKm: 150 },
];
const oceanChecks = [
  { name: "mid-Pacific", lat: 0, lon: -150, minKm: 500 },
  { name: "South Atlantic", lat: -40, lon: -20, minKm: 500 },
];

console.log("\nself-check (nearest land point distance):");
for (const { name, lat, lon, maxKm } of landChecks) {
  const d = nearestLandDistanceKm(lat, lon);
  console.log(`  ${name} (${lat}, ${lon}): ${d.toFixed(1)} km`);
  if (!(d < maxKm)) {
    throw new Error(`assertion failed: ${name} nearest land point is ${d.toFixed(1)} km away, expected < ${maxKm} km`);
  }
}
for (const { name, lat, lon, minKm } of oceanChecks) {
  const d = nearestLandDistanceKm(lat, lon);
  console.log(`  ${name} (${lat}, ${lon}): ${d.toFixed(1)} km`);
  if (!(d > minKm)) {
    throw new Error(`assertion failed: ${name} nearest land point is only ${d.toFixed(1)} km away, expected > ${minKm} km`);
  }
}

console.log("\nall self-checks passed");
