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

import { cmsWriteBlockReason } from '../src/quality/cms-surface.js';
import { insertOpportunity } from '../src/db/repo.js';
import { runApply } from '../src/apply/applier.js';
test('item snippet proposals are blocked before CMS writes, including old queued proposals', async () => {
  for (const path of ['/items/m4a4-buzz-kill-minimal-wear','/items/sticker-boner-snap/','/rust/items/fire-jacket','/dota2/items/example/']) {
    assert.ok(cmsWriteBlockReason(path,'description'));
    assert.ok(cmsWriteBlockReason(path,'title'));
    assert.equal(cmsWriteBlockReason(path,null),null);
  }
  for (const path of ['/sell','/blog/example','/items','/items-guide','/rust/items','/dota2/items/','/rust/items/example/history']) assert.equal(cmsWriteBlockReason(path,'description'),null);
  runMigrations();
  const db=getDb();
  db.prepare('DELETE FROM opportunities').run();
  db.prepare('DELETE FROM content').run();
  for (const path of ['/items/m4a4-buzz-kill-minimal-wear','/rust/items/fire-jacket','/dota2/items/example']) {
  const id=insertOpportunity({kind:'snippet_rewrite',locale:'en',path,field:'description',query:'m4a4 buzz kill',current_value:null,proposed_value:JSON.stringify('A queued item description that cannot render.'),metrics:{impressions:200,ctr:.01,position:5},risk:'low'});
  const result=await runApply();
  assert.equal(result.auto_applied,0);
  assert.equal(result.blocked,1);
  assert.equal((db.prepare('SELECT count(*) n FROM content').get() as {n:number}).n,0);
  assert.equal((db.prepare('SELECT status FROM opportunities WHERE id=?').get(id) as {status:string}).status,'rejected');
  }
  closeDb();
});


test('unsupported payout promises and future returns are blocked; historical context is retained', () => {
  const rejected = [
    'Мгновенные выплаты в USDT', 'Вы получаете USDT мгновенно после подтверждения сделки.',
    'Instant USDT payouts', 'Withdrawals are immediate.', 'Receive USDT instantly.',
    'Аналитика позволяет предсказывать рост цен до 30% в год.',
    'Tier 2 carries similar appreciation as Tier 1 (15-30% per year) with much higher liquidity.', 'Guaranteed 30% annual returns.', 'We cannot guarantee returns but prices will rise 30% next year.', 'Skin prices will rise 30% next year.',
    'Instant payouts are not guaranteed; receive USDT instantly.',
    '<p>Не гарантируем мгновенные выплаты.</p><p>Вы получаете USDT мгновенно.</p>',
  ];
  for (const claim of rejected) assert.ok(commercialClaimViolation(claim), claim);
  const accepted = [
    'Instant sell quotes are separate from payouts.', 'Payout timing depends on settlement and the selected method.',
    'Instant payouts are not guaranteed.', 'Не гарантируем мгновенные выплаты.',
    'Мгновенные выплаты не гарантированы.', 'Are payouts instant?',
    'Цены выросли на 30% в прошлом году по данным указанного источника.',
    'Prices rose 30% last year according to the cited dataset.',
    'Нельзя предсказывать рост цен на 30% по прошлой динамике.',
    'We cannot guarantee 30% returns.', 'P2P sales have a base fee of 2%.', 'Guaranteed 99.9% uptime.',
  ];
  for (const claim of accepted) assert.equal(commercialClaimViolation(claim), null, claim);
});


test('old queued payout promises cannot reach the CMS apply path', async () => {
  runMigrations();
  const db = getDb();
  db.prepare('DELETE FROM opportunities').run();
  db.prepare('DELETE FROM content').run();
  const id = insertOpportunity({kind:'snippet_rewrite',locale:'en',path:'/sell',field:'description',query:'sell skins',current_value:null,proposed_value:JSON.stringify('Sell CS2 skins with instant USDT payouts.'),metrics:{impressions:200,ctr:.01,position:5},risk:'low'});
  const result = await runApply();
  assert.equal(result.auto_applied, 0);
  assert.equal(result.errors, 1);
  assert.match(result.details.join(" "), /Unsupported instant payout promise/);
  assert.equal((db.prepare('SELECT count(*) n FROM content').get() as {n:number}).n, 0);
  assert.equal((db.prepare('SELECT status FROM opportunities WHERE id=?').get(id) as {status:string}).status, 'rejected');
  closeDb();
});


