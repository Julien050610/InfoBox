import test from 'node:test';
import assert from 'node:assert/strict';
import { activeFilterCount, filterItems, scopeItems } from '../web/library/filtering.js';
import { markdownToHtml } from '../web/markdown.js';

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
