// Package the 16 ImageGen frames as a transparent animated WebP; no artwork is drawn.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';

const prefix = process.argv[2] || 'SingleSparkFront/front/static/assets/brands/official-spark';
const atlas = PNG.sync.read(readFileSync(`${prefix}-atlas.png`));
const directory = mkdtempSync('/private/tmp/singlespark-official-');
assert.equal(atlas.width, atlas.height);
try {
  for (let index = 0; index < 16; index++) {
    const column = index % 4, row = Math.floor(index / 4);
    const left = Math.round(column * atlas.width / 4), top = Math.round(row * atlas.height / 4);
    const width = Math.round((column + 1) * atlas.width / 4) - left;
    const height = Math.round((row + 1) * atlas.height / 4) - top;
    const frame = new PNG({ width, height });
    PNG.bitblt(atlas, frame, left, top, width, height, 0, 0);
    writeFileSync(`${directory}/${String(index).padStart(2, '0')}.png`, PNG.sync.write(frame));
  }
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', `${directory}/%02d.png`,
    '-vf', 'scale=96:96:flags=lanczos', '-fps_mode', 'passthrough', '-start_number', '0', `${directory}/frame%02d.png`], { stdio: 'inherit' });
  const frames = Array.from({ length: 16 }, (_, index) => `${directory}/frame${String(index).padStart(2, '0')}.png`);
  execFileSync('img2webp', ['-loop', '0', '-lossless', '-d', '100', ...frames, '-o', `${prefix}-icon.webp`], { stdio: 'inherit' });
  copyFileSync(frames[0], `${prefix}-still.png`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '10', '-i', `${directory}/frame%02d.png`,
    '-filter_complex', '[0:v]split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128',
    '-loop', '0', `${prefix}-preview.gif`], { stdio: 'inherit' });
  const info = execFileSync('webpmux', ['-info', `${prefix}-icon.webp`], { encoding: 'utf8' });
  assert.match(info, /Canvas size: 96 x 96/);
  assert.match(info, /animation transparency/);
  assert.match(info, /Number of frames: 16/);
  console.log('Packaged 16 ImageGen frames: transparent 96px WebP, 1.6s loop, matching PNG and GIF preview.');
} finally { rmSync(directory, { recursive: true, force: true }); }
