import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gameplayPaths } from './build-gameplay.mjs';

test('new gameplay builds and journals stay separate from existing signed recovery', () => {
  const original = gameplayPaths();
  const next = gameplayPaths('repeat-payouts-20261012');
  assert.notEqual(next.output, original.output);
  assert.notEqual(next.journal, original.journal);
  assert(next.output.includes('/testnet/gameplay/redeployments/repeat-payouts-20261012/'));
  assert(next.journal.includes('/testnet/gameplay/redeployments/repeat-payouts-20261012/'));
  for (const id of ['../original', '/tmp/replacement', 'UPPERCASE', 'a'.repeat(65)]) assert.throws(() => gameplayPaths(id));
});
