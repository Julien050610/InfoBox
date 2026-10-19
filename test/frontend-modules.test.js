import test from 'node:test';
import assert from 'node:assert/strict';
import { activeFilterCount, filterItems, scopeItems } from '../web/library/filtering.js';
import { markdownToHtml } from '../web/markdown.js';
import { fitGraphViewport } from '../web/graph-viewport.js';
import { parseWikiLinks, resolveVaultTarget } from '../web/vault-links.js';
import { clampWorkspaceSize } from '../web/ui/workspace-layout.js';
import { folderAtPath, folderBreadcrumbs, folderPickerLevel } from '../web/ui/hierarchy-picker.js';

const filters = () => ({
  folder: '', kinds: [], tags: [], tagMode: 'and', status: '', readingStatuses: [], favorite: 'any', scoreMin: 0,
  publishedFrom: '', publishedTo: '', receivedFrom: '', receivedTo: '', sort: 'received_desc',
});

test('frontend filtering keeps scope, combined filters, and search score ordering independent from the DOM', () => {
  const state = {
    items: [
      { id: 'a', status: 'ready', category: 'AI/Agent', kind: 'pdf', tags: ['agent'], favorite: true, reading_status: 'reading', quality_score: 4, received_at: '2026-09-20', title: 'A' },
      { id: 'b', status: 'ready', category: 'AI/Vision', kind: 'image', tags: ['vision'], favorite: false, reading_status: 'unread', quality_score: 2, received_at: '2026-09-21', title: 'B' },
      { id: 'c', status: 'review', category: '未分类', kind: 'pdf', tags: [], favorite: false, reading_status: 'unread', quality_score: null, received_at: '2026-09-22', title: 'C' },
    ],
    scope: 'category', category: 'AI', query: '', searchMatches: new Map(), filters: filters(),
  };
  assert.deepEqual(scopeItems(state).map(item => item.id), ['a', 'b']);
  state.filters.kinds = ['pdf'];
  state.filters.tags = ['agent'];
  state.filters.favorite = 'yes';
  assert.deepEqual(filterItems(state).map(item => item.id), ['a']);
  assert.equal(activeFilterCount(state.filters), 3);

  state.filters = filters();
  state.query = 'match';
  state.searchMatches = new Map([['a', { score: 1 }], ['b', { score: 5 }]]);
  assert.deepEqual(filterItems(state).map(item => item.id), ['b', 'a']);
});

test('Markdown preview resolves legacy and Vault attachment paths through the note asset API', () => {
  const assetUrl = name => `/assets/${name}`;
  const html = markdownToHtml('![旧图](assets/old.png)\n\n![新图](../attachments/note-1/new%20image.png)', { assetUrl });
  assert.match(html, /src="\/assets\/old\.png"/);
  assert.match(html, /src="\/assets\/new image\.png"/);
});

test('Vault WikiLinks render headings and embeds without trusting link text as HTML', () => {
  const notes = [{ id: 'note-1', title: '研究笔记', aliases: ['旧标题'] }];
  const source = '# 核心贡献\n\n[[旧标题#核心贡献|查看章节]]\n\n![[note-1]]\n\n![[figure.png]]\n\n`[[代码]]`';
  const html = markdownToHtml(source, {
    assetUrl: name => `/assets/${encodeURIComponent(name)}`,
    wikiLink: target => resolveVaultTarget(target, notes),
  });
  assert.match(html, /id="核心贡献"/);
  assert.match(html, /data-wiki-note="note-1" data-wiki-heading="核心贡献"/);
  assert.match(html, /data-wiki-embed="note-1"/);
  assert.match(html, /src="\/assets\/figure.png"/);
  assert.match(html, /<code>\[\[代码\]\]<\/code>/);
  assert.deepEqual(parseWikiLinks('`[[忽略]]`\n[[note-1]]\n```\n[[也忽略]]\n```').map(link => link.target), ['note-1']);
  assert.doesNotMatch(markdownToHtml('[[<script>]]'), /<script>/);
});

test('graph viewport fits only highlighted nodes and centers them', () => {
  const nodes = [{ id: 'a', x: 100, y: 100 }, { id: 'b', x: 200, y: 180 }, { id: 'outside', x: 5000, y: 5000 }];
  const fitted = fitGraphViewport(nodes, new Set(['a', 'b']), 800, 600);
  assert.ok(fitted.scale > 1);
  assert.ok(fitted.scale <= 2.8);
  assert.ok(fitted.x + 100 * fitted.scale > 0);
  assert.ok(fitted.y + 100 * fitted.scale > 0);
  assert.ok(fitted.x + 5000 * fitted.scale > 800);
});

test('workspace layout keeps adjustable panes within usable bounds', () => {
  assert.equal(clampWorkspaceSize('sidebar', 120), 210);
  assert.equal(clampWorkspaceSize('sidebar', 900), 380);
  assert.equal(clampWorkspaceSize('inspector', 360), 360);
  assert.equal(clampWorkspaceSize('catalog', 600, 700), 450);
  assert.equal(clampWorkspaceSize('catalog', 50, 900), 150);
});

test('folder picker drills down one level and excludes a moved folder subtree', () => {
  const tree = { children: [
    { name: 'AI', path: 'AI', children: [{ name: 'Agent', path: 'AI/Agent', children: [] }] },
    { name: 'Physics', path: 'Physics', children: [] },
  ] };
  assert.equal(folderAtPath(tree, 'AI/Agent')?.name, 'Agent');
  assert.deepEqual(folderPickerLevel(tree, '').map(node => node.path), ['AI', 'Physics']);
  assert.deepEqual(folderPickerLevel(tree, '', 'AI').map(node => node.path), ['Physics']);
  assert.deepEqual(folderBreadcrumbs('AI/Agent'), [
    { label: 'Library', path: '' },
    { label: 'AI', path: 'AI' },
    { label: 'Agent', path: 'AI/Agent' },
  ]);
});
