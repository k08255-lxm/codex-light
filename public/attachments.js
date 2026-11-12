export const IMAGE_LIMITS = Object.freeze({ count: 5, bytes: 10 * 1024 * 1024 });
const TYPES = new Set(['image/png','image/jpeg','image/webp','image/gif']);
export function validateImageSelection(files, existing = 0) {
  if (existing + files.length > IMAGE_LIMITS.count) throw new Error('每次最多附带 5 张图片。请减少选择后重试。');
  for (const file of files) {
    if (!Number.isFinite(file.size) || file.size <= 0 || file.size > IMAGE_LIMITS.bytes) throw new Error(`${String(file.name).slice(0,160)}：图片须大于 0 且不超过 10 MiB。`);
    if (!TYPES.has(file.type) && !(file.type === '' && /\.(png|jpe?g|webp|gif)$/i.test(file.name))) throw new Error(`${String(file.name).slice(0,160)}：只支持 PNG、JPEG、WebP、GIF 图片。`);
  }
}
export class AttachmentDraft {
  constructor() { this.records = new Map(); }
  add(record) {
    if (!record || typeof record.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(record.id) || !TYPES.has(record.mime) || !Number.isFinite(record.size) || record.size <= 0 || record.size > IMAGE_LIMITS.bytes) throw new Error('本地附件服务返回了无效的图片信息。');
    if (this.records.size >= IMAGE_LIMITS.count && !this.records.has(record.id)) throw new Error('每次最多附带 5 张图片。');
    this.records.set(record.id, { id: record.id, name: String(record.name || '图片').slice(0,160), size: record.size, mime: record.mime });
  }
  remove(id) { this.records.delete(id); }
  values() { return [...this.records.values()].map(record => ({ ...record })); }
  ids() { return [...this.records.keys()]; }
}

export function validateFileSelection(files, existing = 0) {
  if (existing + files.length > 5) throw new Error('图片和文件每次合计最多 5 个。');
  for (const file of files) if (!Number.isFinite(file.size) || file.size <= 0 || file.size > 20 * 1024 * 1024) throw new Error(`${String(file.name).slice(0,160)}：文件须大于 0 且不超过 20 MiB。`);
}
export class FileAttachmentDraft {
  constructor() { this.records = new Map(); }
  add(record) {
    if (!record || typeof record.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(record.id) || typeof record.riskWarning !== 'boolean' || !Number.isFinite(record.size) || record.size <= 0 || record.size > 20 * 1024 * 1024) throw new Error('本地附件服务返回了无效的文件信息。');
    if (this.records.size >= 5 && !this.records.has(record.id)) throw new Error('每次最多附带 5 个文件。');
    this.records.set(record.id, { id:record.id, name:String(record.name || '文件').slice(0,160),size:record.size,mime:String(record.mime || '').slice(0,128),category:String(record.category || 'unknown').slice(0,32),riskWarning:record.riskWarning,warning:String(record.warning || '').slice(0,1000) });
  }
  remove(id) { this.records.delete(id); }
  values() { return [...this.records.values()].map(record=>({...record})); }
  ids() { return [...this.records.keys()]; }
}
