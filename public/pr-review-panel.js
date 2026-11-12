import {icon} from './icons.js';
const str=(s,n=50000)=>typeof s==='string'?s.slice(0,n):s==null?'未知':String(s);
const number=n=>Number.isSafeInteger(n)&&n>=0?String(n):'未知';
const SECTION_LABELS={files:'文件差异',reviews:'审查记录',comments:'讨论评论','review-comments':'代码行评论'};
export function mountPrReviewPanel(container,{api}={}){
 if(typeof api!=='function')throw new TypeError('api callback required');
 const doc=container.ownerDocument;let disposed=false,listGeneration=0,detailGeneration=0,sectionGeneration=0,listPage=1,sectionPage=1,currentUrl=null,currentSection='files';
 const el=(tag,value,cls)=>{const n=doc.createElement(tag);if(value!==undefined)n.textContent=value;if(cls)n.className=cls;return n;};
 const button=(title,glyph)=>{const b=el('button',title);b.type='button';if(glyph)b.prepend(icon(doc,glyph));return b;};
 const heading=el('h1','PR 浏览与审查信息'),intro=el('p','使用本机已登录的 GitHub CLI，只读查看 github.com PR。此页不 checkout、不执行补丁、不调用模型，也不发布评论或审查。','pr-review-note');
 const status=el('p','点击读取我的 PR，或输入完整 PR 链接。','pr-review-status');status.setAttribute('role','status');
 const filter=el('select');filter.setAttribute('aria-label','PR 范围');for(const [value,title]of [['created','我创建的'],['review-requested','待我审查']]){const o=el('option',title);o.value=value;filter.append(o);}filter.value='created';
 const state=el('select');state.setAttribute('aria-label','PR 状态');for(const [value,title]of [['open','打开'],['closed','关闭'],['all','全部']]){const o=el('option',title);o.value=value;state.append(o);}state.value='open';
 const repoLabel=el('label','可选仓库 owner/repo'),repo=el('input');repo.type='text';repo.placeholder='owner/repository';repo.autocomplete='off';repoLabel.append(repo);
 const refresh=button('读取我的 PR','refresh'),check=button('检测 GitHub CLI');
 const urlLabel=el('label','GitHub Pull Request 链接'),url=el('input');url.type='url';url.placeholder='https://github.com/owner/repo/pull/123';url.autocomplete='off';urlLabel.append(url);const open=button('加载 PR');
 const toolbar=el('div',undefined,'pr-review-toolbar');toolbar.append(filter,state,repoLabel,refresh,check,urlLabel,open);
 const list=el('div',undefined,'pr-review-list'),listPager=el('div',undefined,'pr-review-pager'),previous=button('上一页 PR'),next=button('下一页 PR'),listPageLabel=el('span');listPager.append(previous,listPageLabel,next);previous.disabled=next.disabled=true;
 const detail=el('section',undefined,'pr-review-detail');detail.setAttribute('aria-label','PR 详情');detail.tabIndex=-1;
 const tabs=el('div',undefined,'pr-review-tabs'),section=el('section',undefined,'pr-review-section'),sectionStatus=el('p');sectionStatus.setAttribute('role','status');
 const sectionPager=el('div',undefined,'pr-review-pager'),prevSection=button('上一页内容'),nextSection=button('下一页内容'),sectionPageLabel=el('span');sectionPager.append(prevSection,sectionPageLabel,nextSection);prevSection.disabled=nextSection.disabled=true;
 for(const [kind,title]of Object.entries(SECTION_LABELS)){const b=button(title);b.disabled=true;b.addEventListener('click',()=>{currentSection=kind;loadSection(1);});b.dataset?b.dataset.kind=kind:b.setAttribute('data-kind',kind);tabs.append(b);}
 container.replaceChildren(heading,intro,toolbar,status,list,listPager,detail,tabs,sectionStatus,section,sectionPager);container.classList.add('pr-review-panel');
 const error=(data,fallback)=>data?.ok===false?str(data.message,1000):fallback;
 async function listPr(page=1){
  const generation=++listGeneration;refresh.disabled=true;previous.disabled=next.disabled=true;status.textContent='正在读取 GitHub PR 列表…';list.replaceChildren();
  try{const repository=repo.value.trim(),data=await api('/api/pr/list',{filter:filter.value,state:state.value,page,...(repository?{repository}:{})});if(disposed||generation!==listGeneration)return;if(data?.ok!==true){status.textContent=error(data,'无法读取列表。');return;}
   listPage=page;for(const p of data.items??[]){const card=el('article',undefined,'pr-review-card'),b=button(str(p.title,1000));b.addEventListener('click',()=>loadDetail(p.url));card.append(b,el('p',`#${number(p.number)} · ${str(p.author?.login)} · ${str(p.state)}${p.draft?' · 草稿':''}`),el('p',str(p.updatedAt,100)));list.append(card);}
   if(!data.items?.length)list.append(el('p','当前筛选没有返回 PR；不代表其他范围没有 PR。'));listPageLabel.textContent=`第 ${page} 页`;previous.disabled=page===1;next.disabled=!data.hasMore;status.textContent=`当前账号 ${str(data.login)}；${data.partial?'结果不完整，请缩小仓库范围。':'列表已更新。'} ${str(data.notice,1000)}`;
  }catch{if(!disposed&&generation===listGeneration)status.textContent='PR 列表读取失败，请检查目录筛选、GitHub CLI 与登录状态；未自动重试。';}
  finally{if(!disposed&&generation===listGeneration)refresh.disabled=false;}
 }
 async function loadDetail(value){
  const generation=++detailGeneration;++sectionGeneration;currentUrl=null;open.disabled=true;detail.replaceChildren();section.replaceChildren();sectionStatus.textContent='';for(const b of tabs.children)b.disabled=true;prevSection.disabled=nextSection.disabled=true;status.textContent='正在读取 PR 详情…';
  try{const data=await api('/api/pr/detail',{url:value});if(disposed||generation!==detailGeneration)return;if(data?.ok!==true){status.textContent=error(data,'无法读取 PR。');return;}
   const p=data.pullRequest;currentUrl=data.target.url;url.value=currentUrl;detail.append(el('h2',`#${number(p.number)} ${str(p.title,1000)}`),el('p',`${str(p.author?.login)} · ${p.merged?'已合并':str(p.state)}${p.draft?' · 草稿':''}`),el('p',currentUrl),el('p',`${str(p.head?.ref,500)} → ${str(p.base?.ref,500)}`),el('p',`文件 ${number(p.changedFiles)} · +${number(p.additions)} / −${number(p.deletions)} · 提交 ${number(p.commits)}`));
   const body=el('pre',p.body||'无 PR 描述','pr-review-body');detail.append(body);if(p.bodyTruncated)detail.append(el('p','PR 正文超过显示上限，内容已截断。'));
   detail.append(el('p',`请求审查：${(p.requestedReviewers??[]).map(x=>str(x.login,100)).join('、')||'无返回人员'}；团队：${(p.requestedTeams??[]).map(x=>str(x.name,200)).join('、')||'无返回团队'}`));status.textContent=str(data.notice,1000);detail.focus();for(const b of tabs.children)b.disabled=false;currentSection='files';await loadSection(1);
  }catch{if(!disposed&&generation===detailGeneration)status.textContent='PR 详情读取失败。请使用完整 github.com HTTPS PR 链接，并检查登录权限。';}
  finally{if(!disposed&&generation===detailGeneration)open.disabled=false;}
 }
 async function loadSection(page){
  if(!currentUrl)return;const generation=++sectionGeneration,target=currentUrl,kind=currentSection;section.replaceChildren();prevSection.disabled=nextSection.disabled=true;sectionStatus.textContent=`正在读取${SECTION_LABELS[kind]}…`;
  try{const data=await api('/api/pr/section',{url:target,kind,page});if(disposed||generation!==sectionGeneration||currentUrl!==target)return;if(data?.ok!==true){sectionStatus.textContent=error(data,'内容读取失败。');return;}
   sectionPage=page;for(const item of data.items??[]){const card=el('article',undefined,'pr-review-entry');
    if(kind==='files'){const disclosure=el('details'),summary=el('summary',`${str(item.filename,2000)} · ${str(item.status,100)} · +${number(item.additions)} / −${number(item.deletions)}`);disclosure.append(summary);if(item.previousFilename)disclosure.append(el('p',`原名称：${str(item.previousFilename,2000)}`));if(item.patchUnavailable)disclosure.append(el('p','GitHub 未提供此文件的 patch，可能是二进制或内容过大，不代表没有变化。'));else disclosure.append(el('pre',str(item.patch,200000),'pr-review-patch'));if(item.patchTruncated)disclosure.append(el('p','Patch 超过显示上限，已截断。'));card.append(disclosure);}
    else{card.append(el('h3',`${str(item.author?.login,100)}${item.state?' · '+str(item.state,100):''}`),el('p',str(item.submittedAt,100)));if(item.path)card.append(el('p',`${str(item.path,2000)}${item.line!=null?':'+number(item.line):''}`));card.append(el('pre',item.body||'无正文','pr-review-body'));if(item.bodyTruncated)card.append(el('p','评论超过显示上限，已截断。'));if(item.diffHunk)card.append(el('pre',str(item.diffHunk,10000),'pr-review-patch'));}
    section.append(card);
   }
   if(!data.items?.length)section.append(el('p','当前页没有返回记录；不会推断为已批准或审查通过。'));sectionPageLabel.textContent=`${SECTION_LABELS[kind]} · 第 ${page} 页`;prevSection.disabled=page===1;nextSection.disabled=!data.hasMore;sectionStatus.textContent=`${str(data.notice,1000)}${data.partial?' 已达到覆盖上限，结果不完整。':''}`;
  }catch{if(!disposed&&generation===sectionGeneration)sectionStatus.textContent='该部分读取失败，其他已读取信息仍保留；未自动重试。';}
 }
 refresh.addEventListener('click',()=>listPr(1));previous.addEventListener('click',()=>listPr(listPage-1));next.addEventListener('click',()=>listPr(listPage+1));open.addEventListener('click',()=>loadDetail(url.value.trim()));url.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();loadDetail(url.value.trim());}});prevSection.addEventListener('click',()=>loadSection(sectionPage-1));nextSection.addEventListener('click',()=>loadSection(sectionPage+1));
 check.addEventListener('click',async()=>{const generation=++listGeneration;check.disabled=true;status.textContent='正在检测正常 GitHub CLI 登录…';try{const data=await api('/api/pr/status',{});if(disposed||generation!==listGeneration)return;status.textContent=data?.ok===true?`已登录 github.com：${str(data.login,100)}。仅只读，不显示令牌。`:error(data,'检测失败。');}catch{if(!disposed&&generation===listGeneration)status.textContent='无法检测 GitHub CLI，请检查正常安装与登录。';}finally{if(!disposed){check.disabled=false;refresh.disabled=false;}}});
 return {reset(){listGeneration++;detailGeneration++;sectionGeneration++;currentUrl=null;list.replaceChildren();detail.replaceChildren();section.replaceChildren();status.textContent='上下文已改变，请重新读取 PR。';sectionStatus.textContent='';refresh.disabled=open.disabled=check.disabled=false;previous.disabled=next.disabled=prevSection.disabled=nextSection.disabled=true;for(const b of tabs.children)b.disabled=true;},destroy(){disposed=true;listGeneration++;detailGeneration++;sectionGeneration++;container.replaceChildren();}};
}
