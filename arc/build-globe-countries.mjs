#!/usr/bin/env node
// Builds two assets for the Spark Globe:
//
//   SingleSparkFront/front/static/assets/globe/countries.json  [{ name, lat, lon, rank }, ...]
//   SingleSparkFront/front/static/assets/globe/borders.bin     little-endian Float32 line segments
//                                             (lat1, lon1, lat2, lon2 per segment)
//
// Source data: world-atlas's `countries-110m.json`, a TopoJSON conversion of Natural Earth 1:110m
// Admin 0 countries (public domain; the site credits "Natural Earth" anyway).
//
// Only INTERIOR borders are emitted: the photograph on the sphere already draws every coastline, so
// drawing the outlines again would only thicken them.
//
// Run: node SingleSparkContract/arc/build-globe-countries.mjs
//
// Deterministic: no randomness, fixed grids, fixed rounding. Self-checks (a) that no name still
// contains an abbreviating full stop, (b) that a handful of label points really land where the
// country is, and (c) that no border segment jumps across the antimeridian.

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { feature, mesh } from "topojson-client";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "front", "static", "assets", "globe");
const COUNTRIES_FILE = join(OUT_DIR, "countries.json");
const BORDERS_FILE = join(OUT_DIR, "borders.bin");

// --- The owner's editorial choices -----------------------------------------------------------
// Natural Earth ships these as separate features. Per the owner's decision (2026-09-19) they get no
// name label of their own, and no interior border line is drawn between such an entry and ANY of its
// neighbours, so the globe does not take a side on a disputed boundary. This is an editorial choice
// about what this website displays, not a claim about the underlying data: edit the list and re-run.
// The names are the exact `properties.name` strings in world-atlas/countries-110m.json.
const DISPUTED_NAMES = new Set([
  "Taiwan",
  "Kosovo",
  "Somaliland",
  "N. Cyprus",
  "W. Sahara",
]);

// Labelled nowhere useful on a rotating globe: uninhabited or far off any city the site shows. Their
// borders (they have none that are interior anyway) are unaffected.
const UNLABELLED_NAMES = new Set([
  "Antarctica",
  "Fr. S. Antarctic Lands",
  "Falkland Is.",
]);

// Natural Earth abbreviates a handful of names to fit a paper map. The globe has room for words.
// Anything still holding a "." after this map is applied fails the self-check below.
const READABLE_NAMES = new Map([
  ["Bosnia and Herz.", "Bosnia and Herzegovina"],
  ["Central African Rep.", "Central African Republic"],
  ["Dem. Rep. Congo", "DR Congo"],
  ["Dominican Rep.", "Dominican Republic"],
  ["Eq. Guinea", "Equatorial Guinea"],
  ["S. Sudan", "South Sudan"],
  ["Solomon Is.", "Solomon Islands"],
  ["United States of America", "United States"],
  ["eSwatini", "Eswatini"],
  // Unchanged on purpose: "Czechia" and "Côte d'Ivoire" are the countries' own current names.
]);

// --- Rank thresholds --------------------------------------------------------------------------
// rank 1 is drawn from furthest out, rank 5 only when the camera is close. The break points are the
// largest polygon's area in square kilometres; printed counts below make the spread easy to judge.
const RANK_AREA_KM2 = [2_500_000, 900_000, 300_000, 75_000];

const MAX_COUNTRIES_BYTES = 15 * 1024;
const MAX_BORDERS_BYTES = 250 * 1024;

const EARTH_RADIUS_KM = 6371.0088;
const DEG = Math.PI / 180;

// --- Geometry helpers ---------------------------------------------------------------------------

/** Shortest signed longitude delta, in degrees, so an antimeridian-split ring's closing edge is not
 *  mistaken for a 360 degree jump (the same trick build-globe-land.mjs uses). */
function shortestLonDelta(lon1, lon2) {
  let delta = lon2 - lon1;
  delta -= 360 * Math.round(delta / 360);
  return delta;
}

