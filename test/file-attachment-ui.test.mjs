import test from 'node:test';
import assert from 'node:assert/strict';
import {FileAttachmentDraft,validateFileSelection} from '../public/attachments.js';
test('file draft strips cache paths and retains explicit risk metadata',()=>{const draft=new FileAttachmentDraft();draft.add({id:'11111111-1111-4111-8111-111111111111',name:'bundle.zip',size:100,mime:'application/zip',category:'archive',riskWarning:true,warning:'Do not unpack',path:'/private/cache'});assert.equal(draft.values()[0].riskWarning,true);assert.equal(draft.values()[0].path,undefined);draft.remove(draft.ids()[0]);assert.equal(draft.ids().length,0);});
test('mixed selection cap and file size are enforced before uploads',()=>{assert.throws(()=>validateFileSelection([{size:1}],5));assert.throws(()=>validateFileSelection([{size:21*1024*1024}],0));assert.throws(()=>validateFileSelection([{size:0}],0));assert.doesNotThrow(()=>validateFileSelection([{size:1}],4));});
