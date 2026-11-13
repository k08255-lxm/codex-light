import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {ArtifactPreviewService,inspectArtifact,ARTIFACT_LIMITS} from '../src/artifacts.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=','base64');
const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0H24V24H0Z"/></svg>');
async function fixture(t){
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'artifacts-fixture-')),root=path.join(parent,'project'),outside=path.join(parent,'other-project');await fs.mkdir(root);await fs.mkdir(outside);
 const projects={list:async()=>({projects:[{id:'project-a',path:root},{id:'project-b',path:outside}]})};const service=new ArtifactPreviewService({projects});
 t.after(async()=>{await service.close();await fs.rm(parent,{recursive:true,force:true});});return {service,root,outside};
}

test('registered project and native-bound thread preview the same Chinese/space path as bytes',async t=>{
 const {service,root}=await fixture(t);await fs.mkdir(path.join(root,'图标'));await fs.writeFile(path.join(root,'图标','测试 图.png'),png);
 const result=await service.preview({projectId:'project-a',path:'图标/测试 图.png'});assert.deepEqual(result.bytes,png);assert.equal(result.mime,'image/png');assert.equal(result.width,1);assert.equal(result.height,1);
 await assert.rejects(service.preview({threadId:'unknown',path:'图标/测试 图.png'}),e=>e.code==='ARTIFACT_SCOPE_UNKNOWN');
 service.bindThread({id:'thread-a',cwd:root});const bound=await service.preview({threadId:'thread-a',path:path.join(root,'图标','测试 图.png')});assert.deepEqual(bound.bytes,png);
});

test('known scope allows external local images while rejecting arbitrary cwd, remote URLs and credential paths',async t=>{
 const {service,root,outside}=await fixture(t);await fs.writeFile(path.join(outside,'secret.png'),png);await fs.writeFile(path.join(root,'auth.json'),png);
 for(const input of [{cwd:root,path:'auth.json'},{projectId:'unknown',path:'x.png'},{projectId:'project-a',threadId:'x',path:'x.png'},{projectId:'project-a',path:'https://example.invalid/a.png'},{projectId:'project-a',path:'a.png:secret'},{projectId:'project-a',path:'a\0.png'},{projectId:'project-a',path:'auth.json'}])await assert.rejects(service.preview(input),e=>[400,403,415].includes(e.status));
 for(const file of ['../other-project/secret.png',path.join(outside,'secret.png'),pathToFileURL(path.join(outside,'secret.png')).href])assert.deepEqual((await service.preview({projectId:'project-a',path:file})).bytes,png);
});

test('byte MIME and dimension admission rejects renamed text, mismatches, oversized and malformed headers',async t=>{
 const {service,root}=await fixture(t);await fs.writeFile(path.join(root,'fake.png'),'<html>not a PNG</html>');await fs.writeFile(path.join(root,'mismatch.svg'),png);
 for(const name of ['fake.png','mismatch.svg'])await assert.rejects(service.preview({projectId:'project-a',path:name}),e=>e.status===415);
 const huge=Buffer.from(png);huge.writeUInt32BE(4097,16);await fs.writeFile(path.join(root,'huge.png'),huge);await assert.rejects(service.preview({projectId:'project-a',path:'huge.png'}),e=>e.code==='ARTIFACT_DIMENSION_LIMIT');
 const h=await fs.open(path.join(root,'large.png'),'w');await h.truncate(ARTIFACT_LIMITS.bytes+1);await h.close();await assert.rejects(service.preview({projectId:'project-a',path:'large.png'}),e=>e.code==='ARTIFACT_SIZE_LIMIT');
 assert.throws(()=>inspectArtifact(Buffer.from([0xff,0xd8,0xff]),'.jpg'),e=>e.status===415);assert.throws(()=>inspectArtifact(Buffer.from([0,0,1,0,0,0]),'.ico'),e=>e.status===415);
});

test('header dimensions support GIF, JPEG, lossless WebP and PNG-backed ICO without trusting extension alone',()=>{
 const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');assert.deepEqual(inspectArtifact(gif,'.gif'),{mime:'image/gif',width:1,height:1});
 const webp=Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==','base64');assert.deepEqual(inspectArtifact(webp,'.webp'),{mime:'image/webp',width:1,height:1});
 const jpeg=Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,2,0,3,1,1,0x11,0,0xff,0xd9]);assert.deepEqual(inspectArtifact(jpeg,'.jpg'),{mime:'image/jpeg',width:3,height:2});
 const ico=Buffer.alloc(22+png.length);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico[6]=ico[7]=1;ico.writeUInt32LE(png.length,14);ico.writeUInt32LE(22,18);png.copy(ico,22);assert.deepEqual(inspectArtifact(ico,'.ico'),{mime:'image/vnd.microsoft.icon',width:1,height:1});
});

