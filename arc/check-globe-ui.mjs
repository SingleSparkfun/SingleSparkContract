// The Spark Globe page in a real browser: node SingleSparkContract/arc/check-globe-ui.mjs <origin>
//
// `SingleSparkContract/arc/check-globe.mjs --ui` starts a throwaway Anvil chain, the real backend and a Vite dev
// server on temporary ports and then runs this script against them; what it asserts (which cities
// are lit, how many memes each holds, the order they rank in) is described by GLOBE_UI_FIXTURE.
// Every meme behind it is synthetic — see the header of check-globe.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

const entry = (process.argv[2] ?? 'http://127.0.0.1:5176').replace(/\/+$/, '');
const fixture = JSON.parse(process.env.GLOBE_UI_FIXTURE
  ?? assert.fail('This check needs GLOBE_UI_FIXTURE from check-globe.mjs --ui'));
const shots = resolve('SingleSparkContract/arc/data/globe-ui-check');
mkdirSync(shots, { recursive: true });
const watched = new Set([new URL(entry).origin, new URL(fixture.api).origin]);
// A request the page itself cancelled (a reload, an unmounted query) is not a failure; a server or
// network failure arrives as a connection error or a status of 400 and up, both still asserted.
const CANCELLED = 'net::ERR_ABORTED';
const SEEN_KEY = 'singlespark-intro-v1-seen';

const problems = [];
const errors = [];
const failed = [];
const strayed = [];
const consoleErrors = [];

const browser = await chromium.launch({ channel: 'chrome', headless: true });

/** One page, wired to the same reporters, with the first-visit introduction already marked read.
 *  `devIp` adds the development address header to this backend's requests and to nothing else: as a
 *  context-wide `extraHTTPHeaders` it would also be attached to the Google Fonts requests, whose
 *  preflight then refuses it and leaves every screenshot in a fallback font. */
const openPage = async ({ expectedConsole, devIp, ...options } = {}) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ...options });
  if (devIp) {
    await page.route(`${new URL(fixture.api).origin}/**`, route =>
      route.continue({ headers: { ...route.request().headers(), 'x-arc-dev-ip': devIp } }));
  }
  await page.addInitScript(key => {
    try { localStorage.setItem(key, '1'); } catch { /* A page without storage still renders. */ }
  }, SEEN_KEY);
  page.on('pageerror', error => errors.push(error.message));
  // `expectedConsole` is the one allowance: the page that has WebGL taken away from it, where the
  // browser and three.js both say so out loud. Everything else is a failure of this check.
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (expectedConsole?.test(message.text())) return;
    consoleErrors.push(message.text());
  });
  page.on('requestfailed', request => {
    if (!watched.has(new URL(request.url()).origin)) return;
    const why = request.failure()?.errorText;
    if (why !== CANCELLED) failed.push({ url: request.url(), why });
  });
  page.on('response', response => {
    if (response.status() >= 400 && watched.has(new URL(response.url()).origin)) {
      failed.push({ url: response.url(), why: response.status() });
    }
  });
  // The temporary page must never reach the developer's own stack on 5176 / 8090.
  page.on('request', request => {
    if (['5176', '8090'].includes(new URL(request.url()).port)) strayed.push(request.url());
  });
  return page;
};

/** The globe page, loaded and drawn, with its test hook installed. */
const openGlobe = async page => {
  await page.goto(`${entry}/globe`);
  await expect(page.locator('main.globe-page h1')).toHaveText('Spark Globe');
  await expect(page.locator('.globe-canvas')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__globeTest?.markerCount() ?? -1),
    { timeout: 20_000 }).toBe(fixture.markerCount);
  // The Earth photograph has to be what is on the sphere; 'dots' means it failed to load and the
  // page fell back to the land mask it used before.
  await expect.poll(() => page.evaluate(() => window.__globeTest?.surface() ?? ''),
    { timeout: 20_000 }).toBe('texture');
  // A few frames for the screen-space clusters the picker uses (they follow the turning globe at
  // about five updates a second).
  await page.waitForTimeout(700);
};

