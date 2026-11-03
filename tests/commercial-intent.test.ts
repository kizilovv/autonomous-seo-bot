import test from 'node:test';
import assert from 'node:assert/strict';
import { commercialLandingForQuery } from '../src/quality/commercial-intent.js';
import { blogTopicEligibilityIssue, queryEligibilityIssue } from '../src/quality/query-eligibility.js';
test('observed pure transactional blog topics route to existing landings',()=>{
 for(const [query,path] of [['buy csgo skins online','/buy'],['csgo tradeing','/trades'],['cs go trade website','/trades'],['csgo trading site','/trades'],['csgo skin trading websites','/trades'],['swap csgo skins','/trades'],['csgo markets','/buy'],['продать скины кс 2','/sell'],['купить скины cs2','/buy'],['SELL CS:GO SKINS ONLINE','/sell']]) {
  assert.equal(commercialLandingForQuery(query),path,query);
  assert.match(blogTopicEligibilityIssue(query)!,/existing .* landing/);
  assert.equal(queryEligibilityIssue(query),null,'landing optimization itself remains eligible');
 }
});
test('distinct informational and integration intents are not blanket-blocked',()=>{
 for(const query of ['how to buy csgo skins online','best sites to buy cs2 skins','buy ak-47 neon revolution','cs2 skin deposit api','cs2 marketplace api integration','sell cs2 skins for crypto','как продать скины на карту','cs20 case contents','stattrak skin prices','cs2 market price history','csgo skin websites review']) assert.equal(commercialLandingForQuery(query),null,query);
});
