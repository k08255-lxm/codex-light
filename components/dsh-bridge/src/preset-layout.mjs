import {createRequire} from 'node:module';

const legacy = '@deepseek-ai/dsh-agent-presets';
const split = ['@deepseek-ai/dsh-agent-preset', '@deepseek-ai/dsh-agent-preset-registry'];

// Resolve from the actual executable's dependency tree, not the bridge's.
// A partially installed split layout cannot replace a complete legacy layout.
export function resolvePresetLayout(cli, requireFn = createRequire(cli)) {
  const resolves = name => {
    try {requireFn.resolve(name); return true;}
    catch (error) {
      if (['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) return false;
      throw error;
    }
  };
  if (split.every(resolves)) return 'split';
  if (resolves(legacy)) return 'legacy';
  throw Object.assign(new Error('DSH is missing a complete agent preset installation. Install both dsh-agent-preset and dsh-agent-preset-registry, or use a version with dsh-agent-presets.'), {code: 'DSH_PRESETS_UNAVAILABLE'});
}