/** What the canvas really drew, decoded in the browser: a flat rectangle is not a globe. */
const canvasPixels = async page => {
  const shot = (await page.locator('.globe-canvas').screenshot({ omitBackground: true })).toString('base64');
  return page.evaluate(async data => {
    const image = new Image();
    await new Promise((ok, fail) => { image.onload = ok; image.onerror = fail; image.src = `data:image/png;base64,${data}`; });
    const off = document.createElement('canvas');
    off.width = image.naturalWidth;
    off.height = image.naturalHeight;
    const context = off.getContext('2d');
    context.drawImage(image, 0, 0);
    const { data: pixels } = context.getImageData(0, 0, off.width, off.height);
    const counts = new Map();
    let opaque = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] <= 8) continue;
      opaque += 1;
      const colour = (pixels[index] << 16) | (pixels[index + 1] << 8) | pixels[index + 2];
      counts.set(colour, (counts.get(colour) ?? 0) + 1);
    }
    const dominant = Math.max(0, ...counts.values());
    return { width: off.width, height: off.height, total: pixels.length / 4, opaque,
      colours: counts.size, dominantShare: opaque ? dominant / opaque : 1 };
  }, shot);
};

/** Loaded is not painted: these avatars are `decoding="async"`, and a large one can still be a white
 *  box in the frame a screenshot catches. `decode()` resolves once it is ready to paint. */
const awaitAvatars = async panel => {
  await expect(panel.locator('.globe-memes img')).not.toHaveCount(0);
  await panel.locator('.globe-memes img')
    .evaluateAll(images => Promise.all(images.map(image => image.decode().catch(() => {}))));
};

const canvasHash = async page =>
  createHash('sha256').update(await page.locator('.globe-canvas').screenshot()).digest('hex');

const overflow = async (page, label) => {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (extra > 0) {
    problems.push(`Horizontal overflow of ${extra}px ${label}: ` + await page.locator('main *').evaluateAll(
      elements => elements.filter(element => element.getBoundingClientRect().right > innerWidth + 1)
        .map(element => element.className).slice(0, 8).join(', ')));
  }
};

