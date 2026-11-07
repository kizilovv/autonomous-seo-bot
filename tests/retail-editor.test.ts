import {test} from 'node:test';
import assert from 'node:assert/strict';
import {retailTopicIssue,reviewUnits,validateReview,collectEvidence,hash,reviewRetailDraft,type Evidence} from '../src/quality/retail-editor.js';
import {runMigrations} from '../src/db/migrate.js';
import {getDb,closeDb} from '../src/db/connection.js';
import {reviewPendingRetailBlogs} from '../src/workers/blog-auto-review.js';
const source:Evidence={id:'buy',url:'https://csboard.com/en/buy',fetched_at:new Date().toISOString(),text:'Compare the exact item variant before buying.',sha256:''};source.sha256=hash(source.text);
const units=[{id:'html:0',text:'Compare the exact item variant before buying.'}];
const good=()=>({decision:'publish',checks:{intent:true,useful_decision_support:true,no_filler:true,no_cannibalization:true,correct_language:true,claims_complete:true,no_unsupported_claims:true,safe_links:true},reasons:[],units:[{id:'html:0',fully_checked:true,no_factual_claims:false,claims:[{claim:units[0].text,source_id:'buy',quote:source.text}]}]});
test('retail scope allows decision guides and routes head terms away from duplicate blogs',()=>{
 for(const q of ['how to compare cs2 skin prices','как выбрать скин для покупки','оценка скинов перед продажей','sell cs2 skins for crypto','buy AK-47 skins with different wear'])assert.equal(retailTopicIssue(q),null,q);
 for(const q of ['caseway withdraw','csbattle withdraw','cs20 case contents','free skins promo','cs2 skin investment roi','skin deposit API','buy cs2 skins','продать скины','csgo casino'])assert.ok(retailTopicIssue(q),q);
});
test('verdict fails closed on missing units, invented citations, bad quality or unsupported claims',()=>{
 assert.deepEqual(validateReview(good(),units,[source]),[]);
 const missing=good();missing.units=[];assert.ok(validateReview(missing,units,[source]).length);
 const invented=good();invented.units[0].claims[0].quote='The fee is 99 percent.';assert.ok(validateReview(invented,units,[source]).length);
 const wrong=good();wrong.units[0].claims[0].source_id='invented-source';assert.ok(validateReview(wrong,units,[source]).length);
 const filler=good();filler.checks.no_filler=false;assert.ok(validateReview(filler,units,[source]).length);
 const unsupported=good();unsupported.checks.no_unsupported_claims=false;assert.ok(validateReview(unsupported,units,[source]).length);
 const silent=good();silent.units[0].claims=[];assert.ok(validateReview(silent,units,[source]).length);
 assert.ok(validateReview({decision:'publish'},units,[source]).length);
});
test('review includes metadata FAQ and block representation without truncation',()=>{
 const u=reviewUnits({title:'title',body_html:'<p>ok</p>',body_blocks:[{type:'text',html:'invented claim'}],faq:[{q:'?',a:'bad fact'}],meta_description:'bad price'});
 for(const name of ['title','html','blocks','faq','meta_description'])assert.ok(u.some(v=>v.id.startsWith(name+':')));
 assert.throws(()=>reviewUnits({body_html:'x'.repeat(60001)}));
});
test('unavailable and incomplete source pages stop evidence collection',async()=>{
 const original=globalThis.fetch;
 try{
  globalThis.fetch=async()=>new Response('limited',{status:429});await assert.rejects(collectEvidence('en'),/Evidence unavailable/);
  globalThis.fetch=async()=>new Response('<html><main>loading</main></html>',{headers:{'content-type':'text/html'}});await assert.rejects(collectEvidence('en'),/Incomplete evidence/);
  await assert.rejects(collectEvidence('../../etc'),/unsupported/);
 }finally{globalThis.fetch=original;}
});
test('stale or altered evidence rejects without an LLM call',async()=>{
 const result=await reviewRetailDraft({primary_query:'how to compare cs2 skin prices',body_html:'<p>Compare prices.</p>'},[source],[]);
 assert.equal(result.decision,'reject');assert.equal(result.cost_usd,0);assert.match(result.issues.join(),/evidence/i);
});
test('old out-of-scope pending drafts retire automatically with audit and without network',async()=>{
 runMigrations();const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;throw Error('network forbidden');};
 try{
  const db=getDb();db.prepare("INSERT INTO generated_blogs(slug,locale,title,body_html,primary_query,status) VALUES (?,?,?,?,?,?)").run('old-payout','en','CSBoard guide','<p>unsupported flow</p>','caseway withdraw','pending_approval');
  const r=await reviewPendingRetailBlogs();assert.equal(r.rejected,1);assert.equal(calls,0);
  assert.equal((db.prepare('SELECT status FROM generated_blogs').get() as any).status,'retired');
  assert.equal((db.prepare('SELECT decision FROM blog_editorial_reviews').get() as any).decision,'reject');
 }finally{globalThis.fetch=original;closeDb();}
});

test('legacy Markdown renders safe purchase links but not arbitrary schemes',async()=>{
 const {mdToHtml}=await import('../src/generate/blog-post.js');
 assert.match(mdToHtml('[buy skins](/en/buy)'),/<a href="\/en\/buy">buy skins<\/a>/);
 assert.doesNotMatch(mdToHtml('[click](javascript:alert(1))'),/<a /);
});
test('destination validation rejects malicious and wrong-locale links without fetch',async()=>{
 const {destinationIssues}=await import('../src/quality/retail-editor.js');const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response('ok',{headers:{'content-type':'text/html'}});};
 try{
  for(const link of ['http://127.0.0.1/api','https://csboard.com.evil.test/en/buy','/en/api/purchase','/ru/sell','/en/buy?evil=1'])assert.ok((await destinationIssues({body_html:`<a href="${link}">buy</a>`},'en')).length);
  assert.equal(calls,0);
  assert.deepEqual(await destinationIssues({body_html:'<a href="/en/buy">buy</a>'},'en'),[]);assert.equal(calls,1);
 }finally{globalThis.fetch=original;}
});

test('old queue bounds failed source attempts as well as successful reviews',async()=>{
 runMigrations();const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response('limited',{status:429});};
 try{
  const db=getDb();for(let i=0;i<5;i++)db.prepare("INSERT INTO generated_blogs(slug,locale,title,body_html,primary_query,status) VALUES (?,?,?,?,?,?)").run('retry-'+i,'en','sale guide','<p>check prices</p>','how to compare cs2 skin prices '+i,'pending_approval');
  const r=await reviewPendingRetailBlogs(2);assert.equal(calls,2);assert.equal(r.published,0);assert.equal(r.deferred,5);
  assert.equal((db.prepare("SELECT count(*) n FROM generated_blogs WHERE status='pending_approval'").get() as any).n,5);
 }finally{globalThis.fetch=original;closeDb();}
});
