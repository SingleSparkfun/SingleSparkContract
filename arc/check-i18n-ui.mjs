// Real ARC API, English copy and both themes. No wallet signatures or transactions.
// Run: node SingleSparkContract/arc/check-i18n-ui.mjs [frontend-origin] [api-origin]
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const origin = process.argv[2] ?? 'http://127.0.0.1:5176';
const api = process.argv[3] ?? 'http://127.0.0.1:8089';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const snapshot = await (await page.request.get(`${api}/api/arc/snapshot`)).json();
  const routes = ['/', '/create', `/token/${snapshot.platformToken}`, '/burn'];
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const route of routes) {
      const routeData = route === '/' ? page.waitForResponse(response => response.url().endsWith('/api/arc/snapshot') && response.ok()) : null;
      await page.goto(origin + route);
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.locator('.nav-language-trigger')).toHaveCount(0);
      if (routeData) await expect(page.locator('.discover-token-card')).toHaveCount((await (await routeData).json()).tokens.length);
      if (route === '/create') await page.locator('#arc-create-name').fill('Language Check');
      if (route.startsWith('/token/') || route === '/burn') {
        await expect(page.locator('.arc-price-canvas canvas').first()).toBeVisible();
        await page.locator('.arc-price-canvas canvas').first().evaluate(canvas => { window.languageCheckCanvas = canvas; });
      }
      for (const theme of ['dark', 'light']) {
        if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('.nav-theme-toggle:visible').click();
        await expect(page).toHaveTitle('SingleSpark — ARC Token Launchpad');
        if (route === '/') {
          await expect(page.getByRole('heading', { name: 'Token list' })).toBeVisible();
        } else if (route === '/create') {
          await expect(page.getByLabel('Token name', { exact: true })).toHaveValue('Language Check');
          await expect(page.locator('.arc-create-preview')).toContainText('Launch preview');
        } else {
          await expect(page.locator('.arc-history-header .arc-eyebrow')).toHaveText('ON-CHAIN HISTORY');
          await expect(page.getByRole('group', { name: 'Chart metric' }))
            .toContainText('Holders');
          await expect(page.locator('.arc-market-header')).toContainText('7D');
          assert(await page.locator('.arc-price-canvas canvas').first().evaluate(canvas => canvas === window.languageCheckCanvas), 'Theme switch must preserve the chart instance');
          if (route.startsWith('/token/')) await expect(page.getByRole('form', { name: 'Trade token' })).toBeVisible();
        }
        const content = await page.locator('body').innerText();
        assert(!/\b(?:arc|wallet|discover|nav)\.[a-zA-Z]/.test(content), 'Untranslated dictionary key');
        assert(!/\p{Script=Han}/u.test(content), 'Unexpected non-English UI copy');
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: `/private/tmp/singlespark-i18n-${routes.indexOf(route)}-${theme}-${width}.png`, fullPage: true });
      }
    }
  }
  // English persists through refresh; the shared wallet dialog uses the same copy.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.locator('.nav-cta:visible').click();
  await expect(page.getByRole('dialog', { name: 'Connect wallet' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect your wallet' })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  // API failures remain readable and do not expose raw dictionary keys.
  await page.route('**/api/arc/snapshot', route => route.fulfill({ status: 503, json: { message: 'Service unavailable' } }));
  await page.goto(origin + '/');
  await expect(page.getByRole('alert')).toContainText('ARC data is temporarily unavailable');
  await page.locator('.nav-search-trigger:visible').click();
  await expect(page.getByRole('searchbox')).toHaveAttribute('placeholder', 'Search name, symbol or contract address');
  assert.deepEqual(errors, []);
  console.log('PASS: four routes, English copy, shared wallet, refresh persistence, API errors, desktop/mobile, both themes.');
} finally {
  await browser.close();
}
