import {createHash, createHmac, randomBytes} from 'node:crypto';
import {extractImageContent} from '../public/store.js';
import {HistoryPager} from '../public/state.js';
import {inspectArtifact} from './artifacts.mjs';

const extensions = {'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/gif':'.gif'};
const digestOf = data => createHash('sha256').update(data, 'ascii').digest('hex').slice(0,32);
const invalid = (message, status = 404) => Object.assign(new Error(message), {status});
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\x00-\x1f]/.test(id);

// Only the history response is projected. Codex keeps the original. A signed locator binds
// the exact bytes to their account generation, thread, item and slot, even after cache eviction.
export class HistoryImages {
  constructor(readPage, {budget = 16 * 1024 * 1024} = {}) {
    this.readPage = readPage;
    this.budget = budget;
    this.clear();
  }
  clear() {
    this.secret = randomBytes(32);
    this.bytes = 0;
    this.cache = new Map();
    this.hints = new Map();
    this.pendingPages = new Map();
  }
  key(threadId, itemId, slot, digest) {
    const signature = createHmac('sha256', this.secret).update(JSON.stringify([threadId,itemId,slot,digest])).digest('hex');
    return digest + signature.slice(0,32);
  }
  remember(key, image) {
    if (this.cache.has(key)) {
      const cached = this.cache.get(key);
      this.cache.delete(key); this.cache.set(key,cached);
      return;
    }
    // Copy the encoded bytes so one small image cannot pin the entire original protocol line.
    if (image.data.length > this.budget) return;
    const entry = {data:Buffer.from(image.data, 'ascii'), mime:image.mime};
    this.cache.set(key,entry); this.bytes += entry.data.length;
    while (this.bytes > this.budget) {
      const oldest = this.cache.keys().next().value;
      this.bytes -= this.cache.get(oldest).data.length; this.cache.delete(oldest);
    }
  }
  project(method, params, response) {
    const receipt = {method,params};
    const projectItem = item => {
      if (!validId(item?.id)) return item;
      const extracted = extractImageContent(item);
      if (!extracted.images.length) return extracted.item;
      const handles = [];
      for (const image of extracted.images) {
        const key = this.key(params.threadId,item.id,image.slot,digestOf(image.data));
        handles[image.slot] = key;
        this.hints.delete(key); this.hints.set(key,receipt);
        if (this.hints.size > 8192) this.hints.delete(this.hints.keys().next().value);
        this.remember(key,image);
      }
      return {...extracted.item,_historyImages:handles};
    };
    const projectTurn = turn => Array.isArray(turn?.items) ? {...turn,items:turn.items.map(projectItem)} : turn;
    if (method === 'thread/items/list' && Array.isArray(response?.data))
      return {...response,data:response.data.map(row => row?.item ? {...row,item:projectItem(row.item)} : projectItem(row))};
    if (method === 'thread/turns/list' && Array.isArray(response?.data)) return {...response,data:response.data.map(projectTurn)};
    if (method === 'thread/read' && Array.isArray(response?.thread?.turns))
      return {...response,thread:{...response.thread,turns:response.thread.turns.map(projectTurn)}};
    return response;
  }
  async page(method,params) {
    const pages = this.pendingPages, id = JSON.stringify([method,params]);
    if (pages.has(id)) return pages.get(id);
    const pending = Promise.resolve().then(() => this.readPage(method,params));
    pages.set(id,pending);
    try {return await pending;} finally {pages.delete(id);}
  }
  async recover(threadId, itemId, slot, key) {
    const hint = this.hints.get(key);
    const secret = this.secret, deadline = Date.now()+25000;
    let item;
    if (hint) {
      try {
        const result = await this.page(hint.method,hint.params);
        if (hint.method === 'thread/items/list') item = result.data?.map(row => row.item || row).find(row => row.id === itemId);
        else for (const turn of result.thread?.turns || result.data || []) {
          item = turn.items?.find(row => row.id === itemId);
          if (item) break;
        }
      } catch (error) {
        if (error.code!=='HISTORY_PAGE_TOO_LARGE' && !/cursor|游标/i.test(error.message)) throw error;
      }
    }
    // The first page shifts as newer items arrive. Walk native cursors until the original item.
    if (!item) {
      const pager = new HistoryPager((method,params) => this.page(method,params),threadId);
      do {
        if (this.secret!==secret || Date.now()>deadline) throw invalid('历史已变化或读取超时，请重新打开对话。',409);
        const page = await pager.next({max:100,firstPaint:true});
        item = page.items.find(row => row.id === itemId);
      } while (!item && pager.hasMore);
    }
    const image = item && extractImageContent(item).images.find(image => image.slot === slot);
    if (!image || this.key(threadId,itemId,slot,digestOf(image.data)) !== key) throw invalid('这张历史图片已更新或不再可用，请重新打开对话。');
    this.remember(key,image);
    return image;
  }
  async read(input) {
    const {threadId,historyImage} = input;
    if (!validId(threadId) || Object.keys(input).length !== 2 || !historyImage || typeof historyImage !== 'object' ||
        Object.keys(historyImage).length !== 3) throw invalid('历史图片参数无效',400);
    const {itemId,slot,key} = historyImage;
    if (!validId(itemId) || !Number.isInteger(slot) || slot<0 || slot>4 || typeof key!=='string' ||
        !/^[a-f0-9]{64}$/.test(key) || this.key(threadId,itemId,slot,key.slice(0,32)) !== key) throw invalid('历史图片引用已失效，请重新打开对话。');
    let image = this.cache.get(key);
    if (image) {this.cache.delete(key);this.cache.set(key,image);}
    else image = await this.recover(threadId,itemId,slot,key);
    const bytes = Buffer.from(typeof image.data === 'string' ? image.data : image.data.toString('ascii'),'base64');
    return {bytes,...inspectArtifact(bytes,extensions[image.mime])};
  }
}
