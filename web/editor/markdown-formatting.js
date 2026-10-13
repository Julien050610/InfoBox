const clampSelection = (text, from, to) => {
  const start = Math.max(0, Math.min(Number(from) || 0, text.length));
  const end = Math.max(start, Math.min(Number(to) || start, text.length));
  return { start, end };
};

function replace(text, start, end, insertion, selectionStart, selectionEnd = selectionStart) {
  return {
    text: `${text.slice(0, start)}${insertion}${text.slice(end)}`,
    from: start + selectionStart,
    to: start + selectionEnd,
  };
}

function wrap(text, start, end, before, after = before, placeholder = '') {
  const selected = text.slice(start, end);
  const body = selected || placeholder;
  return replace(text, start, end, `${before}${body}${after}`, before.length, before.length + body.length);
}

function prefixLines(text, start, end, prefix, matchingPrefix) {
  const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const nextBreak = text.indexOf('\n', end);
  const lineEnd = nextBreak < 0 ? text.length : nextBreak;
  const source = text.slice(lineStart, lineEnd);
  const lines = source.split('\n');
  const remove = matchingPrefix && lines.every(line => !line.trim() || matchingPrefix.test(line));
  const output = lines.map(line => {
    if (!line.trim()) return line;
    if (remove) return line.replace(matchingPrefix, '');
    return `${prefix}${line}`;
  }).join('\n');
  return replace(text, lineStart, lineEnd, output, 0, output.length);
}

export function applyMarkdownCommand(source, from, to, command) {
  const text = String(source ?? '');
  const { start, end } = clampSelection(text, from, to);
  if (command === 'bold') return wrap(text, start, end, '**', '**', '粗体文字');
  if (command === 'italic') return wrap(text, start, end, '*', '*', '斜体文字');
  if (command === 'inline-code') return wrap(text, start, end, '`', '`', 'code');
  if (command === 'link') {
    const selected = text.slice(start, end) || '链接文字';
    const insertion = `[${selected}](https://)`;
    const urlStart = insertion.indexOf('https://');
    return replace(text, start, end, insertion, urlStart, urlStart + 8);
  }
  if (command === 'heading-1' || command === 'heading-2' || command === 'heading-3') {
    const level = Number(command.at(-1));
    const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const current = text.slice(lineStart).match(/^#{1,6}\s+/)?.[0] || '';
    const marker = `${'#'.repeat(level)} `;
    return replace(text, lineStart, lineStart + current.length, marker, marker.length, marker.length);
  }
  if (command === 'bullet') return prefixLines(text, start, end, '- ', /^\s*[-*+]\s+/);
  if (command === 'task') return prefixLines(text, start, end, '- [ ] ', /^\s*[-*+]\s+\[[ xX]\]\s+/);
  if (command === 'quote') return prefixLines(text, start, end, '> ', /^\s*>\s?/);
  if (command === 'table') {
    const table = '| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |';
    return replace(text, start, end, table, 2, 5);
  }
  if (command === 'code-block') {
    const selected = text.slice(start, end);
    const body = selected || '代码';
    return replace(text, start, end, `\`\`\`\n${body}\n\`\`\``, 4, 4 + body.length);
  }
  if (command === 'math') {
    const selected = text.slice(start, end);
    if (selected.includes('\n')) return replace(text, start, end, `$$\n${selected}\n$$`, 3, 3 + selected.length);
    return wrap(text, start, end, '$', '$', '公式');
  }
  return { text, from: start, to: end };
}

export function extractMarkdownOutline(source) {
  const text = String(source ?? '');
  const outline = [];
  let offset = 0;
  let fence = null;
  for (const line of text.split('\n')) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      fence = fence === marker ? null : fence || marker;
    } else if (!fence) {
      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) outline.push({ level: heading[1].length, text: heading[2].trim(), from: offset });
    }
    offset += line.length + 1;
  }
  return outline;
}
