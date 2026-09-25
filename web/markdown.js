const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function inline(value, assetUrl = name => name) {
  let source = escapeHtml(value);
  source = source.replace(/!\[([^\]]*)\]\((assets\/[^)\s]+)\)/g, (_, alt, path) => {
    const name = path.slice('assets/'.length).split('/').map(part => { try { return decodeURIComponent(part); } catch { return part; } }).join('-');
    return `<img src="${escapeHtml(assetUrl(name))}" alt="${alt}" loading="lazy">`;
  });
  source = source.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  source = source.replace(/`([^`]+)`/g, '<code>$1</code>');
  source = source.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  source = source.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  return source;
}

export function markdownToHtml(markdown, { assetUrl } = {}) {
  const resolveAsset = assetUrl || (name => `assets/${encodeURIComponent(name)}`);
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const result = [];
  let paragraph = [];
  let list = null;
  let code = null;
  const flushParagraph = () => {
    if (paragraph.length) result.push(`<p>${inline(paragraph.join(' '), resolveAsset)}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list) result.push(`</${list}>`);
    list = null;
  };
  for (const line of lines) {
    if (code !== null) {
      if (/^```/.test(line)) { result.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; }
      else code.push(line);
      continue;
    }
    if (/^```/.test(line)) { flushParagraph(); closeList(); code = []; continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { flushParagraph(); closeList(); const level = heading[1].length; result.push(`<h${level}>${inline(heading[2], resolveAsset)}</h${level}>`); continue; }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      flushParagraph();
      const type = bullet ? 'ul' : 'ol';
      if (list !== type) { closeList(); result.push(`<${type}>`); list = type; }
      result.push(`<li>${inline((bullet || ordered)[1], resolveAsset)}</li>`);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { flushParagraph(); closeList(); result.push(`<blockquote>${inline(quote[1], resolveAsset)}</blockquote>`); continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { flushParagraph(); closeList(); result.push('<hr>'); continue; }
    if (!line.trim()) { flushParagraph(); closeList(); continue; }
    closeList(); paragraph.push(line.trim());
  }
  flushParagraph(); closeList();
  if (code !== null) result.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  return result.join('\n');
}
