// Synthetic stdio peer, not Codex or a model.
import readline from 'node:readline';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let initialized=false;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);const reply=result=>send({id:m.id,result});
 if(m.method==='initialize'){reply({userAgent:'strict-mock'});return;}
 if(m.method==='initialized'){initialized=true;return;}
 if(!initialized){send({id:m.id,error:{code:-32600,message:'Missing initialized'}});return;}
 if(m.method==='config/read'){reply({testInheritedHome:process.env.CODEX_HOME===process.env.TEST_EXPECTED_CODEX_HOME});return;}
 if(m.method==='thread/start'){reply({thread:{id:'test-thread'},model:'configured-model',inheritsPolicy:!Object.hasOwn(m.params,'approvalPolicy')&&!Object.hasOwn(m.params,'sandbox')});return;}
 if(m.method==='thread/unsubscribe'){reply({status:'unsubscribed'});return;}
 if(m.method==='thread/resume'){reply({thread:{id:m.params.threadId,turns:[]}});return;}
 if(m.method==='turn/start'){
  if(m.params.threadId!=='test-thread'||m.params.input.some(v=>v.type==='text'&&!Array.isArray(v.text_elements))){send({id:m.id,error:{code:-32602,message:'Missing required text_elements'}});return;}
  reply({turn:{id:'test-turn',status:'inProgress'}});
  send({method:'turn/completed',params:{threadId:'test-thread',turn:{id:'test-turn',status:'completed'}}});return;
 }
 send({id:m.id,error:{code:-32601,message:'Unsupported synthetic method'}});
});
