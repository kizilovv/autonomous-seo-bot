import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderedContains } from '../src/verify/rendered-text.js';
import { blogReadabilityIssues } from '../src/quality/blog-readability.js';
import { runMigrations } from '../src/db/migrate.js';
import { getDb, closeDb } from '../src/db/connection.js';
import { replaceGa4Window } from '../src/db/repo.js';
import { comparableMetrics, rollbackTo, type CandidateRow } from '../src/workers/ctr-feedback.js';

test('HTML entities and split inline text verify, hydration-only text does not', () => {
  assert.equal(renderedContains('<title>buy &amp; sell &#x43;S2</title>', 'buy & sell CS2'), true);
  assert.equal(renderedContains('<p>buy <b>skins</b> safely</p>', 'buy skins safely'), true);
  assert.equal(renderedContains('<script>"buy skins safely"</script>', 'buy skins safely'), false);
});
test('unreadable drafts are flagged without rejecting concise structured prose', () => {
  assert.deepEqual(blogReadabilityIssues('<h2>Inspect the pattern</h2><p>Check the pattern index in game.</p>'), []);
  assert.ok(blogReadabilityIssues('<p>' + 'word '.repeat(121) + '</p>').length);
  assert.ok(blogReadabilityIssues('<p>[insert screenshot]</p>').length);
});
test('GA4 replacement is repeatable and records window provenance; feedback isolates exact page and periods', () => {
  runMigrations();
  const db = getDb();
  const row = { property_id: 'p', snapshot_date: '2026-09-30', host: 'csboard.com', channel: 'Organic Search', landing_page: '/en/sell', sessions: 4, engaged: 3, engagement_rate: .75 };
  replaceGa4Window('p', '2026-09-03', '2026-09-30', [row]);
  replaceGa4Window('p', '2026-09-03', '2026-09-30', [{...row, sessions: 5}]);
  assert.deepEqual(db.prepare('SELECT sessions, window_start, window_end FROM ga4_snapshots').all(), [{sessions: 5, window_start:'2026-09-03', window_end:'2026-09-30'}]);
  const opp: CandidateRow = { id:1, locale:'en', path:'/sell', field:'title', query:'sell skins', applied_at:'2026-09-10T00:00:00Z', applied_content_id:1, baseline_ctr:.9, baseline_position:1, baseline_impressions:9999, proposed_value:'"new"' };
  const ins = db.prepare('INSERT INTO gsc_snapshots(site, snapshot_date, query, page, impressions, clicks, ctr, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [start, clicks] of [['2026-09-03', 10], ['2026-09-17', 20]] as const) {
    for (let i=0;i<7;i++) {
      const date = new Date(Date.parse(start)+i*86400000).toISOString().slice(0,10);
      ins.run('sc-domain:csboard.com',date,'sell skins','https://csboard.com/en/sell',100,clicks,clicks/100,5);
      ins.run('sc-domain:csboard.com',date,'sell skins','https://csboard.com/en/unrelated',10000,9999,.9999,1);
    }
  }
  const metrics = comparableMetrics(opp,'sc-domain:csboard.com');
  assert.equal(metrics?.before.ctr,.1);
  assert.equal(metrics?.after.ctr,.2);
  assert.equal(metrics?.after.impressions,700);
  db.prepare('INSERT INTO content(id,locale,path,field,value,source) VALUES (1, ?, ?, ?, ?, ?)').run('en','/sell','title','"human title"','human:pinned');
  assert.equal(rollbackTo(opp).ok,false);
  db.prepare("DELETE FROM gsc_snapshots WHERE snapshot_date='2026-09-17'").run();
  assert.equal(comparableMetrics(opp,'sc-domain:csboard.com'),null);
  closeDb();
});

