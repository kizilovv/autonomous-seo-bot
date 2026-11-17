import {parse, type DefaultTreeAdapterMap} from 'parse5';
type Node = DefaultTreeAdapterMap['node'];
const children = (node: Node): Node[] => 'childNodes' in node ? node.childNodes : [];
const attr = (node: Node, name: string): string | undefined => 'attrs' in node ? node.attrs.find(a => a.name === name)?.value : undefined;
const tag = (node: Node): string => 'tagName' in node ? node.tagName : '';
const comment = (node: Node): string => node.nodeName === '#comment' && 'data' in node ? node.data : '';

/** Resolve only completed React HTML segments attached to main. Never execute scripts
 * or use Flight JSON, metadata, unrelated hidden content or generated blog evidence. */
export function serverEvidenceText(html: string): string {
 const document = parse(html);
 const mains: Node[] = [], ids = new Map<string, Node>(), resolved = new Map<string,string>();
 function index(node: Node, insideMain = false): void {
  if(tag(node)==='main' && !insideMain) mains.push(node);
  const id=attr(node,'id');
  if(id && /^[BS]:[a-z0-9]+$/i.test(id)) {
   if(ids.has(id)) throw new Error('Duplicate evidence boundary');
   ids.set(id,node);
  }
  if(tag(node)==='script' && !attr(node,'src') && !attr(node,'type')) {
   const code=children(node).map(n=>'value' in n?n.value:'').join('');
   // This is a transport marker, not JavaScript evaluation. Unknown protocols fail closed.
   for(const m of code.matchAll(/(?:^|[;}])\s*\$RC\("(B:[a-z0-9]+)","(S:[a-z0-9]+)"\)/gi)) {
    if(resolved.has(m[1])) throw new Error('Duplicate evidence completion');
    resolved.set(m[1],m[2]);
   }
  }
  for(const c of children(node)) index(c, insideMain || tag(node)==='main');
 }
 index(document);
 if(mains.length!==1) throw new Error('Missing or ambiguous server-rendered evidence main');
 const active = new Set<string>();
 function text(node: Node): string {
  if(node.nodeName==='#text' && 'value' in node) return node.value;
  // Customer testimonials are not authoritative evidence of product guarantees.
  if(/^trustpilot$/i.test(attr(node,'aria-label')||'')) return '';
  if(['script','style','nav','footer','header','template','noscript','svg'].includes(tag(node))) return '';
  if(attr(node,'hidden')!==undefined || attr(node,'aria-hidden')==='true' || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attr(node,'style')||'') || /(?:^|\s)(?:hidden|sr-only)(?:\s|$)/.test(attr(node,'class')||'')) return '';
  return body(node);
 }
 function body(node: Node): string {
  const nodes=children(node), out:string[]=[];
  for(let i=0;i<nodes.length;i++) {
   if(comment(nodes[i])==='$!') throw new Error('Client-only evidence boundary');
   if(comment(nodes[i])==='$?') {
    const boundary=nodes[i+1], id=boundary && tag(boundary)==='template'?attr(boundary,'id'):undefined;
    const segmentId=id && resolved.get(id), segment=segmentId && ids.get(segmentId);
    if(!id || !segment || tag(segment)!=='div' || attr(segment,'hidden')===undefined || active.has(id)) throw new Error('Unresolved evidence boundary');
    active.add(id);out.push(body(segment));active.delete(id);
    let depth=1;
    for(i+=2;i<nodes.length;i++) {
     const marker=comment(nodes[i]);
     if(['$?','$','$!'].includes(marker)) depth++;
     if(marker==='/$' && --depth===0) break;
    }
    if(depth!==0) throw new Error('Unclosed evidence boundary');
   } else out.push(text(nodes[i]));
  }
  return out.join(' ');
 }
 return body(mains[0]).replace(/\s+/g,' ').trim();
}
