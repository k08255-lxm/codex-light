import {renderMarkdown} from '../markdown.js';

const releaseVersion = value => typeof value === 'string' && /^\d{1,9}(?:\.\d{1,9}){2}$/.test(value) ? value : '';

export function mountMobileAbout(root, {bridge, readNotes}) {
  const doc = root.ownerDocument;
  const get = id => root.querySelector('#' + id);
  const content = root.querySelector('.release-body');
  const picker = get('mobile-notes-switch');
  const choices = [...picker.querySelectorAll('button')];
  const releases = new Map();
  const clientVersion = releaseVersion(bridge?.getAppVersion?.());
  let hostVersion = '', scope = 'client', active = false, displayed = '', reading = null;

  get('mobile-about-client').hidden = !bridge;
  get('mobile-client-version').textContent = clientVersion ? 'v' + clientVersion : '版本未知';
  get('mobile-app-update').hidden = typeof bridge?.checkForUpdates !== 'function';

  function notesFor(version) {
    if (!releases.has(version)) {
      const result = Promise.resolve().then(() => readNotes(version)).then(data => {
        if (data.version !== version || typeof data.notes !== 'string' || !data.notes.trim())
          throw new Error('该版本的发布说明暂不可用');
        return data.notes;
      });
      releases.set(version, result);
      result.catch(() => { if (releases.get(version) === result) releases.delete(version); });
    }
    return releases.get(version);
  }

  function showNotes() {
    const version = scope === 'client' && clientVersion ? clientVersion : hostVersion;
    picker.hidden = !clientVersion || !hostVersion || clientVersion === hostVersion;
    for (const choice of choices) choice.setAttribute('aria-pressed', String(choice.dataset.notesFor === scope));
    get('mobile-notes-version').textContent = version ? 'v' + version : '';
    if (!active) return;
    if (!version) {
      displayed = ''; reading = null; content.textContent = '暂无版本信息。'; content.removeAttribute('aria-busy');
      return;
    }
    if (displayed === version) return reading;
    displayed = version;
    content.setAttribute('aria-busy','true');
    content.textContent = '正在读取更新日志…';
    const task = notesFor(version).then(notes => {
      if (reading === task) content.replaceChildren(renderMarkdown(doc, notes));
    }, () => {
      if (reading !== task) return;
      const link = doc.createElement('a');
      link.textContent = '查看 v' + version + ' 的发布页面';
      link.href = 'https://github.com/k08255-lxm/codex-light/releases/tag/v' + version;
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      content.replaceChildren('暂时无法读取此版本的更新日志。', link);
      displayed = '';
    }).finally(() => {
      if (reading === task) { reading = null; content.removeAttribute('aria-busy'); }
    });
    reading = task;
    return task;
  }

  for (const choice of choices) choice.addEventListener('click', () => {
    scope = choice.dataset.notesFor;
    void showNotes();
  });
  return {
    setHostVersion(value) {
      const next = releaseVersion(value);
      get('mobile-host-version').textContent = next ? 'v' + next : '版本未知';
      if (next === hostVersion) return;
      if (hostVersion !== clientVersion) releases.delete(hostVersion);
      hostVersion = next;
      void showNotes();
    },
    activate() { active = true; return showNotes(); },
    deactivate() {
      active = false;
      if (reading) { reading = null; displayed = ''; content.removeAttribute('aria-busy'); }
    },
  };
}
