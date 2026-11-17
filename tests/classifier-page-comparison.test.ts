import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runMigrations} from '../src/db/migrate.js';
import {getDb,closeDb} from '../src/db/connection.js';
import {classifyAllSites} from '../src/analyze/classifier.js';
const period={currSince:'2026-11-08',currUntil:'2026-11-14',prevSince:'2026-11-01',prevUntil:'2026-11-07'};
function row(date:string,page:string,impressions:number,clicks:number,position:number){getDb().prepare('INSERT INTO gsc_snapshots(site,snapshot_date,query,page,impressions,clicks,ctr,position) VALUES (?,?,?,?,?,?,?,?)').run('sc-domain:csboard.com',date,'cs2 skin trading',page,impressions,clicks,clicks/impressions,position);}
test('another URL ranking top ten cannot create a false lost-ranking alert',async()=>{
 runMigrations();try{
 row('2026-11-01','https://csboard.com/en/',200,0,35);row('2026-11-01','https://csboard.com/en/trades',100,10,5);
 row('2026-11-08','https://csboard.com/en/',100,0,35);
 assert.equal((await classifyAllSites(period)).byKind.lost_ranking,0);
 }finally{closeDb();}
});
test('another URL losing clicks cannot trigger a rewrite of this URL',async()=>{
 runMigrations();try{
 row('2026-11-01','https://csboard.com/en/blog/skin-trading',200,1,5);row('2026-11-01','https://csboard.com/en/trades',100,20,5);
 row('2026-11-08','https://csboard.com/en/blog/skin-trading',100,1,5);
 assert.equal((await classifyAllSites(period)).byKind.ctr_regression,0);
 }finally{closeDb();}
});
test('a real same-page ranking loss is still detected',async()=>{
 runMigrations();try{
 row('2026-11-01','https://csboard.com/en/',200,20,5);row('2026-11-08','https://csboard.com/en/',100,0,35);
 assert.equal((await classifyAllSites(period)).byKind.lost_ranking,1);
 }finally{closeDb();}
});
