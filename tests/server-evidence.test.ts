import {test} from 'node:test';
import assert from 'node:assert/strict';
import {serverEvidenceText} from '../src/quality/server-evidence.js';
const stream=(content:string,script='$RC("B:0","S:0")')=>`<main><!--$?--><template id="B:0"></template><p>fallback must disappear</p><!--/$--></main><div hidden id="S:0">${content}</div><script>${script}</script>`;
test('static main keeps visible nested content and decodes entities',()=>{
 assert.equal(serverEvidenceText('<header>ignore</header><main><div>skins &amp; items <b>sale</b></div><script>fake</script><span hidden>fake</span><span class="sr-only">fake</span><footer>ignore</footer></main>'),'skins & items sale');
});
test('completed streamed main uses only its linked segment and omits fallback',()=>{
 assert.equal(serverEvidenceText(stream('<section><h1>sell skins</h1><p>review your quote</p><div hidden>fake</div></section>')+'<div hidden id="S:9">unrelated promise</div>'),'sell skins review your quote');
});
test('nested completed boundaries resolve without evaluating scripts',()=>{
 const html=stream('first <!--$?--><template id="B:1"></template>wait<!--/$--> last')+'<div hidden id="S:1">second</div><script>$RC("B:1","S:1")</script>';
 assert.equal(serverEvidenceText(html),'first second last');
});
test('missing, unresolved, ambiguous or cyclic content fails closed',()=>{
 for(const html of ['<p>skins</p>','<main>a</main><main>b</main>',stream('skins',''),stream('<!--$?--><template id="B:0"></template><!--/$-->'),stream('skins')+'<div id="S:0">other</div>'])assert.throws(()=>serverEvidenceText(html));
});
test('Flight payload and arbitrary scripts cannot provide a completion',()=>{
 assert.throws(()=>serverEvidenceText(stream('skins','self.__next_f.push([1,\'$RC("B:0","S:0")\'])')));
 assert.throws(()=>serverEvidenceText(stream('skins','globalThis.sideEffect = true')));
});
test('hidden and navigation text are not evidence inside a streamed segment',()=>{
 assert.equal(serverEvidenceText(stream('<nav>nav</nav><div style="display: none">invented</div><span aria-hidden="true">fake</span><p>sell skins</p><script type="application/ld+json">fake</script>')),'sell skins');
});

test('customer testimonials cannot corroborate product facts',()=>{assert.equal(serverEvidenceText(stream('<section aria-label="Trustpilot">guaranteed instant payment</section><p>sell skins</p>')), 'sell skins');});

test('one outer main may contain a nested application main',()=>{assert.equal(serverEvidenceText('<main><div><main><p>buy skins</p></main></div></main>'),'buy skins');});

test('errored client-only boundary cannot corroborate a fallback',()=>{assert.throws(()=>serverEvidenceText('<main><!--$!--><template></template><p>skins fallback</p><!--/$--></main>'),/Client-only/);});
