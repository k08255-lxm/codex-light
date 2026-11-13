// Generated / referenced image artifacts. Previews are fetched only through the authenticated
// POST /api/artifacts/preview (thread- or project-scoped) and shown as <img src="blob:…">.
// Never inline SVG, never use object/iframe, never auto-fetch remote URLs. Blob URLs are revoked.
import { el } from './format.js';
import { icon } from '../icons.js';
import { rasterBase64Mime } from '../store.js';

const PREVIEW_EXT = /\.(png|jpe?g|webp|gif|ico|svg)$/i;
// MCP image content is shown only for raster types; SVG markup from a tool result is never rendered.
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const INLINE_MAX_BASE64 = Math.ceil(6 * 1024 * 1024 / 3) * 4;
function decodeBase64(data, mime) { let binary; try { binary = atob(data); } catch { throw new Error('图片数据不是有效 base64'); } const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i); return new Blob([bytes], { type: mime }); }
const isRemote = value => /^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^file:/i.test(value);

function toolImageCandidate(item, part, index, source) {
  const key = `${item.id}:${source}:${index}:r${part.revision || 0}`;
  const name = `${item.tool || item.name || '工具'} 图片 ${index + 1}`;
  const ref = Number.isInteger(part.imageRef) ? part.imageRef : null;
  const uri = part.imageUrl ?? part.image_url;
  if (!part.imageError && typeof uri === 'string' && !isRemote(uri) && /^(file:|[a-z]:[\\/]|\/)/i.test(uri) && PREVIEW_EXT.test(uri)) return { key, kind: 'viewed', path: uri, status: 'done', caption: '', reason: '', name };
  const match = typeof uri === 'string' ? /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(uri) : null;
  const mime = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : match?.[1]?.toLowerCase() || '';
  const data = match?.[2] || '';
  const reason = part.imageError || (!INLINE_TYPES.has(mime) ? (part.file_id ? '图片仅提供文件标识，尚无可读取内容' : '此图片没有可预览的本地内容') : ref === null && !data ? '没有图片数据' : data.length > INLINE_MAX_BASE64 ? '图片数据超过 6 MiB' : '');
  return { key, kind: 'viewed', path: null, inline: reason ? null : { mime, data: ref === null ? data : null, itemId: item.id, slot: ref, revision: part.revision || 0 }, status: reason ? 'failed' : 'done', caption: '', reason, name };
}

