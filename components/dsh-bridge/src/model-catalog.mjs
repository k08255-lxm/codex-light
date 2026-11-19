import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {desktopCli} from './runtime-launch.mjs';

const metadata = rows => rows.map(({id, name}) => ({id, name}));

// DSH's standalone metadata APIs require neither runtime initialization nor provider sign-in.
export async function loadInstalledModelCatalog(cli, providerIds) {
  const requireDsh = createRequire(cli);
  const catalog = {providers:Object.create(null)};
  try {
    const entry = requireDsh.resolve('@deepseek-ai/dsh-llm-deepseek');
    const {resolveAdapterOptions} = await import(pathToFileURL(entry).href);
    catalog.builtin = metadata(resolveAdapterOptions({}).models);
  } catch {
    catalog.error = '无法读取已安装 DSH 的内置模型目录。';
  }
  if (providerIds.length) {
    try {
      const requirePi = createRequire(requireDsh.resolve('@deepseek-ai/dsh-llm-pi-ai'));
      const entry = requirePi.resolve('@earendil-works/pi-ai/providers/all');
      const {getBuiltinModels} = await import(pathToFileURL(entry).href);
      for (const provider of providerIds) catalog.providers[provider] = metadata(getBuiltinModels(provider));
    } catch {
      catalog.error = '无法读取已安装 DSH 的模型目录。';
    }
  }
  return catalog;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const providerIds = JSON.parse(process.argv[2]);
  const catalog = await loadInstalledModelCatalog(desktopCli(process.execPath), providerIds);
  process.stdout.write(JSON.stringify(catalog) + '\n');
}
