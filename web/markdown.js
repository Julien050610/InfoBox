const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function inline(value, assetUrl = name => name) {
  let source = escapeHtml(value);
  source = source.replace(/!\[([^\]]*)\]\(((?:assets\/|\.\.\/attachments\/[^/]+\/)[^)\s]+)\)/g, (_, alt, path) => {
    const relative = path.startsWith('assets/') ? path.slice('assets/'.length) : path.split('/').at(-1);
    const name = relative.split('/').map(part => { try { return decodeURIComponent(part); } catch { return part; } }).join('-');
    return `<img src="${escapeHtml(assetUrl(name))}" alt="${alt}" loading="lazy">`;
  });
  source = source.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  source = source.replace(/(^|[^\\])\$([^$\n]+)\$/g, (_, prefix, expression) => `${prefix}<span class="math-inline" data-math>${expression}</span>`);
  source = source.replace(/`([^`]+)`/g, '<code>$1</code>');
  source = source.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  source = source.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  source = source.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return source;
}

const tableCells = line => String(line).trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
const tableDivider = line => tableCells(line).every(cell => /^:?-{3,}:?$/.test(cell));

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
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (code !== null) {
      if (/^```/.test(line)) { result.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; }
      else code.push(line);
      continue;
    }
    if (/^```/.test(line)) { flushParagraph(); closeList(); code = []; continue; }
    if (/^\s*\$\$\s*$/.test(line)) {
      flushParagraph(); closeList();
      const formula = [];
      for (lineIndex += 1; lineIndex < lines.length && !/^\s*\$\$\s*$/.test(lines[lineIndex]); lineIndex++) formula.push(lines[lineIndex]);
      result.push(`<div class="math-block" data-math>${escapeHtml(formula.join('\n'))}</div>`);
      continue;
    }
    if (line.includes('|') && lines[lineIndex + 1]?.includes('|') && tableDivider(lines[lineIndex + 1])) {
      flushParagraph(); closeList();
      const headings = tableCells(line);
      const rows = [];
      lineIndex += 2;
      while (lineIndex < lines.length && lines[lineIndex].trim() && lines[lineIndex].includes('|')) {
        rows.push(tableCells(lines[lineIndex]));
        lineIndex += 1;
      }
      lineIndex -= 1;
      result.push(`<table><thead><tr>${headings.map(cell => `<th>${inline(cell, resolveAsset)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headings.map((_, index) => `<td>${inline(row[index] || '', resolveAsset)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { flushParagraph(); closeList(); const level = heading[1].length; result.push(`<h${level}>${inline(heading[2], resolveAsset)}</h${level}>`); continue; }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      flushParagraph();
      const type = bullet ? 'ul' : 'ol';
      if (list !== type) { closeList(); result.push(`<${type}>`); list = type; }
      const value = (bullet || ordered)[1];
      const task = bullet && value.match(/^\[([ xX])\]\s+(.+)$/);
      result.push(task
        ? `<li class="task-list-item"><input type="checkbox"${task[1].toLowerCase() === 'x' ? ' checked' : ''} disabled> ${inline(task[2], resolveAsset)}</li>`
        : `<li>${inline(value, resolveAsset)}</li>`);
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
