// Chart analytics in a real browser, read-only: node SingleSparkContract/arc/check-analytics-ui.mjs
//
// Point it at a stack with ARC_CHECK_API / ARC_CHECK_SITE; `node SingleSparkContract/arc/local-preview-stack.mjs --run
// SingleSparkContract/arc/check-analytics-ui.mjs` provides a throwaway one with synthetic trades and real keeper burns.
// No synthetic prices, burns or holders are injected: the expectations come from the same backend.
//
// Updated 2026-09-22 for the slimmed snapshot and the candlestick chart: the burns a token's chart can
// mark come from `market.burns` and `GET /api/arc/candles` (the snapshot's full `records` list is
// gone), holders from `GET /api/arc/holders`; the chart's intervals are 1m…D, its ranges 1D…All, and
// the site is English only.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const site = process.env.ARC_CHECK_SITE || process.argv[2] || 'http://127.0.0.1:5176';
const api = process.env.ARC_CHECK_API || 'http://127.0.0.1:8090';
const shots = process.env.ARC_CHECK_SCREENSHOTS || '/private/tmp';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const json = async (page, path) => {
  const response = await page.request.get(`${api}${path}`);
  assert.equal(response.status(), 200, path);
  return response.json();
};
/** Every burn the candles endpoint places on this token's 1m chart, all pages. */
const chartBurns = async (page, token) => {
  const burns = [];
  let before;
  for (let i = 0; i < 50; i++) {
    const result = await json(page, `/api/arc/candles?token=${token}&interval=1m&basis=mcap&limit=1000${before ? `&before=${before}` : ''}`);
    burns.push(...result.burns);
    before = result.nextBefore;
    if (before == null) return burns;
  }
  throw new Error('More than 50 candle pages');
};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let data;
  await expect.poll(async () => {
    const response = await page.request.get(`${api}/api/arc/snapshot`).catch(() => null);
    if (!response?.ok()) return false;
    data = await response.json();
    return data.tokens.some(item => item.token.toLowerCase() === data.platformToken.toLowerCase() && item.market?.burns > 0);
  }, { timeout: 300000, intervals: [3000] }).toBe(true);
  // Freeze one real snapshot so polling cannot move the expected values during the assertions.
  await page.route('**/api/arc/snapshot', route => route.fulfill({ json: data }));
  await page.addInitScript(() => {
    localStorage.setItem('singlespark-intro-v1-seen', '1');
    if (!localStorage.getItem('jet-theme')) localStorage.setItem('jet-theme', 'light');
    localStorage.removeItem('singlespark.chart.v1');
  });
  const token = data.tokens.find(item => item.token.toLowerCase() === data.platformToken.toLowerCase());
  const burns = await chartBurns(page, token.token);
  assert.equal(burns.length, token.market.burns, 'Every indexed burn lies inside a real candle window');
  const holders = await json(page, `/api/arc/holders?token=${token.token}&limit=1000`);
  assert(holders.points.length > 0, 'Requires real holder observations');
  assert.equal(holders.points.at(-1).holders, token.holders, 'The newest holder observation is the indexed count');

  await page.goto(`${site}/token/${token.token}`);
  const market = page.locator('.arc-market');
  await expect(market).toHaveAttribute('data-token', token.token);
  const metrics = page.getByRole('group', { name: 'Chart metric' });
  const intervals = page.getByRole('group', { name: 'Candle interval' });
  const ranges = page.getByRole('group', { name: 'Chart time range' });
  await expect(metrics).toHaveClass(/segmented-tabs/);
  await expect(metrics.getByRole('button')).toHaveText(['Burns', 'Holders']);
  await expect(intervals.getByRole('button')).toHaveText(['1m', '5m', '15m', '1h', '4h', 'D']);
  await expect(ranges.getByRole('button')).toHaveText(['1D', '5D', '1M', '3M', '1Y', 'All']);
  // A token hours old offers no zoom that would promise history it does not have.
  const age = Number(data.blockTimestamp) - Number(token.launchTimestamp ?? token.market.initial.timestamp);
  for (const [range, seconds] of [['5D', 432000], ['1M', 2592000], ['3M', 7776000], ['1Y', 31536000]]) {
    if (age < seconds) await expect(ranges.getByRole('button', { name: range, exact: true })).toBeDisabled();
  }
  await intervals.getByRole('button', { name: '1m', exact: true }).click();
  await expect(page.locator('.arc-burn-marker')).toHaveCount(burns.length);
  await expect(page.locator('.arc-burn-marker').first()).toHaveAttribute('href', new RegExp(`/tx/${burns[0].transactionHash}$`));
  // Every marker is a real burn of this token.
  const marked = await page.locator('.arc-burn-marker').evaluateAll(items => items.map(item => item.getAttribute('href').split('/tx/')[1]));
  assert.deepEqual(marked.sort(), burns.map(burn => burn.transactionHash).sort());
  const canvas = await page.locator('.arc-price-canvas canvas').first().elementHandle();
  for (const width of [1440, 375, 320, 812]) {
    await page.setViewportSize({ width, height: width === 812 ? 375 : 1100 });
    for (const metric of ['holders', 'marketCap']) {
      await metrics.getByRole('button', { name: metric === 'holders' ? 'Holders' : 'Burns', exact: true }).click();
      await expect(market).toHaveAttribute('data-metric', metric);
      if (metric === 'holders') {
        await expect(page.locator('.arc-burn-marker')).toHaveCount(0);
        await expect(page.locator('.arc-chart-headline strong')).toHaveText(String(token.holders));
      } else {
        await expect(page.locator('.arc-burn-marker')).toHaveCount(burns.length);
      }
      assert(await canvas.evaluate(node => node.isConnected), 'Tab switching must reuse the chart');
      for (const theme of ['dark', 'light']) {
        await page.locator('.nav-theme-toggle:visible').and(page.getByRole('button', { name: theme === 'dark' ? 'Switch to dark theme' : 'Switch to light theme' })).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await market.scrollIntoViewIfNeeded();
        await page.waitForTimeout(150);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${metric} overflow at ${width}`);
        if ([1440, 375].includes(width)) await market.screenshot({ path: `${shots}/singlespark-${metric}-${theme}-${width}.png` });
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  // The detail page and the burn dashboard share the same chart; interval switches keep one canvas.
  for (const path of [`/token/${token.token}`, '/burn']) {
    await page.goto(`${site}${path}`);
    await expect(market).toHaveAttribute('data-token', token.token);
    const same = await page.locator('.arc-price-canvas canvas').first().elementHandle();
    for (const interval of ['1m', '5m', '15m', '1h', '4h', 'D']) {
      await intervals.getByRole('button', { name: interval, exact: true }).click();
      await expect(intervals.getByRole('button', { name: interval, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.arc-chart-empty')).toHaveCount(0);
      assert(await same.evaluate(node => node.isConnected), 'Interval switching must reuse the chart');
    }
    await ranges.getByRole('button', { name: '1D', exact: true }).click();
    await expect(ranges.getByRole('button', { name: '1D', exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  const diamond = metrics.getByRole('button', { name: 'Holders', exact: true }).locator('img');
  // Offscreen stickers pause by design; bring the chart header into view before judging motion.
  await metrics.scrollIntoViewIfNeeded();
  await expect(diamond).toHaveAttribute('src', /holders-diamond-still\.png$/);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(diamond).toHaveAttribute('data-animated', 'true');
  await expect(diamond).toHaveAttribute('src', /holders-diamond-icon\.webp$/);
  await expect.poll(() => diamond.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(diamond).toHaveAttribute('data-animated', 'false');
  await expect(diamond).toHaveAttribute('src', /holders-diamond-still\.png$/);
  // Another token's chart shows only its own burns.
  for (const other of data.tokens.filter(item => item.token.toLowerCase() !== token.token.toLowerCase())) {
    const own = await chartBurns(page, other.token);
    assert.equal(own.length, other.market.burns);
    assert(own.every(burn => burn.token.toLowerCase() === other.token.toLowerCase()), 'Burns are isolated per token');
    await page.goto(`${site}/token/${other.token}`);
    await expect(market).toHaveAttribute('data-token', other.token);
    await expect(page.locator('.arc-price-canvas')).toHaveAttribute('aria-label', new RegExp(other.symbol));
    await intervals.getByRole('button', { name: '1m', exact: true }).click();
    await expect(page.locator('.arc-burn-marker')).toHaveCount(own.length);
  }
  assert.deepEqual(errors, []);
  console.log(`PASS: ${burns.length} real burn markers and ${token.holders} holders on ${token.symbol}; six intervals and six ranges on detail and /burn with one reused chart; per-token burn isolation on ${data.tokens.length - 1} other tokens; four widths, both themes, diamond motion rules.`);
} finally { await browser.close(); }
