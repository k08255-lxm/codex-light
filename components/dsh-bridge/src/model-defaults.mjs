import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const filename = 'subagent-model.json';
const reminderFile = 'subagent-model-reminder-seen';
const invalid = () => Object.assign(new Error('请填写有效的模型 ID 和提供商 ID。'), {code:'INVALID_INPUT',status:400});
const unreadable = () => Object.assign(new Error('无法读取已保存的子代理默认模型。'), {code:'DSH_MODEL_CONFIG_INVALID',status:409});
export const builtinProvider = 'deepseek-official';
export const builtinModel = 'deepseek-flash';
const validModel = value => typeof value === 'string' && /^[\w][\w.+:/-]{0,254}$/.test(value) && !value.includes('://');
const validProvider = value => typeof value === 'string' && /^[\w][\w.-]{0,99}$/.test(value);

export function modelSelection(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['model','provider'].includes(key)) ||
      !validModel(value.model) || (value.provider !== undefined && !validProvider(value.provider))) throw invalid();
  return value.provider ? {model:value.model,provider:value.provider} : {model:value.model};
}

function catalogLabel(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : fallback;
}

export function modelChoices(providers, {includeBuiltin = true, catalog = {}} = {}) {
  const choices = [];
  function append(provider, label, models, overrides = {}) {
    if (!validProvider(provider)) return;
    const seen = new Set();
    for (const model of models) {
      if (!validModel(model?.id) || seen.has(model.id)) continue;
      seen.add(model.id);
      choices.push({provider, providerName:label, model:model.id, name:catalogLabel(overrides[model.id]?.name ?? model.name, model.id)});
    }
  }
  if (includeBuiltin) {
    append(builtinProvider, 'DeepSeek 官方', catalog.builtin ?? [{id:builtinModel}]);
  }
  for (const [provider, entry] of Object.entries(providers)) {
    if (includeBuiltin && provider === builtinProvider) continue;
    const declared = entry.models?.length > 0;
    append(provider, catalogLabel(entry.displayName, provider), declared ? entry.models : catalog.providers?.[provider] ?? [], declared ? {} : entry.modelOverrides);
  }
  return choices;
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
