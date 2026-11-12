import {join} from 'node:path';
import {projectRoot} from './config.mjs';

// JSON basic strings also quote these paths safely for TOML. Absolute paths
// avoid the reduced PATH inherited by a desktop application launched from GUI.
export function desktopConfig({node = process.execPath, root = projectRoot} = {}) {
  return `# Requires the DSH background service. Replace an existing dsh_subagent table.
# This profile uses standard MCP waits; it does not wake an idle desktop chat.
[mcp_servers.dsh_subagent]
command = ${JSON.stringify(node)}
args = ${JSON.stringify([join(root, 'src/cli.mjs'), 'mcp', '--desktop'])}
startup_timeout_sec = 30
tool_timeout_sec = 3600`;
}
