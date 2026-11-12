// Responsive bar chart. Bars are SVG drawn at the container's measured pixel width (no squashing);
// axis labels are real text at their CSS size. A tap/hover on a bar shows its value in a readout.
import { compact } from './format.js';
const SVG = 'http://www.w3.org/2000/svg';

function svg(document, tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}
/** Picks a readable axis maximum: 1, 2, 2.5 or 5 × 10^n at or above `value`. */
export function niceMax(value) {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * magnitude >= value) return step * magnitude;
  return 10 * magnitude;
}
/** How many x labels fit: roughly one per 56px of plot width (CJK date labels ~40px). */
export function labelStep(count, plotWidth, minSpacing = 56) {
  if (count <= 0) return 1;
  return Math.max(1, Math.ceil(count / Math.max(1, Math.floor(plotWidth / minSpacing))));
}
/** Pure geometry for `count` bars inside `width`×`height` (pixels). Null values are gaps. */
export function chartLayout(values, width, height, { left = 44, right = 6, top = 8, bottom = 22 } = {}) {
  const finite = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  const max = niceMax(Math.max(0, ...finite));
  const plotW = Math.max(10, width - left - right), plotH = Math.max(10, height - top - bottom);
  const slot = values.length ? plotW / values.length : plotW;
  const bar = Math.max(2, Math.min(40, slot * .64));
  const bars = values.map((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const h = Math.max(value > 0 ? 1.5 : 0, plotH * value / max);
    return { x: left + slot * index + (slot - bar) / 2, y: top + plotH - h, w: bar, h, cx: left + slot * index + slot / 2 };
  });
  return { max, plotW, plotH, slot, bar, bars, left, top, bottom, step: labelStep(values.length, plotW) };
}

/**
 * Renders into a wrapper element and re-lays out when the wrapper's width changes.
 * `points=[{label,value,title}]`. Returns the wrapper (with `.dispose()`).
 */
export function barChart(document, points, { height = 200, format = compact, emptyText = '此范围内没有观测数据' } = {}) {
  const wrap = document.createElement('div'); wrap.className = 'bar-chart-wrap';
  const root = svg(document, 'svg', { class: 'bar-chart', role: 'img', height });
  const readout = document.createElement('div'); readout.className = 'chart-readout'; readout.hidden = true; readout.setAttribute('role', 'status');
  wrap.append(root, readout);
  const values = points.map(point => point.value);
  const finite = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  root.setAttribute('aria-label', points.length ? `${points.length} 个时间段，最高 ${format(Math.max(0, ...finite))}` : emptyText);
  let selected = -1;
  const show = index => {
    selected = index; const point = points[index];
    if (!point || typeof point.value !== 'number') { readout.hidden = true; return; }
    readout.hidden = false; readout.textContent = point.title || `${point.label} · ${format(point.value)}`;
    for (const rect of root.querySelectorAll('rect.bar')) rect.classList.toggle('active', Number(rect.dataset.index) === index);
  };
  function draw(width) {
    if (!(width > 0)) return;
    root.replaceChildren(); root.setAttribute('width', String(width)); root.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const layout = chartLayout(values, width, height);
    for (const fraction of [0, .5, 1]) {
      const y = layout.top + layout.plotH * (1 - fraction);
      root.append(svg(document, 'line', { x1: layout.left, x2: width - 6, y1: y, y2: y, class: fraction ? 'grid' : 'axis' }));
      const tick = svg(document, 'text', { x: layout.left - 6, y: y + 4, class: 'tick', 'text-anchor': 'end' }); tick.textContent = format(layout.max * fraction); root.append(tick);
    }
    if (!points.length) { const t = svg(document, 'text', { x: width / 2, y: height / 2, class: 'empty', 'text-anchor': 'middle' }); t.textContent = emptyText; root.append(t); return; }
    layout.bars.forEach((bar, index) => {
      if (bar) {
        // A full-height transparent hit area keeps thin/short bars tappable.
        const hit = svg(document, 'rect', { x: (layout.left + layout.slot * index).toFixed(1), y: layout.top, width: Math.max(1, layout.slot).toFixed(1), height: layout.plotH, class: 'hit', 'data-index': index });
        const rect = svg(document, 'rect', { x: bar.x.toFixed(1), y: bar.y.toFixed(1), width: bar.w.toFixed(1), height: bar.h.toFixed(1), rx: Math.min(3, bar.w / 3), class: 'bar' + (index === selected ? ' active' : ''), 'data-index': index });
        const title = svg(document, 'title'); title.textContent = points[index].title || `${points[index].label} · ${format(points[index].value)}`; rect.append(title);
        for (const node of [hit, rect]) { node.addEventListener('pointerenter', () => show(index)); node.addEventListener('click', () => show(index)); }
        root.append(rect, hit);
      }
      if (index % layout.step === 0) { const t = svg(document, 'text', { x: (layout.left + layout.slot * index + layout.slot / 2).toFixed(1), y: height - 6, class: 'tick', 'text-anchor': 'middle' }); t.textContent = points[index].label; root.append(t); }
    });
  }
  let observer = null, last = 0;
  const measure = () => { const width = Math.round(wrap.clientWidth || 0); if (width && width !== last) { last = width; draw(width); } };
  if (typeof ResizeObserver === 'function') { observer = new ResizeObserver(measure); observer.observe(wrap); }
  // First paint before layout is known (also used by non-browser tests).
  draw(Number(wrap.clientWidth) || 640);
  wrap.addEventListener('pointerleave', () => { readout.hidden = selected < 0; });
  wrap.dispose = () => observer?.disconnect();
  return wrap;
}
