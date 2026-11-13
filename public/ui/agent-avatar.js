// Independently drawn geometric badges. Identity follows the agent thread, never its display name.
const SVG = 'http://www.w3.org/2000/svg';
const MODULUS = 2147483647;
const COLORS = {
  orange: ['#d9953d', '#f2b45f'], pink: ['#bb4b85', '#d674a8'],
  blue: ['#4089d7', '#65a9f5'], red: ['#e14f59', '#ff747a'],
  cyan: ['#228f9f', '#58c1cc'], purple: ['#8865b3', '#b394d0'],
  mint: ['#41b49a', '#7cddbf'], green: ['#65a946', '#94d46b'], yellow: ['#c4a12c', '#e0c34e'],
};
const PALETTE = ['orange','pink','blue','red','cyan','purple','mint','green','yellow','purple','yellow','orange','red','pink','purple','blue','mint','cyan','purple','orange','red','pink','purple','blue','green','mint','cyan','purple'];

export function agentAvatarIndex(identity) {
  const seed = String(identity ?? ''); let hash = 0;
  // Iterate UTF-16 code units: for...of would change non-BMP identities.
  for (let index = 0; index < seed.length; index++) hash = (31 * hash + seed.charCodeAt(index)) % MODULUS;
  return hash % 28;
}

