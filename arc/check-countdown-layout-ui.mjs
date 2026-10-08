// UI-only worker states over a real snapshot. Never sends a transaction.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const data = await (await page.request.get('http://127.0.0.1:8089/api/arc/snapshot')).json();
  let state = 'checking';
  await page.route('**/api/arc/snapshot', route => route.fulfill({ json: { ...data,
    syncedAt: new Date().toISOString(), keeperEnabled: state !== 'paused',
    worker: { ...data.worker, busy: state === 'checking',
      nextCheckAt: new Date(Date.now() + (state === 'countdown' ? 89000 : -1000)).toISOString() },
  } }));
  const validate = async label => {
    const problems = await page.locator('.arc-countdown').evaluate(panel => {
      const rect = panel.getBoundingClientRect();
      const nodes = [...panel.querySelectorAll('.arc-countdown-main, .arc-countdown-metric, .arc-burn-progress, .arc-countdown-note')]
        .filter(el => getComputedStyle(el).display !== 'none');
      const issues = [];
      for (const el of [panel, ...nodes, ...panel.querySelectorAll('.arc-countdown-heading, .arc-clock, .arc-countdown-metric > strong')]) {
        if (el.scrollWidth > el.clientWidth + 1) issues.push(`overflow: ${el.className}`);
        const r = el.getBoundingClientRect();
        if (r.left < rect.left - 1 || r.right > rect.right + 1) issues.push(`outside panel: ${el.className}`);
      }
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i].getBoundingClientRect(), b = nodes[j].getBoundingClientRect();
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) issues.push('overlapping sections');
      }
      for (const [selector, size] of [
        ['.arc-countdown-token, .arc-countdown-metric > span', '14px'],
        ['.arc-eyebrow, .arc-countdown-metric small, .arc-countdown-note', '12px'],
        ['.arc-clock[data-kind=time], .arc-countdown-metric > strong', getComputedStyle(panel).getPropertyValue('--countdown-value-size').trim()],
      ]) {
        for (const el of panel.querySelectorAll(selector)) if (getComputedStyle(el).fontSize !== size) issues.push(`inconsistent font size: ${el.className || el.tagName}`);
      }
      return issues;
    });
    assert.deepEqual(problems, [], label);
    const progress = page.locator('.arc-burn-progress .sb');
    const bounds = await progress.evaluate(bar => ({ height: bar.getBoundingClientRect().height,
      width: bar.getBoundingClientRect().width, parentWidth: bar.parentElement.getBoundingClientRect().width }));
    assert.equal(bounds.height, 20, label);
    assert(Math.abs(bounds.width - bounds.parentWidth) < 1, `${label}: full-width burn progress ${JSON.stringify(bounds)}`);
    const tokenAddress = await page.locator('.arc-countdown').getAttribute('data-token');
    const token = data.tokens.find(item => item.token === tokenAddress);
    assert(Math.abs(Number(await progress.getAttribute('aria-valuenow')) - Number(token.totalBurned) / 1e25) < 1e-10, `${label}: actual cumulative burn ratio`);
    assert.equal(await page.locator('.arc-countdown-progress').count(), 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), label);
  };
  for (const route of ['/burn', `/token/${data.platformToken}`]) {
    // Legacy saved locale values must still render the current English interface.
    for (const locale of ['en', 'zh']) {
      await page.goto('http://127.0.0.1:5176' + route);
      await page.evaluate(locale => localStorage.setItem('ember-locale', locale), locale);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.locator('.arc-clock')).toHaveText('Checking');
      if (route === '/burn') await expect(page.locator('.arc-dashboard-header [role="combobox"]')).toHaveAccessibleName('Select token');
      for (const width of [1440, 1024, 812, 375, 320]) {
        await page.setViewportSize({ width, height: width === 812 ? 375 : 1000 });
        for (const theme of ['light', 'dark']) {
          if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('.nav-theme-toggle:visible').click();
          await validate(`${route} ${locale} ${theme} ${width}`);
          if ([1440, 375].includes(width)) await page.locator('.arc-countdown').screenshot({ path: `/private/tmp/singlespark-countdown-${route === '/burn' ? 'dashboard' : 'detail'}-${locale}-${theme}-${width}.png` });
        }
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const next of ['countdown', 'paused']) {
    state = next;
    await page.goto('http://127.0.0.1:5176/burn');
    await expect(page.locator('.arc-clock')).toHaveAttribute('data-kind', state === 'countdown' ? 'time' : 'status');
    await validate(state);
    if (state === 'countdown') {
      if (await page.locator('html').getAttribute('data-theme') !== 'light') await page.locator('.nav-theme-toggle:visible').click();
      await page.screenshot({ path: '/private/tmp/singlespark-burn-layout-desktop.png' });
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS: consistent typography and token selector label; no overlaps or clipped countdown text; both routes, legacy locale preferences, themes, five widths, countdown/checking/paused.');
} finally { await browser.close(); }
