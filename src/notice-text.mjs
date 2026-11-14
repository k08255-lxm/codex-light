// Lossless, readable collected notices. No legal classification or SPDX rewriting.
import {createHash} from 'node:crypto';
const MAGIC='Codecang collected notice texts v1\n';
const hash=b=>createHash('sha256').update(b).digest('hex');
const safe=n=>typeof n==='string'&&n.length<1024&&!/[\\:\x00-\x1f]/.test(n)&&!n.startsWith('/')&&n.split('/').every(x=>x&&x!=='.'&&x!=='..');
export function collectNoticeText(input){
 const names=Object.keys(input).sort(),seen=new Set(),groups=new Map(),entries=[],parts=[];let offset=0;
 if(!names.length||names.length>10000)throw Error('Invalid notice count');
 for(const name of names){
  if(!safe(name)||seen.has(name.toLowerCase()))throw Error('Unsafe notice path');seen.add(name.toLowerCase());
  const bytes=Buffer.from(input[name]);new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!bytes.length)throw Error('Empty notice');
  const sha256=hash(bytes);let section=groups.get(sha256);
  if(section&&!section.bytes.equals(bytes))throw Error('Notice hash collision');
  if(!section){const title=Buffer.from('\n\n===== '+name+' =====\n');parts.push(title,bytes);offset+=title.length;section={bytes,offset,length:bytes.length};groups.set(sha256,section);offset+=bytes.length;}
  entries.push({path:name,sha256,offset:section.offset,length:section.length});
 }
 return Buffer.concat([Buffer.from(MAGIC+JSON.stringify(entries)+'\n\n'),...parts]);
}
export function readNoticeText(input){
 const bytes=Buffer.from(input);if(bytes.length>64*1024*1024||!bytes.subarray(0,Buffer.byteLength(MAGIC)).equals(Buffer.from(MAGIC)))throw Error('Invalid notice collection');
 const end=bytes.indexOf('\n\n',Buffer.byteLength(MAGIC));if(end<0||end>4*1024*1024)throw Error('Invalid notice index');
 const index=JSON.parse(bytes.subarray(Buffer.byteLength(MAGIC),end).toString('utf8')),body=bytes.subarray(end+2),out=Object.create(null);
 if(!Array.isArray(index)||!index.length||index.length>10000)throw Error('Invalid notice index');
 for(const item of index){if(!safe(item.path)||Object.hasOwn(out,item.path)||!Number.isSafeInteger(item.offset)||!Number.isSafeInteger(item.length)||item.offset<0||item.length<=0||item.offset+item.length>body.length)throw Error('Invalid notice slice');const value=body.subarray(item.offset,item.offset+item.length);if(hash(value)!==item.sha256)throw Error('Notice text changed');out[item.path]=value;}
 if(!collectNoticeText(out).equals(bytes))throw Error('Noncanonical notice collection');
 return out;
}
