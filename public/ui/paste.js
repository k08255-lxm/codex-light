// Composer paste: turn a user's paste event into attachment candidates. Pure logic, no network.
// Only the event's own clipboardData is used; the live clipboard is never read.
export const PASTE_LIMIT = 5;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const IMAGE_BYTES = 10 * 1024 * 1024, FILE_BYTES = 20 * 1024 * 1024;

/** True for supported raster images, including an empty MIME with an allowed extension. */
export function isImageFile(file) { return IMAGE_TYPES.has(file.type) || (!file.type && IMAGE_EXT.test(file.name || '')); }

/**
 * Collects File objects from a paste event's DataTransfer. Must be called synchronously inside the
 * event handler (the browser revokes access afterwards). `items` is the primary source; `files` is
 * only a fallback when items expose no file — they usually describe the same files, while two real
 * files may legitimately share name/size/time, so metadata is not used to deduplicate.
 * String items (text/html with remote <img>) are ignored.
 */
export function pastedFiles(data) {
  const fromItems = [];
  for (const item of Array.from(data?.items || [])) if (item?.kind === 'file') { const file = item.getAsFile?.(); if (file && typeof file.size === 'number') fromItems.push(file); }
  if (fromItems.length) return fromItems;
  return Array.from(data?.files || []).filter(file => file && typeof file.size === 'number');
}

/**
 * Validates the whole batch before any upload. Returns `{images, files, errors}`;
 * `errors` non-empty means nothing is uploaded (no partial surprises).
 * Pasted screenshots without a name get a stable descriptive name.
 */
export function classifyPaste(files, existingCount, now = new Date()) {
  const images = [], others = [], errors = [];
  files.forEach((file, index) => {
    const name = file.name && file.name !== 'image.png' ? file.name : `粘贴的图片-${now.toISOString().slice(0, 19).replace(/[:T]/g, '')}${files.length > 1 ? '-' + (index + 1) : ''}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
    const label = String(file.name || name).slice(0, 120);
    if (!(file.size > 0)) { errors.push(`${label}：文件为空`); return; }
    if (isImageFile(file)) {
      if (file.size > IMAGE_BYTES) errors.push(`${label}：图片超过 10 MiB`);
      else images.push({ file, name });
    } else if (file.type.startsWith('image/')) errors.push(`${label}：不支持的图片格式 ${file.type}，请作为文件添加`);
    else if (file.size > FILE_BYTES) errors.push(`${label}：文件超过 20 MiB`);
    else others.push({ file, name: file.name || `粘贴的文件-${index + 1}` });
  });
  if (existingCount + images.length + others.length > PASTE_LIMIT) errors.unshift(`图片和文件合计最多 ${PASTE_LIMIT} 个（已有 ${existingCount} 个，粘贴 ${images.length + others.length} 个）`);
  return { images, files: others, errors };
}
