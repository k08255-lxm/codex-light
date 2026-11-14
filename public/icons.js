// Codex Light icon system — original geometry drawn for this application.
// 24×24 grid, 2px optical padding, one stroke weight, round caps/joins.
// Filled shapes use fill="currentColor" so selected/disabled states follow text colour.
// No icon font, external asset or runtime dependency.
const SVG_NS = 'http://www.w3.org/2000/svg';
const DOT = 'currentColor';
const ICONS = {
  // Brand: an open aperture with a point of light.
  brand: [['path', { d: 'M16.6 7.5A6.4 6.4 0 1 0 16.6 16.5' }], ['circle', { cx: '18.6', cy: '12', r: '1.5', fill: DOT }]],
  // Navigation
  home: [['path', { d: 'M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11l-4 3.5v-3.5h-.5a2 2 0 0 1-2-2z' }]],
  compose: [['path', { d: 'M11.5 5H6.5a2 2 0 0 0-2 2v10.5a2 2 0 0 0 2 2H17a2 2 0 0 0 2-2v-5' }], ['path', { d: 'M16.8 4.2a1.6 1.6 0 0 1 2.3 0l.7.7a1.6 1.6 0 0 1 0 2.3L13 14l-3 .8.8-3z' }]],
  chart: [['path', { d: 'M4.5 4.5v13a2 2 0 0 0 2 2h13' }], ['path', { d: 'M8.5 14.5l3.2-3.6 2.8 2.3 4.5-5.7' }]],
  usage: [['path', { d: 'M4.8 17a7.5 7.5 0 1 1 14.4 0' }], ['path', { d: 'M12 15.5l3.4-4.2' }], ['circle', { cx: '12', cy: '15.6', r: '1.2', fill: DOT }]],
  user: [['circle', { cx: '12', cy: '8.5', r: '3.5' }], ['path', { d: 'M5 19.5a7 7 0 0 1 14 0' }]],
  terminal: [['rect', { x: '3.5', y: '5', width: '17', height: '14', rx: '2.5' }], ['path', { d: 'M7.5 10l2.5 2-2.5 2' }], ['path', { d: 'M12.5 14.5h4' }]],
  branch: [['circle', { cx: '7', cy: '6', r: '2' }], ['circle', { cx: '7', cy: '18', r: '2' }], ['circle', { cx: '17', cy: '9', r: '2' }], ['path', { d: 'M7 8v8' }], ['path', { d: 'M17 11a4 4 0 0 1-4 4H7.2' }]],
  plug: [['path', { d: 'M9.5 3.5v4M14.5 3.5v4' }], ['path', { d: 'M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0z' }], ['path', { d: 'M12 16v4.5' }]],
  settings: [['path', { d: 'M4.5 7.5h8.5M17 7.5h2.5M4.5 16.5h2.5M11 16.5h8.5' }], ['circle', { cx: '15', cy: '7.5', r: '2' }], ['circle', { cx: '9', cy: '16.5', r: '2' }]],
  panel: [['rect', { x: '3.5', y: '4.5', width: '17', height: '15', rx: '2.5' }], ['path', { d: 'M9.5 4.5v15' }]],
  activity: [['path', { d: 'M3.5 12h4l2.5-7 4 14 2.5-7h4' }]],
  menu: [['path', { d: 'M4.5 7h15M4.5 12h15M4.5 17h15' }]],
  more: [['circle', { cx: '6', cy: '12', r: '1.3', fill: DOT }], ['circle', { cx: '12', cy: '12', r: '1.3', fill: DOT }], ['circle', { cx: '18', cy: '12', r: '1.3', fill: DOT }]],
  search: [['circle', { cx: '10.5', cy: '10.5', r: '6' }], ['path', { d: 'M15 15l4.5 4.5' }]],
  // Content
  file: [['path', { d: 'M6.5 5a1.5 1.5 0 0 1 1.5-1.5h5.5l4 4V19a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 19z' }], ['path', { d: 'M13.5 3.5V7.5h4' }]],
  review: [['path', { d: 'M6.5 5a1.5 1.5 0 0 1 1.5-1.5h5.5l4 4V19a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 19z' }], ['path', { d: 'M9.5 13.5l2 2 3.5-3.5' }]],
  folder: [['path', { d: 'M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2.5h7.2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z' }]],
  image: [['rect', { x: '3.5', y: '5', width: '17', height: '14', rx: '2.5' }], ['circle', { cx: '9', cy: '10', r: '1.5' }], ['path', { d: 'M20.5 15.5l-4.5-4.5-8.5 8' }]],
  diff: [['path', { d: 'M7.5 4.5v6M4.5 7.5h6' }], ['path', { d: 'M13.5 16.5h6' }], ['path', { d: 'M17.5 4.5l-11 15' }]],
  globe: [['circle', { cx: '12', cy: '12', r: '8.5' }], ['ellipse', { cx: '12', cy: '12', rx: '3.5', ry: '8.5' }], ['path', { d: 'M3.5 12h17' }]],
  computer: [['rect', { x: '3.5', y: '4.5', width: '17', height: '11.5', rx: '2' }], ['path', { d: 'M9 19.5h6M12 16v3.5' }]],
  storage: [['ellipse', { cx: '12', cy: '6.5', rx: '7', ry: '2.5' }], ['path', { d: 'M5 6.5v11c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-11' }], ['path', { d: 'M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5' }]],
  archive: [['rect', { x: '3.5', y: '4.5', width: '17', height: '4', rx: '1.2' }], ['path', { d: 'M5 8.5V18a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18V8.5' }], ['path', { d: 'M10 12.5h4' }]],
  keyboard: [['rect', { x: '3', y: '6', width: '18', height: '12', rx: '2.5' }], ['path', { d: 'M7 10h.01M10.3 10h.01M13.6 10h.01M17 10h.01M8 14.5h8' }]],
  card: [['rect', { x: '3.5', y: '6', width: '17', height: '12', rx: '2.5' }], ['path', { d: 'M3.5 10h17M7 14.5h3' }]],
  remote: [['rect', { x: '7.5', y: '3.5', width: '9', height: '17', rx: '2.2' }], ['path', { d: 'M11 17.5h2' }]],
  microphone: [['rect', { x: '9', y: '3.5', width: '6', height: '10', rx: '3' }], ['path', { d: 'M6 11a6 6 0 0 0 12 0M12 17v3.5' }]],
  queue: [['path', { d: 'M4.5 7h11M4.5 12h11M4.5 17h7' }], ['path', { d: 'M17.5 14.5v5M15 17h5' }]],
  // State and actions
  plus: [['path', { d: 'M12 5.5v13M5.5 12h13' }]],
  close: [['path', { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' }]],
  check: [['path', { d: 'M5.5 12.5l4 4 9-9' }]],
  down: [['path', { d: 'M7 10l5 5 5-5' }]],
  right: [['path', { d: 'M10 7l5 5-5 5' }]],
  left: [['path', { d: 'M14 7l-5 5 5 5' }]],
  up: [['path', { d: 'M12 18.5v-13M6.5 11l5.5-5.5 5.5 5.5' }]],
  back: [['path', { d: 'M19 12H5.5M10.5 7l-5 5 5 5' }]],
  refresh: [['path', { d: 'M19 12a7 7 0 1 1-2.05-4.95' }], ['path', { d: 'M19 4.5V8h-3.5' }]],
  reset: [['path', { d: 'M5 12a7 7 0 1 0 2.05-4.95' }], ['path', { d: 'M5 4.5V8h3.5' }]],
  download: [['path', { d: 'M12 4.5v10M7.5 10l4.5 4.5 4.5-4.5' }], ['path', { d: 'M5 19.5h14' }]],
  stop: [['rect', { x: '7', y: '7', width: '10', height: '10', rx: '2', fill: DOT }]],
  clock: [['circle', { cx: '12', cy: '12', r: '8.5' }], ['path', { d: 'M12 7.5V12l3 2' }]],
  bolt: [['path', { d: 'M13 3.5L6.5 13h5l-1 7.5 6.5-9.5h-5z' }]],
  spark: [['path', { d: 'M12 4c.6 3.9 2.1 5.4 6 6-3.9.6-5.4 2.1-6 6-.6-3.9-2.1-5.4-6-6 3.9-.6 5.4-2.1 6-6z' }], ['circle', { cx: '18.5', cy: '18.5', r: '1.2', fill: DOT }]],
  shield: [['path', { d: 'M12 3.5l7 2.5v5.5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z' }]],
  lock: [['rect', { x: '5.5', y: '10.5', width: '13', height: '9.5', rx: '2' }], ['path', { d: 'M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5' }]],
  bell: [['path', { d: 'M6.5 16.5v-5a5.5 5.5 0 0 1 11 0v5l1.5 1.5h-14z' }], ['path', { d: 'M10 20.5h4' }]],
  info: [['circle', { cx: '12', cy: '12', r: '8.5' }], ['path', { d: 'M12 11v5' }], ['circle', { cx: '12', cy: '8', r: '1', fill: DOT }]],
  grid: [['rect', { x: '4.5', y: '4.5', width: '6', height: '6', rx: '1.5' }], ['rect', { x: '13.5', y: '4.5', width: '6', height: '6', rx: '1.5' }], ['rect', { x: '4.5', y: '13.5', width: '6', height: '6', rx: '1.5' }], ['rect', { x: '13.5', y: '13.5', width: '6', height: '6', rx: '1.5' }]],
};
const SAFE_TAGS = new Set(['path', 'rect', 'circle', 'line', 'polyline', 'polygon', 'ellipse']);
function appendNode(document, parent, [tag, attributes]) {
  if (!SAFE_TAGS.has(tag)) return;
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  parent.append(node);
}
export const iconNames = Object.freeze(Object.keys(ICONS));
export function icon(document, name, { size = 18 } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'ui-icon' })) svg.setAttribute(key, String(value));
  for (const entry of Object.hasOwn(ICONS, name) ? ICONS[name] : ICONS.info) appendNode(document, svg, entry);
  return svg;
}
export function hydrateIcons(document, root = document) { for (const node of root.querySelectorAll('[data-icon]')) node.replaceWith(icon(document, node.dataset.icon)); }
