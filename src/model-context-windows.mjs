import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readdir,rename,unlink,writeFile} from 'node:fs/promises';
import {plain} from './storage-maintenance.mjs';

const validModel=model=>typeof model==='string' && !!model && model===model.trim() && model.length<=256 && !/[\x00-\x1f\x7f]/.test(model);
const validSize=size=>Number.isSafeInteger(size) && size>0;
const digest=value=>createHash('sha256').update(value).digest('hex');

// model/list exposes selectable models but no window sizes. Codex maintains richer
// metadata in its own cache. Return only public numeric fields, never identity or instructions.
export async function readModelWindowCatalog(home){
 const empty=status=>({status,fetchedAt:null,models:{}});
 if(!home||!path.isAbsolute(home))return empty('missing');
 const file=path.join(home,'models_cache.json');
 let handle;
 try{
  await plain(file);handle=await open(file,'r');const stat=await handle.stat();
  if(!stat.isFile()||stat.size>8*1024*1024)return empty('invalid');
  const bytes=Buffer.alloc(stat.size+1);let count=0;
  while(count<bytes.length){
   const part=await handle.read(bytes,count,bytes.length-count,count);
   if(!part.bytesRead)break;count+=part.bytesRead;
  }
  if(count!==stat.size)return empty('invalid');
  const data=JSON.parse(bytes.subarray(0,count).toString('utf8'));
  if(!Array.isArray(data?.models))return empty('invalid');
  const models=new Map();
  for(const item of data.models){
   if(!validModel(item?.slug)||!validSize(item.context_window))continue;
   models.set(item.slug,{size:item.context_window,max:validSize(item.max_context_window)?item.max_context_window:null});
  }
  const fetched=typeof data.fetched_at==='string'?Date.parse(data.fetched_at):NaN;
  return {status:'ready',fetchedAt:Number.isFinite(fetched)?new Date(fetched).toISOString():null,models:Object.fromEntries(models)};
 }catch(error){
  if(error.code==='ENOENT')return empty('missing');
  if(error instanceof SyntaxError)return empty('invalid');
  return empty('unreadable');
 }finally{await handle?.close();}
}

// One atomically replaced file per model, so changes to different models cannot overwrite one another.
export class ModelContextWindows {
 constructor(root,profile){
  this.directory=root&&path.join(root,'model-context-windows',digest(JSON.stringify(profile)));
  this.sizes=new Map();this.queue=Promise.resolve();
 }
 async load(){
  if(!this.directory)return;
  await plain(this.directory);
  let names;
  try{names=await readdir(this.directory);}catch(error){if(error.code==='ENOENT')return;throw error;}
  for(const name of names.filter(name=>/^[0-9a-f]{64}\.json$/.test(name))){
   const file=path.join(this.directory,name);await plain(file);
   const handle=await open(file,'r');
   try{
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size>4096)throw new Error('模型上下文配置文件无效');
    const {model,size}=JSON.parse(await handle.readFile('utf8'));
    if(!validModel(model)||!validSize(size)||name!==digest(model)+'.json')throw new Error('模型上下文配置无效');
    this.sizes.set(model,size);
   }finally{await handle.close();}
  }
 }
 snapshot(){return Object.fromEntries(this.sizes);}
 update(input){
  if(!input||Object.keys(input).sort().join(',')!=='model,size'||!validModel(input.model)||(input.size!==null&&!validSize(input.size)))throw new Error('请选择有效模型并填写正整数，或恢复引擎默认值。');
  const {model,size}=input;
  const save=this.queue.then(async()=>{
   if(this.directory){
    const file=path.join(this.directory,digest(model)+'.json');await plain(file);
    if(size===null){await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    else{
     await mkdir(this.directory,{recursive:true,mode:0o700});
     const tmp=file+'.'+randomUUID();
     try{await writeFile(tmp,JSON.stringify({model,size}),{flag:'wx',mode:0o600});await rename(tmp,file);}
     finally{await unlink(tmp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    }
   }
   if(size===null)this.sizes.delete(model);else this.sizes.set(model,size);
   return this.snapshot();
  });
  this.queue=save.catch(()=>{});return save;
 }
 async sessionParams(rpc,params,work={}){
  if(!this.sizes.size)return params;
  let model=work.model||params.model,cwd=work.cwd||params.cwd;
  if(!model&&params.threadId){
   const {thread}=await rpc.call('thread/read',{threadId:params.threadId,includeTurns:false});
   model=thread?.model;cwd??=thread?.cwd;
  }
  if(!model){
   const result=await rpc.call('config/read',{includeLayers:false,...(cwd?{cwd}:{})});
   model=result?.config?.model;
   if(!model){
    let cursor;const seen=new Set();
    do{
     const page=await rpc.call('model/list',{limit:100,...(cursor?{cursor}:{})});
     model=page.data?.find(item=>item.isDefault)?.model;
     cursor=page.nextCursor;
     if(cursor&&seen.has(cursor))throw new Error('模型目录分页游标重复');
     seen.add(cursor);
    }while(!model&&cursor);
   }
  }
  const size=this.sizes.get(model);
  return size===undefined?params:{...params,model,config:{...params.config,model_context_window:size}};
 }
}
