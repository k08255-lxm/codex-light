import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const filename = 'subagent-model.json';
const reminderFile = 'subagent-model-reminder-seen';
const invalid = () => Object.assign(new Error('请填写有效的模型 ID 和提供商 ID。'), {code:'INVALID_INPUT',status:400});
const unreadable = () => Object.assign(new Error('无法读取已保存的子代理默认模型。'), {code:'DSH_MODEL_CONFIG_INVALID',status:409});

export function modelSelection(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['model','provider'].includes(key)) ||
      typeof value.model !== 'string' || !/^[\w][\w.+:/-]{0,254}$/.test(value.model) ||
      value.model.includes('://') || (value.provider !== undefined &&
      (typeof value.provider !== 'string' || !/^[\w][\w.-]{0,99}$/.test(value.provider)))) throw invalid();
  return value.provider ? {model:value.model,provider:value.provider} : {model:value.model};
}

export function readModelDefaults(dir) {
  const file = path.join(dir, filename);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return {acknowledged:fs.existsSync(path.join(dir,reminderFile)),selection:null}; throw error; }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2048) throw unreadable();
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== 1 || value.acknowledged !== true) throw unreadable();
    return {acknowledged:true,selection:modelSelection(value.selection)};
  } catch { throw unreadable(); }
}

export function dismissModelReminder(dir) {
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  try { fs.writeFileSync(path.join(dir,reminderFile),'',{flag:'wx',mode:0o600}); }
  catch (error) { if(error.code !== 'EEXIST') throw error; }
}

export function saveModelDefaults(dir, value) {
  const result = {acknowledged:true,selection:modelSelection(value)};
  fs.mkdirSync(dir, {recursive:true,mode:0o700});
  const file = path.join(dir, filename);
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify({version:1,...result}) + '\n', {flag:'wx',mode:0o600});
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, {force:true}); }
  return result;
}

// Apply at the MCP boundary so a daemon already serving other sessions can stay live.
export function applyModelDefaults(message, dir) {
  if (message.method !== 'tools/call' || message.params?.name !== 'dsh_start') return message;
  const args = message.params.arguments;
  if (!args || (args.provider !== undefined && args.model !== undefined)) return message;
  const {selection} = readModelDefaults(dir);
  if (!selection || (args.provider !== undefined && args.provider !== selection.provider)) return message;
  return {...message,params:{...message.params,arguments:{...selection,...args}}};
}