/** A GeoJSON ring ([lon, lat] pairs) with its longitudes unwrapped into one continuous run. */
function unwrapRing(ring) {
  const points = new Array(ring.length);
  let lon = ring[0][0];
  points[0] = [lon, ring[0][1]];
  for (let i = 1; i < ring.length; i += 1) {
    lon += shortestLonDelta(ring[i - 1][0], ring[i][0]);
    points[i] = [lon, ring[i][1]];
  }
  return points;
}

/** Spherical area of a ring in square kilometres, from the spherical excess of its edges. */
function ringAreaKm2(ring) {
  let total = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [lon1, lat1] = ring[j];
    const [lon2, lat2] = ring[i];
    total += (lon2 - lon1) * DEG * (2 + Math.sin(lat1 * DEG) + Math.sin(lat2 * DEG));
  }
  return Math.abs((total * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2);
}

/** Lambert azimuthal equal-area projection about (lat0, lon0), in kilometres. Equal-area is what an
 *  area-weighted centroid needs; over one country the distance distortion is small enough that the
 *  "how far from the nearest border" search below is meaningful too. */
function makeProjection(lat0, lon0) {
  const sinLat0 = Math.sin(lat0 * DEG);
  const cosLat0 = Math.cos(lat0 * DEG);
  const R = EARTH_RADIUS_KM;
  return {
    forward(lon, lat) {
      const dLon = shortestLonDelta(lon0, lon) * DEG;
      const sinLat = Math.sin(lat * DEG);
      const cosLat = Math.cos(lat * DEG);
      const denominator = 1 + sinLat0 * sinLat + cosLat0 * cosLat * Math.cos(dLon);
      // The antipode of the projection centre; no country reaches it from its own centre.
      const k = R * Math.sqrt(Math.max(0, 2 / Math.max(1e-12, denominator)));
      return [k * cosLat * Math.sin(dLon), k * (cosLat0 * sinLat - sinLat0 * cosLat * Math.cos(dLon))];
    },
    inverse(x, y) {
      const rho = Math.hypot(x, y);
      if (rho < 1e-9) return [lon0, lat0];
      const c = 2 * Math.asin(Math.min(1, rho / (2 * R)));
      const sinC = Math.sin(c);
      const cosC = Math.cos(c);
      const lat = Math.asin(cosC * sinLat0 + (y * sinC * cosLat0) / rho) / DEG;
      const lon = lon0 + Math.atan2(x * sinC, rho * cosLat0 * cosC - y * sinLat0 * sinC) / DEG;
      return [((lon + 540) % 360) - 180, lat];
    },
  };
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(x, y, projected) {
  if (!pointInRing(x, y, projected[0])) return false;
  for (let h = 1; h < projected.length; h += 1) if (pointInRing(x, y, projected[h])) return false;
  return true;
}

function distanceToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSq));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/** How far the point is from the polygon's nearest edge, in kilometres (its "clearance"). */
function clearance(x, y, projected) {
  let best = Infinity;
  for (const ring of projected) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const d = distanceToSegment(x, y, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
      if (d < best) best = d;
    }
  }
  return best;
}

/** The deepest interior point of the polygon: a coarse grid over its bounding box, then three rounds
 *  of refinement around the best cell. Deterministic, and good enough for a label anchor. */
function poleOfInaccessibility(projected) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of projected[0]) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  let best = null;
  let bestClearance = -Infinity;
  let steps = 48;
  for (let round = 0; round < 4; round += 1) {
    const stepX = (maxX - minX) / steps;
    const stepY = (maxY - minY) / steps;
    for (let i = 0; i <= steps; i += 1) {
      for (let j = 0; j <= steps; j += 1) {
        const x = minX + i * stepX;
        const y = minY + j * stepY;
        if (!pointInPolygon(x, y, projected)) continue;
        const value = clearance(x, y, projected);
        if (value > bestClearance) {
          bestClearance = value;
          best = [x, y];
        }
      }
    }
    if (!best) return null;
    // Zoom the window onto the best cell and search it more finely.
    const spanX = (maxX - minX) / steps;
    const spanY = (maxY - minY) / steps;
    minX = best[0] - spanX * 1.5;
    maxX = best[0] + spanX * 1.5;
    minY = best[1] - spanY * 1.5;
    maxY = best[1] + spanY * 1.5;
    steps = 12;
  }
  return { point: best, clearance: bestClearance };
}

