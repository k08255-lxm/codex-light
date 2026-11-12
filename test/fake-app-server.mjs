import readline from 'node:readline';
const send = msg => process.stdout.write(JSON.stringify(msg)+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const msg=JSON.parse(line);
 if(msg.method==='initialize'){if(process.argv.includes('--hang-initialize'))return;if(msg.params.capabilities?.requestAttestation!==false||msg.params.capabilities?.experimentalApi!==true){send({id:msg.id,error:{code:-32602,message:'Required capability flags missing'}});return;}send({id:msg.id,result:{userAgent:'fake-codex-test'}});return;}
 if(msg.method==='test/delayed'){setTimeout(()=>send({id:msg.id,result:{ok:true}}),100);return;}
 if(msg.method==='test/approval'){send({id:900,method:'item/commandExecution/requestApproval',params:{threadId:'a',turnId:'b',command:'echo safe',availableDecisions:['accept','decline']}});send({id:msg.id,result:{ok:true}});return;}
 if(msg.method==='test/error'){send({id:msg.id,error:{code:-1,message:'test failure'}});return;}
 if(msg.method==='test/exit'){process.exit(4);}
 if(msg.method && msg.id)send({id:msg.id,result:{echo:msg.params}});
 if(msg.id===900 && msg.result)send({method:'serverRequest/resolved',params:{requestId:900}});
});
