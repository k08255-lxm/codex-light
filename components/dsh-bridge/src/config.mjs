import {existsSync,realpathSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {locations, installation} from './platform.mjs';
import {commandSpec} from './commands.mjs';
import {desktopCli} from './runtime-launch.mjs';
import {ProviderSources} from './provider-sources.mjs';
import {resolvePresetLayout} from './preset-layout.mjs';

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
  const desktop=Boolean(process.env.DSH_DESKTOP_EXECUTABLE);
  const split=desktop || resolvePresetLayout(cli)==='split';
  const manifest=JSON.parse(readFileSync(join(dirname(dirname(cli)),'package.json'),'utf8'));
  const currentPresets=/^0\.2\.3-/.test(manifest.version);
  const installedPresetPatches=currentPresets ? ['standard','minimal'].map(id=>
    createRequire(cli).resolve(`@deepseek-ai/dsh-web-app/presets/${id}.patch.yml`)) : [];
  const assets=join(projectRoot,'assets/desktop-0.2');
  const presetPatch=split ? readFileSync(join(assets,'preset-host.patch.yml'),'utf8')+
    (currentPresets?'':readFileSync(join(assets,'presets.patch.yml'),'utf8')) : '';
  // 0.2.3's SDK bundle provides workspace. The bridge owns schedule activation;
  // keep it disabled when replacing the SDK server that normally provides it.
  const hostRows=currentPresets ? `    - id: cordis-host-runner
      name: '@deepseek-ai/dsh-cordis-host-runner'
    - id: cordis-inspect-providers
      name: '@deepseek-ai/dsh-tool-cordis/host'
` : `    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
`;
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
${hostRows}    - id: subagent-model-selection-settings
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
    - id: codex-subagent-rpc
      name: ${JSON.stringify(join(projectRoot,'src/dsh-plugin.mjs'))}
`;
    // Provider files are read at each NEW runtime boundary, never hot-reloaded into live tasks.
    const providerSources=new ProviderSources({configDir:locations().config,stateDir:state,home:process.env.DSH_HOME,sourcePath:process.env.DSH_DESKTOP_PROVIDER_CONFIG,cli});
    writeFileSync(patch,presetPatch+shared,{mode:0o600});
    writeFileSync(legacyPatch,presetPatch+shared,{mode:0o600});
    return {database:join(state,'state.sqlite'),cli,patch,legacyPatch,installedPresetPatches,providerSources,profile:process.env.DSH_BRIDGE_PROFILE||'codex-light-bridge',
        revalidateParents:true,
        defaultProvider:process.env.DSH_DEFAULT_PROVIDER,defaultModel:process.env.DSH_DEFAULT_MODEL,
        defaultEffort:process.env.DSH_DEFAULT_EFFORT,
        workspaceIsolation:'shared',isolationRoot:join(state,'workspaces')};
  }
  const legacyPresetRows = split ? '' : `    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: standard
`;
  // Current CLI and Desktop share the same split registry and declarations.
  // Compose them once, using the upstream preset overlay already shipped here.
  const shared=`- id: sdk-jsonrpc-server
  disabled: true
- id: llm-deepseek
  config:
    maxTokens: ${MAX_OUTPUT_TOKENS}
- insert:
${hostRows}${legacyPresetRows}    - id: subagent-model-selection-settings
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
  writeFileSync(patch,presetPatch+(split?'':agentRows.map(id=>`- id: ${id}\n  disabled: true\n`).join(''))+shared,{mode:0o600});
  // Legacy packages keep their original host rows for old conversations.
  // Split packages use the same preset-owned composition as DSH Desktop.
  writeFileSync(legacyPatch,presetPatch+shared,{mode:0o600});
  const native=process.env.CODEX_LIGHT_DSH_TARGET==='wsl';
  return {database:join(state,'state.sqlite'),cli,patch,legacyPatch,installedPresetPatches,...(native?{profile:process.env.DSH_BRIDGE_PROFILE||'codecang-wsl',workspaceIsolation:'shared',defaultProvider:process.env.DSH_DEFAULT_PROVIDER,defaultModel:process.env.DSH_DEFAULT_MODEL,defaultEffort:process.env.DSH_DEFAULT_EFFORT,...(process.env.DSH_NATIVE_PROVIDER_CONFIG?{providerSources:new ProviderSources({configDir:locations().config,stateDir:state,home:process.env.DSH_HOME,sourcePath:process.env.DSH_NATIVE_PROVIDER_CONFIG,cli})}:{})}:{})};
}