// --- Label points -------------------------------------------------------------------------------

/**
 * A label anchor for one country: the area-weighted centroid of its LARGEST polygon when that
 * centroid sits comfortably inside it (a compact country reads best labelled at its middle), and
 * otherwise the polygon's deepest interior point, so a crescent, a sliver or an archipelago never
 * gets its name written on the sea.
 */
function labelPoint(polygonRings) {
  // Project about the polygon's bounding-box middle so the equal-area projection stays well behaved.
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  const unwrapped = polygonRings.map(unwrapRing);
  for (const [lon, lat] of unwrapped[0]) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const projection = makeProjection((minLat + maxLat) / 2, (((minLon + maxLon) / 2 + 540) % 360) - 180);
  const projected = unwrapped.map(ring => ring.map(([lon, lat]) => projection.forward(lon, lat)));

  // Area-weighted centroid of the outer ring minus its holes, in the equal-area plane.
  const ringCentroid = ring => {
    let area = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      area += cross;
      cx += (ring[j][0] + ring[i][0]) * cross;
      cy += (ring[j][1] + ring[i][1]) * cross;
    }
    area /= 2;
    if (Math.abs(area) < 1e-9) return { area: 0, cx: 0, cy: 0 };
    return { area, cx: cx / (6 * area), cy: cy / (6 * area) };
  };
  const outer = ringCentroid(projected[0]);
  let weight = outer.area;
  let cx = outer.cx * outer.area;
  let cy = outer.cy * outer.area;
  for (let h = 1; h < projected.length; h += 1) {
    const hole = ringCentroid(projected[h]);
    // Holes carry the opposite winding, so subtracting is a sign-aware addition.
    weight -= Math.abs(hole.area) * Math.sign(outer.area);
    cx -= hole.cx * Math.abs(hole.area) * Math.sign(outer.area);
    cy -= hole.cy * Math.abs(hole.area) * Math.sign(outer.area);
  }
  const centroid = Math.abs(weight) > 1e-9 ? [cx / weight, cy / weight] : null;

  const deepest = poleOfInaccessibility(projected);
  if (!deepest) {
    // Degenerate sliver: fall back to the centroid, or to the first vertex.
    const [lon, lat] = projection.inverse(...(centroid ?? projected[0][0]));
    return { lon, lat, how: "degenerate" };
  }
  if (centroid && pointInPolygon(centroid[0], centroid[1], projected)) {
    const centroidClearance = clearance(centroid[0], centroid[1], projected);
    // Close to as deep inside as the best point available: keep the familiar middle of the country.
    if (centroidClearance >= deepest.clearance * 0.7) {
      const [lon, lat] = projection.inverse(centroid[0], centroid[1]);
      return { lon, lat, how: "centroid" };
    }
  }
  const [lon, lat] = projection.inverse(deepest.point[0], deepest.point[1]);
  return { lon, lat, how: "interior" };
}

// --- Build --------------------------------------------------------------------------------------

const topologyPath = require.resolve("world-atlas/countries-110m.json");
const topology = JSON.parse(readFileSync(topologyPath, "utf8"));
const collection = feature(topology, topology.objects.countries);

const rankOf = areaKm2 => {
  for (let i = 0; i < RANK_AREA_KM2.length; i += 1) if (areaKm2 >= RANK_AREA_KM2[i]) return i + 1;
  return RANK_AREA_KM2.length + 1;
};

