// Synthetic stdio server: never starts Codex, tools, models or external services.
import readline from 'node:readline';
const received=[],send=value=>process.stdout.write(JSON.stringify(value)+'\n');let initialization;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 if(!message.method){received.push(message);return;}
 if(message.method==='initialized')return;
 if(message.method==='initialize'){initialization=message.params;send({id:message.id,result:{userAgent:'synthetic-approval-server'}});return;}
 if(message.method==='test/request')send(message.params.request);
 if(message.method==='test/notification')send(message.params.notification);
 if(message.method==='test/exit')process.exit(3);
 send({id:message.id,result:message.method==='test/received'?received:message.method==='test/initialization'?initialization:{ok:true}});
});
