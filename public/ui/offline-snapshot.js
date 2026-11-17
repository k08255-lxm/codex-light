// Android persists this read-only projection. Never serialize DOM markup, form values or browser storage.
export function mountOfflineSnapshot({document,window,readState}){
  const pageNames={chat:'对话',usage:'用量',account:'账户'};
  window.CodexLightOfflineSnapshot={capture(){
    const state=readState();
    if(!state.ready||!pageNames[state.page])return null;
    const root=document.getElementById(state.page==='chat'?'messages':state.page==='usage'?'stats-root':'account-root');
    if(!root||root.getAttribute('aria-busy')==='true')return null;
    const text=(root.innerText||'').trim();
    if(!text)return null;
    const prefix=state.page==='chat'?[state.project,document.getElementById('approvals')?.innerText].filter(Boolean).join('\n')+'\n\n':'';
    return {title:String(state.title||'码舱 CodeCang').slice(0,160),page:pageNames[state.page],text:(prefix+text).slice(-100000)};
  }};
  return {ready(){if(readState().ready&&typeof window.CodexLightNative?.offlineSnapshotReady==='function')window.CodexLightNative.offlineSnapshotReady();}};
}
