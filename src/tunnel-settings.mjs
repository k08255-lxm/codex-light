import {randomUUID} from 'node:crypto';
import {mkdir, open, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tunnelEndpoint} from './lan-access.mjs';
import {plain} from './storage-maintenance.mjs';

function validate(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'port,provider,publicOrigin,randomPorts' ||
      !['ssh','frp','cloudflare'].includes(value.provider) || typeof value.randomPorts !== 'boolean') {
    throw new Error('公网配置参数无效。');
  }
  const {publicOrigin, port} = tunnelEndpoint({publicOrigin:value.publicOrigin, port:value.port});
  return {publicOrigin, port, provider:value.provider, randomPorts:value.randomPorts};
}

// Editable settings stay separate from the encrypted capability of the active endpoint.
export class TunnelSettings {
  constructor(directory) {
    this.file = path.join(directory, 'tunnel-settings.json');
  }
  async read() {
    let handle;
    try {
      await plain(this.file);
      handle = await open(this.file, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096) throw new Error();
      return validate(JSON.parse(await handle.readFile('utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('无法读取已保存的公网配置，请检查用户数据目录。', {cause:error});
    } finally {
      await handle?.close();
    }
  }
  async save(input) {
    const settings = validate(input);
    await plain(this.file);
    await mkdir(path.dirname(this.file), {recursive:true, mode:0o700});
    const temp = this.file + '.' + randomUUID();
    try {
      await writeFile(temp, JSON.stringify(settings), {flag:'wx', mode:0o600});
      await rename(temp, this.file);
    } finally {
      await rm(temp, {force:true});
    }
    return settings;
  }
}
