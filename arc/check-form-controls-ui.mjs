// Read-only UI checks against the running ARC preview; never connects a wallet or submits transactions.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

for (const path of readdirSync('front', { recursive: true }).filter(path => /\.tsx?$/.test(path) && !path.includes('.test.'))) {
  const source = readFileSync(`SingleSparkFront/front/${path}`, 'utf8');
  assert(!/\b(?:window|globalThis)\.(?:alert|confirm|prompt)\s*\(/.test(source), `Native browser dialog: ${path}`);
  if (!['components/Input.tsx', 'components/TokenMediaUpload.tsx'].includes(path)) {
    assert(!/<(?:input|textarea|select)\b/.test(source), `Field bypasses shared UI: ${path}`);
  }
}
import { chromium, expect } from '@playwright/test';

const site = process.env.ARC_CHECK_SITE || 'http://127.0.0.1:5176';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const resize = async width => {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('.pg-main').evaluate(async el => {
      el.getBoundingClientRect();
      await Promise.allSettled(el.getAnimations().map(animation => animation.finished));
    });
  };
  await page.addInitScript(() => localStorage.setItem('singlespark-intro-v1-seen', '1'));
  page.on('dialog', dialog => { errors.push(`Native dialog: ${dialog.type()}`); void dialog.dismiss(); });
  const sharedControls = async () => {
    const custom = await page.locator('main button').evaluateAll(buttons => buttons.filter(button =>
      !button.classList.contains('app-button') && !button.closest('.segmented-tabs, .app-select, .token-media-upload')
    ).map(button => ({ label: button.textContent, className: button.className })));
    assert.deepEqual(custom, [], 'Current page buttons must use shared UI');
    await expect(page.locator('select, input:visible:not(.app-input):not(.app-range), textarea:visible:not(.app-input)')).toHaveCount(0);
  };
  await page.goto(site);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => localStorage.setItem('jet-theme', theme), theme);
    await page.goto(`${site}/create`);
    const name = page.locator('#arc-create-name');
    const symbol = page.locator('#arc-create-symbol');
    await expect(name).toHaveClass(/app-input/);
    await name.focus();
    await page.keyboard.press('Tab');
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#arc-name-error')).toContainText('Enter a token name');
    await name.fill('SingleSpark');
    await symbol.fill('spark');
    await expect(symbol).toHaveValue('SPARK');
    await expect(name).toHaveAttribute('aria-invalid', 'false');
    await expect(page.locator('.arc-create-identity h2')).toHaveText('SingleSpark');
    const fee = page.locator('#arc-buy-fee');
    if (await fee.count()) {
      await expect(fee).toHaveClass(/app-range/);
      await expect(fee).toHaveCSS('appearance', 'none');
      await fee.focus();
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowRight');
      await expect(fee).toHaveValue('0.01');
      await page.keyboard.press('Home');
    }
    await sharedControls();
    await expect(page.locator('input[type=file]')).toHaveAttribute('hidden', '');
    for (const width of [1440, 375, 320]) {
      await resize(width);
      await name.focus();
      await expect(name).toHaveCSS('appearance', 'none');
      await expect(name).toHaveCSS('border-radius', '12px');
      const state = await name.evaluate(el => {
        const css = getComputedStyle(el);
        return { height: el.getBoundingClientRect().height, focus: css.boxShadow, border: css.borderColor, accent: css.getPropertyValue('--accent').trim() };
      });
      assert(state.height >= 48);
      assert.notEqual(state.focus, 'none', 'Focused input needs a themed focus ring');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Create overflow: ${theme}/${width}`);
      if (width !== 320) await page.screenshot({ path: `/private/tmp/singlespark-fields-${theme}-${width}.png` });
    }
    await page.goto(`${site}/burn`);
    const select = page.locator('.arc-dashboard-header [role="combobox"]');
    await expect(select).toBeVisible();
    await expect(select).toHaveAccessibleName('Select token');
    await sharedControls();
    for (const width of [1440, 375, 320]) {
      await resize(width);
      await select.focus();
      await expect(select).toHaveCSS('outline-style', 'none');
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('listbox')).toBeVisible();
      const listbox = page.getByRole('listbox');
      const geometry = await listbox.boundingBox();
      assert(geometry.x >= 0 && geometry.x + geometry.width <= width, 'Dropdown must fit the viewport');
      await expect(listbox).toHaveCSS('background-color', theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(23, 25, 27)');
      if (width !== 320) await page.screenshot({ path: `/private/tmp/singlespark-select-${theme}-${width}.png` });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await expect(select).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await select.click();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('listbox')).toHaveCount(0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Burn overflow: ${theme}/${width}`);
    }
    await resize(1440);
    await page.goto(site);
    await expect(page.locator('.discover-token-card').first()).toBeVisible();
    await sharedControls();
    await page.getByRole('button', { name: 'List view', exact: true }).click();
    await page.getByRole('button', { name: 'Card view', exact: true }).click();
    await page.locator('.discover-token-card').first().click();
    await expect(page.locator('.arc-trade-presets')).toBeVisible();
    await sharedControls();
    await page.getByRole('button', { name: '10 USDC', exact: true }).click();
    await expect(page.locator('.arc-trade-amount input')).toHaveValue('10');
    for (const width of [1440, 375, 320]) {
      await resize(width);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Trade overflow: ${theme}/${width}`);
      if (width !== 320) await page.screenshot({ path: `/private/tmp/singlespark-controls-${theme}-${width}.png` });
    }
    await page.goto(`${site}/how-it-works`);
    await sharedControls();
    const details = page.locator('.how-details');
    await details.locator('summary').click();
    await expect(details).toHaveAttribute('open', '');
  }
  assert.deepEqual(errors, []);
  console.log('PASS: no native browser dialogs or unshared fields in source; ARC shared controls, both themes, 1440/375/320px, validation, keyboard, presets and view switching.');
} finally { await browser.close(); }
