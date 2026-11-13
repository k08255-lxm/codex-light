"""Curate the already-built payload and author one HKCU-keyed component per file."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import uuid
import xml.etree.ElementTree as ET

p = argparse.ArgumentParser()
p.add_argument('payload', type=Path)
p.add_argument('output', type=Path)
p.add_argument('--version', default='0.4.0')
a = p.parse_args()
host_source = (Path(__file__).resolve().parent.parent/'WebViewRuntime.cs').read_text(encoding='utf-8')
minimum = re.search(r'const int MinimumMajor\s*=\s*(\d+)\s*;', host_source)
if minimum is None:
    raise SystemExit('Cannot read host WebView2 runtime requirement')
webview_major = int(minimum.group(1))
runtime = json.loads((a.payload/'CodexLight.runtimeconfig.json').read_text(encoding='utf-8'))['runtimeOptions']
frameworks = {f['name']: f['version'] for f in runtime.get('frameworks', [])}
if runtime.get('tfm') != 'net10.0' or frameworks != {'Microsoft.NETCore.App':'10.0.0', 'Microsoft.WindowsDesktop.App':'10.0.0'}:
    raise SystemExit('MSI dependency authoring requires the framework-dependent .NET 10 application payload')
parts = a.version.split('.')
if len(parts) != 3 or any(not s.isdigit() for s in parts) or any(int(s) > m for s, m in zip(parts, [255, 255, 65535])):
    raise SystemExit('MSI version must be major.minor.build (255.255.65535 maximum)')
ns = 'http://wixtoolset.org/schemas/v4/wxs'
ET.register_namespace('', ns)
def sub(parent, name, **attrs):
    return ET.SubElement(parent, '{'+ns+'}'+name, attrs)
root = ET.Element('{'+ns+'}Wix')
pkg = sub(root, 'Package', Name='Codex Light', Manufacturer='Codex Light contributors', Version=a.version,
          UpgradeCode='{C63D113F-36E4-46F6-B635-F1CE57BD166E}', Scope='perUser', Language='1033', InstallerVersion='500')
sub(pkg, 'MajorUpgrade', DowngradeErrorMessage='A newer Codex Light is already installed.', Schedule='afterInstallInitialize')
sub(pkg, 'MediaTemplate', EmbedCab='yes', CompressionLevel='high')
sub(pkg, 'Icon', Id='AppIcon', SourceFile=str(Path(__file__).resolve().parent.parent/'app.ico'))
for key, val in {'ARPPRODUCTICON':'AppIcon', 'ARPNOMODIFY':'1'}.items():
    sub(pkg, 'Property', Id=key, Value=val)
sub(pkg, 'Property', Id='SETUP_PREREQUISITES_VERIFIED', Secure='yes')
sub(pkg, 'SetProperty', Id='ARPINSTALLLOCATION', Value='[INSTALLFOLDER]', After='CostFinalize', Sequence='execute')
for prop, regroot in [('NODE_RUNTIME', 'HKLM'), ('NODE_USER_RUNTIME', 'HKCU')]:
    node = sub(pkg, 'Property', Id=prop)
    nodepath = sub(node, 'RegistrySearch', Id=prop+'Path', Root=regroot, Key='SOFTWARE\\Node.js', Name='InstallPath', Type='directory', Bitness='always64')
    # A directory registry value needs a directory locator before a file signature.
    # Nesting FileSearch directly emits a dangling parent locator in WiX 6.0.2.
    nodedir = sub(nodepath, 'DirectorySearch', Id=prop+'Directory', Depth='0')
    # The official Node executable uses en-US resources. MSI compares language
    # when the version equals MinVersion, so include it to accept Node 20.0.0.
    sub(nodedir, 'FileSearch', Id=prop+'Directory', Name='node.exe', MinVersion='20.0.0.0', Languages='1033')
for prop, regroot, bits in [('WEBVIEW_MACHINE','HKLM','always32'), ('WEBVIEW_USER','HKCU','always32')]:
    entry = sub(pkg, 'Property', Id=prop)
    location = sub(entry, 'RegistrySearch', Id=prop+'Location', Root=regroot, Key='SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', Name='location', Type='directory', Bitness=bits)
    verdir = sub(location, 'DirectorySearch', Id=prop+'VersionDir', Depth='1')
    sub(verdir, 'FileSearch', Id=prop+'VersionDir', Name='msedgewebview2.exe', MinVersion=f'{webview_major}.0.0.0')
net = sub(pkg, 'Property', Id='DESKTOP_RUNTIME_10')
netdir = sub(net, 'DirectorySearch', Id='DesktopRuntimeDirectory', Path='[ProgramFiles64Folder]dotnet\\shared\\Microsoft.WindowsDesktop.App', Depth='1')
sub(netdir, 'FileSearch', Id='DesktopRuntimeDirectory', Name='PresentationFramework.dll', MinVersion='10.0.0.0', MaxVersion='10.65535.65535.65535')
core = sub(pkg, 'Property', Id='CORE_RUNTIME_10')
coredir = sub(core, 'DirectorySearch', Id='CoreRuntimeDirectory', Path='[ProgramFiles64Folder]dotnet\\shared\\Microsoft.NETCore.App', Depth='1')
sub(coredir, 'FileSearch', Id='CoreRuntimeDirectory', Name='coreclr.dll', MinVersion='10.0.0.0', MaxVersion='10.65535.65535.65535')
sub(pkg, 'Launch', Condition='Installed OR REMOVE="ALL" OR SETUP_PREREQUISITES_VERIFIED = "1" OR (DESKTOP_RUNTIME_10 AND CORE_RUNTIME_10 AND (NODE_RUNTIME OR NODE_USER_RUNTIME) AND (WEBVIEW_MACHINE OR WEBVIEW_USER))',
    Message=f'Run CodexLight-Setup.exe to check and install Node.js 20+, .NET Desktop Runtime 10 and WebView2 {webview_major}+ before installing Codex Light.')
sub(pkg, 'SetProperty', Id='INSTALLFOLDER', Value='[LocalAppDataFolder]Programs\\CodexLight\\', Before='AppSearch', Sequence='both', Condition='NOT INSTALLFOLDER')
previous = sub(pkg, 'Property', Id='PREVIOUS_INSTALLFOLDER')
sub(previous, 'RegistrySearch', Id='PreviousFolderSearch', Root='HKCU', Key='Software\\CodexLight\\Installer', Name='InstallLocation', Type='raw', Bitness='always64')
sub(pkg, 'SetProperty', Id='INSTALLFOLDER', Action='RestorePreviousInstallFolder', Value='[PREVIOUS_INSTALLFOLDER]', After='AppSearch', Sequence='both', Condition='PREVIOUS_INSTALLFOLDER AND (Installed OR WIX_UPGRADE_DETECTED)')
existing = sub(pkg, 'Property', Id='EXISTING_TARGET')
sub(existing, 'DirectorySearch', Id='ExistingTargetSearch', Path='[INSTALLFOLDER]', Depth='0', AssignToProperty='yes')
sub(pkg, 'Launch', Condition='Installed OR WIX_UPGRADE_DETECTED OR NOT EXISTING_TARGET',
    Message='The target folder already exists. Choose a new empty location using CodexLight-Setup.exe. Old non-MSI installations are not migrated or overwritten.')
local = sub(pkg, 'StandardDirectory', Id='LocalAppDataFolder')
programs = sub(local, 'Directory', Id='UserPrograms', Name='Programs')
install = sub(programs, 'Directory', Id='INSTALLFOLDER', Name='CodexLight')
menu = sub(pkg, 'StandardDirectory', Id='ProgramMenuFolder')
menu_dir = sub(menu, 'Directory', Id='AppMenu', Name='Codex Light')
feature = sub(pkg, 'Feature', Id='Main', Title='Codex Light', Level='1')
manifest = []
directory_map = {'': install}
cleanup_directories = set()
namespace = uuid.UUID('c63d113f-36e4-46f6-b635-f1ce57bd166e')
allowed_roots = {'CodexLight.exe','CodexLight.dll','CodexLight.deps.json','CodexLight.runtimeconfig.json',
                 'Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll'}
for file in sorted(a.payload.resolve().rglob('*')):
    if not file.is_file():
        continue
    rel = file.relative_to(a.payload.resolve()).as_posix()
    if file.is_symlink():
        raise SystemExit('Symlinks not allowed: '+rel)
    if not (rel in allowed_roots or rel.startswith(('app/public/','app/src/','app/components/dsh-bridge/','licenses/')) or rel in {'app/package.json','runtimes/win-x64/native/WebView2Loader.dll'}):
        continue
    forbidden_parts = {'.git','.codex','logs','sessions','projects'}
    if not rel.startswith('app/components/dsh-bridge/'):
        forbidden_parts.add('node_modules')
    if any(part.lower() in forbidden_parts for part in file.relative_to(a.payload.resolve()).parts):
        raise SystemExit('Unexpected private/development payload: '+rel)
    parent = ''
    for part in Path(rel).parts[:-1]:
        next_parent = parent+'/'+part if parent else part
        if next_parent not in directory_map:
            directory_map[next_parent] = sub(directory_map[parent], 'Directory', Id='D'+hashlib.sha256(next_parent.encode()).hexdigest()[:24], Name=part)
        parent = next_parent
    ident = hashlib.sha256(rel.encode()).hexdigest()[:24]
    comp = sub(directory_map[parent], 'Component', Id='C'+ident, Guid='{'+str(uuid.uuid5(namespace, rel)).upper()+'}')
    if parent not in cleanup_directories:
        sub(comp, 'RemoveFolder', Id='Cleanup'+ident, Directory=directory_map[parent].get('Id'), On='uninstall')
        cleanup_directories.add(parent)
    sub(comp, 'RegistryValue', Root='HKCU', Key='Software\\CodexLight\\Installer\\Files', Name=ident, Type='integer', Value='1', KeyPath='yes')
    f = sub(comp, 'File', Id='F'+ident, Source=str(file))
    if rel == 'CodexLight.exe':
        sub(comp, 'RegistryValue', Root='HKCU', Key='Software\\CodexLight\\Installer', Name='InstallLocation', Type='string', Value='[INSTALLFOLDER]')
        sub(f, 'Shortcut', Id='StartMenuShortcut', Directory='AppMenu', Name='Codex Light', WorkingDirectory='INSTALLFOLDER', Advertise='no', Icon='AppIcon')
        sub(comp, 'RemoveFolder', Id='RemoveAppMenu', Directory='AppMenu', On='uninstall')
    sub(feature, 'ComponentRef', Id='C'+ident)
    manifest.append({'path':rel, 'size':file.stat().st_size, 'sha256':hashlib.sha256(file.read_bytes()).hexdigest(), 'fileId':'F'+ident})
required_payload = allowed_roots | {
    'app/package.json', 'app/src/desktop-backend.mjs', 'app/src/server.mjs',
    'app/public/index.html', 'app/public/app.js', 'app/public/style.css',
    'licenses/CodexLight-LICENSE.txt', 'licenses/DotNet-AppHost-LICENSE.txt',
    'licenses/DotNet-AppHost-THIRD-PARTY-NOTICES.txt', 'licenses/WebView2-LICENSE.txt',
    'licenses/WebView2-NOTICE.txt', 'licenses/VERSIONS.txt',
    'licenses/xterm/LICENSE', 'licenses/xterm/addon-fit-LICENSE',
    'licenses/THIRD-PARTY-NOTICES.md',
    'app/components/dsh-bridge/manifest.json',
    'app/components/dsh-bridge/src/light-entry.mjs',
    'app/components/dsh-bridge/src/provider-sources-adapter.json',
    'app/components/dsh-bridge/package-lock.json',
    'app/components/dsh-bridge/node_modules/@modelcontextprotocol/sdk/package.json',
    'app/components/dsh-bridge/node_modules/yaml/package.json',
    'app/components/dsh-bridge/licenses/manifest.json',
    'licenses/dsh-bridge/Bridge-MIT-LICENSE.txt',
    'licenses/dsh-bridge/DeepSeek-MIT-LICENSE.txt',
}
missing = required_payload-{f['path'] for f in manifest}
if missing:
    raise SystemExit('Missing required application payload: '+', '.join(sorted(missing)))
a.output.mkdir(parents=True, exist_ok=True)
ET.indent(root)
ET.ElementTree(root).write(a.output/'Product.wxs', encoding='utf-8', xml_declaration=True)
(a.output/'payload-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print(f'Authored {len(manifest)} files')