const countries = [];
const skipped = [];
const how = { centroid: 0, interior: 0, degenerate: 0 };
for (const item of collection.features) {
  const raw = item.properties.name;
  if (DISPUTED_NAMES.has(raw)) {
    skipped.push(`${raw} (disputed)`);
    continue;
  }
  if (UNLABELLED_NAMES.has(raw)) {
    skipped.push(`${raw} (unlabelled)`);
    continue;
  }
  const name = READABLE_NAMES.get(raw) ?? raw;
  const polygons = item.geometry.type === "Polygon" ? [item.geometry.coordinates] : item.geometry.coordinates;
  let largest = null;
  let largestArea = -Infinity;
  for (const rings of polygons) {
    const area = ringAreaKm2(unwrapRing(rings[0]));
    if (area > largestArea) {
      largestArea = area;
      largest = rings;
    }
  }
  const point = labelPoint(largest);
  how[point.how] += 1;
  countries.push({
    name,
    lat: Number(point.lat.toFixed(2)),
    lon: Number(point.lon.toFixed(2)),
    rank: rankOf(largestArea),
    _areaKm2: largestArea,
    _polygon: largest,
  });
}
countries.sort((a, b) => a.rank - b.rank || b._areaKm2 - a._areaKm2 || a.name.localeCompare(b.name));
const payload = countries.map(({ name, lat, lon, rank }) => ({ name, lat, lon, rank }));

mkdirSync(OUT_DIR, { recursive: true });
// One country per line: small, and a readable diff when the source data changes.
const json = `[\n${payload.map(entry => JSON.stringify(entry)).join(",\n")}\n]\n`;
writeFileSync(COUNTRIES_FILE, json);

// --- Interior borders -----------------------------------------------------------------------
const keep = (a, b) =>
  a !== b && !DISPUTED_NAMES.has(a.properties.name) && !DISPUTED_NAMES.has(b.properties.name);
const borderMesh = mesh(topology, topology.objects.countries, keep);

const segments = [];
let split = 0;
for (const line of borderMesh.coordinates) {
  for (let i = 1; i < line.length; i += 1) {
    const [lon1, lat1] = line[i - 1];
    const [lon2, lat2] = line[i];
    const delta = shortestLonDelta(lon1, lon2);
    if (Math.abs(lon2 - lon1) > 180) {
      // The pair really is on opposite sides of the seam: cut it at +/-180 so no segment is drawn
      // the long way round the globe.
      const edge = delta > 0 ? 180 : -180;
      const t = (edge - lon1) / delta;
      const latCross = lat1 + (lat2 - lat1) * t;
      segments.push([lat1, lon1, latCross, edge], [latCross, -edge, lat2, lon2]);
      split += 1;
      continue;
    }
    segments.push([lat1, lon1, lat2, lon2]);
  }
}

const buffer = Buffer.alloc(segments.length * 16);
segments.forEach((segment, index) => {
  for (let k = 0; k < 4; k += 1) buffer.writeFloatLE(segment[k], index * 16 + k * 4);
});
writeFileSync(BORDERS_FILE, buffer);

// --- Report ---------------------------------------------------------------------------------
const rankCounts = [1, 2, 3, 4, 5].map(rank => payload.filter(entry => entry.rank === rank).length);
console.log(`countries: ${payload.length} labelled (${collection.features.length} features in the source)`);
console.log(`skipped: ${skipped.length} — ${skipped.join(", ")}`);
console.log(`label points: ${how.centroid} area centroid, ${how.interior} deepest interior, ${how.degenerate} degenerate`);
console.log(`ranks 1..5: ${rankCounts.join(", ")}`);
console.log(`countries.json: ${json.length} bytes (${(json.length / 1024).toFixed(2)} KB)`);
console.log(`border segments: ${segments.length}${split ? ` (${split} split at the antimeridian)` : ""}`);
console.log(`borders.bin: ${buffer.length} bytes (${(buffer.length / 1024).toFixed(2)} KB)`);

// --- Self-checks --------------------------------------------------------------------------------
const failures = [];
for (const entry of payload) {
  if (entry.name.includes(".")) failures.push(`abbreviated name left in the output: ${entry.name}`);
  if (!(entry.lat >= -90 && entry.lat <= 90)) failures.push(`${entry.name}: latitude ${entry.lat} out of range`);
  if (!(entry.lon >= -180 && entry.lon <= 180)) failures.push(`${entry.name}: longitude ${entry.lon} out of range`);
  if (!(entry.rank >= 1 && entry.rank <= 5)) failures.push(`${entry.name}: rank ${entry.rank} out of 1..5`);
}
for (const name of [...DISPUTED_NAMES, ...UNLABELLED_NAMES]) {
  const mapped = READABLE_NAMES.get(name) ?? name;
  if (payload.some(entry => entry.name === mapped)) failures.push(`${mapped} should carry no label`);
}

