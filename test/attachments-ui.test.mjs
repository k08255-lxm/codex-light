import test from 'node:test';
import assert from 'node:assert/strict';
import { AttachmentDraft, IMAGE_LIMITS, validateImageSelection } from '../public/attachments.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const record=n=>({id:id(n),name:`image-${n}.png`,size:1024,mime:'image/png'});
test('client permits only bounded supported image selections',()=>{validateImageSelection([{name:'a.png',type:'image/png',size:10}]);assert.throws(()=>validateImageSelection([{name:'a.svg',type:'image/svg+xml',size:10}]));assert.throws(()=>validateImageSelection([{name:'a.png',type:'image/png',size:IMAGE_LIMITS.bytes+1}]));assert.throws(()=>validateImageSelection([{name:'a.png',type:'image/png',size:10}],5));assert.throws(()=>validateImageSelection([{name:'a.png',type:'image/png',size:0}]));});
test('attachment chips carry IDs and display metadata, never local paths',()=>{const draft=new AttachmentDraft();draft.add({...record(1),path:'/private/temp',token:'SECRET'});assert.deepEqual(Object.keys(draft.values()[0]).sort(),['id','mime','name','size']);assert.ok(!JSON.stringify(draft.values()).includes('/private/temp'));});
test('attachment snapshot remains fixed when draft is edited',()=>{const draft=new AttachmentDraft();draft.add(record(1));const ids=draft.ids();draft.remove(id(1));draft.add(record(2));assert.deepEqual(ids,[id(1)]);assert.deepEqual(draft.ids(),[id(2)]);});
test('at most five valid records, remove does not imply deleting source file',()=>{const draft=new AttachmentDraft();for(let n=1;n<=5;n++)draft.add(record(n));assert.throws(()=>draft.add(record(6)));draft.remove(id(1));assert.equal(draft.values().length,4);assert.throws(()=>draft.add({...record(7),mime:'image/svg+xml'}));});
