import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBackHandler } from '../public/ui/back-navigation.js';
const document = dialogs => ({querySelectorAll: () => dialogs, defaultView: {Event}});
test('modal cancellation comes before drawers; cancellation guard consumes without closing', () => {
 let closes=0,layers=0; const dialog={dispatchEvent:e=>{assert.equal(e.type,'cancel');return false;},close:()=>closes++};
 const back=createBackHandler({document:document([dialog]),layers:[{isOpen:()=>true,close:()=>layers++}]});
 assert.equal(back(),true);assert.equal(closes,0);assert.equal(layers,0);
 dialog.dispatchEvent=()=>true;back();assert.equal(closes,1);
});
test('only the top modal closes',()=>{let closed=[];const dialogs=[0,1].map(id=>({dispatchEvent:()=>true,close:()=>closed.push(id)}));createBackHandler({document:document(dialogs)})();assert.deepEqual(closed,[1]);});
test('back dismisses one layer per invocation and falls through at root',()=>{
 const open=[true,true,true];let nav=1;const closed=[];
 const back=createBackHandler({document:document([]),layers:open.map((_,i)=>({isOpen:()=>open[i],close:()=>{open[i]=false;closed.push(i);}})),navigateBack:()=>nav-->0});
 for(let i=0;i<3;i++){assert.equal(back(),true);assert.equal(nav,1);}assert.deepEqual(closed,[0,1,2]);assert.equal(back(),true);assert.equal(back(),false);
});
test('Android bridges committed system back and legacy back to the same guarded SPA handler',async()=>{
 const java=await readFile(new URL('../android/app/src/main/java/com/codexlight/android/MainActivity.java',import.meta.url),'utf8');
 assert.match(java,/public void onBackPressed\(\)\s*\{\s*handleSystemBack\(\);/);assert.match(java,/systemBackCallback = this::handleSystemBack/);
 assert.match(java,/PRIORITY_DEFAULT/);assert.match(java,/unregisterOnBackInvokedCallback/);assert.match(java,/generation != navigationGeneration/);assert.match(java,/if \(backRequestPending\) return/);
 assert.match(java,/if \("false"\.equals\(result\)\) finishBackNavigation/);
 const manifest=await readFile(new URL('../android/app/src/main/AndroidManifest.xml',import.meta.url),'utf8');assert.match(manifest,/enableOnBackInvokedCallback="true"/);
});
test('activity and sidebar buttons use distinct accessible icons',async()=>{const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');assert.match(html,/id="toggle-details"[^>]*aria-label="工具活动"[^>]*>\s*<span data-icon="activity"/);assert.match(html,/id="rail-sidebar"[^>]*>\s*<span data-icon="panel"/);});
