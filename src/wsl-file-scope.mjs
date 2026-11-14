import path from 'node:path';
const reject=()=>Object.assign(new Error('Path is outside the selected WSL distribution'),{code:'WSL_PATH_REFUSED',status:403});
export function validWslDistribution(value){return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(value)&&!/[. ]$/.test(value);}
/** Identity stays case-sensitive. Only the UNC host alias is case-insensitive. */
export class WslFileScope {
 constructor(distribution){if(!validWslDistribution(distribution))throw reject();this.distribution=distribution;this.root=`\\\\wsl.localhost\\${distribution}`;}
 linux(value){
  if(typeof value!=='string'||!value||value.length>4096||/[\x00-\x1f\x7f]/.test(value))throw reject();
  let source=value;
  if(source.startsWith('\\\\')){const match=/^\\\\(wsl\.localhost|wsl\$)\\([^\\]+)(.*)$/i.exec(source);if(!match||match[2]!==this.distribution)throw reject();source=match[3].replaceAll('\\','/')||'/';}
  if(!source.startsWith('/')||source.startsWith('//')||/[\\:*?"<>|]/.test(source))throw reject();
  if(source.split('/').some(part=>part==='.'||part==='..'||/[. ]$/.test(part)))throw reject();
  return path.posix.normalize(source);
 }
 host(value){return this.root+this.linux(value).replaceAll('/','\\');}
 resolve(root,value){if(typeof value!=='string')throw reject();return this.host(value.startsWith('/')||value.startsWith('\\\\')?value:this.linux(root).replace(/\/$/,'')+'/'+value);}
 inside(root,value){const relative=path.posix.relative(this.linux(root),this.linux(value));return relative===''||(!relative.startsWith('../')&&relative!=='..'&&!path.posix.isAbsolute(relative));}
}
