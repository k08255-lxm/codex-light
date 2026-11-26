// Older WebViews use system windows for select menus, even with styled options.
// Delegate opening so selects added by settings panels need no initialization.
if(CSS.supports('appearance','base-select') && CSS.supports('selector(::picker(select))')){
  // Let the browser dismiss the picker before the app handles a second Escape.
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape' && event.target.closest?.('select:open'))event.stopPropagation();
  },true);
}else mountList();

function mountList(){
  const doc=document, win=window;
  doc.documentElement.dataset.selectFallback='';
  const list=doc.createElement('div');
  list.id='app-select-options';list.className='app-select-list';list.setAttribute('role','listbox');
  let owner=null,active=-1,rows=[],prefix='',typedAt=0,previousAria;
  const aria=['aria-expanded','aria-controls','aria-activedescendant'];
  const observer=new MutationObserver(()=>{if(!eligible(owner))close();else render();});
  const ownerObserver=new MutationObserver(()=>{if(!eligible(owner)||!owner.getClientRects().length)close();});
  const eligible=node=>node instanceof HTMLSelectElement && node.isConnected && !node.matches(':disabled') && !node.multiple && node.size<=1;
  const optionAt=index=>rows.find(row=>row.index===index);
  function close(){
    if(!owner)return;
    observer.disconnect();
    ownerObserver.disconnect();
    aria.forEach((key,i)=>{if(previousAria[i]===null)owner.removeAttribute(key);else owner.setAttribute(key,previousAria[i]);});
    list.remove();owner=null;rows=[];active=-1;prefix='';
  }
  function highlight(index,scroll=true){
    const next=optionAt(index);
    if(!next||next.disabled)return;
    optionAt(active)?.node.removeAttribute('data-active');active=index;
    next.node.setAttribute('data-active','');owner.setAttribute('aria-activedescendant',next.node.id);
    if(scroll)next.node.scrollIntoView({block:'nearest'});
  }
  function place(){
    if(!owner)return;
    if(!eligible(owner)||!owner.getClientRects().length){close();return;}
    const rect=owner.getBoundingClientRect(),viewport=win.visualViewport;
    const x=viewport?.offsetLeft||0,y=viewport?.offsetTop||0;
    const width=viewport?.width||doc.documentElement.clientWidth,height=viewport?.height||doc.documentElement.clientHeight;
    const margin=6,below=y+height-rect.bottom-margin,above=rect.top-y-margin;
    if(rect.bottom<=y||rect.top>=y+height){close();return;}
    list.style.setProperty('--select-anchor-width',rect.width+'px');
    list.style.setProperty('--select-viewport-width',(width-margin*2)+'px');
    const up=below<Math.min(list.scrollHeight,220) && above>below;
    list.style.maxHeight=Math.max(0,Math.min(height*.48,350,up?above:below))+'px';
    list.style.left=Math.max(x+margin,Math.min(rect.left,x+width-list.offsetWidth-margin))+'px';
    list.style.top=(up?rect.top-list.offsetHeight-3:rect.bottom+3)+'px';
  }
  function render(){
    const selected=owner.selectedIndex,fragment=doc.createDocumentFragment();rows=[];
    let previousGroup=null;
    for(const option of owner.options){
      const group=option.parentElement.tagName==='OPTGROUP'?option.parentElement:null;
      if(option.hidden||group?.hidden)continue;
      if(group&&group!==previousGroup){
        const label=doc.createElement('div');label.className='app-select-group';label.textContent=group.label;
        fragment.append(label);
      }
      previousGroup=group;
      const index=option.index,disabled=option.disabled||!!group?.disabled;
      const node=doc.createElement('div');node.setAttribute('role','option');node.dataset.index=String(index);
      node.id=list.id+'-'+index;node.textContent=option.label;
      if(group)node.setAttribute('aria-label',group.label+' · '+option.label);
      node.setAttribute('aria-selected',String(index===selected));
      if(disabled)node.setAttribute('aria-disabled','true');
      fragment.append(node);rows.push({index,node,disabled});
    }
    list.replaceChildren(fragment);place();
    if(owner){
      const selectedRow=optionAt(selected), enabled=selectedRow&&!selectedRow.disabled?selectedRow:rows.find(row=>!row.disabled);
      if(enabled)highlight(enabled.index);
      else owner.removeAttribute('aria-activedescendant');
    }
  }
  function open(select,keyboard=false){
    if(owner===select){close();return;}
    close();owner=select;previousAria=aria.map(key=>select.getAttribute(key));
    list.toggleAttribute('data-keyboard',keyboard);
    owner.focus({preventScroll:true});owner.setAttribute('aria-expanded','true');owner.setAttribute('aria-controls',list.id);
    list.setAttribute('aria-label',select.getAttribute('aria-label')||select.labels?.[0]?.innerText||'选项');
    (owner.closest('dialog[open]')||doc.body).append(list);
    observer.observe(select,{subtree:true,childList:true,attributes:true,characterData:true,attributeFilter:['disabled','selected','hidden','label','value','multiple','size']});
    ownerObserver.observe(doc.body,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled','hidden','open']});
    render();
  }
  function commit(index){
    const select=owner;
    if(!eligible(select)||!optionAt(index)||optionAt(index).disabled){close();return;}
    const changed=select.selectedIndex!==index;
    if(changed)select.selectedIndex=index;
    close();
    if(changed){
      select.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
      select.dispatchEvent(new Event('change',{bubbles:true}));
    }
  }
  doc.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    if(eligible(event.target)){event.preventDefault();open(event.target);}
    else if(owner&&!list.contains(event.target))close();
  },true);
  // Mouse down must not blur the select. Touch scrolling keeps its default behavior.
  list.addEventListener('mousedown',event=>event.preventDefault());
  list.addEventListener('pointermove',event=>{
    if(event.pointerType==='mouse'){
      const row=event.target.closest('[role=option]');
      if(row){list.removeAttribute('data-keyboard');highlight(Number(row.dataset.index),false);}
    }
  });
  list.addEventListener('click',event=>{
    const row=event.target.closest('[role=option]');
    if(row&&!row.hasAttribute('aria-disabled'))commit(Number(row.dataset.index));
  });
  doc.addEventListener('click',event=>{
    if(!eligible(event.target))return;
    event.preventDefault();if(event.detail===0)open(event.target,true);
  },true);
  doc.addEventListener('keydown',event=>{
    const select=event.target;
    if(!eligible(select)||event.ctrlKey||event.metaKey)return;
    const key=event.key;
    if(!owner){
      if(['ArrowDown','ArrowUp','Enter',' ','F4'].includes(key)){event.preventDefault();open(select,true);}
      return;
    }
    if(owner!==select)return;
    list.setAttribute('data-keyboard','');
    if(key==='Tab'){close();return;}
    if(key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
    if(key==='Enter'||key===' '){event.preventDefault();if(active>=0)commit(active);return;}
    const available=rows.filter(row=>!row.disabled),pos=available.findIndex(row=>row.index===active);
    const positions={Home:0,End:available.length-1,ArrowDown:pos+1,ArrowUp:pos-1,PageDown:pos+8,PageUp:pos-8};
    if(Object.hasOwn(positions,key)){
      event.preventDefault();highlight(available[Math.max(0,Math.min(available.length-1,positions[key]))]?.index);
    }else if(key.length===1&&!event.altKey){
      event.preventDefault();const now=Date.now();prefix=(now-typedAt<700?prefix:'')+key.toLocaleLowerCase();typedAt=now;
      const match=available.slice(pos+1).concat(available.slice(0,pos+1)).find(row=>row.node.textContent.toLocaleLowerCase().startsWith(prefix));
      if(match)highlight(match.index);
    }
  },true);
  doc.addEventListener('focusin',event=>{if(owner&&event.target!==owner&&!list.contains(event.target))close();});
  doc.addEventListener('scroll',event=>{if(owner&&!list.contains(event.target))place();},true);
  win.addEventListener('resize',place);win.visualViewport?.addEventListener('resize',place);
  win.visualViewport?.addEventListener('scroll',place);win.addEventListener('blur',close);
  doc.addEventListener('close',close,true);
}
