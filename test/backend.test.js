import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractHtml, extractPdf } from '../src/extract.js';
import { analyzeContent, decideWithJev } from '../src/models.js';
import { Library } from '../src/library.js';
import { createApi } from '../src/server.js';
import { processInbox } from '../src/run-once.js';

function samplePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 53 >>\nstream\nBT /F1 12 Tf 50 250 Td (Agent Harness Design) Tj ET\nendstream',
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(source);
}

async function waitForJob(base, id) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await fetch(`${base}/api/jobs/${id}`);
    const job = await response.json();
    if (job.status === 'ready' || job.status === 'review') return job;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Job did not finish');
}

test('extracts article text, video metadata, and PDF text', async () => {
  const article = extractHtml('<html><head><title>Paper</title><meta property="article:published_time" content="2026-09-10T12:00:00Z"></head><body><nav>Skip me</nav><article><p>Agent harness design is explained in this long paragraph about tool calling.</p></article></body></html>', 'https://example.org/paper');
  assert.equal(article.kind, 'article');
  assert.match(article.text, /harness design/);
  assert.doesNotMatch(article.text, /Skip me/);
  assert.equal(article.publishedAt, '2026-09-10T12:00:00Z');
  const video = extractHtml('<title>Interesting Agent Talk</title><meta name="description" content="An overview of agent tools">', 'https://www.youtube.com/watch?v=123');
  assert.equal(video.kind, 'video');
  assert.equal(video.basis, 'title_description');
  const structuredVideo = extractHtml('<script type="application/ld+json">{"@type":"VideoObject","name":"Talk","description":"Agent design","uploadDate":"2026-09-01"}</script>', 'https://example.org/talk');
  assert.equal(structuredVideo.kind, 'video');
  assert.equal(structuredVideo.publishedAt, '2026-09-01');
  const pdf = await extractPdf(samplePdf());
  assert.match(pdf.text, /Agent Harness Design/);
});

test('Jev selects bounded category and tags and flags uncertainty', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ answers: {
    category: { choice: 'c0', confidence: 0.91 }, insufficient: { noul: 0.1 },
    tag0: { noul: 0.92 }, tag1: { noul: 0.12 },
  } }) });
  const decision = await decideWithJev({ kind: 'article', basis: 'full_text', title: 'Agent article', description: '', text: 'Tool calling' },
    { category: 'AI/Agent', tags: ['agent', 'cooking'], summary: 'Tool calling' },
    { apiKey: 'test', categories: ['AI/Agent'], fetchImpl });
  assert.equal(decision.category, 'AI/Agent');
  assert.deepEqual(decision.tags, ['agent']);
  assert.equal(decision.needs_review, false);
});

test('image analysis flags unreadable handwriting for review', async () => {
  const responses = [
    { description: '一页手写笔记', visible_text: 'Agent ...', handwriting: true, readable: false },
    { title: 'Agent Notes', summary: '这是一页 Agent 手写笔记。', category: 'AI/Agent', tags: ['agent'], needs_review: false, review_reason: '', published_at: null },
  ];
  const fetchImpl = async (_, request) => {
    const payload = JSON.parse(request.body);
    assert.equal(payload.store, false);
    return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(responses.shift()) }] }] }) };
  };
  const result = await analyzeContent({ kind: 'image', basis: 'image', imageMime: 'image/png', imageBuffer: Buffer.from('x'), text: '' }, { provider: 'openai', apiKey: 'test', fetchImpl });
  assert.equal(result.needs_review, true);
  assert.match(result.review_reason, /手写/);
});

