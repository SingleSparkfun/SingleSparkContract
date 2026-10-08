// Transcode original TGS artwork; no shapes or replacement artwork are generated.
// Optional arguments: input.tgs output-prefix still-frame-index (at 30 fps).
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const input = process.argv[2] || 'SingleSparkFront/front/static/assets/jet/burn-flame.json';
const output = process.argv[3] || 'SingleSparkFront/front/static/assets/jet/burn-flame';
const raw = readFileSync(input);
const animation = JSON.parse(input.endsWith('.tgs') ? gunzipSync(raw).toString() : raw.toString());
const frameCount = Math.ceil((animation.op - animation.ip) / animation.fr * 30);
const directory = mkdtempSync('/private/tmp/singlespark-sticker-');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 96, height: 96 }, deviceScaleFactor: 1 });
  await page.setContent('<div id="flame" style="width:96px;height:96px"></div>');
  await page.addScriptTag({ path: 'node_modules/lottie-web/build/player/lottie_light_canvas.min.js' });
  await page.evaluate(animationData => new Promise(resolve => {
    window.flame = window.lottie.loadAnimation({ container: document.getElementById('flame'),
      renderer: 'canvas', loop: false, autoplay: false, animationData,
      rendererSettings: { dpr: 1 } });
    window.flame.addEventListener('DOMLoaded', resolve);
  }), animation);
  for (let index = 0; index < frameCount; index++) {
    const png = await page.evaluate(frame => {
      window.flame.goToAndStop(frame, true);
      return document.querySelector('canvas').toDataURL('image/png').split(',')[1];
    }, index * animation.fr / 30);
    writeFileSync(`${directory}/${String(index).padStart(3, '0')}.png`, Buffer.from(png, 'base64'));
  }
  console.log(`Rendered ${frameCount} original frames at 96px / 30fps: ${input}`);
} finally { await browser.close(); }
execFileSync('python3', ['-c', `
from pathlib import Path
from PIL import Image
import sys
directory, output, still = sys.argv[1:]
frames = [Image.open(p).convert('RGBA') for p in sorted(Path(directory).glob('*.png'))]
assert frames and all(frame.size == (96, 96) for frame in frames)
frames[int(still)].save(output + '-still.png')
frames[0].save(output + '-icon.webp', save_all=True, append_images=frames[1:],
    duration=[round((i+1)*1000/30)-round(i*1000/30) for i in range(len(frames))], loop=0, quality=85, method=4)
print('Saved animated WebP and matching still frame:', output)
`, directory, output, process.argv[4] || '0'], { stdio: 'inherit' });
rmSync(directory, { recursive: true });
