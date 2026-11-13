import test from 'node:test';import assert from 'node:assert/strict';import {DEFAULT_PREFERENCES,PREFERENCE_KEY,validatePreferences,readPreferences,savePreferences,effectiveAppearance,receiptDisplay} from '../public/preferences.js';
import {createDocument} from './mini-dom.mjs';import {createPreferences} from '../public/ui/preferences-view.js';
const memory=(raw=null)=>({raw,getItem(){return this.raw;},setItem(key,value){assert.equal(key,PREFERENCE_KEY);this.raw=value;}});
const {visualStyle:_omit,...LEGACY}=DEFAULT_PREFERENCES;

test('strict non-sensitive preference schema rejects unknown, invalid and mixed legacy data',()=>{
 for(const change of [{token:'secret'},{theme:'invert'},{fontScale:99},{motion:'yes'},{approvalNotice:'true'},{version:2},{visualStyle:'neon'},{visualStyle:null}])assert.throws(()=>validatePreferences({...DEFAULT_PREFERENCES,...change}),JSON.stringify(change));
 for(const change of [{token:'secret'},{fontScale:undefined},{theme:undefined},{motion:'yes'},{version:2},{extra:true}])assert.throws(()=>validatePreferences({...LEGACY,...change}),JSON.stringify(change));
 assert.deepEqual([DEFAULT_PREFERENCES.theme,DEFAULT_PREFERENCES.motion,DEFAULT_PREFERENCES.visualStyle],['dark','system','codex']);
});

test('storage roundtrips only known preferences; corrupt data is reported and left untouched',()=>{
 const storage=memory();
 for(const visualStyle of ['codex','claude']){assert.equal(savePreferences(storage,{...DEFAULT_PREFERENCES,visualStyle,fontScale:125}).visualStyle,visualStyle);assert.deepEqual(readPreferences(storage),{preferences:{...DEFAULT_PREFERENCES,visualStyle,fontScale:125},error:null});}
 storage.raw='{"token":"no"}';const corrupt=readPreferences(storage);assert.ok(corrupt.error);assert.deepEqual(corrupt.preferences,DEFAULT_PREFERENCES);assert.equal(storage.raw,'{"token":"no"}');
 assert.throws(()=>savePreferences({setItem(){throw new Error('blocked');}},DEFAULT_PREFERENCES));
});

test('complete legacy version-1 data is normalized to codex without rewriting untouched storage',()=>{
 const oldRaw=JSON.stringify({...LEGACY,theme:'light',fontScale:110,motion:'off',completionNotice:false});const storage=memory(oldRaw);
 const read=readPreferences(storage);assert.equal(read.error,null);assert.deepEqual(read.preferences,{...DEFAULT_PREFERENCES,theme:'light',fontScale:110,motion:'off',completionNotice:false});assert.equal(storage.raw,oldRaw);
 assert.deepEqual(JSON.parse(storage.raw=JSON.stringify(savePreferences(storage,read.preferences))).visualStyle,'codex');
});

test('system theme/motion, explicit override and visual style resolve deterministically',()=>{
 assert.deepEqual(effectiveAppearance({...DEFAULT_PREFERENCES,theme:'system'},{dark:false,reduced:true}),{theme:'light',fontScale:'100',reducedMotion:true,visualStyle:'codex'});
 assert.equal(effectiveAppearance({...DEFAULT_PREFERENCES,motion:'off'},{reduced:true}).reducedMotion,false);
 assert.equal(effectiveAppearance({...DEFAULT_PREFERENCES,motion:'on'},{reduced:false}).reducedMotion,true);
 assert.equal(effectiveAppearance({...DEFAULT_PREFERENCES,visualStyle:'claude'}).visualStyle,'claude');
});

test('receipt projection retains only metadata and never permits active-instance pending ack',()=>{
 const row={requestId:'instance:123:abc',method:'git/apply',createdAt:123,state:'pending',outcome:'pending',prompt:'do not retain',secret:'x'};
 const shown=receiptDisplay(row,'instance');assert.equal(shown.acknowledgeable,false);assert.deepEqual(Object.keys(shown).sort(),['acknowledgeable','createdAt','method','outcome','requestId','state']);
 assert.equal(receiptDisplay(row,'other').acknowledgeable,true);assert.throws(()=>receiptDisplay({...row,state:'unexpected'},'other'));
});

