/** Viewport math only: loaded logical rows stay in the store; no pagination here. */
export function historyViewport(rows, heights, top, height, overscan = 1000) {
  let offset = 0;
  return rows.map(row => {
    const size = heights.get(row.id) || 320;
    const visible = offset + size >= top - overscan && offset <= top + height + overscan;
    const result = {id:row.id, size, visible}; offset += size; return result;
  });
}
