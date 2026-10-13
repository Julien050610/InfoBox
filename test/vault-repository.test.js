import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { Library } from '../src/library.js';
import { VaultRepository } from '../src/vault/vault-repository.js';

async function withFixture(prefix, run) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try { await run(root); }
  finally {
    if (!root.startsWith(join(tmpdir(), prefix))) throw new Error('Unsafe test cleanup path');
    await rm(root, { recursive: true, force: true });
  }
}

test('VaultRepository preserves unknown YAML and manual tags during round trips', async () => withFixture('infobox-vault-roundtrip-', async root => {
  const repository = new VaultRepository({ root: join(root, 'vault') });
  await repository.init();
  const created = await repository.create({
    id: 'note-roundtrip', type: 'note', title: '往返测试', category: 'Computer Science/AI', status: 'processed',
    manual_tags: ['人工智能/Transformer'], zotero_tags: ['attention'], agent_tags: ['sequence-modeling'],
  }, '# 正文\n\n初始内容');

  const externalSource = (await readFile(created.path, 'utf8')).replace(
    'status: processed',
    'status: processed\n# Obsidian 插件设置\nplugin_field:\n  color: blue\n  folded: true',
  );
  await writeFile(created.path, externalSource);
  const fresh = await repository.read('note-roundtrip');
  const saved = await repository.update('note-roundtrip', {
    metadata: { agent_tags: ['self-attention'] },
    content: '# 正文\n\n由 IB 修改',
    expectedRevision: fresh.revision,
  });

  const source = await readFile(created.path, 'utf8');
  const yaml = source.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
  const metadata = parseDocument(yaml).toJS();
  assert.deepEqual(metadata.plugin_field, { color: 'blue', folded: true });
  assert.match(source, /# Obsidian 插件设置/);
  assert.deepEqual(metadata.manual_tags, ['人工智能/Transformer']);
  assert.deepEqual(metadata.agent_tags, ['self-attention']);
  assert.deepEqual(metadata.tags, ['人工智能/Transformer', 'attention', 'self-attention']);
  assert.equal(saved.content, '# 正文\n\n由 IB 修改');
}));

test('VaultRepository rejects stale saves without overwriting external edits', async () => withFixture('infobox-vault-conflict-', async root => {
  const repository = new VaultRepository({ root: join(root, 'vault') });
  await repository.init();
  const created = await repository.create({ id: 'note-conflict', type: 'note', title: '冲突测试' }, 'IB 初始正文');
  const opened = await repository.read('note-conflict');
  await writeFile(created.path, (await readFile(created.path, 'utf8')).replace('IB 初始正文', 'Obsidian 外部修改'));

  await assert.rejects(
    repository.update('note-conflict', { content: 'IB 的过期编辑', expectedRevision: opened.revision }),
    error => error?.code === 'VAULT_WRITE_CONFLICT' && error?.status === 409,
  );
  assert.match(await readFile(created.path, 'utf8'), /Obsidian 外部修改/);
  assert.equal((await repository.read('note-conflict')).content, 'Obsidian 外部修改');
}));

test('VaultRepository reports external Markdown changes', async () => withFixture('infobox-vault-watch-', async root => {
  const repository = new VaultRepository({ root: join(root, 'vault') });
  await repository.init();
  const created = await repository.create({ id: 'note-watch', type: 'note', title: '监测测试' }, '初始正文');
  const changed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Vault watcher did not report the change')), 3000);
    repository.watch(event => {
      if (event.id !== 'note-watch') return;
      clearTimeout(timeout);
      resolve(event);
    });
  });
  try {
    await writeFile(created.path, (await readFile(created.path, 'utf8')).replace('初始正文', '外部正文'));
    assert.equal((await changed).id, 'note-watch');
    assert.equal((await repository.read('note-watch')).content, '外部正文');
  } finally { repository.close(); }
}));

