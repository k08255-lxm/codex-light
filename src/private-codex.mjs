import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
export const PRIVATE_CODEX=Object.freeze({version:'0.169.0',relativeExecutable:'package/vendor/x86_64-pc-windows-msvc/bin/codex.exe',sha256:'ce1945eb440b5481ed1233ebaf32b7056ee7e4e452fa62ffe1cbfb26103cdee0',packageIntegrity:'sha512-nC+McFU8xRNL9tk3IhxcKdhcyOElwF/HhPO+gzSQCY7yjh3XdzSajX+MYWcHUVHWRHajfwn3/WgJYJK2wS+XWg=='});
export function validatePrivateReceipt(receipt){return !!receipt&&Object.keys(receipt).sort().join(',')==='packageIntegrity,relativeExecutable,sha256,version'&&Object.entries(PRIVATE_CODEX).every(([key,value])=>receipt[key]===value);}
export function privateCodexRoot({env=process.env,home=os.homedir()}={}){const base=env.LOCALAPPDATA||path.win32.join(home,'AppData','Local');if(!path.win32.isAbsolute(base)||/^\\\\/.test(base))throw Error('Invalid private CLI root');return path.win32.join(base,'CodexLightTools','codex');}
function noLinks(file){for(let p=file;;p=path.dirname(p)){if(fs.lstatSync(p).isSymbolicLink())throw Error('Private CLI links refused');if(path.dirname(p)===p)break;}}
export function discoverPrivateCodex({platform=process.platform,arch=process.arch,env=process.env,home=os.homedir()}={}){
 if(platform!=='win32'||arch!=='x64')return null;
 const root=privateCodexRoot({env,home}),receiptPath=path.join(root,'current.json');if(!fs.existsSync(receiptPath))return null;
 noLinks(receiptPath);const stat=fs.statSync(receiptPath);if(!stat.isFile()||stat.size>4096)throw Error('Invalid private CLI receipt');
 const receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));if(!validatePrivateReceipt(receipt))throw Error('Private CLI receipt does not match pinned package');
 const executable=path.join(root,PRIVATE_CODEX.version,...PRIVATE_CODEX.relativeExecutable.split('/'));noLinks(executable);
 const before=fs.lstatSync(executable);if(!before.isFile()||before.nlink!==1)throw Error('Invalid private CLI executable');
 const fd=fs.openSync(executable,'r');try{const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let count;while((count=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,count));const after=fs.fstatSync(fd);if(hash.digest('hex')!==PRIVATE_CODEX.sha256||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('Private CLI hash mismatch');}finally{fs.closeSync(fd);}
 return {path:executable,version:PRIVATE_CODEX.version};
}
