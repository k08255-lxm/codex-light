import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument } from './mini-dom.mjs';
import { agentAvatarIndex, createAgentAvatar } from '../public/ui/agent-avatar.js';
import { agentAvatar, renderNativeAgent } from '../public/ui/agents.js';

const serialize = node => [node.tag, node.attributes, node.children.map(serialize)];
const seedFor = index => String.fromCharCode(84 + index);
function documentWithNamespaces() {
  const document = createDocument(), create = document.createElementNS;
  document.createElementNS = (namespace, tag) => { const node = create(namespace, tag); node.namespaceURI = namespace; return node; };
  return document;
}

test('thread hash matches the UTF-16 polynomial including overflow and surrogate pairs', () => {
  assert.equal(agentAvatarIndex('abc'), 6);
  assert.equal(agentAvatarIndex(''), 0);
  // BigInt evaluates the full polynomial before reducing, independently of the bounded implementation.
  for (const seed of ['abc','thread-019a-hello','𝔘ser🙂','a'.repeat(1000),'\ud800','<img onerror=alert(1)>']) {
    const full = seed.split('').reduce((sum, unit) => sum * 31n + BigInt(unit.charCodeAt(0)), 0n);
    assert.equal(agentAvatarIndex(seed), Number(full % 2147483647n % 28n));
    assert.equal(agentAvatarIndex(seed), agentAvatarIndex(seed));
  }
});

test('all 28 identity slots produce distinct geometry with legal inert SVG nodes', () => {
  const document = documentWithNamespaces(), geometries = new Set();
  const tags = new Set(['svg','g','path','circle','ellipse','polygon','rect']);
  const arity = { M:2,L:2,H:1,V:1,C:6,Q:4,T:2,A:7,Z:0 };
  for (let index=0; index<28; index++) {
    const svg = createAgentAvatar(document, seedFor(index));
    assert.equal(svg.dataset.avatarIndex, String(index));
    assert.equal(svg.getAttribute('viewBox'),'0 0 16 16');
    assert.equal(svg.getAttribute('aria-hidden'),'true'); assert.equal(svg.getAttribute('focusable'),'false');
    assert.ok(svg.classList.contains('agent-avatar'));
    geometries.add(JSON.stringify(svg.children.map(serialize)));
    for (const node of svg.descendants) {
      assert.equal(node.namespaceURI,'http://www.w3.org/2000/svg'); assert.ok(tags.has(node.tag));
      assert.equal(node.id,'');
      for (const [attribute,value] of Object.entries(node.attributes)) {
        assert.doesNotMatch(attribute,/^on|href$/i); assert.doesNotMatch(value,/NaN|Infinity|url\(/);
        if (['cx','cy','r','rx','ry','x','y','width','height'].includes(attribute)) assert.ok(Number.isFinite(Number(value)));
      }
      if (node.tag==='path') {
        const data=node.getAttribute('d');
        const tokens=data.match(/[A-Za-z]|[-+]?(?:\d*\.?\d+)(?:e[-+]?\d+)?/g);
        assert.equal(tokens.join(''),data.replace(/[\s,]+/g,''));
        let command=null,count=0;
        const finish=()=>{if(command){assert.ok(command in arity);assert.ok(arity[command]===0?count===0:count>0&&count%arity[command]===0,`${index}: ${data}`);}};
        for(const token of tokens) { if(/^[A-Za-z]$/.test(token)){finish();command=token;count=0;}else{assert.ok(Number.isFinite(Number(token)));count++;} }
        finish();
      }
    }
    assert.ok(!svg.children.some(node=>node.tag==='rect'&&Number(node.getAttribute('width'))>=16&&Number(node.getAttribute('height'))>=16),'badges have no enclosing tile');
  }
  assert.equal(geometries.size,28);
});

test('repeated badges have no fragment IDs or cross-instance references and accept untrusted thread IDs safely', () => {
  const document=documentWithNamespaces();
  for(let i=0;i<56;i++)document.body.append(agentAvatar(document,i%2?'abc':'<script>alert(1)</script>'));
  assert.equal(document.querySelectorAll('.agent-avatar').length,56);
  for(const node of document.body.descendants.slice(1)) {
    assert.equal(node.id,'');
    assert.ok(!Object.keys(node.attributes).some(key=>key==='href'||key==='xlink:href'));
  }
  assert.doesNotMatch(JSON.stringify(document.body.children.map(serialize)),/script|alert/);
});

test('renaming an agent changes its label while preserving the thread badge', () => {
  const document=documentWithNamespaces();
  const original=renderNativeAgent(document,{id:'abc',path:'agents/research'},{onOpenAgent(){}});
  const renamed=renderNativeAgent(document,{id:'abc',path:'agents/new-name'},{onOpenAgent(){}});
  assert.notEqual(original.textContent,renamed.textContent);
  assert.deepEqual(serialize(original.querySelector('.agent-avatar')),serialize(renamed.querySelector('.agent-avatar')));
  assert.equal(renamed.querySelector('.agent-avatar').dataset.avatarIndex,'6');
});

test('all badges declare paired light and dark colors while inheriting the app theme on the same SVG', () => {
  const document=documentWithNamespaces();
  for(let index=0;index<28;index++) {
    document.documentElement.dataset.theme='dark';
    const svg=createAgentAvatar(document,seedFor(index));document.body.append(svg);
    const style=svg.getAttribute('style'),palette=/color:light-dark\((#[\da-f]{6}),(#[\da-f]{6})\)/i.exec(style);
    assert.ok(palette);assert.notEqual(palette[1],palette[2]);assert.doesNotMatch(style,/color-scheme/);
    assert.equal(svg.getAttribute('fill'),'currentColor');assert.match(svg.getAttribute('stroke'),/--agent-outline/);
    document.documentElement.dataset.theme='light';
    assert.equal(document.body.children.at(-1),svg);assert.equal(svg.getAttribute('style'),style);
  }
});