const find = name => payload.find(entry => entry.name === name);
/** A rough "is this point inside that box" check for label anchors that have an obvious right answer. */
const boxes = [
  // The contiguous states, not Alaska and not the Gulf of Mexico.
  { name: "United States", lat: [30, 49], lon: [-122, -75] },
  // Metropolitan France, not French Guiana (which is at 4N, 53W).
  { name: "France", lat: [42, 51], lon: [-5, 8] },
  { name: "Russia", lat: [50, 75], lon: [40, 179] },
  { name: "China", lat: [22, 48], lon: [80, 125] },
  { name: "Brazil", lat: [-25, 2], lon: [-70, -40] },
  { name: "Australia", lat: [-38, -12], lon: [116, 150] },
  { name: "India", lat: [10, 32], lon: [70, 88] },
  { name: "Canada", lat: [50, 70], lon: [-125, -70] },
  { name: "Norway", lat: [58, 71], lon: [4, 31] },
  { name: "Chile", lat: [-52, -20], lon: [-75, -67] },
  { name: "Indonesia", lat: [-9, 6], lon: [95, 141] },
  { name: "DR Congo", lat: [-11, 5], lon: [13, 30] },
];
for (const box of boxes) {
  const entry = find(box.name);
  if (!entry) {
    failures.push(`${box.name} is missing from the output`);
    continue;
  }
  const inside = entry.lat >= box.lat[0] && entry.lat <= box.lat[1] && entry.lon >= box.lon[0] && entry.lon <= box.lon[1];
  console.log(`  ${box.name.padEnd(16)} ${entry.lat.toFixed(2)}, ${entry.lon.toFixed(2)}  rank ${entry.rank}  ${inside ? "ok" : "OUT OF BOX"}`);
  if (!inside) failures.push(`${box.name}: label at ${entry.lat}, ${entry.lon} is outside its expected box`);
}
for (const name of ["United States", "China", "Brazil", "Russia", "Australia", "India", "Canada"]) {
  const entry = find(name);
  if (entry && entry.rank !== 1) failures.push(`${name} should be rank 1, not ${entry.rank}`);
}
// The strongest check available: every rounded label point, tested straight against the country's
// own largest polygon in plain lon/lat, independently of the equal-area machinery that placed it.
// This is what keeps a sliver (Chile), a crescent (Norway) or an archipelago (Indonesia) honest.
function insideLonLat(lat, lon, rings) {
  const prepared = rings.map(unwrapRing);
  const hit = ring => {
    for (const shift of [0, -360, 360]) {
      const testLon = lon + shift;
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > lat !== yj > lat && testLon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  };
  if (!hit(prepared[0])) return false;
  for (let h = 1; h < prepared.length; h += 1) if (hit(prepared[h])) return false;
  return true;
}
const outside = countries.filter(entry => !insideLonLat(entry.lat, entry.lon, entry._polygon));
console.log(`\nlabel points verified inside their own polygon: ${countries.length - outside.length}/${countries.length}`);
for (const entry of outside) failures.push(`${entry.name}: label at ${entry.lat}, ${entry.lon} is not inside the country`);

for (const segment of segments) {
  if (Math.abs(segment[3] - segment[1]) > 180) {
    failures.push(`a border segment jumps the antimeridian: ${JSON.stringify(segment)}`);
    break;
  }
}
if (json.length > MAX_COUNTRIES_BYTES) failures.push(`countries.json ${json.length} bytes exceeds ${MAX_COUNTRIES_BYTES}`);
if (buffer.length > MAX_BORDERS_BYTES) failures.push(`borders.bin ${buffer.length} bytes exceeds ${MAX_BORDERS_BYTES}`);

if (failures.length) {
  console.error("\nself-checks FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nall self-checks passed");
