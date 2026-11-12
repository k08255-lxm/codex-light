import {existsSync,realpathSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {locations, installation} from './platform.mjs';
import {commandSpec} from './commands.mjs';
import {desktopCli} from './runtime-launch.mjs';
import {ProviderSources} from './provider-sources.mjs';

// DeepSeek rejects a request when prompt plus reserved completion exceeds its
// window. DSH compacts at a fraction of the window without that reservation, so
// its 256k default completion budget let prompts fail below the threshold.
export const CONTEXT_WINDOW_TOKENS=1048576;
export const MAX_OUTPUT_TOKENS=128000;
export const contextLimitTokens=provider=>provider==='deepseek-official'?CONTEXT_WINDOW_TOKENS-MAX_OUTPUT_TOKENS:undefined;
export const projectRoot=dirname(dirname(fileURLToPath(import.meta.url)));
export const stateDirectory=()=>locations().state;
export function resolveDshCli() {
  if (process.env.DSH_DESKTOP_EXECUTABLE) {
    return desktopCli(realpathSync(process.env.DSH_DESKTOP_EXECUTABLE));
  }
  const explicit = process.env.DSH_CLI || installation()?.dsh;
  if (explicit) return realpathSync(explicit);
  const spec = commandSpec('dsh', {prefix: join(locations().data, 'dependencies')});
  return realpathSync(spec.at(-1));
}
export function runtimeConfig(state=stateDirectory(),cli=resolveDshCli()) {
  mkdirSync(state,{recursive:true,mode:0o700});
  const patch=join(state,'bridge.patch.yml');
  const legacyPatch=join(state,'bridge-legacy.patch.yml');
  if (process.env.DSH_DESKTOP_EXECUTABLE) {
    const shared = `- id: sdk-jsonrpc-server
  disabled: true
- id: llm-deepseek
  config:
    maxTokens: ${MAX_OUTPUT_TOKENS}
- id: schedule
  disabled: true
- id: tool-schedule
  disabled: true
- insert:
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
    - id: subagent-model-selection-settings
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
    - id: codex-subagent-rpc
      name: ${JSON.stringify(join(projectRoot,'src/dsh-plugin.mjs'))}
`;
    const presets = readFileSync(join(projectRoot,'assets/desktop-0.2/presets.patch.yml'),'utf8');
    // Provider files are read at each NEW runtime boundary, never hot-reloaded into live tasks.
    const providerSources=new ProviderSources({configDir:locations().config,stateDir:state,home:process.env.DSH_HOME,sourcePath:process.env.DSH_DESKTOP_PROVIDER_CONFIG,cli});
    writeFileSync(patch,presets+shared,{mode:0o600});
    writeFileSync(legacyPatch,presets+shared,{mode:0o600});
    return {database:join(state,'state.sqlite'),cli,patch,legacyPatch,providerSources,profile:process.env.DSH_BRIDGE_PROFILE||'codex-light-bridge',
        revalidateParents:true,
        defaultProvider:process.env.DSH_DEFAULT_PROVIDER,defaultModel:process.env.DSH_DEFAULT_MODEL,
        defaultEffort:process.env.DSH_DEFAULT_EFFORT,
        workspaceIsolation:'shared',isolationRoot:join(state,'workspaces')};
  }
  const shared=`- id: sdk-jsonrpc-server
  disabled: true
- id: llm-deepseek
  config:
    maxTokens: ${MAX_OUTPUT_TOKENS}
- insert:
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: standard
    - id: subagent-model-selection-settings
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
    - id: codex-subagent-rpc
      name: ${JSON.stringify(join(projectRoot,'src/dsh-plugin.mjs'))}
`;
  // As in DSH's Web composition, presets own the agent tools and prompt
  // contributions. Keeping the base tools would make minimal non-minimal.
  const agentRows=['tool-bash','tool-pwsh','tool-jobs','tool-fs','tool-fs-search',
    'skill-filesystem','tool-skill','command-goal','tool-goal','plan-mode',
    'compaction-basic','command-compact','tool-result-pruner','tool-subagent-control',
    'tool-subagent-list-agents','tool-subagent','tool-subagent-fork','workflow-worker-thread',
    'tool-workflow','tool-ralph','agent-instructions','tool-todo','tool-web'];
  writeFileSync(patch,agentRows.map(id=>`- id: ${id}\n  disabled: true\n`).join('')+shared,{mode:0o600});
  // Existing conversations keep the tool composition under which they ran.
  writeFileSync(legacyPatch,shared,{mode:0o600});
  return {database:join(state,'state.sqlite'),cli,patch,legacyPatch};
}