import { BLOCKS_EXAMPLE, renderBlocksToHtml } from '../src/generate/blocks-generator.js';
import { validateBlocks, hasRequiredBlocks } from '../src/generate/blocks-schema.js';
test('the actual generator example satisfies its schema and publishing rules', () => {
  const result = validateBlocks(BLOCKS_EXAMPLE.blocks);
  assert.ok(result.ok, result.ok ? '' : result.errors);
  if (!result.ok) return;
  assert.equal(hasRequiredBlocks(result.blocks).ok, true);
  const html = renderBlocksToHtml(result.blocks);
  assert.deepEqual(blogReadabilityIssues(html), []);
  assert.equal(commercialClaimViolation(html, 'editorial'), null);
});


import { runCtrFeedback } from '../src/workers/ctr-feedback.js';
test('unrendered trading intro is blocked for queued writes and excluded from CTR attribution', async () => {
  assert.ok(cmsWriteBlockReason('/cs2-trading', 'intro_extra'));
  assert.ok(cmsWriteBlockReason('/cs2-trading/', 'intro_extra'));
  for (const path of ['/cs2-trading-sites','/cs2-marketplace/']) assert.ok(cmsWriteBlockReason(path,'intro_extra'));
  for (const [path, field] of [['/cs2-trading','title'],['/sell','intro_extra'],['/trades','intro_extra'],['/comparison','intro_extra'],['/','intro_extra']]) assert.equal(cmsWriteBlockReason(path,field),null);
  runMigrations(); const db=getDb();
  db.prepare('DELETE FROM opportunities').run(); db.prepare('DELETE FROM content').run();
  const id=insertOpportunity({kind:'rank_push',locale:'en',path:'/cs2-trading',field:'intro_extra',query:'paired swap cs2',current_value:null,proposed_value:JSON.stringify('A paired swap exchanges items directly.'),metrics:{impressions:187,ctr:.005,position:4},risk:'low'});
  const applied=await runApply(); assert.equal(applied.auto_applied,0); assert.equal(applied.blocked,1);
  assert.equal((db.prepare('SELECT count(*) n FROM content').get() as {n:number}).n,0);
  // Historical applied rows remain auditable but cannot be judged an improvement.
  db.prepare("UPDATE opportunities SET status='applied', applied_at=datetime('now','-20 days'), baseline_ctr=.005, applied_content_id=633 WHERE id=?").run(id);
  const feedback=await runCtrFeedback();
  assert.equal(feedback.unsupported_surface,1); assert.equal(feedback.improved,0); assert.equal(feedback.rolled_back,0);
  assert.equal((db.prepare('SELECT feedback_outcome FROM opportunities WHERE id=?').get(id) as {feedback_outcome:string}).feedback_outcome,'unsupported_surface');
  closeDb();
});


import { classifyAllSites } from '../src/analyze/classifier.js';
test('classifier uses verified CMS slots for both intro and FAQ opportunities', async () => {
 runMigrations(); const db=getDb();
 db.prepare('DELETE FROM opportunities').run(); db.prepare('DELETE FROM content').run(); db.prepare('DELETE FROM gsc_snapshots').run();
 const ins=db.prepare('INSERT INTO gsc_snapshots(site,snapshot_date,query,page,impressions,clicks,ctr,position) VALUES (?,?,?,?,?,?,?,?)');
 for(const route of ['/cs2-trading','/cs2-trading-sites','/cs2-marketplace','/trends','/premium','/create-offer','/cs2-skins-prices','/sell']) {
  for(const pos of [5,15]) ins.run('sc-domain:csboard.com','2026-10-01',`skin exchange ${pos}`,`https://csboard.com/en${route}`,1000,1,.001,pos);
 }
 await classifyAllSites({currSince:'2026-10-01',currUntil:'2026-10-01'});
 const rows=db.prepare("SELECT path,field FROM opportunities WHERE field IN ('intro_extra','faq') ORDER BY field").all();
 assert.deepEqual(rows,[{path:'/sell',field:'faq'},{path:'/sell',field:'intro_extra'}]);
 assert.ok(cmsWriteBlockReason('/cs2-marketplace','faq'));
 assert.equal(cmsWriteBlockReason('/sell/','faq'),null);
 closeDb();
});
