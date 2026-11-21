import {isAbsoluteWorkingDirectory} from './security.mjs';

function invalid(message) {
  return Object.assign(new Error(message), {status:400, outcome:'notExecuted'});
}

export function createSkillsManagement(rpc, {wsl = false} = {}) {
  function absolute(value) {
    return typeof value === 'string' && value.length <= 8192 && !/[\0\r\n]/.test(value)
      && (isAbsoluteWorkingDirectory(value) || (wsl && value.startsWith('/')));
  }

  async function list(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['cwd','forceReload'].includes(key))
        || (input.cwd !== undefined && !absolute(input.cwd))
        || (input.forceReload !== undefined && typeof input.forceReload !== 'boolean')) {
      throw invalid('技能目录参数无效');
    }
    const result = await rpc.call('skills/list', {
      cwds: input.cwd ? [input.cwd] : [],
      forceReload: input.forceReload ?? false,
    });
    if (!Array.isArray(result?.data) || result.data.some(entry => !Array.isArray(entry?.skills))) {
      throw new Error('Codex 返回的技能目录无效');
    }
    return result;
  }

  async function setEnabled(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['cwd','path','enabled'].includes(key))
        || !absolute(input.path) || typeof input.enabled !== 'boolean') {
      throw invalid('技能开关参数无效');
    }
    // Codex writes a selector into its configuration. Only use a path the
    // active engine still reports for this project, including disabled skills.
    const catalog = await list({cwd:input.cwd, forceReload:true});
    if (!catalog.data.some(entry => entry.skills.some(skill => skill?.path === input.path))) {
      throw Object.assign(new Error('技能目录已变化，请刷新后重试'), {status:409,outcome:'notExecuted'});
    }
    const result = await rpc.call('skills/config/write', {path:input.path, enabled:input.enabled});
    if (typeof result?.effectiveEnabled !== 'boolean') {
      throw Object.assign(new Error('Codex 未返回生效状态，请刷新技能目录核对'), {outcome:'unknown'});
    }
    return {effectiveEnabled:result.effectiveEnabled};
  }
  return {list, setEnabled};
}
