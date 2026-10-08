// Visual-only simulation of a newly confirmed receipt. No transactions or API writes.
//
// Point it at a stack with ARC_CHECK_API / ARC_CHECK_SITE; `node SingleSparkContract/arc/local-preview-stack.mjs --run
// SingleSparkContract/arc/check-burn-animation-ui.mjs` provides a throwaway one with real keeper burns.
//
// Updated 2026-09-22: the countdown reads a token's newest burn from its snapshot `market.lastBurn`
// (the full `records` list left the snapshot), so the simulated receipt is placed there; the real
// burns behind the mocked round list come from the paged `GET /api/arc/candles`. English only.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const api = process.env.ARC_CHECK_API || 'http://127.0.0.1:8090';
const site = process.env.ARC_CHECK_SITE || 'http://127.0.0.1:5176';
const shots = process.env.ARC_CHECK_SCREENSHOTS || '/private/tmp';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const snapshot = await (await page.request.get(`${api}/api/arc/snapshot`)).json();
  const platform = snapshot.platformToken.toLowerCase();
  const burnsOf = async token => {
    const burns = [];
    for (let before, i = 0; ; i++) {
      assert(i < 50, 'More than 50 candle pages');
      const result = await (await page.request.get(`${api}/api/arc/candles?token=${token}&interval=1m&basis=price&limit=1000${before ? `&before=${before}` : ''}`)).json();
      burns.push(...result.burns);
      before = result.nextBefore;
      if (before == null) return burns.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
    }
  };
  const realBurns = Object.fromEntries(await Promise.all(snapshot.tokens.map(async item => [item.token.toLowerCase(), await burnsOf(item.token.toLowerCase())])));
  assert(realBurns[platform].length > 0, 'Requires a confirmed burn of the platform token');
  let simulated;
  let completedAt = snapshot.worker.lastCycleAt;
  await page.route('**/api/arc/snapshot', route => route.fulfill({ json: {
    ...snapshot, syncedAt: new Date().toISOString(), keeperEnabled: true,
    worker: { ...snapshot.worker, busy: false, remainingInRound: 0, pendingHash: null,
      lastCycleAt: completedAt, nextCheckAt: new Date(Date.now() + 12000).toISOString() },
    records: simulated ? [simulated, ...snapshot.records] : snapshot.records,
    tokens: snapshot.tokens.map(item => simulated && item.token.toLowerCase() === platform
      ? { ...item, market: { ...item.market, burns: item.market.burns + 1, lastBurn: simulated } } : item),
  } }));
  // This artwork check needs a visible confirmed burn; current history now includes empty rounds.
  await page.route('**/api/arc/burn/rounds?*', route => {
    const token = new URL(route.request().url()).searchParams.get('token');
    const records = realBurns[token] ?? [];
    return route.fulfill({ json: { chainId: snapshot.chainId, launch: snapshot.launch, token,
      interval: 180, total: records.length, burnCount: records.length, nextCursor: null,
      items: records.map(record => { const slot = Math.floor(Number(record.timestamp) / 180) * 180;
        return { round: Number(record.cycle), token, slot: String(slot), scheduledAt: String(slot),
          endsAt: String(slot + 180), checkedAt: record.timestamp, status: 'burned', reason: 'confirmed', record }; }) } });
  });
  await page.addInitScript(() => { localStorage.setItem('singlespark-intro-v1-seen', '1'); localStorage.setItem('jet-theme', 'dark'); });
  await page.goto(`${site}/burn`);
  await expect(page.locator('.arc-flame-stage')).toHaveAttribute('data-active', 'true');
  await expect(page.locator('.arc-live-flame')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('img.burn-icon[data-animated=true]').first()).toBeVisible();
  const frame = () => page.locator('.arc-flame-lottie svg').evaluate(el => el.innerHTML);
  const firstFrame = await frame();
  await expect.poll(frame).not.toBe(firstFrame);
  await expect(page.locator('.arc-burn-celebration')).toHaveCount(0);
  await page.locator('.arc-countdown').screenshot({ path: `${shots}/singlespark-flame-countdown.png` });
  completedAt = new Date().toISOString();
  await expect(page.locator('.arc-flame-stage')).toHaveAttribute('data-phase', 'extinguished', { timeout: 25000 });
  await expect(page.locator('.arc-burn-celebration')).toHaveCount(0);
  await page.locator('.arc-flame-grow').evaluate(el => el.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = 1100; }));
  await page.locator('.arc-countdown').screenshot({ path: `${shots}/singlespark-flame-extinguished.png` });
  await expect(page.locator('.arc-flame-stage')).toHaveAttribute('data-phase', 'charging', { timeout: 5000 });
  const burn = realBurns[platform][0];
  simulated = { ...burn, cycle: String(BigInt(burn.cycle) + 1n), timestamp: String(Math.floor(Date.now() / 1000)), transactionHash: `0x${'1'.repeat(64)}` };
  await expect(page.locator('.arc-burn-celebration')).toHaveCount(1, { timeout: 25000 });
  await expect(page.locator('.arc-fire-ember')).toHaveCount(36);
  assert.equal(await page.locator('.arc-burn-celebration').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
  // Freeze the actual CSS animations at their burst pose for deterministic visual inspection.
  await page.locator('.arc-burn-celebration').evaluate(el => el.getAnimations({ subtree: true }).forEach(animation => { animation.pause(); animation.currentTime = 430; }));
  await page.screenshot({ path: `${shots}/singlespark-burn-gift-burst.png` });
  await expect(page.locator('.arc-burn-celebration')).toHaveCount(0, { timeout: 5000 });
  await page.reload();
  await expect(page.locator('.arc-flame-stage')).toBeVisible();
  await expect(page.locator('.arc-burn-celebration')).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('.arc-countdown').screenshot({ path: `${shots}/singlespark-flame-mobile.png` });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const historyIcon = page.locator('.arc-burn-quantity .burn-icon').first();
  await historyIcon.scrollIntoViewIfNeeded();
  await expect(historyIcon).toHaveAttribute('data-animated', 'true');
  await expect(historyIcon).toHaveJSProperty('complete', true);
  const iconFrame = await historyIcon.screenshot();
  await page.waitForTimeout(250);
  assert(!iconFrame.equals(await historyIcon.screenshot()), 'History icon must animate the supplied artwork');
  await expect(page.locator('.arc-flame-lottie svg')).toHaveCount(1); // No player per row/icon.
  const offscreenFrame = await frame();
  await page.waitForTimeout(350);
  assert.equal(await frame(), offscreenFrame, 'Offscreen countdown must pause');
  await page.locator('.arc-countdown').scrollIntoViewIfNeeded();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.arc-flame-stage')).toHaveAttribute('data-active', 'false');
  assert.equal(await page.locator('.arc-live-flame').evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.waitForTimeout(100);
  const stillFrame = await frame();
  await page.waitForTimeout(350);
  assert.equal(await frame(), stillFrame, 'Reduced motion must pause Lottie itself');
  await expect(page.locator('img.burn-icon[data-animated=true]')).toHaveCount(0);
  await page.route('**/assets/jet/burn-flame.json', route => route.abort());
  const failedAsset = page.waitForEvent('requestfailed', { predicate: request => request.url().endsWith('/assets/jet/burn-flame.json') });
  await page.reload();
  await failedAsset;
  await expect(page.locator('.arc-live-flame')).toHaveAttribute('data-ready', 'false');
  await expect(page.locator('.arc-flame-lottie svg')).toHaveCount(0);
  assert.match(await page.locator('.arc-live-flame').evaluate(el => getComputedStyle(el).backgroundImage), /burn-gift-atlas/);
  assert.deepEqual(errors, []);
  console.log('PASS: supplied Lottie animates, countdown charging, empty round extinguishes, confirmed burn explodes, no replay, mobile, reduced motion pauses frames, PNG fallback.');
} finally { await browser.close(); }
