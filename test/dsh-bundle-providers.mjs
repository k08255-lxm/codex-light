// Re-run the existing provider safety suite against the distributed implementation,
// not its source twin. This script must be run after `build.mjs --bundle`.
import {spawnSync} from 'node:child_process';
const script=`import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){
 if(specifier==='../src/dsh-provider-sources.mjs'&&context.parentURL?.endsWith('/test/dsh-config-sources-owned.test.mjs'))return next('../components/dsh-bridge/dist/src/provider-sources.mjs',context);
 return next(specifier,context);
}});
await import('./test/dsh-config-sources-owned.test.mjs');`;
const result=spawnSync(process.execPath,['--input-type=module','-e',script],{stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;
process.exitCode=result.status??1;
