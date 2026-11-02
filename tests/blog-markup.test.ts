import test from 'node:test';
import assert from 'node:assert/strict';
import { blogMarkupIssues, blogBlockMarkupIssues } from '../src/quality/blog-markup.js';
import { blogPublicationIssues } from '../src/quality/blog-publication.js';
test('observed swallowed fee paragraph and cells are held',()=>{
 for(const html of ['<p>deposit carries <strong000fee. a direct swap uses steam.</p>','<strong0<%','<strong2% base<%','<strong <%']) assert.ok(blogMarkupIssues(html).length,html);
});
test('valid formatting, comparisons, entities and links are allowed',()=>{
 for(const html of ['<p>deposit: <strong>0%</strong>; sale: <strong>2%</strong>.</p>','<p>float < 0.1; price > 20; &lt;strong&gt;</p>','<a href="/en/items/a?mode=buy&amp;tier=1">skin</a>','<table><tbody><tr><td>0%</td></tr></tbody></table>','<!-- <broken --> <br/>']) assert.deepEqual(blogMarkupIssues(html),[],html);
});
test('clean fallback cannot hide corrupt preferred table blocks',()=>{
 assert.ok(blogPublicationIssues({body_html:'<p>valid content</p>',body_blocks:[{type:'table',rows:[['fee','<strong2% base<%']]}]}).some(x=>x.includes('Malformed HTML')));
 assert.ok(blogBlockMarkupIssues(JSON.stringify([{type:'faq',items:[{q:'fee?',a:'<strong0<%'}]}])).length);
});
test('absent blocks and valid strings pass; invalid JSON is held',()=>{
 assert.deepEqual(blogBlockMarkupIssues(null),[]);assert.deepEqual(blogBlockMarkupIssues('[{"type":"text","html":"<p>valid</p>"}]'),[]);assert.ok(blogBlockMarkupIssues('{bad').length);
});
