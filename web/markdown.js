import { headingSlug, parseWikiLinks } from './vault-links.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function inline(value, assetUrl = name => name, wikiLink = null, allowEmbeds = true) {
  const replacements = [];
  const withTokens = String(value).replace(/`[^`\n]*`|!?\[\[[^\]\n]+\]\]/g, raw => {
    if (raw.startsWith('`')) return raw;
    const link = parseWikiLinks(raw)[0];
    if (!link) return raw;
    const token = `\uE000${replacements.length}\uE001`;
    const imageName = link.embed && /\.(png|jpe?g|gif|webp)$/i.test(link.target) && !/[\\/]/.test(link.target) ? link.target : null;
    if (imageName) replacements.push(`<img src="${escapeHtml(assetUrl(imageName))}" alt="${escapeHtml(link.label || imageName)}" loading="lazy">`);
    else {
      const target = wikiLink?.(link.target);
      const label = escapeHtml(link.label || target?.title || link.target || link.heading);
      if (!target?.id) replacements.push(`<span class="wiki-unresolved">${escapeHtml(raw)}</span>`);
      else if (link.embed && allowEmbeds) replacements.push(`<span class="wiki-embed" data-wiki-embed="${escapeHtml(target.id)}">${label}</span>`);
      else replacements.push(`<a href="#" data-wiki-note="${escapeHtml(target.id)}" data-wiki-heading="${escapeHtml(link.heading)}">${label}</a>`);
    }
    return token;
  });
  let source = escapeHtml(withTokens);
  source = source.replace(/!\[([^\]]*)\]\(((?:assets\/|\.\.\/attachments\/[^/]+\/)[^)\s]+)\)/g, (_, alt, path) => {
    const relative = path.startsWith('assets/') ? path.slice('assets/'.length) : path.split('/').at(-1);
    const name = relative.split('/').map(part => { try { return decodeURIComponent(part); } catch { return part; } }).join('-');
    return `<img src="${escapeHtml(assetUrl(name))}" alt="${alt}" loading="lazy">`;
  });
  source = source.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  source = source.replace(/\[([^\]]+)\]\(([^)\s]+\.md(?:#[^)\s]+)?)\)/g, (raw, label, path) => {
    const [file, heading = ''] = path.split('#', 2);
    const name = file.split('/').at(-1).replace(/\.md$/i, '');
    const target = wikiLink?.(name);
    return target?.id ? `<a href="#" data-wiki-note="${escapeHtml(target.id)}" data-wiki-heading="${escapeHtml(heading)}">${label}</a>` : raw;
  });
  source = source.replace(/(^|[^\\])\$([^$\n]+)\$/g, (_, prefix, expression) => `${prefix}<span class="math-inline" data-math>${expression}</span>`);
  source = source.replace(/`([^`]+)`/g, '<code>$1</code>');
  source = source.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  source = source.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  source = source.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  source = source.replace(/\uE000(\d+)\uE001/g, (_, index) => replacements[Number(index)] || '');
  return source;
}

const tableCells = line => String(line).trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
const tableDivider = line => tableCells(line).every(cell => /^:?-{3,}:?$/.test(cell));

export function markdownToHtml(markdown, { assetUrl, wikiLink, allowEmbeds = true } = {}) {
  const resolveAsset = assetUrl || (name => `assets/${encodeURIComponent(name)}`);
  const renderInline = value => inline(value, resolveAsset, wikiLink, allowEmbeds);
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const result = [];
  let paragraph = [];
  let list = null;
  let code = null;
  const flushParagraph = () => {
    if (paragraph.length) result.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
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
      result.push(`<table><thead><tr>${headings.map(cell => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headings.map((_, index) => `<td>${renderInline(row[index] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { flushParagraph(); closeList(); const level = heading[1].length; result.push(`<h${level} id="${escapeHtml(headingSlug(heading[2]))}">${renderInline(heading[2])}</h${level}>`); continue; }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      flushParagraph();
      const type = bullet ? 'ul' : 'ol';
      if (list !== type) { closeList(); result.push(`<${type}>`); list = type; }
      const value = (bullet || ordered)[1];
      const task = bullet && value.match(/^\[([ xX])\]\s+(.+)$/);
      result.push(task
        ? `<li class="task-list-item"><input type="checkbox"${task[1].toLowerCase() === 'x' ? ' checked' : ''} disabled> ${renderInline(task[2])}</li>`
        : `<li>${renderInline(value)}</li>`);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { flushParagraph(); closeList(); result.push(`<blockquote>${renderInline(quote[1])}</blockquote>`); continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { flushParagraph(); closeList(); result.push('<hr>'); continue; }
    if (!line.trim()) { flushParagraph(); closeList(); continue; }
    closeList(); paragraph.push(line.trim());
  }
  flushParagraph(); closeList();
  if (code !== null) result.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  return result.join('\n');
}