export function createAgentAvatar(document, identity) {
  const index = agentAvatarIndex(identity);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false'); svg.classList.add('agent-avatar'); svg.dataset.avatarIndex = String(index);
  const [light, dark] = COLORS[PALETTE[index]];
  // Inherits the app's color-scheme; theme switches recolor existing nodes without observers or IDs.
  svg.setAttribute('style', `color:light-dark(${light},${dark});--agent-outline:color-mix(in srgb,currentColor 64%,#172020);--agent-glow:color-mix(in srgb,currentColor 68%,white)`);
  svg.setAttribute('fill', 'currentColor'); svg.setAttribute('stroke', 'var(--agent-outline)');
  svg.setAttribute('stroke-width', '.4'); svg.setAttribute('stroke-linejoin', 'round');
  const shape = (tag, attributes, parent = svg) => {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    parent.append(node); return node;
  };
  const circle = (cx, cy, r, extra = {}, parent = svg) => shape('circle', { cx, cy, r, ...extra }, parent);
  const path = (d, extra = {}, parent = svg) => shape('path', { d, ...extra }, parent);
  const rect = (x, y, width, height, rx, extra = {}, parent = svg) => shape('rect', { x, y, width, height, rx, ...extra }, parent);
  const repeat = (count, draw, offset = 0, angle = 360 / count) => {
    for (let step = 0; step < count; step++) draw(shape('g', { transform: `rotate(${offset + step * angle} 8 8)` }), step);
  };
  const diamond = (cx, cy, radius, extra = {}, parent = svg) => shape('polygon', { points: `${cx},${cy-radius} ${cx+radius},${cy} ${cx},${cy+radius} ${cx-radius},${cy}`, ...extra }, parent);
  const petal = (cx, cy, rx, ry, extra = {}, parent = svg) => shape('ellipse', { cx, cy, rx, ry, ...extra }, parent);
  const glow = { fill: 'var(--agent-glow)', 'fill-opacity': '.62' };
  const translucent = { 'fill-opacity': '.73' };
  switch (index) {
    case 0:
      repeat(2, group => rect(2.9, 2.9, 10.2, 10.2, 1.25, translucent, group), 0, 45);
      repeat(4, group => path('M8 8 8 2.2 12.1 8Z', { ...glow, 'fill-opacity': '.3' }, group));
      break;
    case 1:
      repeat(4, group => circle(8, 4.7, 3.5, translucent, group));
      circle(8, 8, 2.3, { 'fill-opacity': '.45' }); break;
    case 2:
      repeat(4, group => path('M8 8C3.6 10.6.7 7.1 2 4 3.6.7 9.3 1.5 8 8Z', translucent, group)); break;
    case 3:
      repeat(4, group => { circle(4.8, 4.8, 3.15, translucent, group); circle(4.8, 4.8, 1.9, { fill:'none', stroke:'var(--agent-glow)', 'stroke-width':'.65' }, group); }); break;
    case 4:
      path('M7.5 2A6 6 0 0 0 1.5 8H7.5Z', translucent);
      path('M1.5 8.5A6 6 0 0 0 7.5 14.5V8.5Z', glow);
      path('M8 8.5V14.5A6 6 0 0 0 14 8.5Z', translucent);
      path('M8.5 1.2V7.5H14.8A6.3 6.3 0 0 0 8.5 1.2Z', glow); break;
    case 5:
      circle(8, 8, 6.4, { 'fill-opacity':'.55' });
      petal(8, 8, 3.4, 6.4, { fill:'none' }); petal(8, 8, 6.4, 3.4, { fill:'none' });
      path('M8 1.7V14.3M1.7 8H14.3', { fill:'none', stroke:'var(--agent-glow)', 'stroke-width':'2.15', 'stroke-linecap':'round' });
      path('M8 1.7V14.3M1.7 8H14.3', { fill:'none', 'stroke-width':'.4' }); break;
    case 6:
      circle(8, 8, 6.7, glow); circle(8, 9.7, 5.1, translucent); circle(8, 11.2, 3.6, glow); circle(8, 12, 2.6, translucent); break;
    case 7:
      repeat(8, group => path('M8 8V1.2L11 4.2Z', translucent, group)); circle(8, 8, .7, glow); break;
    case 8:
      repeat(8, group => circle(8, 4.2, 2.5, translucent, group)); circle(8, 8, 2.75, { 'fill-opacity':'.65' }); break;
    case 9:
      diamond(8, 8, 6.5, translucent); circle(8, 8, 2.15, glow); circle(8, 1.6, 1.45, glow); circle(8, 14.4, 1.45, glow); break;
    case 10:
      repeat(8, group => rect(6.9, 1.1, 2.2, 6.9, 1.1, translucent, group)); circle(8, 8, 1.1, glow); break;
    case 11:
      repeat(4, group => path('M8 8C5.9 8.8 1 5.6 1.7 1.6 5.3.9 9.3 5.5 8 8Z', translucent, group)); circle(8, 8, .9, glow); break;
    case 12:
      repeat(4, group => path('M4.5 8V4.5Q4.5 1.4 8 1.4T11.5 4.5V8Z', translucent, group)); rect(5, 5, 6, 6, 1.4, { 'fill-opacity':'.4' }); break;
    case 13:
      repeat(6, group => petal(8, 4.7, 2, 3.5, translucent, group)); circle(8, 8, 1.9, glow); break;
    case 14:
      repeat(4, group => { diamond(8, 4, 2.9, translucent, group); circle(3, 3, 1, glow, group); }); circle(8, 8, 2, glow); break;
    case 15:
      circle(8, 8, 6.7, translucent); repeat(4, group => circle(8, 5.5, 3.9, { 'fill-opacity':'.42' }, group)); circle(8, 8, 2.4, { ...glow, 'fill-opacity':'.25' }); break;
    case 16:
      circle(8, 8, 6.7, glow); circle(8, 8, 5.4, { fill:'none', 'stroke-width':'.65' });
      repeat(4, group => circle(8, 5.5, 3.1, { fill:'none' }, group)); break;
    case 17:
      repeat(2, group => path('M2.8 1.5H13.2Q14.1 1.5 13.6 2.4L8.7 13.6Q8 14.7 7.3 13.6L2.4 2.4Q1.9 1.5 2.8 1.5Z', translucent, group)); break;
    case 18:
      repeat(2, group => { rect(4.2, 1.4, 2.4, 13.2, 1.2, translucent, group); rect(9.4, 1.4, 2.4, 13.2, 1.2, translucent, group); }, 0, 90); break;
    case 19: {
      const points = Array.from({ length:16 }, (_, step) => { const angle = step * Math.PI / 8 - Math.PI / 2, radius = step % 2 ? 3.9 : 7; return `${8+Math.cos(angle)*radius},${8+Math.sin(angle)*radius}`; }).join(' ');
      shape('polygon', { points, ...glow }); circle(8, 8, 1.65, translucent); break;
    }
    case 20:
      repeat(4, group => path('M8 8 4.7 4.8C1.4 1.4 5.4-.1 8 3 10.6-.1 14.6 1.4 11.3 4.8Z', translucent, group)); break;
    case 21:
      repeat(4, group => petal(8, 4.7, 2.8, 3.4, translucent, group), 45);
      repeat(4, group => circle(8, 1, .8, glow, group)); circle(8, 8, 1.8, glow); break;
    case 22:
      repeat(4, group => diamond(8, 4.6, 3.35, translucent, group)); diamond(8, 8, 1.55, glow); break;
    case 23:
      repeat(4, group => circle(8, 4.8, 3.35, translucent, group)); circle(8, 8, 2.45, { ...glow, 'fill-opacity':'.55' }); break;
    case 24:
      repeat(8, group => path('M8 8C3.5 7 2.6 3.6 3.7 1.4 7.8 2.2 9.2 5.2 8 8Z', translucent, group)); circle(8, 8, 1, glow); break;
    case 25:
      repeat(3, group => path('M8 8C4.5 5 5 .9 8 1.1 11 3.9 11.5 7 8 8Z', translucent, group)); circle(8, 8, 2.7, { fill:'none' }); break;
    case 26:
      repeat(8, group => path('M8 8C5.2 6.5 5 2.3 8 1.2 11 2.3 10.8 6.5 8 8Z', translucent, group)); diamond(8, 8, 3.15, glow); break;
    case 27:
      shape('polygon', { points:'4.8,1.6 11.2,1.6 14.4,4.8 14.4,11.2 11.2,14.4 4.8,14.4 1.6,11.2 1.6,4.8', 'fill-opacity':'.4' });
      for (let y=0; y<4; y++) for (let x=0; x<4; x++) {
        const left=1.6+x*3.2, top=1.6+y*3.2, right=left+3.2, bottom=top+3.2;
        const points=x===0&&y===0?`${right},${top} ${right},${bottom} ${left},${bottom}`:x===3&&y===0?`${left},${top} ${right},${bottom} ${left},${bottom}`:x===0&&y===3?`${left},${top} ${right},${top} ${right},${bottom}`:x===3&&y===3?`${left},${top} ${right},${top} ${left},${bottom}`:`${left},${top} ${right},${top} ${right},${bottom} ${left},${bottom}`;
        shape('polygon', { points, 'fill-opacity':(x+y)%2?'.32':'.78' });
      }
      break;
  }
  return svg;
}
