// Real SIWE/media/metadata API and read-only browser checks; no wallet transactions are sent.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hexToString } from 'viem';

const report = JSON.parse(readFileSync('SingleSparkContract/arc/deployments/arc-current-testnet.json'));
const dir = 'SingleSparkContract/arc/data/current-testnet-20260917/ui';
mkdirSync(dir, { recursive: true });
const site = 'http://127.0.0.1:5176';
const api = 'http://127.0.0.1:8089';
const account = privateKeyToAccount(generatePrivateKey());
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  const errors = [], methods = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('testWalletRequest', async ({ method, params }) => {
    methods.push(method);
    if (method === 'wallet_requestPermissions') return [{ parentCapability: 'eth_accounts' }];
    if (['eth_requestAccounts', 'eth_accounts'].includes(method)) return [account.address];
    if (method === 'eth_chainId') return `0x${(5042002).toString(16)}`;
    if (method === 'eth_getBalance') return '0x0';
    if (method === 'personal_sign') {
      const message = params[0].startsWith('0x') ? hexToString(params[0]) : params[0];
      assert(message.includes('Sign in to SingleSpark on ARC.') && message.includes(site));
      return account.signMessage({ message });
    }
    throw new Error(`Unexpected wallet method: ${method}`);
  });
  await page.addInitScript(() => {
    if (!localStorage.getItem('ember-locale')) localStorage.setItem('ember-locale', 'en');
    window.ethereum = { isMetaMask: true, request: args => window.testWalletRequest(args), on() {}, removeListener() {} };
  });
  let snapshot;
  for (let i = 0; i < 40; i++) {
    const response = await page.request.get(`${api}/api/arc/snapshot`);
    snapshot = await response.json();
    if (snapshot.tokens?.length === 3) break;
    assert(i < 39, 'New tokens must be indexed'); await new Promise(r => setTimeout(r, 2000));
  }
  assert.equal(snapshot.launch.toLowerCase(), report.deployment.launch.toLowerCase());
  assert.equal(snapshot.tokens[0].token.toLowerCase(), report.deployment.platformToken.toLowerCase());
  assert.equal(snapshot.keeperGasSupport, true);
  for (const token of snapshot.tokens) {
    assert(token.imageUrl && token.channels.website === 'https://singlespark.fun/');
    const metadata = await (await page.request.get(token.metadataURI)).json();
    assert.equal(metadata.image, token.imageUrl);
    assert.deepEqual(metadata.channels, token.channels);
    await page.goto(`${site}/token/${token.token}`);
    const avatar = token.token.toLowerCase() === snapshot.platformToken.toLowerCase()
      ? '/assets/brands/singlespark-glossy-v1-still.png' : token.imageUrl;
    await expect(page.locator('.arc-token-avatar img')).toHaveAttribute('src', avatar);
    await expect(page.locator('.arc-token-socials a[data-channel="website"]')).toHaveAttribute('href', token.channels.website);
    await expect.poll(() => page.locator('.arc-token-avatar img').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  }
  await page.goto(`${site}/`);
  const welcome = page.getByRole('dialog').filter({ hasText: 'Welcome to SingleSpark' });
  if (await welcome.count()) await welcome.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.discover-arc-avatar')).toHaveCount(3);
  assert.equal(await page.locator('.discover-arc-avatar img').first().getAttribute('src'), '/assets/brands/singlespark-glossy-v1-still.png');
  await page.screenshot({ path: `${dir}/token-list.png`, fullPage: true });
  await page.goto(`${site}/create`);
  await page.locator('.arc-create-submit').getByRole('button', { name: /^connect wallet$/i }).click();
  await page.locator('.wallet-connect-primary').click();
  const login = page.waitForResponse(response => response.url().endsWith('/api/auth/login') && response.request().method() === 'POST');
  await page.locator('.wallet-picker__option').filter({ has: page.getByText('MetaMask', { exact: true }) }).click();
  const sessionResponse = await login; assert.equal(sessionResponse.status(), 200);
  const session = await sessionResponse.json();
  await expect(page.locator('.wallet-modal-dialog')).toHaveCount(0);
  await page.locator('#arc-create-name').fill('Ember Cat'); await page.locator('#arc-create-symbol').fill('ECAT');
  const uploaded = page.waitForResponse(response => response.url().endsWith('/api/arc/media') && response.request().method() === 'POST');
  await page.getByTestId('token-media-input').setInputFiles('SingleSparkFront/front/static/assets/tokens/ember-cat.png');
  const imageResponse = await uploaded; assert.equal(imageResponse.status(), 201);
  const publicUrl = report.projects.find(token => token.symbol === 'ECAT').imageUrl;
  await expect(page.locator('.arc-create-identity img')).toHaveAttribute('src', publicUrl);
  await page.locator('#arc-social-x').fill('https://x.com.evil.example/cat'); await page.locator('#arc-social-x').blur();
  await expect(page.locator('#arc-social-x')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#arc-social-x').fill('https://x.com/example');
  await page.locator('#arc-social-telegram').fill('https://t.me/example');
  await page.locator('#arc-social-website').fill('https://singlespark.fun');
  await expect(page.locator('.arc-create-social-preview a[data-channel="telegram"]')).toHaveAttribute('href', 'https://t.me/example');
  const document = { name: 'UI validation only', symbol: 'UITEST', image: publicUrl,
    channels: { website: 'https://singlespark.fun', x: 'https://x.com/example', telegram: 'https://t.me/example' } };
  const endpoint = `${api}/api/arc/metadata`;
  assert.equal((await page.request.post(endpoint, { data: document })).status(), 401);
  const headers = { Authorization: `Bearer ${session.token}` };
  const saved = await page.request.post(endpoint, { headers, data: document }); assert.equal(saved.status(), 201);
  const savedDoc = await (await page.request.get((await saved.json()).metadataURI)).json();
  assert.equal(savedDoc.channels.x, document.channels.x); assert.equal(savedDoc.channels.telegram, document.channels.telegram);
  assert.equal((await page.request.post(endpoint, { headers, data: { ...document, channels: { x: 'https://user:pass@x.com/a' } } })).status(), 400);
  for (const theme of ['light', 'dark']) for (const width of [1440, 375]) {
    await page.evaluate(theme => { localStorage.setItem('jet-theme', theme); document.documentElement.dataset.theme = theme; }, theme);
    await page.setViewportSize({ width, height: 1000 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${dir}/create-${theme}-${width}.png`, fullPage: true });
  }
  assert(!methods.includes('eth_sendTransaction'));
  assert.deepEqual(errors, []);
  console.log('PASS: new factory and 3 distinct avatars; SIWE image upload; website/X/Telegram metadata; rejected unsafe links; desktop/mobile layout.');
} finally { await browser.close(); }
