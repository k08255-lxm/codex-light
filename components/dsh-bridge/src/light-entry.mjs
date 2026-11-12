// Installed MCP entry only. Never installs DSH, changes Codex configuration, or prompts a model.
if(process.argv.slice(2).join(' ')!=='mcp --desktop'){process.stderr.write('Use this bundled component through Codex Light connection settings.\n');process.exit(2);}
try{
 if(!process.env.DSH_SUBAGENT_CONFIG||process.env.CODEX_LIGHT_DSH_BRIDGE!=='1')throw Error('Bundled bridge is not configured by Codex Light');
 await import('node:sqlite');
 await (await import('./stdio-proxy.mjs')).stdioProxy({desktop:true});
}catch{process.stderr.write('Codex Light DSH bridge unavailable. Check DSH installation and connection settings.\n');process.exitCode=1;}
