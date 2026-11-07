import {test} from 'node:test';
import assert from 'node:assert/strict';
import {blogTopicEligibilityIssue} from '../src/quality/query-eligibility.js';
import {blogPublicationIssues, BlogQualityError} from '../src/quality/blog-publication.js';
import {runMigrations} from '../src/db/migrate.js';
import {getDb,closeDb} from '../src/db/connection.js';
import {approveBlog,insertBlog,getBlogBySlug,type InsertBlogArgs} from '../src/db/blog-repo.js';
import {runBlogGenerator} from '../src/workers/blog-generator.js';

test('unsupported payout procedures are rejected regardless of the provider spelling',()=>{
 for(const q of ['csbattle withdraw','caseway withdraw','cscase withdraw','gocsgo withdraw','unknown-new-provider cash out','CSBoard withdrawal guide','skinport cash-out','casino payouts','как вывести скины','вывод денег caseway','caseway: вывод?']) assert.match(blogTopicEligibilityIssue(q)!,/verified provider/);
 for(const q of ['AK-47 Neon Revolution Field-Tested price','cs20 case contents','skin deposit API integration','CS2 skin delivery API retries','compare skinport and csfloat','sell cs2 skins for crypto','выводы исследования цен']) assert.equal(blogTopicEligibilityIssue(q),null,q);
});

test('changing the title to CSBoard cannot erase the original service intent',()=>{
 const content={title:'How to sell on CSBoard',body_html:'<p>Check current offers.</p>'};
 assert.ok(blogPublicationIssues({...content,primary_query:'csbattle withdraw'}).length);
 assert.ok(blogPublicationIssues({...content,primary_query:'skin guide',secondary_queries:'["caseway withdraw"]'}).length);
 assert.deepEqual(blogPublicationIssues({...content,primary_query:'skin guide'}),[]);
});

test('old pending drafts are rechecked by approve; archived rejected drafts never serve',()=>{
 runMigrations();
 try {
  const draft:InsertBlogArgs={slug:'payout-fixture',locale:'en',title:'CSBoard guide',body_html:'<p>Check your account.</p>',body_md:'',primary_query:'caseway withdraw',secondary_queries:[],meta_title:null,meta_description:null,excerpt:null,category:null,tags:[],cover_image:null,word_count:4,faq:[],source_model:'test',cost_usd:0};
  const id=insertBlog(draft,'pending_approval');
  assert.throws(()=>approveBlog(id),BlogQualityError);
  assert.equal(getBlogBySlug('en',draft.slug),null);
  const archived=insertBlog({...draft,slug:'retired-fixture'},'retired');
  assert.equal(approveBlog(archived),0);
  assert.equal(getBlogBySlug('en','retired-fixture'),null);
 } finally {closeDb();}
});

test('queued unsafe topics are skipped without any paid calls or Telegram sends',async()=>{
 runMigrations();const originalFetch=globalThis.fetch;let network=0;
 globalThis.fetch=async()=>{network++;throw new Error('No network allowed in this regression');};
 try {
  const db=getDb();
  db.prepare("INSERT INTO blog_topics(primary_query,locale,cluster_queries,total_impressions,avg_position,status) VALUES (?,?,?,?,?,?)").run('caseway withdraw','en','["caseway withdraw"]',27,21,'queued');
  db.prepare("INSERT INTO blog_topics(primary_query,locale,cluster_queries,total_impressions,avg_position,status) VALUES (?,?,?,?,?,?)").run('csbattle withdraw','en','["csbattle withdraw"]',156,15,'queued');
  const result=await runBlogGenerator();
  assert.equal(result.topics_skipped,2);assert.equal(result.blogs_generated,0);assert.equal(network,0);
  db.prepare("UPDATE blog_topics SET detected_at='2020-01-01T00:00:00Z'").run();
  const next=await runBlogGenerator();assert.equal(next.topics_skipped,0);assert.equal(network,0);
  assert.equal((db.prepare("SELECT count(*) n FROM blog_topics WHERE status='skipped'").get() as any).n,2);
  assert.equal((db.prepare("SELECT count(*) n FROM blog_topics WHERE status='queued'").get() as any).n,0);
  assert.equal((db.prepare('SELECT count(*) n FROM generated_blogs').get() as any).n,0);
 } finally {globalThis.fetch=originalFetch;closeDb();}
});
