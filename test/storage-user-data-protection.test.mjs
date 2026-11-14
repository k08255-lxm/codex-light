import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,lstat,rm} from 'node:fs/promises';
import {Readable} from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import {FileAttachmentStore} from '../src/file-attachments.mjs';
import {StorageMaintenance} from '../src/storage-maintenance.mjs';

test('all cleanup categories preserve historical file attachments and recovery/MSI sources across restart',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'codex-storage-protection-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const make=async(rel,content)=>{const file=path.join(root,rel);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,content);return file;};
 const bytes=Buffer.from('historical non-image attachment\nretained across restarts');
 const first=new FileAttachmentStore({root:path.join(root,'attachments')});
 const attachment=await first.add(Readable.from([bytes]),{filename:'history.txt',mime:'text/plain'});
 const protectedFiles=new Map([[attachment.path,bytes]]);
 for(const rel of ['SetupLogs/current/source.msi','SetupArchives/previous/manifest.json','SetupArchives/previous/source.msi.gz','StorageRecovery/previous/backup.gz','recovery/rollout-backup.jsonl','recovery/image.png','projects/important.txt']){
  const value=Buffer.from('must remain unchanged: '+rel);protectedFiles.set(await make(rel,value),value);
 }
 const oldSession=await make('.codex/sessions/old-conversation.jsonl',JSON.stringify({type:'user',attachmentPath:attachment.path}));
 protectedFiles.set(oldSession,await readFile(oldSession));
 await first.close();
 const second=new FileAttachmentStore({root:path.join(root,'attachments')});
 t.after(()=>second.close());
 assert.equal(second.listOwned().length,0,'restart must not treat historical attachments as current staging');
 await assert.rejects(second.resolve([attachment.id]),/not owned/);
 const activeProfile=path.join(root,'WebView','Sessions','a'.repeat(32));
 const activeCache=await make(path.join('WebView','Sessions','a'.repeat(32),'Default','Cache','active'),'active');
 protectedFiles.set(activeCache,Buffer.from('active'));
 let lastRecovery;
 for(let restart=0;restart<2;restart++){
  const unused=await make(`images/${restart?'22222222':'11111111'}-1111-1111-1111-111111111111.png`,'unused fixture image');
  const service=new StorageMaintenance({root,activeProfile,imageFiles:async()=>[{path:unused,cleanupEligible:true}]});
  for(const [category,mode] of [['cache','archive'],['images','archive'],['install','archive'],['cache','delete']]){
   const candidate=category==='cache'?await make(path.join('WebView','Sessions','b'.repeat(32),'Default','Cache','old'),'old cache'):category==='install'?await make('Updates/0.4.2-0123456789abcdef/CodexLight-Setup.exe','old installer'):unused;
   const plan=await service.plan({category,mode});assert.ok(plan.fileCount>0,category+' must exercise a real fixture cleanup');
   const result=await service.apply({id:plan.id,manifestDigest:plan.manifestDigest,confirmed:true});assert.equal(result.outcome,'succeeded');
   await assert.rejects(lstat(candidate),{code:'ENOENT'});
   if(result.recoveryId){lastRecovery=result.recoveryId;const manifest=path.join(root,'StorageRecovery',lastRecovery,'manifest.json');protectedFiles.set(manifest,await readFile(manifest));}
   for(const [file,expected] of protectedFiles)assert.deepEqual(await readFile(file),expected,'protected file changed: '+path.relative(root,file));
   assert.equal(JSON.parse(await readFile(oldSession,'utf8')).attachmentPath,attachment.path);
   assert.deepEqual(await readFile(attachment.path),bytes,'old session path must remain readable');
  }
 }
 const third=new StorageMaintenance({root,activeProfile});
 assert.ok((await third.recoveries()).some(r=>r.id===lastRecovery),'recovery survives service restart');
 for(const [file,expected] of protectedFiles)assert.deepEqual(await readFile(file),expected);
});
