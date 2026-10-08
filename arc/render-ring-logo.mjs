// Package the generated ring-logo frames as a smooth transparent animated WebP that reads as "loading".
// The generated keyframes advance unevenly and their ring segments sit a pixel or two apart, which showed as a
// speed-up, wobble and misaligned segments. So the flame and the ring shapes come from ONE generated frame (the
// fully lit one); segments light up one by one clockwise at constant speed, unlit segments take the grey sampled
// from the generated grey-ring frame, and only the sparks crossfade between neighbouring generated frames.
// Generated pixels are recoloured and composited; no shapes are drawn.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';

const prefix = process.argv[2] || 'SingleSparkFront/front/static/assets/brands/singlespark-ring-v1';
const frameMs = Number(process.argv[3] || 50), quality = Number(process.argv[4] || 75), size = 96;
const FILL = 38, FLARE = 10, COOL = 8, LIT = 11, GREY = 0, FADE = 1.2, START = 9;
const atlas = PNG.sync.read(readFileSync(`${prefix}-atlas.png`));
const directory = mkdtempSync('/private/tmp/singlespark-ring-');
assert.equal(atlas.width, atlas.height);
const cell = Math.floor(atlas.width / 4);

// Premultiplied-alpha blend so transparent pixels do not darken edges.
function mix(from, to, t, out, i) {
  const a0 = from[i + 3] * (1 - t), a1 = to[i + 3] * t, alpha = a0 + a1;
  for (let c = 0; c < 3; c++) out[i + c] = alpha ? Math.round((from[i + c] * a0 + to[i + c] * a1) / alpha) : 0;
  out[i + 3] = Math.round(alpha);
}

