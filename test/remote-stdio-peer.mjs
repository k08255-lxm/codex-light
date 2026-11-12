// Synthetic protocol peer. No remote service/network/account is used.
import readline from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');let ready=false,enabled=false,paired=false;
const status=()=>({status:enabled?'connected':'disabled',serverName:'mock',installationId:'mock-install',environmentId:enabled?'mock-env':null});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),ok=result=>send({id:m.id,result});
 if(m.method==='initialize'){ok({userAgent:'remote-mock'});return;}if(m.method==='initialized'){ready=true;return;}if(!ready)return;
 switch(m.method){
 case 'remoteControl/status/read':ok(status());break;
 case 'remoteControl/enable':enabled=true;ok(status());break;
 case 'remoteControl/disable':enabled=false;ok(status());break;
 case 'remoteControl/pairing/start':if(!enabled){send({id:m.id,error:{code:-32600,message:'Remote control disabled'}});break;}ok({pairingCode:'synthetic-private-code',manualPairingCode:'SYNTHETIC',environmentId:'mock-env',expiresAt:Math.floor(Date.now()/1000)+60});break;
 case 'remoteControl/pairing/status':paired=true;ok({claimed:true});break;
 case 'remoteControl/client/list':ok({data:paired?[{clientId:'mock-client',displayName:'Synthetic client'}]:[],nextCursor:null});break;
 case 'remoteControl/client/revoke':paired=false;ok({});break;
 default:send({id:m.id,error:{code:-32601,message:'Unknown mock method'}});
 }
});