/** Explicit artifact candidates from a native item. Prose is never parsed as proof of an artifact. */
export function artifactCandidates(item) {
  if (!item || typeof item !== 'object') return [];
  if(item.type==='userMessage')return (item.content||[]).flatMap((part,index)=>{
    if(part?.type==='localImage'&&typeof part.path==='string'&&part.path&&!isRemote(part.path))return [{key:`${item.id}:upload:${index}`,kind:'uploaded',path:part.path,status:'done',caption:'',reason:''}];
    if(part?.type!=='image')return [];
    const ref=Number.isInteger(part.imageRef)?part.imageRef:null;
    if(ref!==null)return [{key:`${item.id}:upload:${index}:r${part.revision||0}`,kind:'uploaded',path:null,inline:part.imageError?null:{mime:part.mimeType,itemId:item.id,slot:ref,revision:part.revision||0},status:part.imageError?'failed':'done',caption:'',reason:part.imageError||'',name:`图片 ${index+1}`}];
    return [{key:`${item.id}:upload:${index}`,kind:'uploaded',path:null,status:'failed',caption:'',reason:'此图片没有可预览的本地内容',name:`图片 ${index+1}`}];
  });
  if(item.type==='dynamicToolCall')return (item.contentItems||[]).flatMap((part,index)=>part?.type==='inputImage'?[toolImageCandidate(item,part,index,'dynamic')]:[]);
  if(item.type==='functionCallOutput'&&Array.isArray(item.output))return item.output.flatMap((part,index)=>part?.type==='input_image'?[toolImageCandidate(item,part,index,'function')]:[]);
  if (item.type === 'imageGeneration') {
    const failed = item.failure || ['failed', 'error'].includes(item.status);
    const path = typeof item.savedPath === 'string' && item.savedPath ? item.savedPath : null;
    const mime=rasterBase64Mime(item.result),ref=Number.isInteger(item.imageRef)?item.imageRef:null;
    const imageError=item.imageError||(mime?(item.result.length>INLINE_MAX_BASE64?'图片数据超过 6 MiB':!/^[A-Za-z0-9+/]+={0,2}$/.test(item.result)?'图片数据不是有效 base64':''):'');
    const inline=!path&&!imageError&&(ref!==null||mime)?{mime:item.mimeType||mime,data:ref===null?item.result:null,itemId:item.id,slot:ref,revision:item.revision||0}:null;
    return [{ key: `${item.id}:gen:r${item.revision||0}`, kind: 'generated', path, inline, status: failed ? 'failed' : ['inProgress','in_progress','running'].includes(item.status) || item._complete === false ? 'running' : 'done',
      caption: typeof item.revisedPrompt === 'string' ? item.revisedPrompt.slice(0, 300) : '', reason: failed ? '生成失败' : path||inline ? '' : imageError||'生成结果没有提供本地保存路径' }];
  }
  if (item.type === 'imageView' && typeof item.path === 'string' && item.path) return [{ key: `${item.id}:view`, kind: 'viewed', path: item.path, status: 'done', caption: '', reason: '' }];
  if (item.type === 'mcpToolCall') {
    // 1) MCP image content blocks {type:'image', mimeType, data}: bounded raster bytes, decoded to a Blob.
    // 2) Explicit structured path fields. Prose and remote URLs are never treated as artifacts.
    const rows = [];
    const content = Array.isArray(item.result?.content) ? item.result.content : [];
    content.forEach((block, index) => {
      if (block?.type !== 'image' || rows.length >= 4) return;
      // ItemStore moves typed image bytes out of the text projection (block.imageRef); raw blocks
      // (tests / direct callers) may still carry `data`. Validation happens in both places.
      const mime = typeof block.mimeType === 'string' ? block.mimeType.toLowerCase() : '';
      const ref = Number.isInteger(block.imageRef) ? block.imageRef : null;
      const data = typeof block.data === 'string' ? block.data : '';
      const reason = block.imageError || (!INLINE_TYPES.has(mime) ? `不支持的图片类型 ${mime || '未知'}` : ref === null && !data ? '没有图片数据' : ref === null && data.length > INLINE_MAX_BASE64 ? '图片数据超过 6 MiB' : ref === null && !/^[A-Za-z0-9+/]+={0,2}$/.test(data) ? '图片数据不是有效 base64' : '');
      // The pool revision changes whenever the bytes for this slot change, so key and signature change too.
      const revision = Number.isInteger(block.revision) ? block.revision : 0;
      rows.push({ key: `${item.id}:content:${index}:r${revision}`, kind: 'tool', path: null, inline: reason ? null : { mime, data: ref === null ? data : null, itemId: item.id, slot: ref, revision }, status: reason ? 'failed' : 'done', caption: '', reason, name: `${item.tool || 'MCP'} 图片 ${index + 1}` });
    });
    const visit = (value, depth) => {
      if (depth > 3 || rows.length >= 4 || !value || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'string' && /^(path|savedPath|file|filePath|imagePath|output|outputPath)$/i.test(key) && PREVIEW_EXT.test(entry) && !isRemote(entry)) rows.push({ key: `${item.id}:mcp:${rows.length}`, kind: 'tool', path: entry, status: 'done', caption: '', reason: '' });
        else if (typeof entry === 'object') visit(entry, depth + 1);
      }
    };
    visit(item.result?.structuredContent, 0);
    return rows;
  }
  return [];
}

