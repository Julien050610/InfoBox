import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMarkdownCommand, extractMarkdownOutline } from '../web/editor/markdown-formatting.js';
import { markdownToHtml } from '../web/markdown.js';

test('Markdown editor commands wrap selections and insert structured blocks', () => {
  assert.deepEqual(applyMarkdownCommand('Agent', 0, 5, 'bold'), { text: '**Agent**', from: 2, to: 7 });
  assert.deepEqual(applyMarkdownCommand('第一行\n第二行', 0, 7, 'task').text, '- [ ] 第一行\n- [ ] 第二行');
  assert.match(applyMarkdownCommand('', 0, 0, 'table').text, /^\| 列 1 \| 列 2 \|/);
  assert.equal(applyMarkdownCommand('E=mc^2', 0, 6, 'math').text, '$E=mc^2$');
  assert.match(applyMarkdownCommand('const x = 1;', 0, 12, 'code-block').text, /```\nconst x = 1;\n```/);
});

test('Markdown outline ignores fenced code headings and keeps source offsets', () => {
  const source = '# 标题\n\n## 第一节\n\n```md\n# 代码示例\n```\n\n### 细节';
  const outline = extractMarkdownOutline(source);
  assert.deepEqual(outline.map(item => [item.level, item.text]), [[1, '标题'], [2, '第一节'], [3, '细节']]);
  assert.equal(source.slice(outline[1].from, outline[1].from + 3), '## ');
});

test('Markdown preview supports GFM tables, tasks, and safe formula placeholders', () => {
  const source = '| 名称 | 状态 |\n| --- | --- |\n| Vault | 完成 |\n\n- [x] 往返测试\n- [ ] 编辑器\n\n行内公式 $E=mc^2$\n\n$$\na^2+b^2=c^2\n$$';
  const html = markdownToHtml(source);
  assert.match(html, /<table>/);
  assert.match(html, /type="checkbox" checked disabled/);
  assert.match(html, /class="math-inline"/);
  assert.match(html, /class="math-block"/);
  assert.doesNotMatch(html, /<script>/);
});
