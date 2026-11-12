// Remote control (official remoteControl/* protocol): status, devices, pairing.
// Each mutation is confirmed explicitly, goes through the operation ledger, and is never retried.
// Connection/pairing success is not presented as a verified phone.
import { boundedText } from '../store.js';
import { remoteStatusLabel, safePairing, pairingQuery, remoteActionState, remoteEnvironmentId, remoteEnvironmentChanged, canRevokeDevice } from '../remote.js';

export function createRemoteView({ document, state, $, el, rpc, notice, confirm, performMutation, scopedPending, rowsNode }) {
  const remote = {busy:false,status:null,pair:null,timer:null,generation:0};
  function remoteActions(){return remoteActionState({connected:state.connected,busy:remote.busy,pending:scopedPending('remote').length>0,status:remote.status,pair:remote.pair});}
  function remoteControls(){const actions=remoteActions();for(const [id,key] of [['remote-refresh','refresh'],['remote-enable','enable'],['remote-disable','disable'],['remote-pair','pair'],['remote-pair-check','pairCheck']])$(id).disabled=!actions[key];$('remote-pair-check').title=actions.pairCheck?'查询本机配对码是否已被领取':'需要已连接且有效的本机配对码';}
  function remoteStatusRows(status){return rowsNode([['状态',remoteStatusLabel(status.status)],['服务名称',boundedText(status.serverName||'未知',200)],['安装标识',boundedText(status.installationId||'未知',200)]]);}
  function applyRemoteStatus(status){
   if(!state.connected)return;
   if(!status||!['disabled','connecting','connected','errored'].includes(status.status))return;
   const changed=!!remoteEnvironmentId(remote.status)&&remoteEnvironmentChanged(remote.status,status);remote.status=status;
   if(changed){clearRemotePair('远控环境已变化，本机配对码显示已清除；不会撤销原环境设备。');$('remote-devices').replaceChildren(el('p','','远控环境已变化，请刷新设备列表；不会撤销原环境设备。'));}
   else if(status.status!=='connected')$('remote-devices').replaceChildren(el('p','','远控未连接，设备列表不可用；未撤销任何设备。'));
   $('remote-status').replaceChildren(remoteStatusRows(status));remoteControls();
  }
  function remoteReset({statusMessage='尚未读取远控状态。',pairMessage='本机配对码显示已清除；不会撤销已配对设备。',devicesMessage='远控状态未读取，请刷新设备列表。'}={}){
   remote.generation++;remote.busy=false;remote.status=null;clearRemotePair(pairMessage);$('remote-status').textContent=statusMessage;$('remote-devices').replaceChildren(el('p','',devicesMessage));remoteControls();
  }
  function clearRemotePair(message='本机配对码显示已清除；这不会撤销已配对设备。'){clearTimeout(remote.timer);remote.timer=null;remote.pair=null;$('remote-pair-code').textContent='';$('remote-pair-expiry').textContent='';$('remote-pairing').classList.add('hidden');$('remote-pair-status').textContent=message;remoteControls();}
  async function refreshRemote(){
   if(remote.busy)return;
   if(!state.connected){notice('尚未连接 Codex，无法读取远控状态。',true);return;}
   const generation=++remote.generation,instance=state.serverInstance,previous=remote.status;
   remote.busy=true;remoteControls();remote.status=null;$('remote-status').textContent='正在读取…';$('remote-devices').replaceChildren(el('p','','尚未读取设备。'));
   const current=()=>generation===remote.generation&&state.connected&&instance===state.serverInstance;
   try{const status=await rpc('remoteControl/status/read',{});if(!current())return;if(remote.status&&remoteEnvironmentChanged(remote.status,status))return;
    const changed=!!remoteEnvironmentId(previous)&&remoteEnvironmentChanged(previous,status);remote.status=status;$('remote-status').replaceChildren(remoteStatusRows(status));
    if(changed){clearRemotePair('远控环境已变化，本机配对码显示已清除；不会撤销原环境设备。');$('remote-devices').replaceChildren(el('p','','远控环境已变化，请手动刷新设备列表；不会撤销原环境设备。'));return;}
    if(status.status!=='connected'){$('remote-devices').replaceChildren(el('p','','远控未连接，设备列表不可用；未撤销任何设备。'));return;}
    if(!status.environmentId){$('remote-devices').replaceChildren(el('p','','服务未提供环境标识，无法查询设备；不能据此判断没有设备。'));return;}
    let cursor,rows=[],pages=0;do{const result=await rpc('remoteControl/client/list',{environmentId:status.environmentId,limit:100,order:'desc',...(cursor?{cursor}:{})});if(!current())return;rows.push(...(result.data||[]));cursor=result.nextCursor;pages++;}while(cursor&&pages<5);
    if(!current()||remote.status!==status)return;const fragment=document.createDocumentFragment();if(!rows.length)fragment.append(el('p','','本次返回没有设备。'));for(const client of rows.slice(0,500)){const card=el('section','remote-device');card.append(el('strong','',boundedText(client.displayName||client.clientId||'未知设备',200)),el('p','',boundedText([client.deviceType,client.platform,client.osVersion,client.deviceModel,client.appVersion].filter(Boolean).join(' · '),500)));if(client.lastSeenAt)card.append(el('small','','最近活动：'+boundedText(String(client.lastSeenAt),100)));if(client.clientId){const button=el('button','','撤销此设备');button.type='button';button.addEventListener('click',()=>{if(!canRevokeDevice(remote.status,status.environmentId)){notice('远控环境已变化或未连接，未撤销任何设备。请刷新后重试。',true);return;}remoteChange('remoteControl/client/revoke',{environmentId:status.environmentId,clientId:client.clientId},`撤销设备“${client.displayName||client.clientId}”对本环境的远程访问权限？这会移除该设备的已配对授权。`);});card.append(button);}fragment.append(card);}if(cursor)fragment.append(el('p','','仅显示前 500 条；设备列表未完整。'));$('remote-devices').replaceChildren(fragment);
   }catch(error){if(current()){$('remote-status').textContent='远控状态/设备读取失败：'+error.message+'。未开启、配对或使用替代远控。';$('remote-devices').replaceChildren(el('p','','读取失败，未撤销任何设备。'));}}finally{if(generation===remote.generation){remote.busy=false;remoteControls();}}
  }
  async function remoteChange(method,params,question){
   if(!state.connected){notice('尚未连接 Codex，不能执行远控操作，也未撤销设备。',true);return;}
   if(remote.busy||scopedPending('remote').length){notice('远控状态仍在自动同步，请稍后再试。',true);return;}
   if(method==='remoteControl/client/revoke'&&!canRevokeDevice(remote.status,params.environmentId)){notice('远控环境已变化或未连接，未撤销任何设备。请刷新后重试。',true);return;}
   if(!confirm(question))return;
   const generation=++remote.generation,instance=state.serverInstance,environment=remoteEnvironmentId(remote.status);
   remote.busy=true;remoteControls();
   const current=()=>generation===remote.generation&&state.connected&&state.serverInstance===instance&&remoteEnvironmentId(remote.status)===environment;
   try{const result=await performMutation(method,params,{confirmed:true});
   if(!current()){notice('远控环境、账户或连接已变化；未渲染旧状态或旧配对码，请刷新核对。',true);return;}
   if(method==='remoteControl/pairing/start'){clearRemotePair('');remote.pair=safePairing(result);if(!remote.pair){$('remote-pair-status').textContent='服务未返回有效且未过期的配对码。不会显示无效码，也未自动重试。';return;}$('remote-pair-code').textContent=remote.pair.manualPairingCode||remote.pair.pairingCode;$('remote-pair-expiry').textContent='有效期至 '+new Date(remote.pair.expiresAt).toLocaleString()+'。仅在官方配对流程中输入；不要公开分享。';$('remote-pairing').classList.remove('hidden');remote.timer=setTimeout(()=>clearRemotePair('配对码已过期并清除；已授权设备仍需单独撤销。'),Math.min(2147483647,remote.pair.expiresAt-Date.now()));remoteControls();}
   else {if(method==='remoteControl/disable')clearRemotePair();if(method==='remoteControl/enable'||method==='remoteControl/disable')applyRemoteStatus(result);notice('远控操作已返回。请手动刷新状态与设备确认实际结果；尚未验证手机端。');}
   }catch(error){if(generation===remote.generation)notice('远控操作未确认完成：'+error.message+'。没有自动重试；连接正常时会自动同步原请求状态。',true);}finally{if(generation===remote.generation){remote.busy=false;remoteControls();}}
  }
  $('remote-refresh').addEventListener('click',refreshRemote);
  $('remote-enable').addEventListener('click',()=>remoteChange('remoteControl/enable',{ephemeral:true},'通过官方协议仅为本次会话启用远程控制？这不会改变已有持久偏好；此期间配对的设备仍可能保存授权，需要单独撤销。'));
  $('remote-disable').addEventListener('click',()=>remoteChange('remoteControl/disable',{ephemeral:false},'持久停用官方远程控制？该偏好会保留，但不会解除设备绑定；设备授权需单独撤销。'));
  $('remote-pair').addEventListener('click',()=>remoteChange('remoteControl/pairing/start',{manualCode:true},'创建官方远控配对码，让持有此码的设备完成配对并获得远程访问授权？码到期不会撤销已经配对的设备；必须在设备列表单独撤销。配对码仅显示在本机，不记录或保存。'));
  $('remote-pair-hide').addEventListener('click',()=>clearRemotePair());
  $('remote-pair-check').addEventListener('click',async()=>{
   if(remote.busy)return;
   const params=pairingQuery(remote.pair);
   if(!remoteActions().pairCheck||!params){if(!params)clearRemotePair('配对码已过期或不存在。');else notice('尚未连接或远控状态不允许查询配对码。',true);return;}
   const generation=++remote.generation,instance=state.serverInstance,environment=remoteEnvironmentId(remote.status);
   remote.busy=true;remoteControls();
   const current=()=>generation===remote.generation&&state.connected&&state.serverInstance===instance&&remoteEnvironmentId(remote.status)===environment;
   try{const result=await rpc('remoteControl/pairing/status',params);
    if(!current()){notice('远控环境、账户或连接已变化；未更新旧配对状态，请刷新核对。',true);return;}
    if(!pairingQuery(remote.pair)){clearRemotePair('配对码已过期。');return;}
    if(result.claimed===true)clearRemotePair('服务报告已领取配对授权；不等于手机连接已实测成功。请刷新设备列表核对。');
    else $('remote-pair-status').textContent=result.claimed===false?'服务报告尚未领取；不会自动轮询。':'服务未返回明确配对状态。';
   }catch(error){if(generation===remote.generation)$('remote-pair-status').textContent='查询失败：'+error.message;}
   finally{if(generation===remote.generation){remote.busy=false;remoteControls();}}
  });

  /** Clears an expired pairing code when the page becomes visible again. */
  function expireIfNeeded() { if (remote.pair && !pairingQuery(remote.pair)) clearRemotePair('配对码已过期并清除。'); }
  return { remoteControls, applyRemoteStatus, remoteReset, refreshRemote, expireIfNeeded };
}