/** Local markdown image references `![alt](path)` with an explicit image extension. */
export function markdownImageRefs(text) {
  const rows = []; const pattern = /!\[([^\]\n]{0,200})\]\((<[^<>\n]+>|[^()\s\n]+)\)/g; let match;
  while ((match = pattern.exec(String(text || ''))) && rows.length < 6) {
    const path = match[2].replace(/^<|>$/g, '');
    if (!isRemote(path) && !/^data:/i.test(path) && PREVIEW_EXT.test(path.split(/[?#]/)[0])) rows.push({ path: path.split(/[?#]/)[0], alt: match[1] });
  }
  return rows;
}

const basename = path => String(path).split(/[\\/]/).filter(Boolean).at(-1) || String(path);

/**
 * Artifact strip with lazy, cached, cancellable previews.
 * `fetchPreview(path)` → `{blob,width,height}` or throws `{message}`.
 */
export function mountArtifacts({ document, fetchPreview, onOpen, ttlMs = 60000, resolveImage = () => null, getScope=()=>null }) {
  // Cache key = candidate key (item id + slot), so a new item writing the same path is read again.
  // Entries are reference-counted by live cards; unreferenced entries are revoked after ttlMs.
  const cache = new Map();
  const timers = new Map();
  const pending=[];let active=0;
  function pump(){while(active<3&&pending.length){const job=pending.shift();if(cache.get(job.key)!==job.entry){job.reject(new Error('预览已取消'));continue;}active++;Promise.resolve().then(job.run).then(job.resolve,job.reject).finally(()=>{active--;pump();});}}
  function enqueue(key,entry,run){return new Promise((resolve,reject)=>{pending.push({key,entry,run,resolve,reject});pump();});}
  function acquire(candidate) {
    const key = candidate.key;
    const scope=getScope();
    let entry = cache.get(key);
    clearTimeout(timers.get(key)); timers.delete(key);
    if (!entry) {
      entry = { state: 'loading', url: null, width: null, height: null, error: '', listeners: new Set(), refs: 0 };
      cache.set(key, entry);
      const source = candidate.inline ? Promise.resolve().then(() => {
        const stored = candidate.inline.data ? candidate.inline : resolveImage(candidate.inline.itemId, candidate.inline.slot);
        if (!stored?.data) throw new Error('图片数据已不在内存中（超过显示预算），请重新打开对话');
        if (!candidate.inline.data && candidate.inline.revision && stored.revision !== candidate.inline.revision) throw new Error('图片已被更新，正在刷新');
        return { blob: decodeBase64(stored.data, candidate.inline.mime), width: null, height: null };
      }) : enqueue(key,entry,() => fetchPreview(candidate.path,scope));
      source.then(result => {
        if (cache.get(key) !== entry) return;
        entry.url = URL.createObjectURL(result.blob); entry.width = result.width; entry.height = result.height; entry.state = 'ready';
      }, error => { if (cache.get(key) === entry) { entry.state = 'error'; entry.error = error?.message || '无法预览'; } })
        .finally(() => { for (const listener of [...entry.listeners]) listener(); });
    }
    entry.refs++;
    return entry;
  }
  function drop(key) { const entry = cache.get(key); if (!entry) return; if (entry.url) URL.revokeObjectURL(entry.url); cache.delete(key); clearTimeout(timers.get(key)); timers.delete(key); }
  function release(key, entry, listener) {
    entry.listeners.delete(listener); entry.refs = Math.max(0, entry.refs - 1);
    if (!entry.refs && cache.get(key) === entry) timers.set(key, setTimeout(() => drop(key), ttlMs));
  }
  function card(candidate) {
    const node = el(document, 'figure', 'artifact');
    node.dataset.kind = candidate.kind;
    const frame = el(document, 'button', 'artifact-frame'); frame.type = 'button';
    const caption = el(document, 'figcaption', 'artifact-caption');
    const title = candidate.name || (candidate.path ? basename(candidate.path) : '生成的图片');
    const name = el(document, 'span', 'artifact-name', title);
    const meta = el(document, 'span', 'artifact-meta');
    caption.append(name, meta);
    node.append(frame, caption);
    if (candidate.path) node.title = candidate.path;
    const previewable = (candidate.path || candidate.inline) && candidate.status === 'done';
    const entry = previewable ? acquire(candidate) : null;
    const paint = () => {
      frame.replaceChildren(); frame.disabled = true; node.dataset.state = candidate.status;
      if (candidate.status === 'running') { frame.append(icon(document, 'image', { size: 20 })); meta.textContent = '正在生成…'; return; }
      if (!entry) { frame.append(icon(document, 'image', { size: 20 })); meta.textContent = candidate.reason || '无法预览'; node.dataset.state = 'unavailable'; return; }
      if (entry.state === 'loading') { frame.append(el(document, 'span', 'artifact-spinner')); meta.textContent = '读取预览…'; return; }
      if (entry.state === 'error') { frame.append(icon(document, 'image', { size: 20 })); meta.textContent = entry.error; node.dataset.state = 'unavailable'; return; }
      const img = el(document, 'img'); img.alt = candidate.caption || title; img.src = entry.url; img.decoding = 'async'; img.draggable = false;
      img.addEventListener('load', () => { if (!entry.width && img.naturalWidth) { entry.width = img.naturalWidth; entry.height = img.naturalHeight; meta.textContent = `${entry.width}×${entry.height}`; } });
      img.addEventListener('error', () => { frame.replaceChildren(icon(document, 'image', { size: 20 })); meta.textContent = '浏览器无法解码此图片'; node.dataset.state = 'unavailable'; frame.disabled = true; });
      frame.append(img); frame.disabled = false; node.dataset.state = 'ready';
      frame.setAttribute('aria-label', '放大查看 ' + title);
      meta.textContent = entry.width && entry.height ? `${entry.width}×${entry.height}` : '';
    };
    frame.addEventListener('click', () => { if (entry?.state === 'ready') onOpen({ url: entry.url, name: title, path: candidate.path || '', width: entry.width, height: entry.height, caption: candidate.caption }); });
    if (entry) entry.listeners.add(paint);
    node._release = () => { if (entry) release(candidate.key, entry, paint); node._release = null; };
    paint();
    return node;
  }
  function strip(candidates) {
    const node = el(document, 'div', 'artifact-strip');
    for (const candidate of candidates) node.append(card(candidate));
    node.release = () => { for (const child of node.children) child._release?.(); };
    return node;
  }
  /** Revokes every blob URL (thread switch / reset). */
  function clear() { for (const key of [...cache.keys()]) drop(key); }
  return { strip, clear, size: () => cache.size };
}

/** Full-size viewer. Escape/close return focus to the opener. */
export function mountLightbox(document) {
  const dialog=el(document,'dialog','lightbox');dialog.setAttribute('aria-label','图片预览');
  const bar=el(document,'div','lightbox-bar'),title=el(document,'strong','lightbox-title'),meta=el(document,'span','lightbox-meta');
  const controls=el(document,'div','lightbox-controls');
  function button(label,action){const node=el(document,'button','btn ghost small',label);node.type='button';node.addEventListener('click',action);controls.append(node);return node;}
  let opener=null,image=null,scale=1,fit=true;
  button('−',()=>zoom(scale/1.25)).setAttribute('aria-label','缩小图片');
  const percent=el(document,'output','lightbox-zoom');controls.append(percent);
  button('+',()=>zoom(scale*1.25)).setAttribute('aria-label','放大图片');
  const fitButton=button('适应',()=>{fit=true;paint();});
  const actual=button('原尺寸',()=>{fit=false;scale=1;paint();});
  const imageButtons=[...controls.querySelectorAll('button')];
  const close=button('关闭',()=>dialog.close());close.setAttribute('aria-label','关闭预览');
  const stage=el(document,'div','lightbox-stage'),canvas=el(document,'div','lightbox-canvas');
  stage.tabIndex=0;stage.setAttribute('aria-label','图片，可滚动查看');stage.append(canvas);
  const caption=el(document,'p','lightbox-caption');bar.append(title,meta,controls);dialog.append(bar,stage,caption);document.body.append(dialog);
  function paint(){
    if(!image?.naturalWidth)return;
    for(const button of imageButtons)button.disabled=false;
    if(fit)scale=Math.min(1,Math.max(.01,(stage.clientWidth-32)/image.naturalWidth),Math.max(.01,(stage.clientHeight-32)/image.naturalHeight));
    image.style.width=Math.round(image.naturalWidth*scale)+'px';image.style.height=Math.round(image.naturalHeight*scale)+'px';
    percent.textContent=Math.round(scale*100)+'%';meta.textContent=image.naturalWidth+' × '+image.naturalHeight;
    fitButton.setAttribute('aria-pressed',String(fit));actual.setAttribute('aria-pressed',String(!fit&&scale===1));
  }
  function zoom(value){if(!image?.naturalWidth)return;fit=false;scale=Math.max(.01,Math.min(8,value));paint();}
  window.addEventListener('resize',()=>{if(dialog.open&&fit)paint();});
  dialog.addEventListener('click',event=>{if([dialog,stage,canvas].includes(event.target))dialog.close();});
  dialog.addEventListener('close',()=>{canvas.replaceChildren();image=null;opener?.isConnected&&opener.focus?.();opener=null;});
  dialog.addEventListener('keydown',event=>{if(event.key==='+'||event.key==='='){event.preventDefault();zoom(scale*1.25);}if(event.key==='-'){event.preventDefault();zoom(scale/1.25);}});
  return {open({url,name='',path='',caption:text}){
    if(!/^(blob:|data:image\/(png|jpeg|webp|gif);base64,)/i.test(url||''))return;
    if(!dialog.open)opener=document.activeElement;
    title.textContent=name||'图片';title.title=path||name;meta.textContent='';percent.textContent='';fit=true;scale=1;
    for(const button of imageButtons)button.disabled=true;
    const opened=el(document,'img');image=opened;image.alt=text||name||'图片';image.draggable=false;image.addEventListener('load',paint);
    image.addEventListener('error',()=>{if(image!==opened)return;image=null;percent.textContent='';for(const button of imageButtons)button.disabled=true;const error=el(document,'p','inline-error','无法读取此图片，文件可能已失效或无法解码。');error.setAttribute('role','status');canvas.replaceChildren(error);});
    image.src=url;canvas.replaceChildren(image);
    caption.textContent=text||'';caption.hidden=!text;if(!dialog.open)dialog.showModal();stage.scrollTop=0;stage.scrollLeft=0;paint();close.focus();
  }};
}