test('SVG is admitted as image bytes, not sanitized or executed; unknown/huge dimensions and DTD are refused',async t=>{
 const {service,root}=await fixture(t);await fs.writeFile(path.join(root,'icon.svg'),svg);const result=await service.preview({projectId:'project-a',path:'icon.svg'});assert.equal(result.mime,'image/svg+xml');assert.equal(result.width,24);assert.deepEqual(result.bytes,svg);
 const withScript=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><script>globalThis.BAD=true</script></svg>');assert.equal(inspectArtifact(withScript,'.svg').mime,'image/svg+xml','security boundary is the image consumer, not a fake sanitizer');
 for(const text of ['<!DOCTYPE svg [<!ENTITY x "many">]>'+svg.toString(),'<svg xmlns="http://www.w3.org/2000/svg"/>','<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"/>','<svg xmlns="http://www.w3.org/2000/svg" data=" width=\'1\' height=\'1\' "/>'])assert.throws(()=>inspectArtifact(Buffer.from(text),'.svg'),e=>e.status===415);
 assert.throws(()=>inspectArtifact(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 99999 20"/>'),'.svg'),e=>e.status===413);
 assert.throws(()=>inspectArtifact(Buffer.alloc(ARTIFACT_LIMITS.svgBytes+1,32),'.svg'),e=>e.code==='ARTIFACT_SIZE_LIMIT');
});

test('junction/symlink directory cannot escape the authorized project',async t=>{
 const {service,root,outside}=await fixture(t);await fs.writeFile(path.join(outside,'outside.png'),png);
 try{await fs.symlink(outside,path.join(root,'linked'),process.platform==='win32'?'junction':'dir');}catch(e){if(['EPERM','EACCES','ENOSYS'].includes(e.code)){t.skip('Current environment cannot create a directory link');return;}throw e;}
 await assert.rejects(service.preview({projectId:'project-a',path:'linked/outside.png'}),e=>e.code==='ARTIFACT_LINK_REFUSED');
});

test('hard links are refused even when their visible path is inside the project',async t=>{
 const {service,root,outside}=await fixture(t);await fs.writeFile(path.join(outside,'outside.png'),png);
 try{await fs.link(path.join(outside,'outside.png'),path.join(root,'linked.png'));}catch(e){if(['EPERM','EACCES','ENOSYS'].includes(e.code)){t.skip('Current environment cannot create a hard link');return;}throw e;}
 await assert.rejects(service.preview({projectId:'project-a',path:'linked.png'}),e=>e.code==='ARTIFACT_FILE_REFUSED');
});

test('a file changed during its bounded read is rejected rather than showing mismatched content',async t=>{
 const {service,root}=await fixture(t),file=path.join(root,'growing.png');await fs.writeFile(file,png);const original=fs.open;
 t.mock.method(fs,'open',async function(name,...args){const h=await original.call(fs,name,...args);if(name===file){const read=h.read.bind(h);h.read=async(...values)=>{const result=await read(...values);await fs.appendFile(file,'x');return result;};}return h;});
 await assert.rejects(service.preview({projectId:'project-a',path:'growing.png'}),e=>e.code==='ARTIFACT_CHANGED');
});

test('synthetic link/identity rejection paths never open the refused file',async t=>{
 const {service,root}=await fixture(t),folder=path.join(root,'synthetic-junction'),file=path.join(root,'hard.png');await fs.mkdir(folder);await fs.writeFile(file,png);
 const lstat=fs.lstat,open=fs.open;let opened=0;
 t.mock.method(fs,'open',async(...args)=>{opened++;return open(...args);});
 t.mock.method(fs,'lstat',async name=>{const stat=await lstat(name);if(name===folder)stat.isSymbolicLink=()=>true;if(name===file)Object.defineProperty(stat,'nlink',{value:2});return stat;});
 await assert.rejects(service.preview({projectId:'project-a',path:'synthetic-junction/x.png'}),e=>e.code==='ARTIFACT_LINK_REFUSED');
 await assert.rejects(service.preview({projectId:'project-a',path:'hard.png'}),e=>e.code==='ARTIFACT_FILE_REFUSED');assert.equal(opened,0);
});

test('animated GIF frame resource count is bounded before image decoding',()=>{
 const header=Buffer.alloc(19);header.write('GIF89a');header.writeUInt16LE(1,6);header.writeUInt16LE(1,8);header[10]=0x80;header[16]=header[17]=header[18]=255;
 const frame=Buffer.from([0x2c,0,0,0,0,1,0,1,0,0,2,2,0x44,0x01,0]);const bytes=Buffer.concat([header,...Array.from({length:ARTIFACT_LIMITS.frames+1},()=>frame),Buffer.from([0x3b])]);
 assert.throws(()=>inspectArtifact(bytes,'.gif'),e=>e.code==='ARTIFACT_FRAME_LIMIT');
});

test('ICO embedded PNG dimensions and APNG declared frame count cannot bypass preview resource limits',()=>{
 const huge=Buffer.from(png);huge.writeUInt32BE(5000,16);const ico=Buffer.alloc(22+huge.length);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico[6]=ico[7]=1;ico.writeUInt32LE(huge.length,14);ico.writeUInt32LE(22,18);huge.copy(ico,22);
 assert.throws(()=>inspectArtifact(ico,'.ico'),e=>e.code==='ARTIFACT_DIMENSION_LIMIT');
 const animation=Buffer.alloc(20);animation.writeUInt32BE(8,0);animation.write('acTL',4);animation.writeUInt32BE(ARTIFACT_LIMITS.frames+1,8);
 assert.throws(()=>inspectArtifact(Buffer.concat([png.subarray(0,33),animation,png.subarray(33)]),'.png'),e=>e.code==='ARTIFACT_FRAME_LIMIT');
});

test('a canonical root changed after component checks is rejected before opening image bytes',async t=>{
 const {service,root,outside}=await fixture(t);await fs.writeFile(path.join(root,'x.png'),png);await fs.writeFile(path.join(outside,'x.png'),png);
 const realpath=fs.realpath;let opened=0;t.mock.method(fs,'realpath',async name=>name===root?outside:name===path.join(root,'x.png')?path.join(outside,'x.png'):realpath(name));t.mock.method(fs,'open',async()=>{opened++;throw new Error('Must not open outside bytes');});
 await assert.rejects(service.preview({projectId:'project-a',path:'x.png'}),e=>e.code==='ARTIFACT_PATH_CHANGED');assert.equal(opened,0);
});
