import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZoteroClient } from '../src/zotero/zotero-client.js';
import { Library } from '../src/library.js';
import { createApi } from '../src/server.js';

test('ZoteroClient reads local API v3 resources without write calls', async () => {
  const requests = [];
  const client = new ZoteroClient({ fetchImpl: async (url, options) => {
    requests.push({ path: url.pathname, query: url.searchParams.toString(), method: options.method || 'GET', version: options.headers['Zotero-API-Version'] });
    if (url.pathname.endsWith('/items/ABCD1234')) return new Response(JSON.stringify({ key: 'ABCD1234', data: { key: 'ABCD1234', itemType: 'journalArticle', title: 'Paper' } }));
    return new Response(JSON.stringify([]));
  } });
  assert.equal((await client.status()).connected, true);
  await client.collections();
  await client.items({ collectionKey: 'EFGH5678', start: 50 });
  await client.children('ABCD1234');
  await client.tags();
  assert.equal((await client.item('ABCD1234')).data.title, 'Paper');
  assert.ok(requests.every(request => request.method === 'GET' && request.version === '3'));
  assert.ok(requests.some(request => request.path === '/api/users/0/collections/EFGH5678/items/top' && request.query.includes('start=50')));
  await assert.rejects(client.item('../bad'), error => error.code === 'VALIDATION_ERROR');
});

test('Zotero literature note is idempotent and keeps Zotero tags separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'infobox-zotero-note-'));
  const library = new Library({ root });
  await library.init({ watchInbox: false });
  try {
    const entry = { key: 'ABCD1234', data: { key: 'ABCD1234', itemType: 'journalArticle', title: 'An Agent Paper', DOI: '10.1234/agent', date: '2025-03-01',
      creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }], tags: [{ tag: 'agent' }], abstractNote: 'Abstract' } };
    const first = await library.createZoteroLiteratureNote(entry);
    const again = await library.createZoteroLiteratureNote(entry);
    assert.equal(first.id, again.id);
    assert.equal(first.kind, 'note');
    assert.equal(first.zotero_key, 'ABCD1234');
    assert.deepEqual(first.zotero_tags, ['agent']);
    assert.deepEqual(first.manual_tags, []);
    assert.deepEqual(first.authors, ['Ada Lovelace']);
    assert.match((await library.noteContent(first.id)).content, /## 我的理解/);
    assert.equal((await library.items()).filter(item => item.zotero_key === 'ABCD1234').length, 1);
    const concurrentEntry = { ...entry, key: 'EFGH5678', data: { ...entry.data, key: 'EFGH5678' } };
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => library.createZoteroLiteratureNote(concurrentEntry)));
    assert.equal(new Set(concurrent.map(note => note.id)).size, 1);
    assert.equal((await library.items()).filter(item => item.zotero_key === 'EFGH5678').length, 1);
    const create = library.vault.create.bind(library.vault);
    library.vault.create = async () => { throw new Error('simulated write failure'); };
    const retryEntry = { ...entry, data: { ...entry.data, key: 'IJKL9012' } };
    await assert.rejects(library.createZoteroLiteratureNote(retryEntry), /simulated write failure/);
    library.vault.create = create;
    assert.equal((await library.createZoteroLiteratureNote(retryEntry)).zotero_key, 'IJKL9012');
  } finally {
    library.close();
    if (!root.startsWith(join(tmpdir(), 'infobox-zotero-note-'))) throw new Error('Unsafe test cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});

test('Zotero read-only HTTP routes expose items, children, annotations, and local note creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'infobox-zotero-api-'));
  const library = new Library({ root });
  await library.init({ watchInbox: false });
  const calls = [];
  const zoteroClient = new ZoteroClient({ fetchImpl: async (url, options) => {
    calls.push({ path: url.pathname, method: options.method || 'GET' });
    const data = url.pathname.endsWith('/items/ABCD1234')
      ? { key: 'ABCD1234', data: { key: 'ABCD1234', title: 'Paper', itemType: 'journalArticle', tags: [{ tag: 'science' }] } }
      : url.pathname.endsWith('/items/ABCD1234/children')
        ? [{ key: 'PDFG5678', data: { key: 'PDFG5678', itemType: 'attachment', title: 'PDF', contentType: 'application/pdf' } }]
        : url.pathname.endsWith('/items/PDFG5678/children')
          ? [{ key: 'ANNO1234', data: { key: 'ANNO1234', itemType: 'annotation', annotationText: 'Finding' } }]
          : [];
    return new Response(JSON.stringify(data));
  } });
  const server = createApi(library, { zoteroClient });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await (await fetch(`${base}/api/zotero/status`)).json()).connected, true);
    assert.equal((await (await fetch(`${base}/api/zotero/items/ABCD1234/annotations`)).json())[0].data.annotationText, 'Finding');
    assert.equal((await fetch(`${base}/api/zotero/items/INVALID`)).status, 404);
    const created = await (await fetch(`${base}/api/zotero/items/ABCD1234/literature-note`, { method: 'POST' })).json();
    assert.equal(created.zotero_key, 'ABCD1234');
    assert.ok(calls.every(call => call.method === 'GET'));
  } finally {
    library.close();
    await new Promise(resolve => server.close(resolve));
    if (!root.startsWith(join(tmpdir(), 'infobox-zotero-api-'))) throw new Error('Unsafe test cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});
