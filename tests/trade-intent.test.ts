import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestTargetPage } from '../src/workers/dataforseo_pull.js';

test('contracts and calculators stay out of transactional landing copy', () => {
  for (const query of ['knife trade up calculator', 'AK-47 trade-up contract', 'CS2 tradeups']) {
    assert.equal(suggestTargetPage(query), null);
  }
  assert.equal(suggestTargetPage('trade cs2 skins'), '/trades');
  assert.equal(suggestTargetPage('sell cs2 skins'), '/sell');
});