import { pullLandingPages } from '../src/google/ga4.js';
test('GA4 fetches tail after 5,000 rows and never replaces a snapshot on partial failure', async () => {
  runMigrations();
  const offsets: number[] = [];
  const client = { runReport: async (request: {offset:number}) => {
    offsets.push(request.offset);
    return [{rowCount:5001, rows:Array.from({length:request.offset === 0 ? 5000 : 1}, (_, i) => ({dimensionValues:[{value:`/item/${request.offset+i}`},{value:'csboard.com'},{value:'Organic Search'}],metricValues:[{value:'1'},{value:'1'},{value:'1'}]}))}];
  }};
  assert.equal(await pullLandingPages({sinceDate:'2026-10-01',untilDate:'2026-10-02'}, client as any),5001);
  assert.deepEqual(offsets,[0,5000]);
  await assert.rejects(pullLandingPages({sinceDate:'2026-10-01',untilDate:'2026-10-02'}, {runReport:async () => [{rowCount:5001,rows:[]}]} as any), /incomplete/);
  assert.equal((getDb().prepare("SELECT COUNT(*) n FROM ga4_snapshots WHERE window_start='2026-10-01'").get() as {n:number}).n,5001);
  closeDb();
});

import { commercialClaimViolation } from '../src/quality/commercial-facts.js';
test('commercial facts distinguish money sales from deposits and nonmonetary swaps', () => {
  for (const claim of ['Zero trading fees', 'P2P sales with zero commission', 'Продажа скинов без комиссии', 'Торговая комиссия 0%', 'Commission-free P2P trades', 'Нулевая комиссия', 'Zero-Fee Marketplace', 'P2P sales commission is 1%', 'Комиссия за продажу 0,0%']) assert.ok(commercialClaimViolation(claim), claim);
  for (const claim of ['Deposits have 0% fees.', 'P2P sales commission is 2%.', 'Item-for-item trades have zero fees.', 'Пополнение без комиссии.', 'Обмен скин на скин без комиссии.']) assert.equal(commercialClaimViolation(claim), null, claim);
  assert.ok(commercialClaimViolation('CSBoard is operated by Transtrade.'));
  assert.equal(commercialClaimViolation('CSBoard operator is Nextrade Labs. Transtrade is a payment processor.'),null);
});

test('editorial competitor attribution and conditional Premium discount do not cause false positives', () => {
  assert.equal(commercialClaimViolation('CSFloat sales fee is 2.5%.', 'editorial'), null);
  assert.equal(commercialClaimViolation('Skinport sales fee is 8%.', 'editorial'), null);
  assert.equal(commercialClaimViolation('CS.MONEY sales fee is 5%.', 'editorial'), null);
  assert.ok(commercialClaimViolation('All marketplaces have zero trading fees.', 'editorial'));
  assert.ok(commercialClaimViolation('Все площадки включая CSFloat продают без комиссии.', 'editorial'));
  assert.ok(commercialClaimViolation('CSFloat charges 2.5% while CSBoard sales are commission-free.', 'editorial'));
  assert.ok(commercialClaimViolation('P2P sales fee is 1.6%'));
  assert.equal(commercialClaimViolation('P2P sales fee is 1.6% after an active Premium discount.'), null);
  assert.equal(commercialClaimViolation('P2P sales have a base fee of 2% with a 20% Premium discount.'), null);
  assert.ok(commercialClaimViolation('Premium sales have zero commission after discount.'));
  assert.ok(commercialClaimViolation('Premium sales fee is 3% after discount.'));
  assert.ok(commercialClaimViolation('<p>CSFloat sales fee is 2.5%</p><p>Sales are commission-free</p>', 'editorial'));
});

test('real-world paraphrases cannot reintroduce universal free selling or wrong operator', () => {
  const invalid = ['CSBoard is 100% free', 'buy and sell at no cost', 'eliminate trading commissions entirely', 'keep 100% sale proceeds', 'нет комиссий', 'комиссия за сделки отсутствует', 'Никаких комиссий', 'CSBoard полностью бесплатный', 'Transtreid operates CSBoard', 'Оператор платформы Транстрейд'];
  for (const claim of invalid) assert.ok(commercialClaimViolation(claim), claim);
  for (const claim of ['Browsing CSBoard listings is 100% free', 'Browse the inventory at no cost', 'Просмотр предметов полностью бесплатный', 'Item-for-item exchanges have no commissions', 'Deposits have no fees', 'Transtreid is a payment processor', 'Транстрейд не является оператором платформы']) assert.equal(commercialClaimViolation(claim), null, claim);
  assert.ok(commercialClaimViolation('Browse and sell at no cost'));
  assert.equal(commercialClaimViolation('CSFloat lets sellers keep 100% sale proceeds', 'editorial'), null);
});
