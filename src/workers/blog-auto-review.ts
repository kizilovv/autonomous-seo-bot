import {getDb,tx} from '../db/connection.js';
import {budgetExceeded} from '../llm/openrouter.js';
import {collectEvidence,hash,retailTopicIssue,reviewRetailDraft,EDITOR_VERSION} from '../quality/retail-editor.js';
import {logger} from '../logger.js';
import type {BlogContentForReview} from '../quality/blog-publication.js';

export function existingRetailPages(locale:string){
 return getDb().prepare("SELECT title,primary_query,excerpt FROM generated_blogs WHERE status='published' AND locale=? ORDER BY published_at DESC").all(locale) as Array<{title:string;primary_query:string;excerpt:string|null}>;
}
/** Old manual queue is drained automatically, never bulk-approved. Concurrent
 * editorial changes cause a compare-and-swap failure, not an overwritten edit. */
export async function reviewPendingRetailBlogs(limit=2){
 const stats={published:0,rejected:0,deferred:0,cost_usd:0};let reviewed=0;
 const rows=getDb().prepare("SELECT * FROM generated_blogs WHERE status='pending_approval' ORDER BY id LIMIT 50").all() as Array<BlogContentForReview & {id:number;locale:string}>;
 for(const row of rows){
  const scope=retailTopicIssue(row.primary_query??'');
  if(!scope && (reviewed>=limit||!budgetExceeded().ok)){stats.deferred++;continue;}
  if(!scope)reviewed++;
  try{
   const review=scope?{version:EDITOR_VERSION,decision:'reject',issues:[scope],draft_hash:hash(row),sources:[],cost_usd:0,reviewed_at:new Date().toISOString()}:await reviewRetailDraft(row,await collectEvidence(row.locale),existingRetailPages(row.locale));
   stats.cost_usd+=review.cost_usd;
   tx(()=>{
    const current=getDb().prepare("SELECT * FROM generated_blogs WHERE id=? AND status='pending_approval'").get(row.id);
    if(hash(current)!==hash(row))throw new Error('Draft changed during review');
    getDb().prepare("INSERT INTO blog_editorial_reviews(blog_id,decision,review_json) VALUES (?,?,?)").run(row.id,review.decision,JSON.stringify(review));
    const publish=review.decision==='publish';
    getDb().prepare("UPDATE generated_blogs SET status=?,published_at=? WHERE id=? AND status='pending_approval'").run(publish?'published':'retired',publish?new Date().toISOString():null,row.id);
    getDb().prepare('UPDATE blog_topics SET status=? WHERE blog_id=?').run(publish?'generated':'skipped',row.id);
   });
   if(review.decision==='publish')stats.published++;else stats.rejected++;
  }catch(error){stats.deferred++;logger.warn({blogId:row.id,error:String(error)},'automatic review deferred; no publication or approval notification');}
 }
 return stats;
}
