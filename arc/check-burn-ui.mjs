// Burn UI across the ARC routes, read-only: node SingleSparkContract/arc/check-burn-ui.mjs. Never sends a transaction.
//
// Point it at a stack with ARC_CHECK_API / ARC_CHECK_SITE; `node SingleSparkContract/arc/local-preview-stack.mjs --run
// SingleSparkContract/arc/check-burn-ui.mjs` provides a throwaway one with synthetic trades and real keeper burns.
//
// Updated 2026-09-22. The snapshot no longer carries `prices` or every burn: a token's burns are its
// `market.burns`, and the burns its chart marks are the ones `GET /api/arc/candles` returns inside real
// candles (the old premise "a burn has its own swap price point" is what that endpoint now enforces).
// The chart is the candlestick panel (intervals 1m…D, ranges 1D…All), the site is English only, the
// detail page has no back link or burn shortcut any more, and its burn table is the "Burn records" tab.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const api = process.env.ARC_CHECK_API || 'http://127.0.0.1:8090';
const site = process.env.ARC_CHECK_SITE || 'http://127.0.0.1:5176';
const shots = process.env.ARC_CHECK_SCREENSHOTS || '/private/tmp';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('singlespark-intro-v1-seen', '1'));
  const snapshot = await (await page.request.get(`${api}/api/arc/snapshot`)).json();
  const chartBurns = async token => {
    const burns = [];
    for (let before, i = 0; ; i++) {
      assert(i < 50, 'More than 50 candle pages');
      const response = await page.request.get(`${api}/api/arc/candles?token=${token}&interval=1m&basis=mcap&limit=1000${before ? `&before=${before}` : ''}`);
      assert.equal(response.status(), 200);
      const result = await response.json();
      burns.push(...result.burns);
      before = result.nextBefore;
      if (before == null) return burns.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
    }
  };
  const platform = snapshot.tokens.find(token => token.token.toLowerCase() === snapshot.platformToken.toLowerCase());
  const burns = await chartBurns(platform.token);
  assert(burns.length > 0, 'Requires a confirmed buyback');
  assert.equal(burns.length, platform.market.burns);
  assert(burns.every(record => record.token.toLowerCase() === platform.token.toLowerCase()));

  await page.goto(`${site}/burn`);
  await expect(page).toHaveTitle(/^SingleSpark/);
  await expect(page.locator('.desktop-nav__brand')).toHaveAccessibleName('SingleSpark');
  await expect(page.locator('.desktop-nav__brand img')).toHaveAttribute('src', '/assets/brands/singlespark-glossy-v1-still.png');
  await expect.poll(() => page.locator('.desktop-nav__brand img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('.nav-theme-toggle:visible').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('heading', { name: 'Burn', exact: true }).waitFor({ timeout: 120000 });
  const intervals = page.getByRole('group', { name: 'Candle interval' });
  await intervals.getByRole('button', { name: '1m', exact: true }).click();
  const markers = page.locator('.arc-burn-marker');
  await expect(markers).toHaveCount(burns.length);
  await expect(page.locator('.arc-market .ph-fire, .arc-history .ph-fire, .arc-legend-dot')).toHaveCount(0);
  const metrics = page.getByRole('group', { name: 'Chart metric' });
  await expect(metrics).toHaveClass(/segmented-tabs/);
  await metrics.getByRole('button', { name: 'Holders', exact: true }).click();
  await expect(markers).toHaveCount(0);
  assert(Number.isSafeInteger(platform.holders), 'requires the real holder index');
  await expect(page.locator('.arc-chart-headline strong')).toHaveText(String(platform.holders));
  await metrics.getByRole('button', { name: 'Burns', exact: true }).click();
  await expect(markers).toHaveCount(burns.length);
  // Hiding the markers is a toggle, not a data change.
  await page.getByRole('button', { name: 'Show burn markers' }).click();
  await expect(markers).toHaveCount(0);
  await page.getByRole('button', { name: 'Show burn markers' }).click();
  await expect(markers).toHaveCount(burns.length);
  // Each marker links its own burn transaction.
  assert.deepEqual((await markers.evaluateAll(items => items.map(item => item.getAttribute('href').split('/tx/')[1]))).sort(),
    burns.map(burn => burn.transactionHash).sort());
  for (const [width, height] of [[1440, 1100], [375, 812], [812, 375]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(300); // Let the existing navigation resize transition finish.
    await expect.poll(() => page.locator('.arc-burn-markers').evaluate(element => element.offsetWidth > 0)).toBe(true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(17, 19, 21)');
    await page.screenshot({ path: `${shots}/jet-burn-icons-${width}.png`, fullPage: true });
    assert(await noOverflow(page), `Horizontal overflow at ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 1100 });

  await page.goto(`${site}/`);
  await expect(page.locator('.discover-token-card')).toHaveCount(snapshot.tokens.length);
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await expect(page.locator('.discover-token-list-row')).toHaveCount(snapshot.tokens.length);
  for (const [width, height] of [[1440, 1100], [1024, 900], [375, 812], [320, 740]]) {
    await page.setViewportSize({ width, height }); await page.waitForTimeout(300);
    assert(await noOverflow(page), `Restored table overflow at ${width}`);
    await expect(page.getByRole('button', { name: 'Card view', exact: true })).toBeVisible();
    await page.screenshot({ path: `${shots}/jet-restored-table-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole('button', { name: 'Burned', exact: true }).click();
  await expect(page.locator('.discover-token-list-row')).toHaveCount(snapshot.tokens.filter(token => BigInt(token.cycles) > 0n).length);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.locator('.discover-token-list-row')).toHaveCount(snapshot.tokens.length);
  await page.getByRole('button', { name: 'Card view', exact: true }).click();
  await expect(page.locator('.discover-token-card')).toHaveCount(snapshot.tokens.length);
  await page.locator('.nav-search-trigger:visible').click();
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.getByRole('searchbox').fill(snapshot.tokens[1].token);
  await expect(page.locator('.token-search-modal__result')).toHaveCount(1);
  await expect(page.locator('.token-search-modal__result')).toContainText(snapshot.tokens[1].name);
  await page.getByRole('searchbox').press('Escape');

  // Every token's page shows its own countdown, chart and burns, and nobody else's.
  for (const token of snapshot.tokens) {
    const own = await chartBurns(token.token);
    assert.equal(own.length, token.market.burns);
    await page.goto(`${site}/token/${token.token}`);
    await expect(page.locator('.arc-countdown')).toHaveAttribute('data-token', token.token);
    await expect(page.locator('.arc-countdown [role=timer]')).toBeVisible();
    await expect(page.locator('.arc-countdown-token')).toContainText(token.symbol);
    await expect(page.locator('.arc-flame-stage')).toBeVisible();
    await expect(page.locator('.arc-price-canvas')).toHaveAttribute('aria-label', new RegExp(token.symbol));
    await page.getByRole('group', { name: 'Candle interval' }).getByRole('button', { name: '1m', exact: true }).click();
    await expect(page.locator('.arc-burn-marker')).toHaveCount(own.length);
    await page.getByRole('group', { name: 'Token activity' }).getByRole('button', { name: 'Burn records', exact: true }).click();
    const table = page.locator('.arc-history').filter({ has: page.locator('.arc-burn-table') });
    await expect(table.locator('tbody tr').first()).toBeVisible();
    // Every burned row on the page is one of this token's own burns.
    const ownHashes = new Set(own.map(record => `burn-${record.transactionHash}`));
    for (const id of await table.locator('[data-round-status=burned]').evaluateAll(rows => rows.map(row => row.id))) {
      assert(ownHashes.has(id), `Foreign burn row on ${token.symbol}: ${id}`);
    }
    // Rows on the page are this token's only.
    for (const href of await table.locator('.arc-record-token').evaluateAll(items => items.map(item => item.getAttribute('href')))) {
      assert(href.toLowerCase().endsWith(token.token.toLowerCase()), `Foreign token row on ${token.symbol}: ${href}`);
    }
    await expect(page.getByRole('button', { name: 'Buy', exact: true }).first()).toBeVisible();
  }
  await page.goto(`${site}/token/${snapshot.platformToken}`);
  await page.locator('.arc-token-header').waitFor();
  for (const [width, height] of [[1440, 1100], [375, 812], [812, 375]]) {
    await page.setViewportSize({ width, height }); await page.waitForTimeout(300);
    await page.locator('.arc-countdown').scrollIntoViewIfNeeded();
    await expect(page.locator('.arc-countdown [role=timer]')).toBeVisible();
    await expect(page.locator('.arc-flame-stage')).toBeVisible();
    assert(await noOverflow(page));
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(17, 19, 21)');
    await page.screenshot({ path: `${shots}/jet-token-burn-${width}.png`, fullPage: true });
  }
  // Both themes cover every ARC route and the shared navigation/dialogs.
  for (const path of ['/', '/create', '/burn', `/token/${snapshot.platformToken}`]) {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(`${site}${path}`);
    await page.locator('.pg-main h1, main h1').first().waitFor();
    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('.nav-theme-toggle:visible').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('.nav-theme-toggle:visible')).toHaveText('');
      await expect(page.locator('.nav-theme-toggle:visible img')).toHaveAttribute('src', `/assets/toolbar/${theme === 'light' ? 'sun' : 'moon'}.png`);
      await expect.poll(() => page.locator('.nav-theme-toggle:visible img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
      assert.equal(await page.evaluate(() => localStorage.getItem('jet-theme')), theme);
      await expect(page.locator('body')).toHaveCSS('background-color', theme === 'light' ? 'rgb(245, 246, 248)' : 'rgb(17, 19, 21)');
      for (const [width, height] of [[1440, 1100], [1024, 900], [375, 812], [320, 740], [812, 375]]) {
        await page.setViewportSize({ width, height }); await page.waitForTimeout(300);
        await expect(page.locator('.nav-theme-toggle:visible')).toBeInViewport();
        const controls = await page.locator('.nav-topbar :is(.nav-search-trigger, .nav-theme-toggle, .nav-cta, .nav-chain-trigger, .nav-drawer-toggle)').evaluateAll(items => items
          .filter(item => item.getClientRects().length)
          .map(item => { const box = item.getBoundingClientRect(); return { name: item.className, height: box.height, width: box.width, top: box.top }; }));
        for (const control of controls) {
          assert.equal(control.height, 44, `Control height: ${control.name}, ${width}`);
          assert(control.width >= 44, `Control width: ${control.name}, ${width}`);
          assert(Math.abs(control.top - controls[0].top) < 1, `Control alignment: ${control.name}, ${width}`);
        }
        assert(await noOverflow(page), `Overflow: ${path}, ${theme}, ${width}`);
        if (path.startsWith('/token')) {
          for (const selector of ['.arc-countdown-metric strong', '.arc-token-burn-stats']) {
            await expect(page.locator(`${selector} img[src="/assets/brands/usdc-token.svg"]`).first()).toBeAttached();
          }
          assert(await page.locator('.arc-history').first().evaluate(element => element.scrollWidth <= element.clientWidth + 1), `Clipped history table: ${theme}, ${width}`);
          if (width === 375) {
            await page.locator('.arc-mobile-trade-link').click();
            await expect(page.locator('.arc-trade-panel')).toBeInViewport();
            await page.keyboard.press('Escape');
            await expect(page.locator('.arc-mobile-trade-link')).toBeVisible();
            await page.evaluate(() => scrollTo(0, 0));
          }
        }
        if (width === 1440 || width === 375) await page.screenshot({ path: `${shots}/jet-${theme}-${path === '/' ? 'list' : path.startsWith('/token') ? 'detail' : path.slice(1)}-${width}.png`, fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      if (path === '/') {
        await page.locator('.nav-cta:visible').click();
        await expect(page.locator('.wallet-modal-dialog')).toHaveCSS('background-color', theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(23, 25, 27)');
        await page.screenshot({ path: `${shots}/jet-${theme}-wallet.png` });
        await page.keyboard.press('Escape');
        await expect(page.locator('.wallet-modal-dialog')).toHaveCount(0);
      }
    }
  }
  // Switching a live chart's theme changes its paint, not its canvas or the marker coordinates.
  await page.goto(`${site}/burn`);
  await page.getByRole('group', { name: 'Candle interval' }).getByRole('button', { name: '1m', exact: true }).click();
  await expect(markers).toHaveCount(burns.length);
  await page.waitForTimeout(300);
  const canvas = await page.locator('.arc-price-canvas canvas').first().elementHandle();
  const chartBefore = await canvas.evaluate(element => element.toDataURL());
  const coordinates = await markers.evaluateAll(items => items.map(item => item.style.left));
  await page.locator('.nav-theme-toggle:visible').click();
  await expect.poll(() => canvas.evaluate(element => element.toDataURL())).not.toBe(chartBefore);
  assert(await canvas.evaluate(element => element.isConnected), 'Theme switch must retain the chart');
  await page.waitForTimeout(300);
  assert.deepEqual(await markers.evaluateAll(items => items.map(item => item.style.left)), coordinates);
  // Privacy/storage restrictions must not break the switch or the page.
  const restricted = await browser.newPage();
  restricted.on('pageerror', error => errors.push(error.message));
  await restricted.addInitScript(() => {
    localStorage.setItem('singlespark-intro-v1-seen', '1'); // the first-visit intro would cover the toolbar
    for (const method of ['getItem', 'setItem']) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function (...args) {
        if (args[0] === 'jet-theme') throw new DOMException('Blocked', 'SecurityError');
        return original.apply(this, args);
      };
    }
  });
  await restricted.goto(`${site}/`);
  await expect(restricted.locator('html')).toHaveAttribute('data-theme', 'light');
  await restricted.locator('.nav-theme-toggle:visible').click();
  await expect(restricted.locator('html')).toHaveAttribute('data-theme', 'dark');
  await restricted.close();
  assert.deepEqual(errors, []);
  console.log(`PASS: ${burns.length} real burn markers on /burn (= market.burns), per-token chart/countdown/burn-table isolation on ${snapshot.tokens.length} tokens, list/card/filters/search, both themes on all ARC routes at five sizes, wallet dialog, storage restriction and chart viewport preservation.`);
} finally { await browser.close(); }
