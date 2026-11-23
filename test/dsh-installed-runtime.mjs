// Run with the Node (or Electron in Node mode) that belongs to the tested DSH.
// The only RPCs exercised create/read isolated test sessions and shut them down.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const desktop = process.argv[2] === '--desktop';
const src = new URL(process.argv.includes('--bundled') ? '../components/dsh-bridge/dist/src/' : '../components/dsh-bridge/src/',import.meta.url);
const {desktopCli} = await import(new URL('runtime-launch.mjs',src));
const cli = desktop ? desktopCli(process.execPath) : path.resolve(process.argv[2]);
const {version} = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(cli)),'package.json'),'utf8'));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codecang-dsh-sdk-')));
try {
  const systemKeys = new Set(['SYSTEMROOT','PATH','COMSPEC','PATHEXT','WINDIR','ELECTRON_RUN_AS_NODE','LANG']);
  for (const key of Object.keys(process.env)) {
    if (!systemKeys.has(key.toUpperCase())) delete process.env[key];
  }
  for (const key of ['DSH_HOME','DSH_SUBAGENT_CONFIG','DSH_SUBAGENT_STATE','DSH_SUBAGENT_DATA','HOME','USERPROFILE','LOCALAPPDATA','APPDATA','TMPDIR','TMP','TEMP']) {
    process.env[key] = path.join(root, key);
    fs.mkdirSync(process.env[key]);
  }
  process.env.DSH_CLI = cli;
  if (desktop) process.env.DSH_DESKTOP_EXECUTABLE = process.execPath;
  const profile = desktop ? 'codex-light-bridge' : 'codex-subagent';
  const dir = path.join(process.env.DSH_HOME, 'profiles', profile);
  fs.mkdirSync(dir, {recursive:true});
  fs.writeFileSync(path.join(dir,'package.json'), JSON.stringify({name:profile,private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-sdk-app'],patchReload:'startup'}}}));
  for (const file of ['cordis.yml','cordis.patch.yml']) fs.writeFileSync(path.join(dir,file), '[]\n');

  const {runtimeConfig} = await import(new URL('config.mjs',src));
  const {Runtime} = await import(new URL('runtime.mjs',src));
  const cfg = runtimeConfig(process.env.DSH_SUBAGENT_STATE, cli);
  const parent = randomUUID();
  for (const preset of ['standard','minimal']) {
    const sessionId = randomUUID();
    for (const resume of [false,true]) {
      const rt = new Runtime({cwd:root,preset}, cfg);
      const rpc = (method,params) => rt.request(method,params).catch(error => {
        throw new Error(`${method} (${preset}, resume=${resume}): ${error.message}`);
      });
      try {
        await rpc('initialize',{cwd:root,provider:'deepseek-official',model:'deepseek-flash',permission:'read-only',preset,resume,parent});
        const compatibility = await rpc('bridge/compatibility',{});
        assert.deepEqual(compatibility.presets, ['standard','minimal']);
        if (!resume) await rpc('parent/seed',{parent,parentTitle:'Runtime fixture',cwd:root});
        const identity = await rpc('session/prepare',{sessionId});
        assert.equal(identity.cwd,root);
        assert.equal(identity.permission,'read-only');
        assert.equal(identity.preset,preset);
        assert.ok(identity.session_ids.includes(parent));
        if (version.startsWith('0.2.3-') && resume) {
          const moved=fs.mkdtempSync(path.join(root,'worktree-'));
          await rpc('session/working-directory/set',{sessionId,path:moved});
          await assert.rejects(rpc('session/prepare',{sessionId}),/Active session cwd differs/);
          await rpc('session/working-directory/set',{sessionId,path:root});
          assert.equal((await rpc('session/prepare',{sessionId})).cwd,root);
        }
        await rpc('session/checkpoint',{sessionId});
        await rt.close().catch(error => {throw new Error(`shutdown (${preset}, resume=${resume}): ${error.message}`);});
        assert.equal(rt.child.exitCode,0,rt.stderr);
        console.log(JSON.stringify({version,preset,resume,node:process.version,modelCalled:false}));
      } finally {
        if (!rt.exited && rt.child.pid) {
          rt.child.kill();
          await rt.exitPromise;
        }
      }
    }
  }
} finally {
  fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
