import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
export const defaultRolloutRoots=()=>['sessions','archived_sessions'].map(p=>path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),p));
const within=(root,file)=>{const r=path.relative(root,file);return r&&!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep);};
export async function readInlineHistoryImage({rollout,threadId,imagePath,roots=defaultRolloutRoots()}){
 if(typeof rollout!=='string'||!path.isAbsolute(rollout)||!roots.some(r=>within(path.resolve(r),rollout))||!path.basename(rollout).endsWith('-'+threadId+'.jsonl'))return null;
 for(let p=rollout;;p=path.dirname(p)){const s=await fs.lstat(p);if(s.isSymbolicLink())throw Error('History link refused');if(path.dirname(p)===p)break;}
 if(!same(await fs.realpath(rollout),path.resolve(rollout)))throw Error('History path changed');
 const h=await fs.open(rollout,'r');
 try{
  const info=await h.stat();if(!info.isFile()||info.nlink!==1||info.size>256*1024*1024)return null;
  let buffer=Buffer.alloc(0),skip=false,verified=false,total=0;const start=Date.now();
  for await(const chunk of h.createReadStream({autoClose:false,highWaterMark:64*1024})){
   total+=chunk.length;if(total>256*1024*1024||Date.now()-start>8000)return null;
   buffer=Buffer.concat([buffer,chunk]);let end;
   while((end=buffer.indexOf(10))>=0){
    const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);if(skip){skip=false;continue;}
    let row;try{row=JSON.parse(line.toString('utf8'));}catch{continue;}
    if(row.type==='session_meta'){if(row.payload?.id!==threadId)return null;verified=true;continue;}
    if(!verified||row.type!=='response_item'||row.payload?.type!=='message'||row.payload?.role!=='user'||!Array.isArray(row.payload.content))continue;
    const items=row.payload.content;
    for(let i=0;i+1<items.length;i++){
     if(items[i]?.type!=='input_text'||typeof items[i].text!=='string')continue;
     const match=/^<image name=\[Image #\d+\] path="([^"\r\n]+)">\r?\n?$/.exec(items[i].text);
     if(!match||!same(match[1],imagePath)||items[i+1]?.type!=='input_image')continue;
     const uri=items[i+1].image_url;if(typeof uri!=='string'||uri.length>14*1024*1024)return null;
     const data=/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(uri);if(!data)return null;
     const bytes=Buffer.from(data[2],'base64');if(bytes.length>10*1024*1024||bytes.toString('base64')!==data[2])return null;
     return {bytes,mime:data[1]};
    }
   }
   if(buffer.length>32*1024*1024){buffer=Buffer.alloc(0);skip=true;}
  }
  return null;
 }finally{await h.close();}
}