try {
  // ------------------------------------------------- Direct load, the scene, and the city panel
  // The first navigation of the session goes straight to /globe: the route has to bring its own
  // styles, the way the Satisfaction route had to learn to.
  const page = await openPage({ reducedMotion: 'no-preference' });
  await openGlobe(page);
  const stage = page.locator('.globe-stage');
  await expect(stage).toHaveCSS('border-radius', '16px'); // .arc-surface, from pages/Arc/market.css
  const background = await stage.evaluate(element => getComputedStyle(element).backgroundColor);
  assert(!['rgba(0, 0, 0, 0)', 'transparent'].includes(background),
    `A direct load left the globe stage unstyled: ${background}`);
  await expect(page.locator('.globe-hidden-badge')).toHaveText(`Hidden location · ${fixture.hidden}`);
  const stats = page.locator('.globe-stats > div dd');
  await expect(stats).toHaveCount(3);
  await expect(stats.nth(0)).toHaveText(String(fixture.markerCount));

  const drawn = await canvasPixels(page);
  assert(drawn.opaque > drawn.total * 0.2,
    `The globe canvas is all but transparent: ${drawn.opaque}/${drawn.total} pixels`);
  // A photograph of the Earth, not the flat two-tone ball the dotted land mask used to draw: a
  // satellite mosaic runs to tens of thousands of distinct colours (86,950 when this was written,
  // against the old rendering's handful), and no one colour owns the frame. The dominant share is
  // mostly the stage around the disc, so it is only asked to stay well clear of a flat fill.
  assert(drawn.colours >= 2_000 && drawn.dominantShare < 0.8,
    `The globe canvas does not look like a photograph: ${drawn.colours} colours, dominant ${(drawn.dominantShare * 100).toFixed(1)}%`);

  // Country names, written into the overlay above the canvas and kept clear of one another.
  const named = await page.evaluate(() => window.__globeTest.labels());
  assert(named.length >= 8, `Only ${named.length} country names are drawn: ${named.join(', ')}`);
  assert(new Set(named).size === named.length, `A country name is drawn twice: ${named.join(', ')}`);
  for (const name of named) {
    if (name.includes('.')) problems.push(`An abbreviated country name reached the globe: ${name}`);
  }
  const boxes = await page.locator('.globe-labels .globe-label')
    .evaluateAll(nodes => nodes.filter(node => node.style.visibility !== 'hidden')
      .map(node => { const box = node.getBoundingClientRect(); return [box.left, box.top, box.right, box.bottom]; }));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const [aL, aT, aR, aB] = boxes[i];
      const [bL, bT, bR, bB] = boxes[j];
      if (aL < bR && bL < aR && aT < bB && bT < aB) problems.push(`Two country names overlap: ${named[i]} / ${named[j]}`);
    }
  }
  // The overlay must never eat a gesture meant for the globe.
  await expect(page.locator('.globe-labels')).toHaveCSS('pointer-events', 'none');

  // The city flames are HTML buttons over the canvas, so they can play the site's animated flame and
  // can be reached from the keyboard. One per city, and the ones near the middle of the view move.
  await expect(page.locator('.globe-flames button.globe-flame')).toHaveCount(fixture.markerCount);
  await expect.poll(() => page.evaluate(() => window.__globeTest.flames().shown)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__globeTest.flames().animating)).toBeGreaterThan(0);
  const playing = page.locator('.globe-flame:not([hidden]) .globe-flame-art').first();
  // Since 41658d4 a city is marked with the SingleSpark mark, not the burn flame; that mark has no
  // animated version yet, so FLAME_ANIMATED and FLAME_STILL in GlobeScene.ts are the same thumbnail.
  assert.match(await playing.getAttribute('src'), /singlespark-glossy-v1-thumb\.png$/,
    'A flame near the middle of the view is not playing the animated flame');

  // Reading the canvas back scrolled it into view; the panel's own position is measured from the top.
  await page.evaluate(() => scrollTo(0, 0));
  const scrolledBefore = await page.evaluate(() => Math.round(scrollY));
  // The hook rotates the city to the front and hands back where its flame is now drawn.
  const spot = await page.evaluate(id => window.__globeTest.focus(id), fixture.shanghaiPlaceId);
  assert(spot && spot.x > 0 && spot.y > 0, `No screen position for the lit city: ${JSON.stringify(spot)}`);

  // A press that starts ON a flame and travels is the user turning the globe, not a pick: the
  // flames take no pointer events, so the drag reaches OrbitControls exactly as it always did.
  const flameX = async id => page.evaluate(placeId => {
    const flame = [...document.querySelectorAll('.globe-flame')].find(node => node.dataset.placeId === String(placeId));
    const box = flame?.getBoundingClientRect();
    return box ? Math.round(box.x + box.width / 2) : null;
  }, id);
  const beforeDrag = await flameX(fixture.shanghaiPlaceId);
  await page.mouse.move(Math.round(spot.x), Math.round(spot.y));
  await page.mouse.down();
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(Math.round(spot.x + step * 10), Math.round(spot.y));
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);
  const afterDrag = await flameX(fixture.shanghaiPlaceId);
  assert(afterDrag !== null && Math.abs(afterDrag - beforeDrag) > 40,
    `Dragging from a flame did not turn the globe (${beforeDrag} -> ${afterDrag})`);
  assert.equal(await page.locator('.globe-panel').count(), 0, 'Dragging from a flame opened a city');

  // ...while a press and release in the same place still picks the city.
  const picked = await page.evaluate(id => window.__globeTest.focus(id), fixture.shanghaiPlaceId);
  await page.mouse.click(Math.round(picked.x), Math.round(picked.y));
  const panel = page.locator('.globe-panel');
  await expect(panel).toBeVisible();
  assert.equal(await page.evaluate(() => Math.round(scrollY)), scrolledBefore,
    'Opening the city panel scrolled the page');
  // On a desktop the panel is docked in the rail, in place of the city list: it is a labelled
  // region, not a dialog, and it covers neither the globe nor the numbers above it.
  assert.equal(await panel.getAttribute('role'), 'region', 'The docked city panel is not a region');
  await expect(page.locator('.globe-rail .globe-panel')).toHaveCount(1);
  const panelBox = await panel.boundingBox();
  const stageBox = await page.locator('.globe-stage').boundingBox();
  const statsBox = await page.locator('.globe-stats').boundingBox();
  if (panelBox.x < stageBox.x + stageBox.width) problems.push('The city panel overlaps the globe');
  if (panelBox.y < statsBox.y + statsBox.height) problems.push('The city panel overlaps the statistics');
  await expect(panel.locator('h2')).toHaveText('Shanghai, China');
  await expect(panel.locator('.globe-panel-count')).toContainText(`${fixture.shanghaiCount} memes`);
  await expect(panel.locator('.globe-panel-sorted')).toHaveText('Sorted by market cap');
  const memes = panel.locator('.globe-memes a.globe-meme-main');
  await expect(memes).toHaveCount(10);
  for (const href of await memes.evaluateAll(links => links.map(link => link.getAttribute('href')))) {
    assert(/^\/token\/0x[0-9a-fA-F]{40}$/.test(href), `A meme does not link to its token: ${href}`);
  }
  // Every meme states its market cap and its shortened address, with the whole one for hovering.
  for (const row of await panel.locator('.globe-memes li.globe-meme').all()) {
    const cap = await row.locator('.globe-meme-cap [aria-label]').getAttribute('aria-label');
    assert(/ USDC$/.test(cap), `A meme's market cap is not an amount in USDC: ${cap}`);
    const short = await row.locator('.globe-meme-contract code').textContent();
    assert(/^0x[0-9a-f]{4}…[0-9a-f]{4}$/.test(short), `A meme's address is not shortened: ${short}`);
    const full = await row.locator('.globe-meme-contract code').getAttribute('title');
    assert(/^0x[0-9a-fA-F]{40}$/.test(full), `A meme's shortened address has no full address: ${full}`);
  }
  await expect(panel.locator('.globe-memes img')).toHaveCount(10);
  await expect.poll(() => panel.locator('.globe-memes img')
    .evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
  await awaitAvatars(panel);
  await page.screenshot({ path: resolve(shots, 'globe-city-panel-1440-light.png') });

  // Attribution. The geolocation and city credits come from the API, so their wording is the
  // backend's; these two are the page's own, for the photograph on the sphere and the map data
  // behind the borders and names. Both sources are public domain and are credited anyway.
  for (const [name, href] of [
    ['Earth imagery: NASA Earth Observatory (Blue Marble)', 'https://visibleearth.nasa.gov/collection/1484/blue-marble'],
    ['Borders and names: Natural Earth', 'https://www.naturalearthdata.com'],
  ]) {
    await expect(page.locator('.globe-footer a', { hasText: name })).toHaveAttribute('href', href);
  }
  // The API's own credits are still there, whatever it calls them.
  await expect(page.locator('.globe-footer a[href="https://db-ip.com"]')).toHaveCount(1);
  await expect(page.locator('.globe-footer a[href="https://www.geonames.org"]')).toHaveCount(1);

  // Finding a meme by name takes the visitor to the city it was launched from, and says so.
  await panel.getByRole('button', { name: 'All cities' }).click();
  await page.getByLabel('Find a meme').fill(fixture.order[0]);
  await expect(page.locator('.globe-search-result').first()).toContainText('Shanghai, China');
  await page.locator('.globe-search-result').first().click();
  await expect(page.locator('.globe-found')).toHaveText(`${fixture.order[0]} was launched from Shanghai, China.`);
  assert.match(new URL(page.url()).search, /^\?token=0x[0-9a-f]{40}$/,
    `Choosing a meme did not make the view shareable: ${page.url()}`);
  await expect(panel).toBeVisible();

  const viewAll = panel.getByRole('button', { name: `View all ${fixture.shanghaiCount}` });
  await expect(viewAll).toHaveCount(1);
  await viewAll.click();
  const rows = panel.locator('.globe-panel-list .lst-row');
  await expect(rows).toHaveCount(fixture.shanghaiCount);
  const names = await panel.locator('.globe-panel-list .lst-token-name').allTextContents();
  assert.deepEqual(names, fixture.order, 'The city list is not in market cap order');
  await overflow(page, 'on the globe at 1440px');

  // ------------------------------------------------- Keyboard only
  const keyboard = await openPage({ reducedMotion: 'reduce' });
  await openGlobe(keyboard);
  const cityButtons = keyboard.locator('.globe-cities button.globe-city');
  await expect(cityButtons).toHaveCount(fixture.markerCount);
  let reached = false;
  for (let press = 0; press < 40 && !reached; press += 1) {
    await keyboard.keyboard.press('Tab');
    reached = await keyboard.evaluate(() => !!document.activeElement?.closest('.globe-cities'));
  }
  assert(reached, 'Tab never reached the city list');
  const focusedCity = await keyboard.evaluate(() => document.activeElement.textContent);
  await keyboard.keyboard.press('Enter');
  const keyboardPanel = keyboard.locator('.globe-panel');
  await expect(keyboardPanel).toBeVisible();
  await expect.poll(() => keyboard.evaluate(() => document.activeElement?.className ?? ''))
    .toContain('globe-panel');
  await keyboard.keyboard.press('Escape');
  await expect(keyboardPanel).toHaveCount(0);
  assert.equal(await keyboard.evaluate(() => document.activeElement.textContent), focusedCity,
    'Closing the panel did not return focus to the city that opened it');
  await keyboard.close();

  // ------------------------------------------------- Motion
  // Reduced motion: the globe holds still. The same page without it turns slowly, on its own, for
  // as long as nobody touches it.
  const still = await openPage({ reducedMotion: 'reduce' });
  await openGlobe(still);
  const firstStill = await canvasHash(still);
  await still.waitForTimeout(1_500);
  assert.equal(await canvasHash(still), firstStill, 'The globe rotated with prefers-reduced-motion: reduce');
  // The flames hold still too: the still frame, not the animation.
  assert.equal(await still.evaluate(() => window.__globeTest.flames().animating), 0,
    'A flame kept playing with prefers-reduced-motion: reduce');
  for (const src of await still.locator('.globe-flame-art').evaluateAll(images => images.map(image => image.getAttribute('src')))) {
    // The same file as the "animated" one for now (see above): `animating === 0` is what proves stillness.
    assert.match(src, /singlespark-glossy-v1-thumb\.png$/, `A flame shows another asset under reduced motion: ${src}`);
  }
  await still.close();

  const moving = await openPage({ reducedMotion: 'no-preference' });
  await openGlobe(moving);
  const firstMoving = await canvasHash(moving);
  await moving.waitForTimeout(1_500);
  assert.notEqual(await canvasHash(moving), firstMoving, 'The globe did not rotate on its own');
  // ...and it stops for the user: the turn pauses for five seconds after an interaction, so two
  // frames taken shortly after one are the same frame. (The scene's own pause/resume rule is unit
  // tested in SingleSparkFront/front/pages/Globe/sceneState.test.ts; this is the same rule in a real browser.)
  await moving.evaluate(id => window.__globeTest.focus(id), fixture.shanghaiPlaceId);
  await moving.waitForTimeout(1_200);
  const paused = await canvasHash(moving);
  await moving.waitForTimeout(400);
  assert.equal(await canvasHash(moving), paused, 'The globe kept turning while the user was working with it');
  await moving.close();

  // ------------------------------------------------- No WebGL at all
  const fallback = await openPage({ reducedMotion: 'reduce', expectedConsole: /webgl|WebGL/ });
  await fallback.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      return /webgl/i.test(String(type)) ? null : original.call(this, type, ...rest);
    };
  });
  await fallback.goto(`${entry}/globe`);
  await expect(fallback.locator('main.globe-page h1')).toHaveText('Spark Globe');
  await expect(fallback.locator('.globe-scene-note')).toBeVisible();
  await expect(fallback.locator('.globe-canvas')).toHaveCount(0);
  const fallbackCities = fallback.locator('.globe-cities button.globe-city');
  await expect(fallbackCities).toHaveCount(fixture.markerCount);
  await fallback.screenshot({ path: resolve(shots, 'globe-fallback-1440-light.png'), fullPage: true });
  await fallbackCities.first().click();
  await expect(fallback.locator('.globe-panel h2')).toHaveText('Shanghai, China');
  await fallback.close();

  // ------------------------------------------------- Both themes, desktop and phone
  for (const theme of ['light', 'dark']) {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(value => localStorage.setItem('jet-theme', value), theme);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect.poll(() => page.evaluate(() => window.__globeTest?.markerCount() ?? -1),
        { timeout: 20_000 }).toBe(fixture.markerCount);
      await page.waitForTimeout(1_200);
      await overflow(page, `at ${width}px (${theme})`);
      await page.screenshot({ path: resolve(shots, `globe-${width}-${theme}.png`), fullPage: true });
    }
  }

  // The bottom sheet: the same panel at phone width, opened from the keyboard-reachable list.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.setItem('jet-theme', 'light'));
  await page.reload();
  await page.locator('.globe-cities button.globe-city').first().click();
  const sheet = page.locator('.globe-panel');
  await expect(sheet).toBeVisible();
  // At phone width the panel is still a sheet over the page, and still portalled out of the
  // transformed shell — which is why it can sit on the bottom of the screen at all.
  assert.equal(await sheet.getAttribute('role'), 'dialog', 'The phone city sheet is not a dialog');
  assert.equal(await sheet.evaluate(node => node.parentElement === document.body), true,
    'The phone city sheet is not portalled to the body');
  await expect.poll(() => sheet.locator('.globe-avatars img')
    .evaluateAll(images => images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0)))
    .toBe(true);
  await awaitAvatars(sheet);
  const box = await sheet.boundingBox();
  if (box.width > 390) problems.push(`The city sheet is ${box.width}px wide at 390px`);
  if (Math.round(box.x) !== 0) problems.push(`The city sheet does not span the phone width (x=${box.x})`);
  // A sheet is only a sheet if it sits on the bottom of the screen, not on the bottom of the document.
  if (Math.round(box.y + box.height) !== 844) {
    problems.push(`The city sheet ends at y=${Math.round(box.y + box.height)} instead of the 844px viewport bottom`);
  }
  await page.screenshot({ path: resolve(shots, 'globe-city-sheet-390-light.png') });
  await overflow(page, 'with the city sheet open at 390px');

  await page.close();

  // ------------------------------------------------- The launch page switch
  const create = await openPage({ reducedMotion: 'reduce', devIp: fixture.devIp });
  await create.goto(`${entry}/create`);
  // A cross-origin request that the page itself marks with the header: the browser preflights it,
  // so this is the local-mode CORS allowance being exercised rather than asserted in a unit test.
  const probe = await create.evaluate(async ({ api, ip }) => {
    try {
      const response = await fetch(`${api}/api/arc/geo/me`, { headers: { 'X-Arc-Dev-Ip': ip } });
      return { status: response.status, body: await response.json() };
    } catch (error) { return { status: 0, error: String(error) }; }
  }, { api: fixture.api, ip: fixture.devIp });
  assert.equal(probe.status, 200, `The local-mode CORS preflight refused X-Arc-Dev-Ip: ${JSON.stringify(probe)}`);
  assert.equal(probe.body.city, fixture.devCity);

  const toggle = create.locator('#arc-show-location');
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeChecked();
  await expect(toggle).toHaveAttribute('role', 'switch');
  await expect(create.locator('.arc-create-globe-switch')).toContainText('Show my city on the globe');
  // The development address this page sends is the Paris one, so it says where it would appear.
  await expect(create.locator('#arc-globe-note')).toHaveText(`You'll appear in ${fixture.devCity}, France.`);
  await create.locator('.arc-create-globe').scrollIntoViewIfNeeded();
  await create.screenshot({ path: resolve(shots, 'create-location-switch-1440-light.png') });
  await create.close();

  // One report for the whole run: a single failure must not hide the others.
  assert.deepEqual({ pageErrors: errors, consoleErrors, failedRequests: failed,
    requestsToTheDevelopmentStack: strayed, layout: problems },
  { pageErrors: [], consoleErrors: [], failedRequests: [], requestsToTheDevelopmentStack: [], layout: [] });
  console.log(`PASS: /globe at ${entry} — direct-load styling, ${fixture.markerCount} flames, the Earth `
    + `photograph on the sphere (${drawn.colours} colours, dominant ${(drawn.dominantShare * 100).toFixed(1)}%), `
    + `${named.length} country names with no overlaps, animated flames, the docked Shanghai panel `
    + 'with market caps and addresses, a meme found by name, and all '
    + `${fixture.shanghaiCount} memes in market cap order, keyboard open and close, a globe that turns `
    + 'on its own and stops for the user, reduced motion honoured, a fallback list without WebGL, and '
    + `the launch switch. Screenshots in ${shots}.`);
} finally {
  await browser.close();
}
