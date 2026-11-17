import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {Completions} from 'openai/resources/chat/completions';
import {config} from '../src/config.js';
import {getDb,closeDb} from '../src/db/connection.js';
import {runMigrations} from '../src/db/migrate.js';
import {runGenerate} from '../src/workers/generate.js';

test('a rejected monetary promise is not reported as a technical generation failure',async()=>{
 runMigrations();const old=config.OPENROUTER_API_KEY;config.OPENROUTER_API_KEY='test-no-network';let calls=0;
 const stub=mock.method(Completions.prototype,'create',async()=>{calls++;return {choices:[{message:{content:'Compare skin prices on CSBoard with guaranteed instant payouts and zero P2P selling fees. Sell your CS2 skins instantly with no restrictions today.'}}],usage:{prompt_tokens:10,completion_tokens:30}};});
 try{
  const db=getDb();db.prepare("INSERT INTO opportunities(kind,locale,path,field,query,status) VALUES ('snippet_rewrite','en','/blog/compare-fixture','description','compare skin prices','pending')").run();
  const result=await runGenerate();assert.equal(calls,1);assert.equal(result.quality_rejected,1);assert.equal(result.failed,0);assert.equal(result.generated,0);
  const row=db.prepare('SELECT status,notes,proposed_value FROM opportunities').get() as any;
  assert.equal(row.status,'rejected');assert.match(row.notes,/quality-gate:/);assert.equal(row.proposed_value,null);
 }finally{stub.mock.restore();config.OPENROUTER_API_KEY=old;closeDb();}
});
