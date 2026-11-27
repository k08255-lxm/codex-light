import {createHash} from 'node:crypto';
import {mkdir,open,readdir} from 'node:fs/promises';
import path from 'node:path';
import {plain} from './storage-maintenance.mjs';
import {validTaskId} from './mobile-task-routes.mjs';

// Each marker belongs to one identified async question. Separate immutable files
// let simultaneous desktop instances dismiss different cards without overwriting a list.
export class IgnoredQuestions {
  constructor(root, profile) {
    this.root=root && path.join(root,'ignored-questions');
    this.profile=profile;
    this.keys=new Set();
  }
  key(threadId,itemId) {
    if(!validTaskId(threadId)||!validTaskId(itemId))throw Object.assign(new Error('提问标识无效'),{status:400});
    return createHash('sha256').update(JSON.stringify([this.profile,threadId,itemId])).digest('hex');
  }
  async load() {
    if(!this.root)return;
    await plain(this.root);
    try {
      const files=await readdir(this.root,{withFileTypes:true});
      for(const file of files)if(file.isFile()&&/^[a-f0-9]{64}$/.test(file.name))this.keys.add(file.name);
    } catch(error){if(error.code!=='ENOENT')throw error;}
  }
  has(threadId,itemId) {return this.keys.has(this.key(threadId,itemId));}
  async ignore(threadId,itemId) {
    const key=this.key(threadId,itemId);
    if(this.keys.has(key))return;
    if(this.root){
      await plain(this.root);await mkdir(this.root,{recursive:true,mode:0o700});
      const file=path.join(this.root,key);await plain(file);
      try{const handle=await open(file,'wx',0o600);await handle.close();}
      catch(error){if(error.code!=='EEXIST')throw error;}
    }
    this.keys.add(key);
  }
}
