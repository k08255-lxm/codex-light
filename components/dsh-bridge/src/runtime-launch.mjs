import {dirname, join, isAbsolute} from 'node:path';

// Mirror the installed desktop dsh.cmd without cmd.exe interpolation.
// No extraction, installation, credentials or desktop configuration changes.
export function desktopCli(executable) {
  if (!isAbsolute(executable)) throw new Error('DSH_DESKTOP_EXECUTABLE must be absolute');
  return join(dirname(executable), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
}

export function runtimeLaunch(config, agent, env = process.env) {
  const executable = config.desktopExecutable || env.DSH_DESKTOP_EXECUTABLE;
  const cli = executable ? desktopCli(executable) : config.cli;
  const args = [cli, '--profile', config.profile || 'codex-subagent', '--patch', agent.preset ? config.patch : config.legacyPatch];
  return {
    command: executable || process.execPath,
    args: executable ? ['--expose-internals', ...args] : args,
    env: {...env, DSH_CLI: cli, ...(executable ? {ELECTRON_RUN_AS_NODE: '1'} : {})},
  };
}
