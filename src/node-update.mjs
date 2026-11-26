import {compareVersions} from './update-manifest.mjs';

const scheduleUrl='https://raw.githubusercontent.com/nodejs/Release/main/schedule.json';
const stable=/^\d+\.\d+\.\d+$/;

async function readMetadata(fetchFn,url){
  const response=await fetchFn(url,{signal:AbortSignal.timeout(12000),redirect:'error'});
  if(!response.ok||!response.body)throw new Error('Node.js 官方版本信息暂时不可用。');
  const chunks=[];let size=0;
  for await(const chunk of response.body){
    size+=chunk.length;
    if(size>128*1024)throw new Error('Node.js 官方版本信息过大。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class NodeUpdateCheck {
  constructor({current=process.versions.node,fetchFn=fetch,now=()=>new Date()}={}){
    this.current=current;this.fetchFn=fetchFn;this.now=now;
    this.status={current};this.pending=null;
  }
  check(){
    if(!this.pending)this.pending=this.refresh().catch(error=>{
      this.status={current:this.current,error:'无法检查 Node.js 更新：'+error.message};
      throw error;
    }).finally(()=>{this.pending=null;});
    return this.pending;
  }
  async refresh(){
    if(!stable.test(this.current))throw new Error('当前使用预发布版 Node.js。');
    const major=Number(this.current.split('.')[0]);
    const schedule=JSON.parse(await readMetadata(this.fetchFn,scheduleUrl));
    const today=this.now().toISOString().slice(0,10);
    const supported=Object.entries(schedule).filter(([key,line])=>/^v\d+$/.test(key)&&
      typeof line.lts==='string'&&line.lts<=today&&line.end>today).map(([key])=>Number(key.slice(1)));
    if(!supported.length)throw new Error('官方支持周期数据无效。');
    const ownLine=schedule['v'+major];
    if(typeof ownLine?.end!=='string')throw new Error('官方支持周期尚未收录当前版本。');
    const endOfLife=ownLine.end<=today;
    // Stay on the user's major while it is supported. An EOL line needs a supported LTS.
    const target=endOfLife?Math.max(...supported):major;
    const sums=await readMetadata(this.fetchFn,'https://nodejs.org/dist/latest-v'+target+'.x/SHASUMS256.txt');
    const matches=[...sums.matchAll(/^([0-9a-f]{64})[ \t]+node-v(\d+\.\d+\.\d+)-x64\.msi\r?$/gmi)];
    if(matches.length!==1||Number(matches[0][2].split('.')[0])!==target)throw new Error('官方清单缺少唯一的 Windows x64 安装包。');
    const latest=matches[0][2];
    return this.status={current:this.current,latest,endOfLife,available:endOfLife||compareVersions(latest,this.current)>0};
  }
}
