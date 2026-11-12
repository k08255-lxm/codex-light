export const MAX_ITEMS = 100;
/** Display bound for secondary strings (tool payload fields, labels). Message bodies are not bound by it. */
export const MAX_TEXT = 32768;
/**
 * Message bodies (agent/user text, command output) are kept in full, in UTF-16 code units.
 * - perField: one body beyond this keeps its first `head` units and its latest tail, with an explicit
 *   in-text marker stating how much of the middle was not retained (the tail keeps following deltas).
 * - total: when all retained bodies in the window exceed this, the oldest completed bodies are released
 *   to their first `releasedKeep` units plus an explicit marker; re-opening the conversation re-reads them.
 */
export const TEXT_LIMITS = Object.freeze({ perField: 4 * 1024 * 1024, head: 1024 * 1024, slack: 512 * 1024, total: 24 * 1024 * 1024, releasedKeep: 32768 });
// Typed MCP image bytes are kept outside the text projection, with their own budget.
export const IMAGE_LIMITS = Object.freeze({ perImageBase64: Math.ceil(6 * 1024 * 1024 / 3) * 4, totalBase64: 24 * 1024 * 1024, perItem: 4 });
const RASTER = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export function boundedText(value, limit = MAX_TEXT) {
  const s = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return s.length > limit ? s.slice(0, limit) + '\n…〔界面显示已截断；完整内容由 Codex 保存〕' : s;
}
export function itemText(item) {
  if (item.type === 'plan') return [item.text, ...(Array.isArray(item.content) ? item.content.map(step => `${step.status || ''} ${step.step || ''}`) : [])].filter(Boolean).join('\n');
  if (item.type === 'userMessage') return (item.content || []).map(c => c.text ?? (['image','localImage'].includes(c.type) ? '[图片]' : '')).join('\n');
  return item.text ?? item.aggregatedOutput ?? item.output ?? item.result ?? item.summary ?? item.content ?? '';
}
// Preserve only a bounded display snapshot, never unbounded nested tool payloads.
export function displaySnapshot(value) {
  const budget = { nodes: 300, chars: 65536 };
  function visit(v, depth) {
    if (--budget.nodes < 0 || depth > 6) return '[显示摘要已截断]';
    if (typeof v === 'string') { const n = Math.min(MAX_TEXT, Math.max(0, budget.chars)); budget.chars -= Math.min(v.length, n); return boundedText(v, n); }
    if (!v || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.slice(0, 50).map(x => visit(x, depth + 1));
    return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, visit(x, depth + 1)]));
  }
  return visit(value, 0);
}

// ---------- Full message bodies ----------

/** The marker placed where an over-long body's middle was not retained. Its length is fixed. */
export const OMITTED_MARKER = '\n\n…〔此条正文超过界面单条保留上限，中间部分未保留；开头与最新结尾均已保留，完整内容由 Codex 保存〕…\n\n';
const RELEASED_MARKER = length => `\n\n…〔为控制界面内存，此条较早正文的其余部分已从当前窗口释放（原 ${length} 字符）。重新打开对话可再次读取完整内容〕`;
const isLow = code => code >= 0xdc00 && code <= 0xdfff;
/** Index adjusted so a cut never separates a surrogate pair. */
function safeCut(text, index) { return index > 0 && index < text.length && isLow(text.charCodeAt(index)) ? index - 1 : index; }
/**
 * Fits one body into the per-field limit. `omitted` is the count already dropped from a value that
 * still carries the marker (streaming append); a fresh full value carries no marker and starts at 0.
 */
export function retainBody(value, omitted = 0) {
  const text = typeof value === 'string' ? value : '';
  const { perField, head } = TEXT_LIMITS;
  // The head cut may have moved back one unit to keep a surrogate pair whole.
  const marker = omitted > 0 ? [head, head - 1].find(at => text.startsWith(OMITTED_MARKER, at)) ?? -1 : -1;
  // Streaming appends may grow `slack` beyond the limit before the next trim, so a 4 MiB body is not
  // re-copied on every delta.
  if (text.length <= perField + (marker >= 0 ? TEXT_LIMITS.slack : 0)) return { text, omitted: marker >= 0 ? omitted : 0 };
  const headEnd = marker >= 0 ? marker : safeCut(text, head);
  const bodyStart = marker >= 0 ? marker + OMITTED_MARKER.length : headEnd;
  const keep = perField - head - OMITTED_MARKER.length;
  const tailStart = Math.max(bodyStart, safeCut(text, text.length - keep));
  return { text: text.slice(0, headEnd) + OMITTED_MARKER + text.slice(tailStart), omitted: (marker >= 0 ? omitted : 0) + (tailStart - bodyStart) };
}
const BODY_FIELDS = ['text', 'aggregatedOutput'];
/** Body strings of an item: [{key, text}] where key is a field name or `content.N`. */
function bodies(item) {
  const rows = [];
  for (const field of BODY_FIELDS) if (typeof item[field] === 'string') rows.push({ key: field, text: item[field] });
  if (item.type === 'userMessage' && Array.isArray(item.content)) item.content.forEach((part, index) => { if (typeof part?.text === 'string') rows.push({ key: 'content.' + index, text: part.text }); });
  return rows;
}
const bodySize = item => bodies(item).reduce((sum, row) => sum + row.text.length, 0);

