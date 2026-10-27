/** Offline replay against a read-only export. Never calls an LLM or writes CMS. */
import { readFileSync, writeFileSync } from 'node:fs';
import { blogPublicationIssues } from '../src/quality/blog-publication.js';
import { queryEligibilityIssue } from '../src/quality/query-eligibility.js';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: tsx scripts/audit-content-quality.ts input.json output.json');
const data = JSON.parse(readFileSync(input, 'utf8'));
if (!Array.isArray(data.blogs) || !Array.isArray(data.opportunities)) throw new Error('Export must contain blogs and opportunities arrays; inspect extraction errors before replay');
const blogs = (data.blogs ?? []).map((b: any) => ({id:b.id,slug:b.slug,status:b.status,issues:blogPublicationIssues(b)}));
const opportunities = (data.opportunities ?? []).filter((o: any) => queryEligibilityIssue(o.query))
  .map((o: any) => ({id:o.id,path:o.path,status:o.status,issue:queryEligibilityIssue(o.query)}));
const summary = {blogsChecked:blogs.length,blogsFlagged:blogs.filter((b: any)=>b.issues.length).length,
  opportunitiesChecked:(data.opportunities ?? []).length,opportunitiesFlagged:opportunities.length};
writeFileSync(output,JSON.stringify({summary,blogs,opportunities},null,2));
console.log(summary);