test('DeepSeek drives both image extraction and knowledge analysis', async () => {
  const calls = [];
  const responses = [
    { description: '一张包含流程图的图片', visible_text: 'Inbox -> Library', handwriting: false, readable: true },
    { title: 'Inbox-Workflow', summary: '这张图展示了收件箱到知识库的流程。', category: 'AI/Agent', tags: ['agent'], needs_review: false, review_reason: '', published_at: null, publication_evidence: '' },
  ];
  const fetchImpl = async (url, request) => {
    calls.push({ url, body: JSON.parse(request.body) });
    return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(responses.shift()) }] }] }) };
  };
  const result = await analyzeContent({ kind: 'image', basis: 'image', imageMime: 'image/png', imageBuffer: Buffer.from('x'), text: '' },
    { provider: 'deepseek', apiKey: 'test', model: 'deepseek-v4-pro', fetchImpl });
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.model, 'deepseek-v4-pro');
  assert.equal(result.vision_model, 'deepseek-flash');
  assert.equal(result.category, 'AI/Agent');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.url === 'https://api.deepseek.com/responses'));
  assert.equal(calls[0].body.model, 'deepseek-flash');
  assert.equal(calls[0].body.input[0].content[1].type, 'input_image');
  assert.equal(calls[1].body.model, 'deepseek-v4-pro');
  assert.equal(calls[1].body.text.format.type, 'json_schema');
  assert.equal(calls[1].body.text.format.strict, undefined);
  assert.equal(calls[1].body.store, undefined);
});