test('new independent notes use portable Markdown while bound notes stay legacy compatible', async () => withFixture('infobox-vault-library-', async root => {
  const library = new Library({ root });
  await library.init({ watchInbox: false });
  try {
    const note = await library.createLibraryNote({ title: '独立笔记', category: 'AI/Agent', content: '# Agent\n\n内容' });
    assert.equal(note.storage, 'vault');
    assert.equal(note.metadata_path, null);
    assert.match(note.asset_path, /vault[\\/]notes[\\/].+\.md$/);
    assert.equal((await library.noteContent(note.id)).content, '# Agent\n\n内容');
    const edited = await library.patchItem(note.id, { tags: ['用户标签'], category: 'AI/Tools' });
    assert.deepEqual(edited.tags, ['用户标签']);
    assert.equal((await library.vault.read(note.id)).metadata.manual_tags[0], '用户标签');
    await writeFile(note.asset_path, (await readFile(note.asset_path, 'utf8')).replaceAll('用户标签', 'Obsidian标签').replace('# Agent', '# 外部标题'));
    assert.deepEqual((await library.items()).find(item => item.id === note.id).tags, ['Obsidian标签']);
    assert.match((await library.noteContent(note.id)).content, /# 外部标题/);

    const sourceFolder = join(root, 'library', 'AI');
    await mkdir(sourceFolder, { recursive: true });
    const sourceAsset = join(sourceFolder, 'paper.pdf');
    await writeFile(sourceAsset, 'pdf');
    await writeFile(join(sourceFolder, 'paper.json'), JSON.stringify({
      id: 'paper-source', title: 'Paper', category: 'AI', tags: [], status: 'ready', kind: 'pdf', summary: '', quality_score: null,
      published_at: null, received_at: '2026-10-13', asset_path: sourceAsset, original_name: 'paper.pdf',
    }));
    const bound = await library.createLibraryNote({ title: '绑定笔记', bound_item_id: 'paper-source', content: '绑定正文' });
    assert.notEqual(bound.storage, 'vault');
    assert.ok((await library.items()).find(item => item.id === bound.id).metadata_path);
  } finally { library.close(); }
}));

test('vault attachments use stable relative paths', async () => withFixture('infobox-vault-assets-', async root => {
  const repository = new VaultRepository({ root: join(root, 'vault') });
  await repository.init();
  await repository.create({ id: 'note-assets', type: 'note', title: '附件测试' }, '正文');
  const attachment = await repository.addAttachment('note-assets', 'diagram.png', Buffer.from('image'));
  assert.equal(attachment.relativePath, '../attachments/note-assets/diagram.png');
  assert.equal((await stat(join(root, 'vault', 'attachments', 'note-assets', 'diagram.png'))).isFile(), true);
}));

test('legacy note migration leaves its source intact and can roll back', async () => withFixture('infobox-vault-migration-', async root => {
  const library = new Library({ root });
  await library.init({ watchInbox: false });
  try {
    const folder = join(root, 'library', 'Legacy');
    await mkdir(join(folder, 'legacy.assets'), { recursive: true });
    const metadataPath = join(folder, 'legacy.json');
    const contentPath = join(folder, 'legacy.md');
    await writeFile(join(folder, 'legacy.assets', 'figure.png'), 'image');
    await writeFile(contentPath, '# 旧笔记\n\n![图](assets/figure.png)');
    await writeFile(metadataPath, JSON.stringify({
      id: 'legacy-note', status: 'ready', kind: 'note', title: '旧笔记', category: 'Legacy', tags: ['manual'], summary: '摘要',
      quality_score: null, published_at: null, received_at: '2026-10-13', asset_path: contentPath, original_name: '旧笔记.md',
      custom_legacy_field: { retained: true },
    }));

    const preview = await library.previewNoteMigration('legacy-note');
    assert.equal(preview.source_untouched, true);
    const migrated = await library.migrateNoteToVault('legacy-note');
    assert.equal(migrated.storage, 'vault');
    assert.equal((await stat(metadataPath)).isFile(), true);
    assert.match((await library.noteContent('legacy-note')).content, /\.\.\/attachments\/legacy-note\/figure\.png/);
    assert.equal((await library.items()).filter(item => item.id === 'legacy-note').length, 1);
    assert.deepEqual((await library.vault.read('legacy-note')).metadata.custom_legacy_field, { retained: true });

    await library.rollbackNoteMigration('legacy-note');
    const restored = (await library.items()).find(item => item.id === 'legacy-note');
    assert.notEqual(restored.storage, 'vault');
    assert.equal(await readFile(contentPath, 'utf8'), '# 旧笔记\n\n![图](assets/figure.png)');
  } finally { library.close(); }
}));