// ---- Real preferences view over a minimal DOM ----
async function view({desktop=false,storage=memory(),api=async()=>{throw new Error('unexpected api');}}={}){
 const document=createDocument();document.documentElement=document.createElement('html');
 const nodes=new Map(),calls=[],notices=[];
 const $=id=>{if(!nodes.has(id)){const node=document.createElement(id.startsWith('preference-')&&!['preference-status','preference-native-reload'].includes(id)?'input':'div');node.id=id;nodes.set(id,node);}return nodes.get(id);};
 const choices=[...['system','light','dark'].map(theme=>{const b=document.createElement('button');b.dataset.themeChoice=theme;return b;}),...['codex','claude'].map(style=>{const b=document.createElement('button');b.dataset.styleChoice=style;return b;})];
 document.querySelectorAll=selector=>choices.filter(button=>selector==='[data-theme-choice]'?button.dataset.themeChoice:button.dataset.styleChoice);
 const media={matches:false,addEventListener(){}};
 const prefs=createPreferences({document,window:{localStorage:storage,matchMedia:()=>media},state:{desktop,serverInstance:'i'},$,el:(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;},
  api:async(path,body)=>{calls.push([path,body]);return api(path,body);},notice:(text,error)=>notices.push([text,!!error]),confirm:()=>true});
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 return {prefs,document,$,calls,notices,storage,settle,click:async value=>{choices.find(b=>b.dataset.styleChoice===value||b.dataset.themeChoice===value).click();await settle();},pressed:()=>choices.map(b=>b.getAttribute('aria-pressed'))};
}

test('browser appearance choices apply to the root, persist locally and never touch desktop APIs',async()=>{
 const h=await view();const root=h.document.documentElement.dataset;
 assert.deepEqual([root.theme,root.visualStyle,root.fontScale],['dark','codex','100']);assert.deepEqual(h.pressed(),['false','false','true','true','false']);
 await h.click('claude');await h.click('light');
 assert.deepEqual([root.theme,root.visualStyle],['light','claude']);assert.deepEqual(h.pressed(),['false','true','false','false','true']);
 assert.deepEqual(JSON.parse(h.storage.raw),{...DEFAULT_PREFERENCES,theme:'light',visualStyle:'claude'});h.prefs.syncHostTheme();await h.settle();assert.deepEqual(h.calls,[]);
 const reloaded=await view({storage:h.storage});assert.equal(reloaded.document.documentElement.dataset.visualStyle,'claude','choice restores independently of theme');
});

test('desktop preferences load from and save to the native state API and sync the caption theme',async()=>{
 let saved={...DEFAULT_PREFERENCES,theme:'light'};
 const h=await view({desktop:true,api:async(path,body)=>{if(path==='/api/desktop/preferences')return body?{preferences:saved=body.preferences}:{preferences:saved};if(path==='/api/desktop/receipts')return {receipts:[]};if(path==='/api/desktop/theme')return body;throw new Error(path);}});
 await h.prefs.loadDesktopState();await h.settle();
 assert.equal(h.document.documentElement.dataset.theme,'light');
 await h.click('claude');
 assert.deepEqual(h.calls.filter(([path])=>path==='/api/desktop/preferences').map(([,body])=>body),[undefined,{preferences:{...DEFAULT_PREFERENCES,theme:'light',visualStyle:'claude'}}]);
 assert.deepEqual(h.calls.filter(([path])=>path==='/api/desktop/theme').at(-1)[1],{theme:'light',visualStyle:'claude'});
 assert.equal(h.storage.raw,null,'desktop mode never falls back to browser storage');
});

test('a failed desktop preference read uses defaults explicitly instead of browser storage',async()=>{
 const storage=memory(JSON.stringify({...DEFAULT_PREFERENCES,theme:'light'}));
 const h=await view({desktop:true,storage,api:async path=>{if(path==='/api/desktop/receipts')return {receipts:[]};if(path==='/api/desktop/theme')return {};throw new Error('state unavailable');}});
 await h.prefs.loadDesktopState();
 assert.equal(h.document.documentElement.dataset.theme,'dark');assert.match(h.$('preference-status').textContent,/无法读取本机偏好.*默认外观/);assert.equal(h.notices.at(-1)[1],true);
});
