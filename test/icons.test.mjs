import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {icon,iconNames,hydrateIcons} from '../public/icons.js';
const doc={createElementNS(ns,name){return {ns,name,attributes:{},children:[],setAttribute(k,v){this.attributes[k]=v;},append(child){this.children.push(child);}};}};
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
const ROOT_ATTRIBUTES={viewBox:'0 0 24 24',width:'18',height:'18',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false',class:'ui-icon'};
const SAFE_TAGS=new Set(['path','rect','circle','line','polyline','polygon','ellipse']);
const SAFE_ATTRIBUTES=new Set(['d','x','y','width','height','rx','ry','cx','cy','r','x1','x2','y1','y2','points','fill']);
// Every name used by the shell and views. New names may be added; none may disappear silently.
const REQUIRED=['archive','back','bell','bolt','brand','branch','card','chart','check','clock','close','compose','computer','diff','down','download','file','folder','globe','grid','home','image','info','keyboard','left','lock','menu','microphone','more','panel','plug','plus','queue','refresh','remote','reset','review','right','search','settings','shield','spark','stop','storage','terminal','up','usage','user'];

test('icon set covers every required name and every static placeholder',async()=>{
 for(const name of REQUIRED)assert.ok(iconNames.includes(name),name);
 const html=await read('public/index.html');
 for(const [,name] of html.matchAll(/data-icon="([^"]+)"/g))assert.ok(iconNames.includes(name),name);
 assert.doesNotMatch(html,/[⌂▦◷◇⇄⌑▧◔⌘＋⌕↻⚙☰⋯◫×⌁▱⌄▣♧ϟ↺›‹■↑←]/,'no mixed unicode glyph icons');
});

test('icons are fixed safe SVG children under one root contract on a 24px grid',()=>{
 for(const name of iconNames){
  const node=icon(doc,name);assert.equal(node.ns,'http://www.w3.org/2000/svg');assert.equal(node.name,'svg');assert.deepEqual(node.attributes,ROOT_ATTRIBUTES);assert.ok(node.children.length,name);
  for(const child of node.children){
   assert.ok(SAFE_TAGS.has(child.name),`${name}:${child.name}`);
   for(const [key,value] of Object.entries(child.attributes)){assert.ok(SAFE_ATTRIBUTES.has(key),`${name}:${key}`);assert.equal(typeof value,'string');if(key==='fill')assert.equal(value,'currentColor',`${name} fills follow text colour`);}
   for(const key of ['x','y','cx','cy'])if(child.attributes[key]!==undefined){const v=Number(child.attributes[key]);assert.ok(v>=1&&v<=23,`${name}:${key}=${v}`);}
  }
 }
 assert.equal(icon(doc,'grid',{size:24}).attributes.width,'24');
});

test('unknown, prototype and markup-like names fall back to the local information symbol',()=>{
 const fallback=icon(doc,'info').children.map(child=>[child.name,child.attributes]);
 for(const name of ['not-an-icon','__proto__','constructor','<img src=x onerror=alert(1)>'])assert.deepEqual(icon(doc,name).children.map(child=>[child.name,child.attributes]),fallback,name);
});

test('hydrateIcons replaces placeholders with the same public icon factory',()=>{
 const replaced=[];const placeholder={dataset:{icon:'home'},replaceWith(node){replaced.push(node);}};
 hydrateIcons(doc,{querySelectorAll(selector){assert.equal(selector,'[data-icon]');return [placeholder];}});
 assert.equal(replaced.length,1);assert.deepEqual(replaced[0].attributes,ROOT_ATTRIBUTES);assert.deepEqual(replaced[0].children.map(c=>[c.name,c.attributes]),icon(doc,'home').children.map(c=>[c.name,c.attributes]));
});

// Licensing/provenance: geometry is original (not the formerly vendored Lucide paths) and the notice keeps upstream credit.
test('icon geometry is original and the brand mark matches the ICO generator',async()=>{
 const [source,svg,ps,notice]=await Promise.all(['public/icons.js','public/icon.svg','desktop/build-icon.ps1','public/vendor/LUCIDE-NOTICES.md'].map(read));
 for(const lucide of ['M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8','M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706','M15 6a9 9 0 0 0-9 9V3'])assert.ok(!source.includes(lucide),lucide);
 assert.doesNotMatch(source,/lucide/i);assert.match(source,/original geometry/i);
 for(const pattern of [/rx="15"/,/#17181a/,/#f2b25c/,/r="4.5"/])assert.match(svg,pattern);assert.doesNotMatch(svg,/<script|href|on\w+=/i);
 for(const pattern of [/#17181a/,/#f2b25c/,/DrawArc\(\$pen, 17, 17, 30, 30, 48, 264\)/,/FillEllipse\(\$accent, 42, 27.5, 9, 9\)/])assert.match(ps,pattern);assert.doesNotMatch(ps,/PointF/);
 for(const pattern of [/original geometry/i,/ISC License/,/Cole Bemis/])assert.match(notice,pattern);assert.doesNotMatch(notice,/\.repair-review/);
});
