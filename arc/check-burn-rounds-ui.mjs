// Burn rounds, read-only: node SingleSparkContract/arc/check-burn-rounds-ui.mjs. Never sends a transaction.
//
// Point it at a stack with ARC_CHECK_API / ARC_CHECK_SITE; `node SingleSparkContract/arc/local-preview-stack.mjs --run
// SingleSparkContract/arc/check-burn-rounds-ui.mjs` provides a throwaway one with real keeper burns.
//
// Updated 2026-09-22: the snapshot's full `records` list is gone (it now holds the newest 25 across all
// tokens), so the token's burns are compared against `market.burns` and against every burn the paged
// `GET /api/arc/candles` returns for it; the site is English only, and on a token page the burn table
// is the "Burn records" tab of the activity history.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const api = process.env.ARC_CHECK_API || 'http://127.0.0.1:8090';
const site = process.env.ARC_CHECK_SITE || 'http://127.0.0.1:5176';
const shots = process.env.ARC_CHECK_SCREENSHOTS || '/private/tmp';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const snapshot = await (await page.request.get(`${api}/api/arc/snapshot`)).json();
  const token = snapshot.platformToken.toLowerCase();
  const view = snapshot.tokens.find(item => item.token.toLowerCase() === token);
  const path = `${api}/api/arc/burn/rounds?token=${token}`;
  let cursor;
  const rows = [];
  do {
    const response = await page.request.get(`${path}&limit=100${cursor ? `&before=${cursor}` : ''}`);
    assert.equal(response.status(), 200);
    const result = await response.json();
    rows.push(...result.items);
    cursor = result.nextCursor;
    assert(rows.length < 10000, 'Preview check is bounded to 10,000 rounds');
  } while (cursor);
  assert(rows.length > view.market.burns, 'Empty rounds must be included');
  const burns = rows.filter(row => row.status === 'burned');
  // Every indexed burn of this token, from the chart endpoint's pages (the snapshot no longer lists them all).
  const indexed = [];
  for (let before, i = 0; ; i++) {
    assert(i < 50, 'More than 50 candle pages');
    const result = await (await page.request.get(`${api}/api/arc/candles?token=${token}&interval=1m&basis=price&limit=1000${before ? `&before=${before}` : ''}`)).json();
    indexed.push(...result.burns);
    before = result.nextBefore;
    if (before == null) break;
  }
  assert.equal(indexed.length, view.market.burns);
  assert.deepEqual(burns.map(row => row.record.transactionHash).sort(), indexed.map(row => row.transactionHash).sort());
  rows.forEach((row, i) => {
    assert.equal(row.token, token);
    if (i) assert.equal(Number(rows[i - 1].slot) - Number(row.slot), 180);
    if (row.status !== 'burned') assert.equal(row.record, null);
  });
  for (const invalid of ['limit=0', 'limit=101', 'before=1']) {
    assert.equal((await page.request.get(`${path}&${invalid}`)).status(), 400);
  }
  await page.addInitScript(() => { localStorage.setItem('singlespark-intro-v1-seen', '1'); if (!localStorage.getItem('jet-theme')) localStorage.setItem('jet-theme', 'light'); });
  await page.goto(`${site}/burn`);
  const history = page.locator('.arc-history').filter({ has: page.locator('.arc-burn-table') });
  await expect(history.locator('tbody tr')).toHaveCount(20, { timeout: 30000 });
  await expect(history.locator('th')).toHaveText(['Cycle / Time', 'Buyback spend', 'Tokens burned', 'Result / Transaction']);
  await expect(history.locator('tbody tr:first-child td')).toHaveCount(4);
  await expect(history.locator('tbody tr:first-child td:last-child .arc-record-token')).toBeVisible();
  // Rounds without a burn (empty, or with no saved check) are listed and never link a transaction.
  await expect(history.locator('tbody tr:not([data-round-status=burned])').first()).toBeVisible();
  assert.equal(await history.locator('tbody tr:not([data-round-status=burned]) a[href*="/tx/"]').count(), 0);
  await expect(history.locator('.arc-history-footer')).toContainText(`${burns.length} burns`);
  await expect(history.locator('.arc-history-page')).toHaveText(`Page 1 of ${Math.ceil(rows.length / 20).toLocaleString('en')}`);
  await expect(history.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
  const firstId = await history.locator('tbody tr').first().getAttribute('id');
  await history.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(history.locator('tbody tr').first()).not.toHaveAttribute('id', firstId);
  await expect(history.locator('.arc-history-page')).toHaveText(/^Page 2 of /);
  await history.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(history.locator('tbody tr').first()).toHaveAttribute('id', firstId);
  await expect(history.locator('.arc-history-page')).toHaveText(/^Page 1 of /);
  await history.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/singlespark-burn-rounds-desktop.png` });
  await page.setViewportSize({ width: 375, height: 812 });
  await history.scrollIntoViewIfNeeded();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile page must not overflow');
  await page.screenshot({ path: `${shots}/singlespark-burn-rounds-mobile.png` });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const openBurnTab = async () => {
    await page.getByRole('group', { name: 'Token activity' }).getByRole('button', { name: 'Burn records', exact: true }).click();
  };
  await page.goto(`${site}/token/${token}`);
  await openBurnTab();
  await expect(page.locator('.arc-burn-table tbody tr')).toHaveCount(20, { timeout: 30000 });
  // Layout-only token name override; prices, transactions and history use the real API.
  const longName = 'SingleSpark Community Token With A Very Long Name For Layout QA';
  await page.route('**/api/arc/snapshot', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.tokens.find(item => item.token.toLowerCase() === token).name = longName;
    await route.fulfill({ response, json: data });
  });
  for (const route of ['/burn', `/token/${token}`]) {
    await page.goto(site + route);
    if (route !== '/burn') await openBurnTab();
    const link = page.locator('.arc-record-token').first();
    await expect(link).toHaveAttribute('title', new RegExp(longName));
    for (const width of [1440, 1024, 375, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const theme of ['light', 'dark']) {
        if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('.nav-theme-toggle:visible').click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(link.locator(':scope > span')).toHaveCSS('text-overflow', 'ellipsis');
        assert(await link.locator(':scope > span').evaluate(element => element.scrollWidth > element.clientWidth), 'Long name must be truncated');
        assert(await link.evaluate(element => element.getBoundingClientRect().right <= element.closest('td').getBoundingClientRect().right + 1), 'Token stays inside result cell');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No overflow: ${route}, ${width}: ${await page.locator('body *').evaluateAll(elements => JSON.stringify(elements.filter(element => element.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map(element => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right }))))}`);
        const footer = page.locator('.arc-history-footer').filter({ has: page.locator('.arc-history-page') }).last();
        await expect(footer.locator('.arc-history-page')).toHaveText(/^Page 1 of [\d,]+$/);
        await footer.scrollIntoViewIfNeeded();
        assert(await footer.locator('.arc-history-pagination').evaluate(element => element.scrollWidth <= element.clientWidth), 'Page count and buttons must fit');
        if ([1440, 320].includes(width)) await footer.screenshot({ path: `${shots}/singlespark-pagination-${route === '/burn' ? 'dashboard' : 'detail'}-${theme}-${width}.png`, animations: 'disabled' });
        if ([1440, 375].includes(width)) {
          await page.locator('.arc-burn-table tbody tr').first().screenshot({ path: `${shots}/singlespark-burn-result-${route === '/burn' ? 'dashboard' : 'detail'}-${theme}-${width}.png`, animations: 'disabled' });
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(`PASS: ${rows.length} continuous rounds, ${burns.length} real burns (= market.burns and the candle pages); four columns, token in result, long-name ellipsis, both themes and four widths on dashboard/detail; cursor pagination preserved.`);
} finally { await browser.close(); }
