export function fitGraphViewport(nodes, ids, width, height, { padding = 46, minScale = .45, maxScale = 2.8 } = {}) {
  const visible = nodes.filter(node => ids.has(node.id) && Number.isFinite(node.x) && Number.isFinite(node.y));
  if (!visible.length) return { x: 0, y: 0, scale: 1 };
  const minX = Math.min(...visible.map(node => node.x - 18));
  const maxX = Math.max(...visible.map(node => node.x + 110));
  const minY = Math.min(...visible.map(node => node.y - 24));
  const maxY = Math.max(...visible.map(node => node.y + 24));
  const scale = Math.max(minScale, Math.min(maxScale,
    (width - padding * 2) / Math.max(1, maxX - minX),
    (height - padding * 2) / Math.max(1, maxY - minY)));
  return {
    x: (width - (minX + maxX) * scale) / 2,
    y: (height - (minY + maxY) * scale) / 2,
    scale,
  };
}