try {
  const keys = Array.from({ length: 16 }, (_, index) => {
    const frame = new PNG({ width: cell, height: cell });
    PNG.bitblt(atlas, frame, Math.round((index % 4) * atlas.width / 4), Math.round(Math.floor(index / 4) * atlas.height / 4), cell, cell, 0, 0);
    return frame.data;
  });
  // Ring geometry measured from the fully lit frame: left and bottom extremes are ring, never sparks.
  const lit = keys[LIT], alphaAt = (x, y) => lit[(y * cell + x) * 4 + 3];
  let minX = cell, maxY = 0, top = -1;
  for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) if (alphaAt(x, y) > 128) { minX = Math.min(minX, x); maxY = Math.max(maxY, y); }
  for (let y = 0; y < cell && top < 0; y++) for (let x = minX + 100; x < minX + 130; x++) if (alphaAt(x, y) > 128) { top = y; break; }
  const radius = (maxY - top) / 2, centerX = minX + radius, centerY = top + radius;
  const ringAngle = new Float32Array(cell * cell).fill(-1), inside = new Uint8Array(cell * cell);
  const occupied = new Uint16Array(720);
  for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
    const distance = Math.hypot(x - centerX, y - centerY), pixel = y * cell + x;
    if (distance < 0.8 * radius) inside[pixel] = 1;
    else if (distance <= 1.02 * radius) {
      ringAngle[pixel] = (Math.atan2(x - centerX, centerY - y) * 180 / Math.PI + 360) % 360;
      if (alphaAt(x, y) > 128) occupied[Math.floor(ringAngle[pixel] * 2) % 720]++;
    }
  }
  // Segments are the runs of occupied half-degree bins, ordered clockwise from 12 o'clock.
  // A gap bin holds far fewer opaque pixels than a bin across the middle of a segment.
  const floor = [...occupied].sort((left, right) => left - right)[360] * 0.45;
  const firstGap = occupied.findIndex(count => count < floor), centers = [];
  assert(firstGap >= 0, 'ring has no gaps');
  for (let offset = 1, from = -1; offset <= 720; offset++) {
    const bin = (firstGap + offset) % 720, filled = occupied[bin] >= floor;
    if (filled && from < 0) from = offset;
    if (!filled && from >= 0) { centers.push(((firstGap + (from + offset - 1) / 2) / 2) % 360); from = -1; }
  }
  centers.sort((left, right) => left - right);
  assert(centers.length >= 12 && centers.length <= 40, `unexpected segment count ${centers.length}`);
  const segment = new Int16Array(cell * cell).fill(-1);
  for (let pixel = 0; pixel < segment.length; pixel++) if (ringAngle[pixel] >= 0) {
    let best = 0, nearest = 360;
    centers.forEach((center, index) => {
      const gap = Math.abs(ringAngle[pixel] - center), span = Math.min(gap, 360 - gap);
      if (span < nearest) { nearest = span; best = index; }
    });
    segment[pixel] = best;
  }
  // Unlit colour: the mean of the generated grey ring pixels.
  const grey = [0, 0, 0]; let samples = 0;
  for (let pixel = 0; pixel < segment.length; pixel++) {
    const i = pixel * 4, source = keys[GREY];
    if (ringAngle[pixel] < 0 || source[i + 3] < 250 || Math.max(source[i], source[i + 1], source[i + 2]) - Math.min(source[i], source[i + 1], source[i + 2]) > 24) continue;
    for (let c = 0; c < 3; c++) grey[c] += source[i + c];
    samples++;
  }
  assert(samples > 500, 'grey ring sample');
  const unlit = Buffer.from(lit);
  for (let i = 0; i < unlit.length; i += 4) for (let c = 0; c < 3; c++) unlit[i + c] = Math.round(grey[c] / samples);

  const sequence = [];
  const emit = (position, level) => {
    const index = Math.floor(position) % 16, data = Buffer.alloc(cell * cell * 4);
    for (let pixel = 0; pixel < segment.length; pixel++) {
      const i = pixel * 4;
      if (inside[pixel]) lit.copy(data, i, i, i + 4);
      else if (segment[pixel] >= 0) mix(unlit, lit, level(segment[pixel]), data, i);
      else mix(keys[index], keys[(index + 1) % 16], position - Math.floor(position), data, i);
    }
    sequence.push(data);
  };
  for (let step = 0; step < FILL; step++) {
    // One more segment per constant time slice, each fading in briefly; sparks follow generated frames 1-11.
    const head = 1 + (centers.length - 1 + FADE) * (step / (FILL - 1));
    emit(step / FILL * 11, (index) => Math.min(1, Math.max(0, (head - index) / FADE)));
  }
  for (let step = 0; step < FLARE; step++) emit(11 + step / FLARE * 2, () => 1);
  for (let step = 0; step < COOL; step++) emit(13 + step / COOL * 3, (index) => index === 0 ? 1 : 1 - (step + 1) / COOL);
  console.log(`Ring: ${centers.length} segments at ${centers.map(center => Math.round(center)).join(' ')}, grey rgb(${grey.map(value => Math.round(value / samples)).join(', ')}).`);
  // The loop starts with the upper-right arc lit, matching the master, so the still and favicon are not a grey ring.
  const names = sequence.map((_, index) => {
    const frame = new PNG({ width: cell, height: cell });
    frame.data = sequence[(index + START) % sequence.length];
    const name = `${directory}/${String(index).padStart(3, '0')}.png`;
    writeFileSync(name, PNG.sync.write(frame));
    return name;
  });

  // Optional: keep the full-size frames, e.g. to build an opaque social GIF.
  if (process.env.RING_LOGO_FRAMES) names.forEach((name, index) => copyFileSync(name, `${process.env.RING_LOGO_FRAMES}/${String(index).padStart(3, '0')}.png`));
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', `${directory}/%03d.png`,
    '-vf', `scale=${size}:${size}:flags=lanczos`, '-fps_mode', 'passthrough', '-start_number', '0', `${directory}/frame%03d.png`], { stdio: 'inherit' });
  const frames = names.map((_, index) => `${directory}/frame${String(index).padStart(3, '0')}.png`);
  execFileSync('img2webp', ['-loop', '0', '-lossy', '-q', String(quality), '-m', '6', '-min_size', '-d', String(frameMs), ...frames, '-o', `${prefix}-icon.webp`], { stdio: 'inherit' });
  copyFileSync(names[0], `${prefix}-still.png`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(1000 / frameMs), '-i', `${directory}/frame%03d.png`,
    '-filter_complex', '[0:v]split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128',
    '-loop', '0', `${prefix}-preview.gif`], { stdio: 'inherit' });
  const info = execFileSync('webpmux', ['-info', `${prefix}-icon.webp`], { encoding: 'utf8' });
  assert.match(info, new RegExp(`Canvas size: ${size} x ${size}`));
  assert.match(info, /animation transparency/);
  assert.match(info, new RegExp(`Number of frames: ${frames.length}`));
  console.log(`Packaged ${frames.length} frames from 16 generated frames, ${frameMs} ms each, ${(frames.length * frameMs / 1000).toFixed(2)}s loop.`);
} finally { rmSync(directory, { recursive: true, force: true }); }
