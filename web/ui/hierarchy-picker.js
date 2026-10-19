export function folderAtPath(tree, path = '') {
  if (!path) return tree || { children: [] };
  const pending = [...(tree?.children || [])];
  while (pending.length) {
    const node = pending.shift();
    if (node.path === path) return node;
    pending.push(...(node.children || []));
  }
  return null;
}

export function folderPickerLevel(tree, path = '', excludedPath = '') {
  const current = folderAtPath(tree, path);
  return (current?.children || []).filter(node => !excludedPath || (node.path !== excludedPath && !node.path.startsWith(`${excludedPath}/`)));
}

export function folderBreadcrumbs(path = '') {
  const crumbs = [{ label: 'Library', path: '' }];
  const parts = String(path).split('/').filter(Boolean);
  parts.forEach((label, index) => crumbs.push({ label, path: parts.slice(0, index + 1).join('/') }));
  return crumbs;
}
