// ELECTRON_RUN_AS_NODE=1; static compatibility check only. No profile/runtime/model activation.
const fs=require('fs'),path=require('path');
try{
 if(process.env.ELECTRON_RUN_AS_NODE!=='1')throw Error('node mode required');
 const root=path.join(path.dirname(process.execPath),'resources','app.asar','dsh','node_modules');
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'@deepseek-ai','dsh-desktop-host','package.json'),'utf8'));
 const sqlite=typeof require('node:sqlite').DatabaseSync==='function';
 process.stdout.write(JSON.stringify({name:pkg.name,version:pkg.version,node:process.versions.node,sqlite})+'\n');
}catch{process.stdout.write(JSON.stringify({error:'DSH_RUNTIME_UNSUPPORTED'})+'\n');process.exitCode=1;}
