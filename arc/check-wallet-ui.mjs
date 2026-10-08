// Browser wallet adapter simulation + real ARC backend SIWE. Never sends transactions.
// Run with the testnet API and frontend: node SingleSparkContract/arc/check-wallet-ui.mjs
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(generatePrivateKey());
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const methods = []; const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('testWalletRequest', async ({ method, params }) => {
    methods.push(method);
    if (method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }];
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account.address];
    if (method === 'eth_chainId') return `0x${(5042002).toString(16)}`;
    if (method === 'eth_getBalance') return '0x0'; // Empty test wallet display only.
    if (method === 'personal_sign') {
      assert(params[0].includes('Sign in to SingleSpark on ARC.'), 'wallet signature uses the current brand');
      return account.signMessage({ message: params[0] });
    }
    throw new Error(`Unexpected wallet request: ${method}`);
  });
  await page.addInitScript(() => {
    if (!localStorage.getItem('ember-locale')) localStorage.setItem('ember-locale', 'en');
    window.ethereum = { isMetaMask: true, request: args => window.testWalletRequest(args), on() {}, removeListener() {} };
  });
  const snapshot = await (await page.request.get('http://127.0.0.1:8089/api/arc/snapshot')).json();
  const url = `http://127.0.0.1:5176/token/${snapshot.platformToken}`;
  await page.goto(url);
  const form = page.getByRole('form', { name: 'Trade token' });
  const input = form.getByRole('textbox');
  await expect(input).toHaveValue('');
  // Empty required inputs must not prevent connection.
  await form.getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.locator('.wallet-modal-dialog')).toBeVisible();
  await page.locator('.wallet-connect-primary').click();
  const login = page.waitForResponse(response => response.url().includes('/api/auth/login') && response.request().method() === 'POST');
  await page.locator('.wallet-picker__option').filter({ has: page.getByText('MetaMask', { exact: true }) }).click();
  const response = await login;
  assert.equal(response.status(), 200);
  const session = await response.json();
  assert.equal(session.address, account.address.toLowerCase());
  assert.equal(session.chainId, 5042002);
  await expect(page.locator('.wallet-modal-dialog')).toHaveCount(0);
  await expect(form.locator('.arc-trade-wallet')).toContainText('Connected wallet');
  await expect(form.getByRole('button', { name: 'Confirm buy', exact: true })).toBeVisible();
  assert(methods.includes('personal_sign'));
  await form.getByRole('button', { name: '5 USDC', exact: true }).click();
  await expect(input).toHaveValue('5');
  await form.getByRole('button', { name: 'Sell', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(input).toHaveAttribute('aria-label', 'Amount to pay (JET)');
  await expect(form.locator('.arc-trade-presets')).toHaveCount(0);
  await expect(form.locator('.arc-trade-tabs.segmented-tabs .segmented-tabs__slider')).toBeVisible();
  await input.fill('12');
  await form.getByRole('button', { name: 'Sell', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(input).toHaveAttribute('aria-label', 'Amount to pay (USDC)');
  await expect(input).toHaveValue('');
  await page.keyboard.press('ArrowRight');
  await expect(form.getByRole('button', { name: 'Sell', exact: true })).toBeFocused();
  // A connected wallet still requires a valid amount before any transaction call.
  await form.getByRole('button', { name: 'Confirm sell', exact: true }).click();
  assert.equal(await input.evaluate(element => element.validity.valueMissing), true);
  await input.fill('abc');
  await form.getByRole('button', { name: 'Confirm sell', exact: true }).click();
  assert.equal(await input.evaluate(element => element.validity.patternMismatch), true);
  await input.fill('0.5');
  assert.equal(await input.evaluate(element => element.checkValidity()), true);
  // A saved pending transaction must disable the reused tabs, including keyboard input.
  const pendingKey = `arc.pending:5042002:${account.address.toLowerCase()}`;
  await page.evaluate(key => localStorage.setItem(key, `0x${'a'.repeat(64)}`), pendingKey);
  await page.reload();
  await expect(form.getByRole('button', { name: 'Buy', exact: true })).toBeDisabled();
  await expect(form.getByRole('button', { name: 'Sell', exact: true })).toBeDisabled();
  await expect(input).toBeDisabled();
  await page.evaluate(key => localStorage.removeItem(key), pendingKey);
  await page.reload();
  await expect(form.getByRole('button', { name: 'Sell', exact: true })).toBeEnabled();
  await page.goto('http://127.0.0.1:5176/create');
  const launch = page.getByRole('form', { name: 'Launch token', exact: true });
  const name = launch.getByLabel('Token name', { exact: true });
  const symbol = launch.getByLabel('Token symbol', { exact: true });
  await expect(launch.getByRole('button', { name: 'Launch token', exact: true })).toBeEnabled();
  await name.fill('불'.repeat(22));
  await symbol.fill('cat');
  await expect(symbol).toHaveValue('CAT');
  await launch.getByRole('button', { name: 'Launch token', exact: true }).click();
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(launch.getByText('Shorten the name to 64 UTF-8 bytes or fewer.')).toBeVisible();
  await name.fill('Arc Cat');
  await expect(page.getByRole('complementary', { name: 'Launch preview' }).getByRole('heading', { name: 'Arc Cat' })).toBeVisible();
  await launch.locator('summary').click();
  const metadata = launch.getByLabel('Metadata URL', { exact: true });
  await metadata.fill('https://');
  await launch.getByRole('button', { name: 'Launch token', exact: true }).click();
  await expect(metadata).toBeFocused();
  await expect(launch.getByText('Enter a complete HTTPS or IPFS URL.')).toBeVisible();
  assert(!methods.includes('eth_sendTransaction'), 'Invalid launch inputs must never request a transaction');
  // UI upload responses are isolated here; SingleSparkContract/arc/smoke.mjs checks real storage and authentication.
  await metadata.fill('');
  const imageUrl = 'https://images.example.test/cat.png';
  let uploadStatus = 201;
  await page.route(imageUrl, route => route.fulfill({ path: 'SingleSparkFront/front/static/assets/brands/singlespark.png', contentType: 'image/png' }));
  await page.route('**/api/arc/media', route => route.fulfill({ status: uploadStatus, json: uploadStatus === 201 ? { publicUrl: imageUrl } : {} }));
  await page.getByTestId('token-media-input').setInputFiles('SingleSparkFront/front/static/assets/brands/singlespark.png');
  await expect(page.locator('.arc-create-identity img')).toHaveAttribute('src', imageUrl);
  await expect(launch.getByRole('button', { name: 'Launch token', exact: true })).toBeEnabled();
  uploadStatus = 503;
  await page.getByTestId('token-media-input').setInputFiles('SingleSparkFront/front/static/assets/brands/singlespark.png');
  await expect(page.locator('.token-media-upload__error')).toContainText('Image storage is not available yet');
  await expect(page.locator('.arc-create-identity img')).toHaveAttribute('src', imageUrl);
  await page.getByRole('button', { name: 'Remove image', exact: true }).click();
  await expect(page.locator('.arc-create-identity img')).toHaveAttribute('src', '/assets/brands/usdc-token.svg');
  for (const locale of ['zh', 'en']) {
    await page.evaluate(locale => localStorage.setItem('ember-locale', locale), locale);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', locale === 'zh' ? 'zh-CN' : 'en');
    for (const width of [1440, 375, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark']) {
        if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('.nav-theme-toggle:visible').click();
        await expect(page.locator('.arc-create-image .create-media-button')).toBeVisible();
        await expect(page.locator('.arc-create-image .create-media-button')).toHaveCSS('color', theme === 'light' ? 'rgb(28, 32, 38)' : 'rgb(243, 244, 246)');
        assert(await page.locator('.arc-create-image .create-media-button').evaluate(element => element.clientHeight >= 44));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (width !== 320) await page.locator('.arc-create-layout').screenshot({ path: `/private/tmp/singlespark-image-upload-${locale}-${theme}-${width}.png`, animations: 'disabled' });
      }
    }
  }
  await page.evaluate(() => localStorage.setItem('ember-locale', 'en'));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(url);
  await expect(form.locator('.arc-trade-wallet')).toContainText('Connected wallet');
  await page.locator('.nav-cta--connected').click();
  await page.getByRole('menuitem', { name: 'Disconnect wallet' }).click();
  await expect(form.getByRole('button', { name: 'Connect wallet', exact: true })).toBeVisible();
  await page.goto('http://127.0.0.1:5176/create');
  await page.locator('.create-page form').getByRole('button', { name: 'Connect wallet', exact: true }).click();
  await expect(page.locator('.wallet-modal-dialog')).toBeVisible();
  assert(!methods.includes('eth_sendTransaction'));
  assert.deepEqual(errors, []);
  console.log('PASS: real SIWE login, trade/launch validation, image upload preview/retry/removal, both languages/themes on desktop/mobile and disconnect. No transactions sent.');
} finally { await browser.close(); }