/**
 * Extracts typed MCP image blocks ({type:'image', mimeType, data}) out of an item before it is projected
 * for display. Returns the item with each block's `data` replaced by a short reference and the extracted
 * images. Oversized, non-raster or malformed blocks keep a reason instead of their bytes.
 */
export function extractImageContent(item) {
  const content = item?.type === 'mcpToolCall' && Array.isArray(item.result?.content) ? item.result.content : null;
  // `replaces`: the item carries a complete result, so any previously pooled images are superseded.
  if (!content) return { item, images: [], replaces: item?.type === 'mcpToolCall' && item.result !== undefined };
  const images = []; let index = 0;
  const blocks = content.map(block => {
    if (block?.type !== 'image') return block;
    // Already-projected references (re-upserting a stored snapshot) pass through unchanged.
    if (Number.isInteger(block.imageRef) && block.data === undefined) return block;
    const slot = index++;
    const mime = typeof block.mimeType === 'string' ? block.mimeType.toLowerCase() : '';
    const data = typeof block.data === 'string' ? block.data : '';
    const reason = slot >= IMAGE_LIMITS.perItem ? '图片数量超过显示上限' : !RASTER.has(mime) ? `不支持的图片类型 ${mime || '未知'}` : !data ? '没有图片数据' : data.length > IMAGE_LIMITS.perImageBase64 ? '图片数据超过 6 MiB' : !/^[A-Za-z0-9+/]+={0,2}$/.test(data) ? '图片数据不是有效 base64' : '';
    if (!reason) images.push({ slot, mime, data });
    return { type: 'image', mimeType: mime, imageRef: slot, ...(reason ? { imageError: reason } : {}), bytes: Math.floor(data.length * 3 / 4) };
  });
  // A stored snapshot being re-upserted carries only image references: not a replacement.
  // Any other complete result (including one without images) supersedes the pooled images.
  const imageBlocks = content.filter(block => block?.type === 'image');
  const projectedOnly = imageBlocks.length > 0 && imageBlocks.every(block => Number.isInteger(block.imageRef) && block.data === undefined);
  return { item: { ...item, result: { ...item.result, content: blocks } }, images, replaces: !projectedOnly };
}
let imageRevision = 0;
export class ItemStore {
  constructor(limit = MAX_ITEMS) { this.limit = limit; this.items = new Map(); this.dirty = new Set(); this.trimmed = false; this.images = new Map(); this.imageChars = 0; this.textChars = 0; this.textSizes = new Map(); }
  clear() { this.items.clear(); this.dirty.clear(); this.trimmed = false; this.images.clear(); this.imageChars = 0; this.textChars = 0; this.textSizes.clear(); }
  /** `{mime, data, revision}` for an extracted image, or null. */
  image(itemId, slot) { return this.images.get(itemId)?.get(slot) || null; }
  dropImages(id) { const rows = this.images.get(id); if (!rows) return; for (const row of rows.values()) this.imageChars -= row.data.length; this.images.delete(id); }
  /**
   * Replaces an item's pooled images. Older items are evicted first; if the item alone still exceeds
   * the total budget, its later images are refused (they render a budget error instead of bytes).
   * Returns the set of accepted slots.
   */
  keepImages(id, images) {
    this.dropImages(id);
    const accepted = new Map();
    for (const image of images) {
      while (this.imageChars + image.data.length > IMAGE_LIMITS.totalBase64) {
        const oldest = [...this.images.keys()].find(key => key !== id);
        if (oldest === undefined) break;
        this.dropImages(oldest);
      }
      if (this.imageChars + image.data.length > IMAGE_LIMITS.totalBase64) continue;
      accepted.set(image.slot, { mime: image.mime, data: image.data, revision: ++imageRevision });
      this.imageChars += image.data.length;
    }
    if (accepted.size) this.images.set(id, accepted);
    return accepted;
  }
  setTextSize(id, size) { this.textChars += size - (this.textSizes.get(id) || 0); if (size) this.textSizes.set(id, size); else this.textSizes.delete(id); }
  forget(id) { this.items.delete(id); this.dirty.delete(id); this.dropImages(id); this.setTextSize(id, 0); }
  /**
   * Keeps the window's retained bodies under TEXT_LIMITS.total by releasing the oldest completed bodies
   * (never the item just updated, never a streaming one). Released text says so explicitly.
   */
  releaseBodies(currentId) {
    for (const [id, size] of this.textSizes) {
      if (this.textChars <= TEXT_LIMITS.total) return;
      const item = this.items.get(id);
      if (id === currentId || !item || item._complete === false || size <= TEXT_LIMITS.releasedKeep) continue;
      const next = { ...item };
      const omitted = { ...(item._omitted || {}) }; const released = { ...(item._released || {}) };
      for (const row of bodies(item)) {
        if (row.text.length <= TEXT_LIMITS.releasedKeep) continue;
        // Original length as received: retained text minus the omission marker plus what it replaced.
        const original = omitted[row.key] ? row.text.length - OMITTED_MARKER.length + omitted[row.key] : row.text.length;
        const text = row.text.slice(0, safeCut(row.text, TEXT_LIMITS.releasedKeep)) + RELEASED_MARKER(original);
        if (row.key.startsWith('content.')) { const index = Number(row.key.slice(8)); next.content = next.content.map((part, n) => n === index ? { ...part, text } : part); }
        else next[row.key] = text;
        released[row.key] = original; delete omitted[row.key];
      }
      if (Object.keys(omitted).length) next._omitted = omitted; else delete next._omitted;
      next._released = released; next._bodyReleased = true;
      this.items.set(id, next); this.dirty.add(id); this.setTextSize(id, bodySize(next));
    }
  }
  upsert(item, { append = null } = {}) {
    if (!item?.id) return;
    const extracted = extractImageContent(item);
    let next = extracted.item;
    if (extracted.replaces) {
      const accepted = this.keepImages(item.id, extracted.images);
      if (Array.isArray(next.result?.content))
      // Record pool revision (changes when the bytes change) and budget refusals in the projection.
      next = { ...next, result: { ...next.result, content: next.result.content.map(block => {
        if (block?.type !== 'image' || block.imageError || !Number.isInteger(block.imageRef)) return block;
        const pooled = accepted.get(block.imageRef);
        return pooled ? { ...block, revision: pooled.revision } : { ...block, imageError: '图片超过显示内存预算' };
      }) } };
    }
    const previous = this.items.get(item.id) || {};
    const combined = { ...previous, ...next };
    // Message bodies bypass the bounded display snapshot; everything else stays a bounded projection.
    const body = {};
    for (const field of BODY_FIELDS) if (typeof combined[field] === 'string') { body[field] = combined[field]; delete combined[field]; }
    const userContent = combined.type === 'userMessage' && Array.isArray(combined.content) ? combined.content.slice(0, 64) : null;
    if (userContent) delete combined.content;
    const merged = displaySnapshot(combined);
    for (const key of ['output', 'result', 'summary', 'content']) if (typeof merged[key] === 'string') merged[key] = boundedText(merged[key]);
    const omitted = {};
    // A re-upserted stored projection (window rebuild) carries its own omission/release records.
    const known = this.items.has(item.id);
    const carriedMap = previous._omitted || (known ? {} : item._omitted) || {};
    const carriedReleased = (known ? previous._released : item._released) || {};
    const released = {};
    const fit = (key, text) => {
      // An unchanged stored value keeps its record; an append continues it; any other value starts fresh
      // (retainBody only continues a record when the marker is still in place).
      const carried = carriedMap[key] || 0;
      const same = !known || (key.startsWith('content.') ? previous.content?.[Number(key.slice(8))]?.text === text : previous[key] === text);
      const result = retainBody(text, same || append === key ? carried : 0);
      if (result.omitted) omitted[key] = result.omitted; else delete omitted[key];
      // A released body stays marked only while it is still exactly the released projection.
      if (same && append !== key && carriedReleased[key]) released[key] = carriedReleased[key];
      return result.text;
    };
    for (const [field, text] of Object.entries(body)) merged[field] = fit(field, text);
    if (userContent) merged.content = userContent.map((part, index) => {
      if (!part || typeof part !== 'object') return part;
      const { text, ...rest } = part;
      const projected = displaySnapshot(rest);
      return typeof text === 'string' ? { ...projected, text: fit('content.' + index, text) } : projected;
    });
    if (Object.keys(omitted).length) merged._omitted = omitted; else delete merged._omitted;
    if (Object.keys(released).length) { merged._released = released; merged._bodyReleased = true; }
    else { delete merged._released; delete merged._bodyReleased; }
    this.items.set(item.id, merged); this.dirty.add(item.id); this.setTextSize(item.id, bodySize(merged));
    while (this.items.size > this.limit) { this.forget(this.items.keys().next().value); this.trimmed = true; }
    if (this.textChars > TEXT_LIMITS.total) this.releaseBodies(item.id);
  }
  /** Removes one item from the window (e.g. a local echo replaced by the server copy). */
  delete(id) { this.forget(id); }
  /**
   * Replaces the window with `items` (chronological, already deduplicated and trimmed by the caller),
   * keeping the pooled images of items that remain. Used when older history is prepended.
   */
  replaceWindow(items) {
    const keep = new Set(items.map(item => item.id));
    for (const id of [...this.images.keys()]) if (!keep.has(id)) this.dropImages(id);
    this.items.clear(); this.dirty.clear(); this.textSizes.clear(); this.textChars = 0;
    for (const item of items) this.upsert(item);
  }
  /** Appends a streaming delta to a body field; the latest tail is always retained. */
  delta(id, delta, type = 'agentMessage', field = 'text') {
    if (!id || !delta) return;
    const item = this.items.get(id) || { id, type };
    const current = typeof item[field] === 'string' ? item[field] : '';
    this.upsert({ ...item, [field]: current + delta, _complete: false }, { append: field });
  }
  values() { return [...this.items.values()]; }
}
