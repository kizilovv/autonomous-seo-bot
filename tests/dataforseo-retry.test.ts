import test from 'node:test';
import assert from 'node:assert/strict';
import { requestWithRetry } from '../src/dataforseo/retry.js';
function response(task=20000,http=200,cost=0,headers:Record<string,string>={}) {
 return new Response(JSON.stringify({status_code:20000,status_message:'Ok.',cost,tasks:[{status_code:task,status_message:'test',cost,result:[{items:[{keyword:'skins'}]}]}]}),{status:http,headers});
}
function harness(responses:Array<Response|Error>, guard?: (n:number)=>void) {
 let calls=0,guards=0; const delays:number[]=[],spend:number[]=[],retries:unknown[]=[];
 const run=()=>requestWithRetry({request:async()=>{const r=responses[calls++];if(r instanceof Error)throw r;assert.ok(r);return r;},beforeAttempt:()=>{guards++;guard?.(guards)},recordSpend:c=>spend.push(c),onRetry:x=>retries.push(x),sleep:async ms=>{delays.push(ms)},random:()=>0,now:()=>0});
 return {run,delays,spend,retries,get calls(){return calls},get guards(){return guards}};
}
test('actual HTTP500/task50000 shape recovers and records only successful cost',async()=>{const h=harness([response(50000,500),response(20000,200,0.03)]);const r=await h.run();assert.equal(r.cost,0.03);assert.equal(h.calls,2);assert.equal(h.guards,2);assert.deepEqual(h.delays,[2000]);assert.deepEqual(h.spend,[0.03]);assert.equal(h.retries.length,1);});
test('task failure in HTTP200 is retried rather than accepted as empty success',async()=>{const h=harness([response(50000),response(50303),response()]);await h.run();assert.equal(h.calls,3);assert.deepEqual(h.delays,[2000,5000]);});
test('exhaustion throws once after exactly three attempts',async()=>{const h=harness([response(50000,500),response(50000,500),response(50000,500)]);await assert.rejects(h.run(),/attempt 3\/3/);assert.equal(h.calls,3);assert.equal(h.retries.length,2);});
for(const code of [40200,40210,40203,40100,40501])test(`permanent ${code} does not retry`,async()=>{const h=harness([response(code)]);await assert.rejects(h.run());assert.equal(h.calls,1);assert.equal(h.delays.length,0);});
test('HTTP auth failure never retries even with transient task',async()=>{const h=harness([response(50000,401)]);await assert.rejects(h.run());assert.equal(h.calls,1);});
test('charged failure is accounted but not replayed',async()=>{const h=harness([response(50000,500,0.01)]);await assert.rejects(h.run());assert.deepEqual(h.spend,[0.01]);assert.equal(h.calls,1);});
test('task cost cannot be hidden by envelope zero',async()=>{const r=response(50000,500);const data=await r.json();data.tasks[0].cost=0.02;const h=harness([new Response(JSON.stringify(data),{status:500})]);await assert.rejects(h.run());assert.deepEqual(h.spend,[0.02]);assert.equal(h.calls,1);});
test('budget is checked before every attempt',async()=>{const h=harness([response(50000,500)],n=>{if(n===2)throw Error('budget capped')});await assert.rejects(h.run(),/budget capped/);assert.equal(h.calls,1);assert.equal(h.guards,2);});
test('honors Retry-After seconds and date',async()=>{for(const value of ['8','Thu, 01 Jan 1970 00:00:08 GMT']){const h=harness([response(40202,429,0,{'retry-after':value}),response()]);await h.run();assert.deepEqual(h.delays,[8000]);}});
test('does not shorten Retry-After exceeding total wait allowance',async()=>{const h=harness([response(50303,503,0,{'retry-after':'31'})]);await assert.rejects(h.run(),/wait budget/);assert.equal(h.calls,1);assert.deepEqual(h.delays,[]);});
test('transport errors and malformed envelopes with uncertain cost are not replayed',async()=>{for(const r of [new Error('timeout'),new Response('bad',{status:502}),new Response('{}'),new Response('null'),new Response(JSON.stringify({status_code:20000,cost:0,tasks:[]}))]){const h=harness([r]);await assert.rejects(h.run());assert.equal(h.calls,1);}});
test('successful task is not repeated on contradictory HTTP500',async()=>{const h=harness([response(20000,500)]);await assert.rejects(h.run());assert.equal(h.calls,1);});