test('uploads, files, deduplicates, and updates manual quality score', async () => {
  const root = await mkdtemp(join(tmpdir(), 'infobox-test-'));
  const library = new Library({ root,
    analyze: async () => ({ title: 'Agent-Harness-Design', summary: '这篇内容介绍 Agent 工具调用。', category: 'AI/Agent', tags: ['agent', 'harness'], published_at: '2026-09-10', needs_review: false, review_reason: '' }),
    decide: async (_, analysis) => ({ category: analysis.category, tags: analysis.tags, needs_review: false, provider: 'test' }),
  });
  await library.init({ watchInbox: false });
  const server = createApi(library);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bytes = Buffer.from('not a real image but accepted by the fake analyzer');
    const upload = async () => {
      const response = await fetch(`${base}/api/inbox/files?filename=sample.png`, { method: 'POST', body: bytes });
      assert.equal(response.status, 202);
      return response.json();
    };
    const first = await upload();
    assert.equal((await waitForJob(base, first.id)).status, 'ready');
    const items = await (await fetch(`${base}/api/items`)).json();
    assert.equal(items.length, 1);
    assert.match(items[0].asset_path, /library[\\/]AI[\\/]Agent[\\/]2026-09-Agent-Harness-Design\.png$/);
    await stat(items[0].asset_path);
    const tree = await (await fetch(`${base}/api/library/tree`)).json();
    assert.equal(tree.count, 1);
    assert.equal(tree.children[0].path, 'AI');
    assert.equal(tree.children[0].children[0].path, 'AI/Agent');
    const asset = await fetch(`${base}/api/items/${items[0].id}/asset`, { headers: { range: 'bytes=0-2' } });
    assert.equal(asset.status, 206);
    assert.equal(await asset.text(), 'not');
    const note = await fetch(`${base}/api/items/${items[0].id}/markdown`);
    assert.match(await note.text(), /Agent-Harness-Design/);
    const createNote = await fetch(`${base}/api/items/${items[0].id}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ anchor: { type: 'document', x: 0.4, y: 0.5 } }) });
    assert.equal(createNote.status, 201);
    const anchoredNote = await createNote.json();
    const updateNote = await fetch(`${base}/api/items/${items[0].id}/notes/${anchoredNote.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '关键实验结论' }) });
    assert.equal((await updateNote.json()).content, '关键实验结论');
    assert.equal((await (await fetch(`${base}/api/items/${items[0].id}/notes`)).json()).length, 1);
    assert.equal((await fetch(`${base}/api/items/${items[0].id}/notes/${anchoredNote.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await (await fetch(`${base}/api/items/${items[0].id}/notes`)).json()).length, 0);
    const workbench = await fetch(base);
    assert.match(await workbench.text(), /InfoBox/);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.api_version, 9);
    const pdfRuntime = await fetch(`${base}/vendor/pdf.mjs`);
    assert.equal(pdfRuntime.status, 200);
    assert.match(await pdfRuntime.text(), /getDocument/);
    const patch = await fetch(`${base}/api/items/${items[0].id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quality_score: 4 }) });
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).quality_score, 4);
    assert.match(await readFile(items[0].metadata_path.slice(0, -5) + '.md', 'utf8'), /内容质量：4\/5/);
    const previousAssetPath = items[0].asset_path;
    const edit = await fetch(`${base}/api/items/${items[0].id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Agent-Harness-Updated', summary: '更新后的摘要。', tags: ['agent', 'edited'] }) });
    assert.equal(edit.status, 200);
    const edited = edit.json ? await edit.json() : null;
    assert.equal(edited.title, 'Agent-Harness-Updated');
    assert.deepEqual(edited.tags, ['agent', 'edited']);
    const refreshed = (await library.items()).find(item => item.id === items[0].id);
    assert.match(refreshed.asset_path, /2026-09-Agent-Harness-Updated\.png$/);
    assert.equal(await stat(previousAssetPath).then(() => true, () => false), false);
    assert.match(await readFile(refreshed.metadata_path.slice(0, -5) + '.md', 'utf8'), /更新后的摘要/);
    const second = await upload();
    assert.equal((await waitForJob(base, second.id)).status, 'review');
    const review = (await library.items()).find(item => item.id === second.id);
    assert.match(review.review_reason, /Duplicate/);
    const removeItem = await fetch(`${base}/api/items/${items[0].id}`, { method: 'DELETE' });
    assert.equal(removeItem.status, 200);
    assert.equal((await removeItem.json()).id, items[0].id);
    assert.equal(await stat(refreshed.asset_path).then(() => true, () => false), false);
    assert.equal(await stat(refreshed.metadata_path).then(() => true, () => false), false);
    assert.equal((await library.items()).some(item => item.id === items[0].id), false);
  } finally {
    library.close();
    await new Promise(resolve => server.close(resolve));
    if (!root.startsWith(join(tmpdir(), 'infobox-test-'))) throw new Error('Unsafe test cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps uploaded files pending until inbox classification is started manually', async () => {
  const root = await mkdtemp(join(tmpdir(), 'infobox-test-'));
  const library = new Library({ root,
    analyze: async () => ({ title: 'Pending-Image', summary: '一张待分类图片。', category: 'Images', tags: ['image'], published_at: null, needs_review: false, review_reason: '' }),
    decide: async (_, analysis) => ({ category: analysis.category, tags: analysis.tags, needs_review: false, provider: 'test' }),
  });
  await library.init({ watchInbox: false });
  const server = createApi(library);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const upload = await fetch(`${base}/api/inbox/files?defer=1&filename=pending.png`, { method: 'POST', body: Buffer.from('pending image') });
    assert.equal(upload.status, 202);
    assert.deepEqual(await upload.json(), { status: 'pending', name: 'pending.png' });
    assert.equal((await library.items()).length, 0);
    const pending = await (await fetch(`${base}/api/inbox`)).json();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].name, 'pending.png');
    assert.equal(pending[0].processing, false);

    await fetch(`${base}/api/inbox/files?defer=1&filename=delete-me.png`, { method: 'POST', body: Buffer.from('delete me') });
    const deleted = await fetch(`${base}/api/inbox/files?filename=delete-me.png`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { name: 'delete-me.png' });
    assert.deepEqual((await (await fetch(`${base}/api/inbox`)).json()).map(file => file.name), ['pending.png']);

    const process = await fetch(`${base}/api/inbox/process`, { method: 'POST' });
    assert.equal(process.status, 202);
    const batch = await process.json();
    assert.equal(batch.jobs.length, 1);
    assert.equal((await waitForJob(base, batch.jobs[0].id)).status, 'ready');
    assert.equal((await (await fetch(`${base}/api/inbox`)).json()).length, 0);
    assert.equal((await library.items()).length, 1);
  } finally {
    library.close();
    await new Promise(resolve => server.close(resolve));
    if (!root.startsWith(join(tmpdir(), 'infobox-test-'))) throw new Error('Unsafe test cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});

test('corrected handwriting can be reanalyzed and moved into the library', async () => {
  const root = await mkdtemp(join(tmpdir(), 'infobox-test-'));
  const library = new Library({ root,
    analyze: async extracted => ({ title: 'Handwritten-Agent-Notes', summary: extracted.basis === 'manual_correction' ? '人工校正后的 Agent 笔记摘要。' : '原始摘要', category: 'AI/Agent', tags: ['agent'], published_at: null, needs_review: extracted.basis !== 'manual_correction', review_reason: '字迹不清' }),
    decide: async (extracted, analysis) => ({ category: analysis.category, tags: analysis.tags, needs_review: extracted.basis !== 'manual_correction', review_reason: '字迹不清', provider: 'test' }),
  });
  await library.init({ watchInbox: false });
  const server = createApi(library);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/inbox/files?filename=notes.png`, { method: 'POST', body: Buffer.from('handwriting test') });
    const job = await response.json();
    assert.equal((await waitForJob(base, job.id)).status, 'review');
    const patch = await fetch(`${base}/api/items/${job.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ corrected_text: 'Agent 可以调用工具并记录执行结果。' }) });
    assert.equal(patch.status, 200);
    const reanalyze = await fetch(`${base}/api/items/${job.id}/reanalyze`, { method: 'POST' });
    assert.equal(reanalyze.status, 200);
    const item = await reanalyze.json();
    assert.equal(item.status, 'ready');
    assert.equal((await waitForJob(base, job.id)).status, 'ready');
    assert.match(item.summary, /人工校正/);
    assert.match(await readFile(item.asset_path.replace(/\.png$/, '.txt'), 'utf8'), /Agent 可以调用工具/);
  } finally {
    library.close();
    await new Promise(resolve => server.close(resolve));
    if (!root.startsWith(join(tmpdir(), 'infobox-test-'))) throw new Error('Unsafe test cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});

test('searches full text and persists organization metadata, views, and relations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'infobox-test-'));
  const library = new Library({ root });
  await library.init({ watchInbox: false });
  const records = [
    { id: '11111111-1111-4111-8111-111111111111', title: '等离子体控制', category: '核聚变/等离子体控制', tags: ['强化学习', '控制'], text: '托卡马克使用强化学习稳定等离子体。' },
    { id: '22222222-2222-4222-8222-222222222222', title: 'Agent 决策系统', category: 'Computer Science/Agent', tags: ['强化学习', 'agent'], text: '决策层调用工具完成任务。' },
  ];
  for (const record of records) {
    const folder = join(root, 'library', ...record.category.split('/'));
    await mkdir(folder, { recursive: true });
    const base = join(folder, record.title);
    const asset = `${base}.png`;
    await writeFile(asset, 'asset');
    await writeFile(`${base}.txt`, record.text);
    await writeFile(`${base}.md`, `# ${record.title}`);
    await writeFile(`${base}.json`, JSON.stringify({ ...record, status: 'ready', kind: 'image', summary: '摘要', quality_score: null, published_at: null, received_at: '2026-09-23', asset_path: asset, original_name: `${record.title}.png` }));
  }
  const server = createApi(library);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const search = await (await fetch(`${base}/api/search?q=${encodeURIComponent('托卡马克 强化学习')}`)).json();
    assert.deepEqual(search.map(result => result.id), [records[0].id]);
    assert.match(search[0].snippet, /托卡马克/);

    const patchResponse = await fetch(`${base}/api/items/${records[0].id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ favorite: true, reading_status: 'reading', last_opened_at: '2026-09-23T08:00:00.000Z', reading_progress: 0.4 }) });
    assert.equal(patchResponse.status, 200);
    const patched = await patchResponse.json();
    assert.equal(patched.favorite, true);
    assert.equal(patched.reading_status, 'reading');
    assert.equal(patched.reading_progress, 0.4);

    const createdView = await (await fetch(`${base}/api/views`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '强化学习收藏', query: '强化学习', scope: 'favorites', filters: { scoreMin: 3 } }) })).json();
    assert.equal((await (await fetch(`${base}/api/views`)).json()).length, 1);

    const createdRelation = await (await fetch(`${base}/api/relations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source_id: records[0].id, target_id: records[1].id, type: 'related' }) })).json();
    assert.equal((await (await fetch(`${base}/api/relations`)).json()).length, 1);
    assert.equal(createdRelation.type, 'related');

    assert.equal((await fetch(`${base}/api/views/${createdView.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await (await fetch(`${base}/api/views`)).json()).length, 0);
    assert.equal((await fetch(`${base}/api/items/${records[0].id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await (await fetch(`${base}/api/relations`)).json()).length, 0);
  } finally {
    library.close();
    await new Promise(resolve => server.close(resolve));
    if (!root.startsWith(join(tmpdir(), 'infobox-test-'))) throw new Error('Unsafe test cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});

test('creates two-level folders and moves a ready item between them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'infobox-test-'));
  const library = new Library({ root });
  await library.init({ watchInbox: false });
  const id = '33333333-3333-4333-8333-333333333333';
  const originalFolder = join(root, 'library', '强化学习');
  await mkdir(originalFolder, { recursive: true });
  const originalBase = join(originalFolder, '2026-09-强化学习导论');
  const originalAsset = `${originalBase}.pdf`;
  await writeFile(originalAsset, 'pdf');
  await writeFile(`${originalBase}.txt`, '强化学习正文');
  await writeFile(`${originalBase}.md`, '# 强化学习导论');
  await writeFile(`${originalBase}.json`, JSON.stringify({
    id, title: '强化学习导论', category: '强化学习', tags: ['强化学习'], status: 'ready', kind: 'pdf',
    summary: '摘要', quality_score: null, published_at: null, received_at: '2026-09-23', asset_path: originalAsset, original_name: '强化学习导论.pdf',
  }));
  const server = createApi(library);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const top = await fetch(`${base}/api/library/folders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Computer Science' }) });
    assert.equal(top.status, 201);
    const child = await fetch(`${base}/api/library/folders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '强化学习', parent: 'Computer Science' }) });
    assert.equal(child.status, 201);
    assert.equal((await child.json()).path, 'Computer Science/强化学习');

    const beforeMove = await (await fetch(`${base}/api/library/tree`)).json();
    assert.equal(beforeMove.name, 'Library');
    assert.equal(beforeMove.path, '');
    assert.equal(beforeMove.children.find(node => node.path === 'Computer Science').count, 0);

    const move = await fetch(`${base}/api/items/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: 'Computer Science/强化学习' }) });
    assert.equal(move.status, 200);
    const moved = await move.json();
    assert.equal(moved.category, 'Computer Science/强化学习');
    assert.match(moved.asset_path, /library[\\/]Computer Science[\\/]强化学习[\\/]2026-09-强化学习导论\.pdf$/);
    await stat(moved.asset_path);
    assert.equal(await stat(originalAsset).then(() => true, () => false), false);
    assert.match(await readFile(moved.asset_path.slice(0, -4) + '.md', 'utf8'), /主分类：Computer Science\/强化学习/);

    const afterMove = await (await fetch(`${base}/api/library/tree`)).json();
    const computerScience = afterMove.children.find(node => node.path === 'Computer Science');
    assert.equal(computerScience.count, 1);
    assert.equal(computerScience.children.find(node => node.path === 'Computer Science/强化学习').count, 1);
  } finally {
    library.close();
    await new Promise(resolve => server.close(resolve));
    if (!root.startsWith(join(tmpdir(), 'infobox-test-'))) throw new Error('Unsafe test cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});

test('previews, applies, and undoes taxonomy changes without breaking relations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'infobox-test-'));
  const records = [
    { id: '44444444-4444-4444-8444-444444444444', title: '强化学习导论', category: '强化学习', tags: ['强化学习'] },
    { id: '55555555-5555-4555-8555-555555555555', title: 'Agent 工具调用', category: 'Computer Science/Agent', tags: ['agent'] },
  ];
  const library = new Library({ root, restructure: async () => ({
    rationale: '把学科领域作为稳定的一级目录。',
    changes: [{ item_id: records[0].id, category: 'Computer Science/强化学习', reason: '强化学习属于计算机科学。', confidence: 0.96 }],
    provider: 'test', model: 'test-model',
  }) });
  await library.init({ watchInbox: false });
  for (const record of records) {
    const folder = join(root, 'library', ...record.category.split('/'));
    await mkdir(folder, { recursive: true });
    const stem = join(folder, record.title);
    const asset = `${stem}.pdf`;
    await writeFile(asset, 'pdf');
    await writeFile(`${stem}.txt`, '正文');
    await writeFile(`${stem}.md`, `# ${record.title}`);
    await writeFile(`${stem}.json`, JSON.stringify({ ...record, status: 'ready', kind: 'pdf', summary: '摘要', quality_score: null, published_at: null, received_at: '2026-09-23', asset_path: asset, original_name: `${record.title}.pdf` }));
  }
  await library.addRelation({ source_id: records[0].id, target_id: records[1].id, type: 'related' });
  const server = createApi(library);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const preview = await (await fetch(`${base}/api/restructure/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: '' }) })).json();
    assert.equal(preview.changes.length, 1);
    assert.equal(preview.changes[0].from, '强化学习');
    assert.equal((await library.items()).find(item => item.id === records[0].id).category, '强化学习');

    const appliedResponse = await fetch(`${base}/api/restructure/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(preview) });
    assert.equal(appliedResponse.status, 201);
    const applied = await appliedResponse.json();
    assert.equal((await library.items()).find(item => item.id === records[0].id).category, 'Computer Science/强化学习');
    assert.equal((await library.relations()).length, 1);
    assert.equal((await library.relations())[0].source_id, records[0].id);
    assert.equal((await library.restructureHistory())[0].status, 'applied');

    const undone = await fetch(`${base}/api/restructure/${applied.id}/undo`, { method: 'POST' });
    assert.equal(undone.status, 200);
    assert.equal((await library.items()).find(item => item.id === records[0].id).category, '强化学习');
    assert.equal((await library.relations()).length, 1);

    await library.addFolder({ name: 'Plasma' });
    const folderMove = await fetch(`${base}/api/library/folders`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'Computer Science', name: '计算机科学', parent: '' }) });
    assert.equal(folderMove.status, 200);
    const folderRecord = await folderMove.json();
    assert.equal((await library.items()).find(item => item.id === records[1].id).category, '计算机科学/Agent');
    assert.equal((await library.relations()).length, 1);
    assert.ok((await library.categories()).includes('计算机科学/Agent'));

    assert.equal((await fetch(`${base}/api/restructure/${folderRecord.id}/undo`, { method: 'POST' })).status, 200);
    assert.equal((await library.items()).find(item => item.id === records[1].id).category, 'Computer Science/Agent');
    assert.equal((await library.relations()).length, 1);
  } finally {
    library.close();
    await new Promise(resolve => server.close(resolve));
    if (!root.startsWith(join(tmpdir(), 'infobox-test-'))) throw new Error('Unsafe test cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});

test('supports deep folders and snapshot rollback without moving later items', async () => {
  const root = await mkdtemp(join(tmpdir(), 'infobox-test-'));
  const originalId = '77777777-7777-4777-8777-777777777777';
  const outsideId = '88888888-8888-4888-8888-888888888888';
  const library = new Library({ root, restructure: async items => ({
    rationale: '补全稳定的学科层级。',
    changes: items.map(item => ({ item_id: item.id, category: 'Computer Science/AI/强化学习/策略优化', reason: '补充学科上下文。', confidence: 0.95 })),
    provider: 'test', model: 'test-model',
  }) });
  await library.init({ watchInbox: false });
  const writeItem = async (id, title, category) => {
    const folder = join(root, 'library', ...category.split('/'));
    await mkdir(folder, { recursive: true });
    const stem = join(folder, title);
    const asset = `${stem}.pdf`;
    await writeFile(asset, 'pdf');
    await writeFile(`${stem}.txt`, '正文');
    await writeFile(`${stem}.md`, `# ${title}`);
    await writeFile(`${stem}.json`, JSON.stringify({ id, title, category, tags: [], status: 'ready', kind: 'pdf', summary: '摘要', quality_score: null, published_at: null, received_at: '2026-09-23', asset_path: asset, original_name: `${title}.pdf` }));
  };
  await writeItem(originalId, '策略优化', '强化学习');
  await writeItem(outsideId, '细胞生物学', 'Biology');
  const server = createApi(library);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await library.addFolder({ name: 'Computer Science' });
    await library.addFolder({ name: 'AI', parent: 'Computer Science' });
    await library.addFolder({ name: '强化学习', parent: 'Computer Science/AI' });
    const deep = await library.addFolder({ name: '实验', parent: 'Computer Science/AI/强化学习' });
    assert.equal(deep.path, 'Computer Science/AI/强化学习/实验');

    const run = await fetch(`${base}/api/restructure/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scopes: ['强化学习'] }) });
    assert.equal(run.status, 201);
    const record = await run.json();
    assert.equal(record.snapshot.items.length, 2);
    assert.equal((await library.items()).find(item => item.id === originalId).category, 'Computer Science/AI/强化学习/策略优化');
    assert.equal((await library.items()).find(item => item.id === outsideId).category, 'Biology');

    const laterId = '99999999-9999-4999-8999-999999999999';
    await writeItem(laterId, '后加入资料', 'Computer Science/AI/强化学习/策略优化');
    const undo = await fetch(`${base}/api/restructure/${record.id}/undo`, { method: 'POST' });
    assert.equal(undo.status, 200);
    const restored = await library.items();
    assert.equal(restored.find(item => item.id === originalId).category, '强化学习');
    assert.equal(restored.find(item => item.id === laterId).category, 'Computer Science/AI/强化学习/策略优化');
    assert.equal((await library.restructureHistory())[0].status, 'undone');
  } finally {
    library.close();
    await new Promise(resolve => server.close(resolve));
    if (!root.startsWith(join(tmpdir(), 'infobox-test-'))) throw new Error('Unsafe test cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});

test('one-shot run handles current inbox and exits without a watcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'infobox-test-'));
  const inbox = join(root, 'inbox');
  await mkdir(inbox);
  await writeFile(join(inbox, 'first.png'), 'first image');
  await writeFile(join(inbox, 'second.png'), 'second image');
  await writeFile(join(inbox, 'ignored.txt'), 'leave this alone');
  const library = new Library({ root,
    analyze: async () => ({ title: 'Image-Note', summary: '一张图片。', category: 'Images', tags: ['image'], published_at: null, needs_review: false, review_reason: '' }),
    decide: async (_, analysis) => ({ category: analysis.category, tags: analysis.tags, needs_review: false, provider: 'test' }),
  });
  try {
    const { results, skipped } = await processInbox(library);
    assert.equal(results.length, 2);
    assert.ok(results.every(job => job.status === 'ready'));
    assert.deepEqual(skipped, ['ignored.txt']);
    assert.equal(library.watcher, null);
    assert.equal((await readFile(join(inbox, 'ignored.txt'), 'utf8')), 'leave this alone');
  } finally {
    library.close();
    if (!root.startsWith(join(tmpdir(), 'infobox-test-'))) throw new Error('Unsafe test cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});
