export function headingSlug(text) {
  return String(text || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
}

export function parseWikiLinks(markdown) {
  const source = String(markdown || '').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const wiki = [...source.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)].map(match => {
    const [address, label] = match[2].split('|', 2);
    const hash = address.indexOf('#');
    return {
      target: (hash < 0 ? address : address.slice(0, hash)).trim(),
      heading: hash < 0 ? '' : address.slice(hash + 1).trim(),
      label: (label || '').trim(),
      embed: Boolean(match[1]),
    };
  });
  const standard = [...source.matchAll(/(?<!!)\[([^\]\n]+)\]\(([^)\s]+\.md(?:#[^)\s]+)?)\)/g)].map(match => {
    const [path, heading = ''] = match[2].split('#', 2);
    return { target: path.split('/').at(-1).replace(/\.md$/i, ''), heading, label: match[1], embed: false };
  });
  return [...wiki, ...standard];
}

export function resolveVaultTarget(target, notes, currentId = '') {
  const name = String(target || '').trim().replace(/\.md$/i, '');
  if (!name) return notes.find(note => note.id === currentId) || null;
  const direct = notes.find(note => note.id === name);
  if (direct) return direct;
  const matches = notes.filter(note => note.title === name || (note.aliases || []).includes(name) ||
    (note.vault_properties?.aliases || []).includes(name));
  return matches.length === 1 ? matches[0] : null;
}
