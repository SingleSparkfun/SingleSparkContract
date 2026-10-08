// The Satisfaction page in a real browser: node SingleSparkContract/arc/check-satisfaction-ui.mjs <origin> [--live]
//
// `SingleSparkContract/arc/check-satisfaction.mjs --ui` starts a throwaway Anvil chain, the real backend and a Vite
// dev server on temporary ports and then runs this script against them; the data it asserts (the three
// round 0 votes and their reasons, the settled rounds) is described by SATISFACTION_UI_FIXTURE.
//
// `--live` keeps only what any environment must satisfy — menu, direct-load styling, the hero, the
// records section, the wallet list, no page errors, no failed same-origin requests, screenshots — so
// the same script can be pointed at a real deployment, where the seeded votes and rounds do not exist
// and where the running binary may not serve the vote records endpoint at all.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

const entry = (process.argv[2] ?? 'http://127.0.0.1:5176').replace(/\/+$/, '');
const live = process.argv.includes('--live');
const fixture = process.env.SATISFACTION_UI_FIXTURE ? JSON.parse(process.env.SATISFACTION_UI_FIXTURE) : null;
assert(live || fixture, 'Without --live this check needs SATISFACTION_UI_FIXTURE from check-satisfaction.mjs --ui');
const shots = resolve('SingleSparkContract/arc/data/satisfaction-ui-check');
mkdirSync(shots, { recursive: true });
const watched = new Set([new URL(entry).origin, ...(fixture ? [new URL(fixture.api).origin] : [])]);
const MENU = ['Token list', 'Launch', 'Burn', 'Satisfaction', 'Globe', 'How it works'];
// Rewritten in the words of the two buttons; the on-chain outcomes keep their own names.
const RULES = ['If Satisfied wins, the round settles as Approved',
  'If Not satisfied wins, the round settles as Rejected',
  'the round is Void and the pot rolls into the next round', 'Earlier votes weigh more',
  'locked until the round is settled', 'The team can vote too', 'Both come from the contract'];
// The four truthful phase lines; exactly one of them is on the page.
const PHASES = ['Not started · voting opens in', 'Accumulating · voting opens in', 'Voting open · ends in',
  'Voting open · round not opened yet', 'Round over · awaiting settlement'];
// Every request this page makes must succeed, with two allowances: a request the page itself cancelled,
// and — against a live deployment only — the vote records endpoint that an older binary does not serve.
// Each reload here aborts whatever was in flight, and the page aborts its own fetches on unmount
// (react-query's signal, the record and round lists). A server or network failure is not reported as
// ERR_ABORTED -- it arrives as a connection error or a status of 400 and up, both still asserted.
const CANCELLED = 'net::ERR_ABORTED';
const RECORDS = '/api/arc/satisfaction/votes';

