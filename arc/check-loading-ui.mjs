// Delays real read responses to inspect loading UI. Never connects a wallet or sends a transaction.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';

const site = process.env.ARC_CHECK_SITE || 'http://127.0.0.1:5176';
const api = process.env.ARC_CHECK_API || 'http://127.0.0.1:8090';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  // Hold all script/style downloads: the HTML alone must paint a themed startup skeleton.
  for (const [theme, width, path] of [['light', 1440, '/'], ['dark', 375, '/create']]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await page.addInitScript(theme => {
      localStorage.setItem('jet-theme', theme);
      localStorage.setItem('singlespark-intro-v1-seen', '1');
    }, theme);
    let releaseBoot, releaseWallet;
    const bootGate = new Promise(resolve => { releaseBoot = resolve; });
    const walletGate = new Promise(resolve => { releaseWallet = resolve; });
    await page.route('**/*', async route => {
      if (['script', 'stylesheet'].includes(route.request().resourceType())) await bootGate;
      await route.continue();
    });
    await page.route(url => /\/WalletModal(?:[\w.-]*\.js|\.tsx)$/.test(url.pathname), async route => { await walletGate; await route.continue(); });
    await page.goto(site + path, { waitUntil: 'commit' });
    await expect(page.locator('#app-boot')).toBeVisible();
    await expect(page.locator('#app-boot')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#app-boot')).toHaveCSS('background-color', theme === 'light' ? 'rgb(245, 246, 248)' : 'rgb(17, 19, 21)');
    await expect(page.locator('.boot-title')).toHaveCSS('animation-name', 'none');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Startup skeleton must fit the viewport');
    // Playwright screenshots await fonts.ready, which we intentionally keep pending here.
    const cdp = await page.context().newCDPSession(page);
    const shot = await cdp.send('Page.captureScreenshot');
    writeFileSync(`/private/tmp/singlespark-startup-${theme}.png`, Buffer.from(shot.data, 'base64'));
    await cdp.detach();
    releaseBoot();
    await expect(page.locator(path === '/' ? '.discover-token-card' : '.arc-create-form').first()).toBeVisible();
    await expect(page.locator('#app-boot')).toHaveCount(0);

    const connect = page.getByRole('button', { name: 'Connect', exact: true });
    await connect.click();
    const loading = page.locator('.wallet-loading-dialog');
    await expect(loading).toBeVisible();
    await expect(loading.locator('[aria-busy="true"]')).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
    await expect(loading.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(loading.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    assert(await loading.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }), 'Wallet skeleton must fit the viewport');
    await page.screenshot({ path: `/private/tmp/singlespark-wallet-loading-${theme}.png` });
    await page.keyboard.press('Escape');
    await expect(loading).toHaveCount(0);
    await expect(connect).toBeFocused();
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
    await connect.click();
    await expect(loading).toBeVisible();
    await loading.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(loading).toHaveCount(0);
    releaseWallet();
    await connect.click();
    await expect(page.locator('.wallet-modal-dialog')).toBeVisible();
    await expect(loading).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.wallet-modal-dialog')).toHaveCount(0);
    await page.close();
    console.log(`PASS: pre-script startup and wallet loading, close/reopen/focus (${theme}/${width}).`);
  }

  const request = await browser.newPage();
  const snapshot = await (await request.request.get(`${api}/api/arc/snapshot`)).json();
  const token = snapshot.tokens[0]?.token;
  assert(token, 'The checked API must have an indexed token for the detail-page check');
  await request.close();
  for (const [path, layout, ready] of [
    ['/', 'list', '.discover-token-card'], ['/create', 'create', '.arc-create-form'],
    ['/burn', 'burn', '.arc-countdown'], [`/token/${token}`, 'detail', '.arc-token-header'],
  ]) {
    const mobile = layout === 'detail' || layout === 'burn';
    const page = await browser.newPage({ viewport: { width: mobile ? 375 : 1440, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(mobile => {
      localStorage.setItem('singlespark-intro-v1-seen', '1');
      localStorage.setItem('jet-theme', mobile ? 'dark' : 'light');
    }, mobile);
    let releaseSnapshot, releaseHistory;
    let snapshotGate = new Promise(resolve => { releaseSnapshot = resolve; });
    const historyGate = new Promise(resolve => { releaseHistory = resolve; });
    let requested = false;
    await page.route('**/api/arc/snapshot', async route => { requested = true; await snapshotGate; await route.continue(); });
    await page.route('**/api/arc/burn/rounds?**', async route => { await historyGate; await route.continue(); });
    await page.goto(site + path, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => requested).toBe(true);
    await expect(page.locator(`.page-skeleton--${layout}`)).toBeVisible();
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
    await expect(page.locator(ready)).toHaveCount(0);
    await expect(page.locator('.discover-empty-list')).toHaveCount(0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Skeleton must fit the viewport');
    await page.screenshot({ path: `/private/tmp/singlespark-loading-${layout}.png` });
    if (layout === 'list') {
      await page.getByRole('button', { name: 'Search tokens', exact: true }).click();
      await expect(page.locator('.token-search-modal__results .app-skeleton-group')).toBeVisible();
      await expect(page.locator('.token-search-modal__state, .token-search-modal__result')).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
    releaseSnapshot();
    await expect(page.locator(ready).first()).toBeVisible();
    await expect(page.locator('.page-skeleton')).toHaveCount(0);
    if (mobile) {
      if (layout === 'detail') await page.getByRole('button', { name: 'Burn records', exact: true }).click();
      await expect(page.locator('.arc-history-loading')).toBeVisible();
      await expect(page.locator('.arc-burn-table')).toHaveCount(0);
      await expect(page.locator('.arc-history-footer')).toHaveCount(0);
    }
    releaseHistory();
    if (mobile) await expect(page.locator('.arc-burn-table')).toBeVisible();
    if (layout === 'detail') {
      let releaseRewards;
      const rewardGate = new Promise(resolve => { releaseRewards = resolve; });
      await page.route(url => url.pathname.startsWith('/api/arc/rewards'), async route => { await rewardGate; await route.continue(); });
      await page.getByRole('button', { name: 'Distributions', exact: true }).click();
      await expect(page.locator('.arc-history-loading')).toBeVisible();
      await expect(page.locator('.arc-history-footer')).toHaveCount(0);
      releaseRewards();
      await expect(page.locator('.arc-history-footer')).toBeVisible();
      await expect(page.locator('.arc-history-loading')).toHaveCount(0);
    }

    // A full reload starts with no in-memory snapshot, on every visit.
    for (let refresh = 0; refresh < 2; refresh += 1) {
      snapshotGate = new Promise(resolve => { releaseSnapshot = resolve; });
      requested = false;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect.poll(() => requested).toBe(true);
      await expect(page.locator(`.page-skeleton--${layout}`)).toBeVisible();
      await expect(page.locator(ready)).toHaveCount(0);
      await expect(page.locator('[role="alert"], .api-error-toast')).toHaveCount(0);
      releaseSnapshot();
      await expect(page.locator(ready).first()).toBeVisible();
    }

    // The automatic five-second poll keeps the loaded DOM while its response is pending.
    snapshotGate = new Promise(resolve => { releaseSnapshot = resolve; });
    requested = false;
    const loaded = await page.locator(ready).first().elementHandle();
    await expect.poll(() => requested, { timeout: 10_000 }).toBe(true);
    await expect(page.locator(ready).first()).toBeVisible();
    await expect(page.locator('.page-skeleton')).toHaveCount(0);
    assert(await loaded.evaluate(el => el.isConnected), 'Polling must retain the loaded page');
    const refreshed = page.waitForResponse(response => response.url().endsWith('/api/arc/snapshot') && response.ok());
    releaseSnapshot();
    await refreshed;
    assert.deepEqual(errors, []);
    console.log(`PASS: ${layout}, initial load, two full reloads and background polling (${mobile ? 'mobile/dark' : 'desktop/light'}).`);
    await page.close();
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('singlespark-intro-v1-seen', '1'));
  let releaseDirectory;
  const directoryGate = new Promise(resolve => { releaseDirectory = resolve; });
  await page.route('**/api/v2/chains', async route => { await directoryGate; await route.continue(); });
  await page.goto(site, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.page-skeleton')).toBeVisible();
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  releaseDirectory();
  await expect(page.locator('.discover-token-card').first()).toBeVisible();

  // Cached snapshots are shared across ARC routes; navigation does not await another response.
  let releaseNavigation;
  const navigationGate = new Promise(resolve => { releaseNavigation = resolve; });
  const holdNavigation = async route => { await navigationGate; await route.continue(); };
  await page.route('**/api/arc/snapshot', holdNavigation);
  await page.locator('a[href="/create"]').first().click();
  await expect(page.locator('.arc-create-form')).toBeVisible();
  await expect(page.locator('.page-skeleton')).toHaveCount(0);
  releaseNavigation();
  await page.unroute('**/api/arc/snapshot', holdNavigation);

  let retrying = false, releaseRetry;
  const retryGate = new Promise(resolve => { releaseRetry = resolve; });
  await page.route('**/api/arc/snapshot', async route => {
    if (!retrying) await route.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"UI_LOADING_TEST"}' });
    else { await retryGate; await route.continue(); }
  });
  await page.goto(site + '/create', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Data is temporarily unavailable')).toBeVisible();
  await expect(page.locator('.arc-create-form')).toHaveCount(0);
  await expect(page.locator('.api-error-toast')).toHaveCount(0);
  retrying = true;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.page-skeleton--create')).toBeVisible();
  await expect(page.getByText('Data is temporarily unavailable')).toHaveCount(0);
  releaseRetry();
  await expect(page.locator('.arc-create-form')).toBeVisible();
  await page.close();
  console.log('PASS: network directory and history skeletons; cached navigation, delayed real responses, no premature errors/empty data, failure and retry.');
} finally { await browser.close(); }
