// Search descriptions stay available before their panels have been loaded.
const anchors = [
  ['wsl-runtime-panel', 'WSL 运行环境', 'Linux 发行版'],
  ['runtime-panel', '运行环境', 'Codex CLI'],
  ['title-settings-root', '对话标题', '摘要标题 自动命名 标题生成', '#title-settings-root > .section-title'],
  ['config-panel', 'Codex 配置', '默认模型 思考强度 审批 沙箱', '#config-panel > .section-title'],
  ['question-notification-label', '提问与审批提醒', '允许通知 允许系统通知 通知授权 系统通知设置', '#question-notification-permission'],
  ['dsh-connection-root', '子代理默认模型', 'DSH 默认模型 模型选择 DeepSeek Harness', '.dsh-default-model > h3'],
  ['dsh-connection-root', 'DSH 连接', '子代理'],
  ['dsh-config-root', 'DSH 模型来源', '模型 供应商 服务配置'],
  ['settings-plugins', '插件管理', '安装 启用 停用'],
  ['storage-root', '存储空间', '缓存 清理'],
  ['about-root', '版本与更新', '检查更新 下载 安装'],
];

export function mountSettingsSearch({ document, navigate }) {
  const input = document.getElementById('settings-search');
  const results = document.getElementById('settings-search-results');
  const nav = document.getElementById('settings-nav');
  const normalize = value => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');

  function available(node, page) {
    if (!node?.isConnected) return false;
    for (; node && node !== page; node = node.parentElement) {
      if (node.hidden || node.classList.contains('hidden') || document.defaultView.getComputedStyle(node).display === 'none') return false;
    }
    return node === page;
  }

  function focusDestination(destination, page) {
    for (let parent = destination.parentElement; parent && parent !== page; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') parent.open = true;
    }
    if (destination.tabIndex < 0) destination.tabIndex = -1;
    destination.focus({ preventScroll: true });
    destination.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function clear() {
    input.value = '';
    render();
  }

  function render() {
    const query = normalize(input.value);
    results.hidden = !query;
    nav.hidden = Boolean(query);
    results.replaceChildren();
    if (!query) return;
    const words = query.split(' ');
    for (const link of nav.querySelectorAll('[data-settings-section]')) {
      const section = link.dataset.settingsSection;
      const page = document.getElementById('settings-' + section);
      if (document.documentElement.dataset.access === 'lan' && link.classList.contains('local-only')) continue;
      const category = link.textContent.trim();
      const seen = new Set();
      function add(target, label, keywords = '', destinationSelector) {
        if (!label || seen.has(label) || !words.every(word => normalize(label + ' ' + keywords).includes(word))) return;
        if (!available(target, page)) return;
        seen.add(label);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'settings-search-result';
        const title = document.createElement('span');
        title.textContent = label;
        button.append(title);
        if (category !== label) {
          const path = document.createElement('small');
          path.textContent = category;
          button.append(path);
        }
        button.addEventListener('click', () => {
          clear();
          const ready = navigate(section);
          const findDetail = () => destinationSelector && page.querySelector(destinationSelector);
          const detail = findDetail();
          const fallback = available(target, page) ? target : page;
          const destination = available(detail, page) && !detail.disabled ? detail : fallback;
          focusDestination(destination, page);
          if (ready && destinationSelector) {
            void ready.then(() => {
              const loaded = findDetail();
              if (document.activeElement === destination && loaded !== destination && available(loaded, page) && !loaded.disabled) {
                focusDestination(loaded, page);
              }
            });
          }
        });
        results.append(button);
      }
      add(page, category);
      for (const [id, label, keywords, destination] of anchors) {
        const target = document.getElementById(id);
        if (target && page.contains(target)) add(target, label, keywords, destination);
      }
      for (const node of page.querySelectorAll('h2, h3, .pref-row strong, .field > span, dt, summary, button, .config-settings-field strong')) {
        // Never include archived conversation names, paired devices or plugin entries.
        if (node.closest('#archived-list, #remote-devices, #settings-plugins, #question-notification-permission')) continue;
        const row = node.closest('.pref-row');
        add(node, node.textContent.trim(), row?.querySelector('small')?.textContent || '');
      }
    }
    if (!results.childElementCount) {
      const empty = document.createElement('p');
      empty.className = 'fine';
      empty.setAttribute('role', 'status');
      empty.textContent = '没有找到相关设置';
      results.append(empty);
    }
  }
  input.addEventListener('input', render);
  input.addEventListener('keydown', event => {
    if (event.isComposing || !input.value.trim()) return;
    if (!['Escape', 'ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') clear();
    if (event.key === 'ArrowDown') results.querySelector('button')?.focus();
    if (event.key === 'ArrowUp') [...results.querySelectorAll('button')].at(-1)?.focus();
    if (event.key === 'Enter') results.querySelector('button')?.click();
  });
  results.addEventListener('keydown', event => {
    if (event.isComposing || !['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...results.querySelectorAll('button')];
    const index = buttons.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      clear();
      input.focus();
    } else if (event.key === 'ArrowUp' && index === 0) {
      input.focus();
    } else {
      const next = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: buttons.length - 1 }[event.key];
      buttons[next]?.focus();
    }
  });
}
