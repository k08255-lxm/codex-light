import {access,realpath,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
// Never ask Windows' process loader (or PATH) to search the repository for git.exe.
export async function resolveGitExecutable(cwd,{platform=process.platform,env=process.env,probe=async file=>{await access(file,constants.X_OK);if(!(await stat(file)).isFile())throw new Error('not a file');return realpath(file);}}={}){
 const p=platform==='win32'?path.win32:path.posix;
 const roots=platform==='win32'?['C:\\Program Files','C:\\Program Files (x86)',env.ProgramFiles,env['ProgramFiles(x86)']].filter(Boolean):[];
 const candidates=platform==='win32'?roots.flatMap(root=>p.isAbsolute(root)?[p.join(root,'Git','cmd','git.exe'),p.join(root,'Git','bin','git.exe')]:[]):['/usr/bin/git','/bin/git','/usr/local/bin/git','/opt/homebrew/bin/git'];
 const normalized=value=>platform==='win32'?p.resolve(value).toLowerCase():p.resolve(value);
 let canonicalCwd=cwd;try{canonicalCwd=await realpath(cwd);}catch{}
 const repo=normalized(canonicalCwd);
 for(const candidate of [...new Set(candidates)]){try{const actual=await probe(candidate);if(typeof actual!=='string'||!p.isAbsolute(actual))continue;const resolved=normalized(actual);if(resolved===repo||resolved.startsWith(repo+p.sep))continue;return actual;}catch{}}
 throw Object.assign(new Error('未找到可信系统安装的 Git。请安装官方 Git；不会运行仓库内的 git.exe 或从当前目录搜索。'),{code:'GIT_EXECUTABLE_NOT_FOUND',outcome:'notExecuted'});
}
