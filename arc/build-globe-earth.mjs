#!/usr/bin/env node
// Builds the photographic Earth textures the Spark Globe wraps around its sphere:
//
//   SingleSparkFront/front/static/assets/globe/earth-2048.jpg   the one every visitor downloads
//   SingleSparkFront/front/static/assets/globe/earth-4096.jpg   fetched only after someone zooms right in
//
// Source: NASA Earth Observatory, "Blue Marble Next Generation" with topography and bathymetry,
// August 2004, equirectangular (plate carree), 5400x2700:
//   https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73776/world.topo.bathy.200408.3x5400x2700.jpg
// (August rather than the December mosaic: both are equally real, but in December the northern
// hemisphere is under snow, which reads as an ice planet on a small sphere.)
// Collection page: https://visibleearth.nasa.gov/collection/1484/blue-marble
// NASA imagery is public domain; the credit line the site shows is "NASA Earth Observatory".
//
// The only processing is a Lanczos downscale and a JPEG re-encode. The photograph is never tinted,
// repainted or stylised: what the globe shows is the satellite mosaic itself.
//
// Run: node SingleSparkContract/arc/build-globe-earth.mjs
//
// The download is cached, so a re-run is offline and deterministic for a given source file. Set
// GLOBE_EARTH_SOURCE=/path/to/world.topo.bathy...jpg to skip the download entirely (the script still
// checks the file's SHA-256 against SOURCE_SHA256 so an unexpected image cannot slip in).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "front", "static", "assets", "globe");

const SOURCE_URL =
  "https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73776/world.topo.bathy.200408.3x5400x2700.jpg";
const SOURCE_SHA256 = "f76d7b94445e8975a755c849ddaa93ed07b7e01118fb0b7e6bc5546a68c18d5c";
const SOURCE_WIDTH = 5400;
const SOURCE_HEIGHT = 2700;

const CACHE_DIR = join(tmpdir(), "singlespark-globe-earth");
const CACHE_FILE = join(CACHE_DIR, "world.topo.bathy.200408.3x5400x2700.jpg");

// 2048 wide is the default budget: the globe is never drawn wider than ~720 CSS px, so at the
// default camera distance a wider texture would only cost bytes and GPU memory. The 4096 version is
// for the one case where that stops being true — zoomed all the way in on one region — and the page
// only asks for it then.
const OUTPUTS = [
  { width: 2048, height: 1024, quality: 82, maxBytes: 450 * 1024 },
  { width: 4096, height: 2048, quality: 82, maxBytes: 1_200 * 1024 },
];

function download(url, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  execFileSync("curl", ["-sSfL", "--retry", "2", "-o", destination, url], { stdio: ["ignore", "inherit", "inherit"] });
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const override = process.env.GLOBE_EARTH_SOURCE;
const source = override ?? CACHE_FILE;
if (!existsSync(source)) {
  if (override) throw new Error(`GLOBE_EARTH_SOURCE does not exist: ${override}`);
  console.log(`downloading ${SOURCE_URL}`);
  download(SOURCE_URL, CACHE_FILE);
}
const sourceHash = sha256(source);
console.log(`source: ${source}`);
console.log(`source size: ${statSync(source).size} bytes`);
console.log(`source sha256: ${sourceHash}`);
if (SOURCE_SHA256 !== "" && !/^0+$/.test(SOURCE_SHA256) && sourceHash !== SOURCE_SHA256) {
  // Recorded from the NASA download on 2026-09-19; a mismatch means the served file changed, which
  // is worth a human look before it becomes the texture on the site.
  console.warn(`WARNING: source sha256 differs from the recorded ${SOURCE_SHA256}`);
}

// --- Resize with Pillow -------------------------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true });
const script = `
import sys
from PIL import Image
src, dst, w, h, q = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
image = Image.open(src)
print("opened %dx%d %s" % (image.width, image.height, image.mode))
if (image.width, image.height) != (${SOURCE_WIDTH}, ${SOURCE_HEIGHT}):
    raise SystemExit("unexpected source size %dx%d" % (image.width, image.height))
image = image.convert("RGB").resize((w, h), Image.LANCZOS)
image.save(dst, "JPEG", quality=q, optimize=True, progressive=True)
print("wrote %dx%d" % (w, h))
`;
const written = [];
for (const { width, height, quality, maxBytes } of OUTPUTS) {
  const outFile = join(OUT_DIR, `earth-${width}.jpg`);
  process.stdout.write(execFileSync(
    "python3", ["-c", script, source, outFile, String(width), String(height), String(quality)],
    { encoding: "utf8" },
  ));
  const bytes = statSync(outFile).size;
  console.log(`output: ${outFile}`);
  console.log(`output size: ${bytes} bytes (${(bytes / 1024).toFixed(2)} KB), quality ${quality}, progressive\n`);
  if (bytes > maxBytes) throw new Error(`output ${bytes} bytes exceeds the ${maxBytes} byte budget`);
  written.push(outFile);
}

// --- Self-check: the photograph must still be the right way up and the right way round -----------
// Equirectangular means pixel (column, row) is a known lat/lon; a handful of samples tell apart a
// correct image from one that is mirrored, upside down or rolled by 180 degrees of longitude.
const check = `
import sys
from PIL import Image
image = Image.open(sys.argv[1]).convert("RGB")
w, h = image.size
def at(lat, lon):
    x = min(w - 1, max(0, int((lon + 180.0) / 360.0 * w)))
    y = min(h - 1, max(0, int((90.0 - lat) / 180.0 * h)))
    return image.getpixel((x, y))
samples = {
    "Sahara (23N, 13E)": (23.0, 13.0),
    "Greenland ice (72N, 40W)": (72.0, -40.0),
    "Amazon (3S, 62W)": (-3.0, -62.0),
    "mid-Pacific (0N, 150W)": (0.0, -150.0),
    "Antarctica (82S, 0E)": (-82.0, 0.0),
}
out = {}
for name, (lat, lon) in samples.items():
    r, g, b = at(lat, lon)
    out[name] = (r, g, b)
    print("  %-26s rgb(%3d,%3d,%3d)" % (name, r, g, b))
def bright(p): return (p[0] + p[1] + p[2]) / 3.0
sahara, ice, amazon, ocean, ant = (out[k] for k in samples)
fails = []
if not (sahara[0] > 120 and sahara[0] > sahara[2] + 30): fails.append("the Sahara is not sandy")
if bright(ice) < 150: fails.append("Greenland is not bright ice")
if not (amazon[1] > amazon[0] and amazon[1] > amazon[2] + 15): fails.append("the Amazon is not green")
if not (ocean[2] > ocean[0] + 15 and bright(ocean) < 110): fails.append("the mid-Pacific is not dark blue")
if bright(ant) < 150: fails.append("Antarctica is not bright ice")
if fails:
    raise SystemExit("orientation/colour self-check failed: " + "; ".join(fails))
print("orientation/colour self-check passed")
`;
for (const file of written) {
  console.log(`self-check (equirectangular sample colours) for ${file}:`);
  process.stdout.write(execFileSync("python3", ["-c", check, file], { encoding: "utf8" }));
}