const seconds = clock => {
  const [, days, hours, minutes, secs] = /(?:(\d+)d )?(\d{2}):(\d{2}):(\d{2})/.exec(clock)
    ?? assert.fail(`Not a countdown: ${clock}`);
  return Number(days ?? 0) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(secs);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const problems = [];
const notes = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  const errors = [];
  const dialogs = [];
  const failed = [];
  page.on('pageerror', error => errors.push(error.message));
  // An `alert(1)` from an injected reason would arrive here; dismissing it keeps the page usable so
  // the failure is reported by this check rather than by a timeout.
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  const cancelled = [];
  const recordsMissing = [];
  page.on('requestfailed', request => {
    if (!watched.has(new URL(request.url()).origin)) return;
    const why = request.failure()?.errorText;
    (why === CANCELLED ? cancelled : failed).push({ url: request.url(), why });
  });
  page.on('response', response => {
    if (response.status() < 400 || !watched.has(new URL(response.url()).origin)) return;
    if (live && response.status() === 404 && new URL(response.url()).pathname === RECORDS) {
      recordsMissing.push(response.url());
      return;
    }
    failed.push({ url: response.url(), why: response.status() });
  });
  // The temporary page must never reach the developer's own stack on 5176/8090.
  const strayed = [];
  page.on('request', request => {
    if (!live && ['5176', '8090'].includes(new URL(request.url()).port)) strayed.push(request.url());
  });

  // ---------------------------------------------------------------- Direct load, menu and styling
  // First navigation of the session goes straight to /satisfaction: the route used to render unstyled
  // because only ArcMarket imported the shared stylesheet.
  await page.goto(`${entry}/satisfaction`);
  // A profile that has never visited gets the first-visit introduction over every route; it is modal,
  // so it has to be closed (which is what marks it read) before anything on the page can be clicked.
  const intro = page.locator('.how-intro');
  await expect(intro).toHaveCount(1);
  await expect(intro.locator('#how-intro-title')).toBeVisible();
  await intro.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(intro).toHaveCount(0);
  await expect(page.locator('main.satisfaction-page h1')).toHaveText('Satisfaction');
  const hero = page.locator('.satisfaction-hero');
  await expect(hero).toHaveCSS('border-radius', '16px'); // .arc-surface, from pages/Arc/market.css
  const background = await hero.evaluate(element => getComputedStyle(element).backgroundColor);
  assert(!['rgba(0, 0, 0, 0)', 'transparent'].includes(background), `A direct load left .arc-surface unstyled: ${background}`);
  const menu = page.locator('.desktop-nav__links > a');
  await expect(menu).toHaveCount(MENU.length);
  await expect(menu.locator('span')).toHaveText(MENU);
  await expect(menu.nth(3)).toHaveAttribute('aria-current', 'page');
  const icon = menu.nth(3).locator('img');
  await expect(icon).toHaveAttribute('src', /assets\/navigation\/satisfaction-still\.png$/);
  await expect.poll(() => icon.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);

  // ---------------------------------------------------------------- The hero
  const status = await page.locator('.arc-network-status').textContent();
  const round = Number(/Round (\d+)/.exec(status)?.[1]);
  assert(Number.isSafeInteger(round) && round >= 0, `No round number in "${status}"`);
  if (fixture) assert.equal(round, fixture.currentRound);
  const phase = (await page.locator('.satisfaction-phase').textContent()).trim();
  assert(PHASES.includes(phase), `The hero states an unknown phase: "${phase}"`);
  // `vote()` opens the round itself, so both voting phases accept votes — also the one nobody has opened yet.
  const open = phase.startsWith('Voting open');
  if (!live) assert(open, `The fixture run needs the voting window open, not "${phase}"`);
  // Both durations come from the contract, so the page must never print a hard-coded round length.
  const figures = page.locator('.satisfaction-figure');
  await expect(figures).toHaveCount(3);
  await expect(figures.nth(1)).toContainText('Round length');
  await expect(figures.nth(2)).toContainText('Voting window');
  for (const index of [1, 2]) {
    const text = (await figures.nth(index).textContent()).replace(/Round length|Voting window/, '').trim();
    assert(/^\d+ (second|minute|hour|day)s?( \d+ (second|minute|hour)s?)?$/.test(text), `Not a spelled-out duration: "${text}"`);
  }
  const pot = (await figures.nth(0).textContent())
    .replace('The pot is fixed when voting opens. Revenue arriving after that goes to the next round.', '')
    .replace(/Estimated pot|Pot|USDC/g, '').trim();
  assert(/^\d[\d,]*(\.\d+)?$/.test(pot), `The pot does not read as an amount: "${pot}"`);
  await expect(figures.nth(0).locator('img')).toHaveCount(1); // the shared USDC asset icon

  const clock = page.locator('.satisfaction-countdown');
  if (phase === 'Round over · awaiting settlement') {
    await expect(clock).toHaveCount(0);
    notes.push('The round had ended, so no countdown was shown.');
  } else {
    const first = (await clock.textContent()).trim();
    if (!live) assert(seconds(first) > 30, `The voting window is nearly over (${first}); the page check needs it open`);
    await page.waitForTimeout(1_500);
    const second = (await clock.textContent()).trim();
    assert(seconds(second) < seconds(first), `The countdown did not tick: ${first} -> ${second}`);
    notes.push(`countdown ${first} -> ${second}`);
  }

  // The two sides, their stickers and their shares.
  const sides = page.locator('.satisfaction-vote-button');
  await expect(sides).toHaveCount(2);
  await expect(sides.nth(0)).toContainText('Satisfied');
  await expect(sides.nth(1)).toContainText('Not satisfied');
  await expect(sides.nth(0)).toHaveAttribute('data-support', 'true');
  await expect(sides.nth(1)).toHaveAttribute('data-support', 'false');
  // The artwork is the transcoded Telegram sticker, not an emoji character or a drawn shape.
  for (const [index, name] of [[0, 'satisfied'], [1, 'not-satisfied']]) {
    const sticker = sides.nth(index).locator('img');
    await expect(sticker).toHaveAttribute('src', new RegExp(`assets/satisfaction/${name}-(still\\.png|icon\\.webp)$`));
    await expect.poll(() => sticker.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  }
  const percent = async index => Number(/(\d+(?:\.\d+)?)%/.exec(await sides.nth(index).textContent())[1]);
  const [yes, no] = [await percent(0), await percent(1)];
  for (const value of [yes, no]) assert(value >= 0 && value <= 100, `A share outside 0-100%: ${value}`);
  const staked = await sides.locator('.satisfaction-vote-meta').nth(0).textContent();
  const untouched = live && yes === 0 && no === 0;
  assert(untouched || Math.abs(yes + no - 100) < 0.05, `Satisfied and Not satisfied do not add up: ${yes} + ${no}`);
  for (const index of [0, 1]) {
    const lines = await sides.nth(index).locator('.satisfaction-vote-meta').allTextContents();
    assert.equal(lines.length, 2);
    assert(/^[\d,]+(\.\d+)? SPARK staked$/.test(lines[0]), `Bad stake line: "${lines[0]}"`);
    assert(/^[\d,]+(\.\d+)? vote weight$/.test(lines[1]), `Bad weight line: "${lines[1]}"`);
    if (!live) assert(parseFloat(lines[0].replace(/,/g, '')) > 0, `Both sides must have stake: ${staked}`);
  }
  await expect(page.getByRole('progressbar', { name: /^Staked toward the minimum: \d+(\.\d+)?%$/ })).toHaveCount(1);
  await expect(page.getByRole('progressbar', { name: /^Vote weight toward the minimum: \d+(\.\d+)?%$/ })).toHaveCount(1);
  await expect(page.getByRole('progressbar', { name: /^Satisfied \d+(\.\d+)?%$/ })).toHaveCount(1);
  // Yes/No are gone from this page: the sides are named the way the owner asked for.
  const body = await page.locator('main.satisfaction-page').textContent();
  for (const broken of ['NaN', 'undefined', 'Infinity', '[object']) {
    assert(!body.includes(broken), `"${broken}" is rendered on the page`);
  }
  const rules = page.locator('.satisfaction-rules > li');
  await expect(rules).toHaveCount(RULES.length);
  for (const [index, text] of RULES.entries()) await expect(rules.nth(index)).toContainText(text);

  // ---------------------------------------------------------------- A side opens the vote dialog
  if (open) {
    await sides.nth(1).click();
    const voteDialog = page.locator('.satisfaction-dialog');
    await expect(voteDialog.locator('h2')).toHaveText(`Vote on round ${round}`);
    // The pressed side is preselected, and the other one is still offered.
    await expect(voteDialog.locator('.segmented-tabs__item[aria-pressed="true"]')).toHaveText('Not satisfied');
    await expect(voteDialog.locator('.segmented-tabs__item')).toHaveText(['Satisfied', 'Not satisfied']);
    await page.screenshot({ path: resolve(shots, 'vote-dialog-1440-light.png') });
    await voteDialog.getByRole('button', { name: 'Connect wallet' }).click();
    const picker = page.locator('.wallet-modal-dialog .wallet-picker');
    await expect(picker).toBeVisible();
    await expect(picker.locator('.wallet-picker__option .wallet-picker__name'))
      .toHaveText(['MetaMask', 'OKX Wallet', 'Binance Wallet', 'Coinbase Wallet']);
    await expect(picker.locator('.wallet-connect-header__title')).toHaveText('Connect Wallet');
    await expect(picker.getByText('Choose how to connect to SingleSpark')).toBeVisible();
    // The list itself, not an intro page with a second entry into it.
    await expect(page.getByRole('button', { name: /open wallet picker/i })).toHaveCount(0);
    await expect(page.locator('.wallet-modal-dialog .wallet-connect-header__back-icon')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.wallet-modal-dialog')).toHaveCount(0);
    await voteDialog.getByRole('button', { name: 'Close' }).click();
    await expect(voteDialog).toHaveCount(0);
  } else {
    // Outside the window both sides refuse the vote and say why, in text rather than a tooltip.
    for (const index of [0, 1]) await expect(sides.nth(index)).toBeDisabled();
    const reason = await sides.nth(0).getAttribute('aria-describedby');
    await expect(page.locator(`#${reason}`)).toHaveText('Voting opens in the last part of each round.');
    notes.push('The live round was not open for voting, so the dialog was not photographed.');
  }

  // ---------------------------------------------------------------- The vote records
  const records = page.locator('.satisfaction-records');
  await expect(records.locator('h2')).toHaveText('Vote records');
  await expect(records.getByText('Votes appear once their block is finalized.')).toBeVisible();
  const chips = records.locator('.satisfaction-round-chip');
  await expect(chips.nth(0)).toContainText(`Round ${round}`);
  await expect(chips.nth(0)).toHaveAttribute('aria-pressed', 'true');
  const unavailable = records.getByText('Vote records are not available from this server yet.');
  /** Switches the records to a past round through its chip. */
  const showRound = async wanted => {
    await chips.filter({ hasText: new RegExp(`^Round ${wanted}\\b`) }).first().click();
    await expect(chips.filter({ hasText: new RegExp(`^Round ${wanted}\\b`) }).first()).toHaveAttribute('aria-pressed', 'true');
  };
  if (live && await unavailable.count()) {
    // The binary running on the testnet predates this endpoint; the page must say so and keep working.
    await expect(unavailable).toBeVisible();
    await expect(records.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(records.locator('.satisfaction-table')).toHaveCount(0);
    notes.push('This server has no vote records endpoint yet; the friendly unavailable state was checked instead.');
  } else {
    assert(!await unavailable.count(), 'The fixture backend must serve the vote records endpoint');
    const outcomes = await page.locator('.satisfaction-round-row').allTextContents();
    if (!live) {
      for (const outcome of ['Approved · Satisfied won', 'Rejected · Not satisfied won', 'Void · pot rolled over']) {
        assert(outcomes.some(row => row.includes(outcome)), `Past rounds without a ${outcome} round: ${outcomes}`);
      }
      await showRound(fixture.round);
      const rows = records.locator('tbody tr');
      await expect(rows).toHaveCount(3);
      await expect(records.getByText(fixture.normal, { exact: true })).toBeVisible();
      await expect(records.getByText('Reason hidden by moderators')).toBeVisible();
      const listed = await records.textContent();
      assert(!listed.includes(fixture.hidden), 'A hidden reason still shows its text');
      // Verbatim as text; never as markup, and never a script that runs.
      await expect(records.getByText(fixture.injection, { exact: true })).toBeVisible();
      assert.equal(await page.evaluate(() => document.querySelector('img[src="x"]')), null);
      assert.deepEqual(dialogs, [], 'A dialog was opened from page content');
      // Each row names its side in the new words, with the sticker beside it.
      const listedSides = await records.locator('tbody .satisfaction-side').allTextContents();
      assert.equal(listedSides.length, 3);
      for (const side of listedSides) assert(['Satisfied', 'Not satisfied'].includes(side), `Unknown side "${side}"`);
      await expect(records.locator('tbody .satisfaction-side img')).toHaveCount(3);
      // Only one side of the filter, and the counts must not disagree with the table.
      await records.getByRole('button', { name: 'Not satisfied', exact: true }).click();
      await expect(records.locator('tbody tr')).toHaveCount(1);
      await records.getByRole('button', { name: 'Satisfied', exact: true }).click();
      await expect(records.locator('tbody tr')).toHaveCount(2);
      await records.getByRole('button', { name: 'All', exact: true }).click();
      await expect(records.locator('tbody tr')).toHaveCount(3);
    } else {
      // A live deployment may have an empty round; either a table or the empty line, never both.
      const table = await records.locator('.satisfaction-table').count();
      const empty = await records.getByText('No finalized votes in this round yet.').count();
      assert.equal(table + empty, 1, 'The records section showed neither a table nor an empty state');
      notes.push(table ? 'live vote records listed' : 'the live round has no finalized votes yet');
    }
  }

  // ---------------------------------------------------------------- The celebration overlay
  // The development-only hook stands in for a confirmed vote; it is absent from a production build.
  const hooked = await page.evaluate(() => typeof window.__satisfactionTest?.celebrate === 'function');
  if (hooked) {
    const overlay = page.locator('.satisfaction-celebration');
    await expect(overlay).toHaveCount(0); // Never on load, and never for records already listed.
    // Photographed with motion allowed; the reduced-motion path is checked right after.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    for (const [side, announcement, atMs] of [['satisfied', 'Your Satisfied vote is confirmed.', 900],
      ['not-satisfied', 'Your Not satisfied vote is confirmed.', 1_600]]) {
      const focusedBefore = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120));
      await page.evaluate(value => window.__satisfactionTest.celebrate(value), side);
      await expect(overlay).toHaveCount(1);
      await expect(overlay).toHaveAttribute('data-side', side);
      await expect(overlay).toHaveAttribute('data-reduced', 'false');
      await expect(overlay.getByRole('status')).toHaveText(announcement);
      // Decorative only: it must never take the pointer or move focus away.
      await expect(overlay).toHaveCSS('pointer-events', 'none');
      assert.equal(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120)), focusedBefore, 'The celebration moved focus');
      await page.waitForTimeout(atMs);
      // The Lottie player has the unpacked artwork by now; the burst is layered at the impact frame.
      await expect(overlay.locator('.satisfaction-celebration-player svg')).toHaveCount(1);
      if (side === 'not-satisfied') await expect(overlay.locator('.satisfaction-celebration-impact')).toHaveCount(1);
      await page.screenshot({ path: resolve(shots, `celebration-${side}.png`) });
      await expect(overlay).toHaveCount(0, { timeout: 5_000 });
    }
    // Reduced motion: the still artwork, for a moment, with no player mounted at all.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => window.__satisfactionTest.celebrate('satisfied'));
    await expect(overlay).toHaveAttribute('data-reduced', 'true');
    await expect(overlay.locator('.satisfaction-celebration-player')).toHaveCount(0);
    await expect(overlay.locator('.satisfaction-celebration-still')).toHaveCount(1);
    await expect(overlay).toHaveCount(0, { timeout: 5_000 });
  } else {
    problems.push('The development test hook was missing, so the celebration was not checked');
  }

  // ---------------------------------------------------------------- Both themes, desktop and phone
  for (const theme of ['light', 'dark']) {
    for (const [width, height] of [[1440, 1100], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(value => localStorage.setItem('jet-theme', value), theme);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('.satisfaction-rules > li')).toHaveCount(RULES.length);
      await expect(page.locator('.satisfaction-vote-button')).toHaveCount(2);
      if (!live) await showRound(fixture.round);
      await page.waitForTimeout(500); // Let the segmented bars finish their reveal.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      if (overflow > 0) {
        problems.push(`Horizontal overflow of ${overflow}px at ${width}px (${theme}): ` + await page.locator('main *').evaluateAll(
          elements => elements.filter(element => element.getBoundingClientRect().right > innerWidth + 1)
            .map(element => element.className).slice(0, 10).join(', ')));
      }
      // The two sides stay a comfortable target on a phone.
      for (const index of [0, 1]) {
        const box = await page.locator('.satisfaction-vote-button').nth(index).boundingBox();
        if (box.height < 44) problems.push(`A vote button is only ${box.height}px tall at ${width}px`);
      }
      await page.screenshot({ path: resolve(shots, `satisfaction-${width}-${theme}.png`), fullPage: true });
    }
  }
  // The dialog at phone width: it must fit the viewport it opens in.
  await page.evaluate(() => localStorage.setItem('jet-theme', 'light'));
  await page.reload();
  if (open) {
    await page.locator('.satisfaction-vote-button').nth(0).click();
    await expect(page.locator('.satisfaction-dialog')).toBeVisible();
    await page.screenshot({ path: resolve(shots, 'vote-dialog-390-light.png') });
    const surface = page.locator('.app-modal-dialog'); // the wallet modal is closed, so this is the vote dialog
    const box = await surface.boundingBox();
    if (box.width > 390) problems.push(`The vote dialog is ${box.width}px wide at 390px`);
    // The shared modal brings no padding of its own; a dialog that forgets to add any puts its title
    // in the very corner of the box.
    const padding = await surface.evaluate(element => getComputedStyle(element).padding);
    if (/(^|\s)0px/.test(padding)) problems.push(`The vote dialog surface has no padding: ${padding}`);
    const dialogOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (dialogOverflow > 0) problems.push(`The vote dialog overflows the phone viewport by ${dialogOverflow}px`);
  }

  // One report for the whole run: a single failure here should not hide the others.
  assert.deepEqual({ pageErrors: errors, requestsToTheDevelopmentStack: strayed, failedRequests: failed,
    dialogsOpenedByThePage: dialogs, layout: problems },
  { pageErrors: [], requestsToTheDevelopmentStack: [], failedRequests: [], dialogsOpenedByThePage: [], layout: [] });
  console.log(`PASS: /satisfaction at ${entry} — menu order, direct-load styling, hero for round ${round} `
    + `("${phase}", ${yes}% Satisfied / ${no}% Not satisfied), round length and voting window from the chain, `
    + `quorum bars, ${RULES.length} rules, ${open ? 'the preselected side in the vote dialog, wallet list, ' : ''}`
    + `${live ? 'vote records structure only' : 'round ' + fixture.round + ' vote records with the injection probe as text'}, `
    + `both celebrations, no page errors, no failed requests (${cancelled.length} cancelled by the page's own reloads`
    + `${recordsMissing.length ? `, ${recordsMissing.length} vote-record 404s from an older binary` : ''}). `
    + `${notes.join('. ')}. Screenshots in ${shots}.`);
} finally {
  await browser.close();
}
