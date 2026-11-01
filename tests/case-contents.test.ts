import {test} from 'node:test';
import assert from 'node:assert/strict';
import {caseContentsIssues, CS20_CONTENTS} from '../src/quality/case-contents.js';
import {blogPublicationIssues} from '../src/quality/blog-publication.js';
const title='CS20 Case: All Skins, Rarity Tiers, and How to Trade Them';
const rows=Object.entries(CS20_CONTENTS).map(([name,rarity])=>[rarity,name]);
const correct={title,body_html:'<p>Valve lists seventeen weapon finishes and the Classic Knife rare special item.</p>',body_blocks:[{type:'table',rows}]};
test('verified17 contents pass without a claim about current prices or drops',()=>assert.deepEqual(caseContentsIssues(correct),[]));
test('observed606 foreign skins, rarity errors and no-knives FAQ are held in shared publication gate',()=>{
 const draft={...correct,body_blocks:[{type:'table',rows:[['Mil-Spec','SSG 08 | Death Strike'],['Classified','SCAR-20 | Assault'],['Mil-Spec','MP7 | Teal Blossom'],['Mil-Spec','PP-Bizon | Judgement of Anubis']]}],faq:[{q:'Knives?',a:'No, the CS20 Case does not include rare special items like knives or gloves.'}]};
 const issues=blogPublicationIssues(draft);
 assert.ok(issues.some(x=>x.includes('Death Strike')));assert.ok(issues.some(x=>x.includes('SCAR-20')));assert.ok(issues.some(x=>x.includes('Classic Knife')));assert.ok(issues.some(x=>x.includes('the17')));
});
test('HTML fallback and serialized blocks cannot bypass rarity validation',()=>{
 assert.ok(caseContentsIssues({...correct,body_html:'<table><tr><td>Classified</td><td>P250 | Inferno</td></tr></table>'}).some(x=>x.includes('P250')));
 assert.ok(caseContentsIssues({...correct,body_blocks:JSON.stringify([{type:'item_grid',items:[{name:'P90 | Nostalgia',stat:'Mil-Spec'}]}])}).some(x=>x.includes('P90')));
});
test('other complete case lists require evidence; ordinary item and title-only lookups do not',()=>{
 assert.ok(caseContentsIssues({...correct,title:'Gamma Case: All Skins and Rarity'}).length);
 assert.deepEqual(caseContentsIssues({...correct,title:'Case Hardened: all skins and patterns'}),[]);
 assert.deepEqual(caseContentsIssues({...correct,title:'M4A4 Converter price'}),[]);
 assert.deepEqual(caseContentsIssues({title,body_html:''}),[]);
});
