// Phone viewport: keep the composer above the on-screen keyboard and expose its state to CSS.
// Uses visualViewport where available; no polling, no layout reads outside resize events.
export function watchKeyboard(window, root, { threshold = 120 } = {}) {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const update = () => {
    const covered = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    const open = covered > threshold;
    root.dataset.keyboard = open ? 'open' : 'closed';
    root.style.setProperty('--keyboard-inset', open ? `${Math.round(covered)}px` : '0px');
  };
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  update();
  return () => { viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update); };
}
