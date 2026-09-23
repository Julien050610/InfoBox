import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, rename, rmdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { analyzeContent, decideWithJev, proposeRestructure } from './models.js';
import { extractFile } from './extract.js';

const safePart = value => String(value || '').normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 80);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const exists = async path => access(path).then(() => true, () => false);
export const SUPPORTED_INBOX_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.url', '.webloc']);
const READING_STATUSES = new Set(['unread', 'reading', 'read']);
const RELATION_TYPES = new Set(['related', 'cites', 'supports', 'contradicts', 'follow_up']);

async function readJsonArray(path) {
  return JSON.parse(await readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '[]';
    throw error;
  }));
}

function publicationDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value) ? value : null;
}

export function renderNote(item) {
  const lines = [
    `# ${item.title}`, '',
    `- 类型：${item.kind}`,
    `- 来源：${item.source_url || item.original_name}`,
    `- 摘要依据：${item.summary_basis === 'title_description' ? '仅标题和简介' : item.summary_basis === 'title_only' ? '仅标题' : item.summary_basis === 'image' ? '图片内容' : item.summary_basis === 'manual_correction' ? '人工校正的文本' : item.summary_basis === 'full_text' ? '提取的正文' : '未提取'}`,
    `- 发表日期：${item.published_at || '未知'}`,
    `- 收件日期：${item.received_at}`,
    `- 主分类：${item.category}`,
    `- 内容质量：${item.quality_score === null ? '未评分' : `${item.quality_score}/5`}`,
    `- 状态：${item.status === 'ready' ? '已入库' : '待检查'}`,
    '', '## 摘要', '', item.summary || '暂无摘要', '',
    '## 标签', '', item.tags?.map(tag => `- ${tag}`).join('\n') || '暂无标签', '',
  ];
  if (item.review_reason) lines.push('## 待检查原因', '', item.review_reason, '');
  return lines.join('\n');
}

async function scanJson(directory) {
  if (!await exists(directory)) return [];
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await scanJson(path));
    else if (entry.name.endsWith('.json')) found.push(path);
  }
  return found;
}

export class Library {
  constructor(options = {}) {
    this.root = resolve(options.root || process.env.DATA_DIR || '.');
    this.inbox = join(this.root, 'inbox');
    this.library = join(this.root, 'library');
    this.review = join(this.root, 'needs-review');
    this.jobs = join(this.root, 'data', 'jobs');
    this.notesDirectory = join(this.root, 'data', 'notes');
    this.savedViewsFile = join(this.root, 'data', 'saved-views.json');
    this.relationsFile = join(this.root, 'data', 'relations.json');
    this.foldersFile = join(this.root, 'data', 'folders.json');
    this.restructureHistoryFile = join(this.root, 'data', 'restructure-history.json');
    this.analyze = options.analyze || analyzeContent;
    this.decide = options.decide || decideWithJev;
    this.restructure = options.restructure || proposeRestructure;
    this.pending = new Set();
    this.chain = Promise.resolve();
    this.watcher = null;
    this.timers = new Map();
  }

  async init({ watchInbox = true } = {}) {
    await Promise.all([this.inbox, this.library, this.review, this.jobs, this.notesDirectory].map(path => mkdir(path, { recursive: true })));
    if (watchInbox) {
      this.watcher = watch(this.inbox, (_, name) => {
        if (name) this.schedule(name.toString());
      });
      for (const name of await readdir(this.inbox)) this.schedule(name);
    }
  }

  close() {
    this.watcher?.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
  }

  schedule(name) {
    if (!name || name.startsWith('.') || name.endsWith('.partial')) return;
    clearTimeout(this.timers.get(name));
    this.timers.set(name, setTimeout(async () => {
      this.timers.delete(name);
      const path = join(this.inbox, name);
      if ((await stat(path).catch(() => null))?.isFile()) await this.enqueue(path);
    }, 1500));
  }

  async enqueue(path, originalName = null) {
    const fullPath = resolve(path);
    if (!fullPath.startsWith(`${this.inbox}\\`) && !fullPath.startsWith(`${this.inbox}/`)) throw new Error('Input must be inside inbox');
    if (this.pending.has(fullPath)) return null;
    this.pending.add(fullPath);
    const job = { id: randomUUID(), input: basename(fullPath), original_name: originalName || basename(fullPath), status: 'queued', created_at: new Date().toISOString() };
    await this.writeJob(job);
    this.chain = this.chain.catch(() => {}).then(async () => {
      try { await this.process(job, fullPath); }
      finally { this.pending.delete(fullPath); }
    });
    return job;
  }

  async writeJob(job) { await writeFile(join(this.jobs, `${job.id}.json`), json(job)); }
  async getJob(id) { return JSON.parse(await readFile(join(this.jobs, `${id}.json`), 'utf8')); }

  async items() {
    const paths = [...await scanJson(this.library), ...await scanJson(this.review)];
    const items = await Promise.all(paths.map(async path => {
      const item = JSON.parse(await readFile(path, 'utf8'));
      return {
        ...item,
        favorite: Boolean(item.favorite),
        reading_status: READING_STATUSES.has(item.reading_status) ? item.reading_status : 'unread',
        last_opened_at: item.last_opened_at || null,
        reading_progress: Number.isFinite(item.reading_progress) ? Math.max(0, Math.min(1, item.reading_progress)) : null,
        metadata_path: path,
      };
    }));
    return items.sort((a, b) => b.received_at.localeCompare(a.received_at));
  }

  async search(query) {
    const source = String(query || '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
    if (!source) return [];
    const terms = source.split(/\s+/).filter(Boolean).slice(0, 12);
    const results = [];
    for (const item of await this.items()) {
      const textPath = item.metadata_path.slice(0, -5) + '.txt';
      const fullText = await readFile(textPath, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
      const fields = {
        title: String(item.title || '').toLocaleLowerCase('zh-CN'),
        tags: (item.tags || []).join(' ').toLocaleLowerCase('zh-CN'),
        category: String(item.category || '').toLocaleLowerCase('zh-CN'),
        summary: String(item.summary || '').toLocaleLowerCase('zh-CN'),
        text: String(fullText || item.corrected_text || '').toLocaleLowerCase('zh-CN'),
      };
      const combined = Object.values(fields).join('\n');
      if (!terms.every(term => combined.includes(term))) continue;
      let score = 0;
      for (const term of terms) {
        if (fields.title.includes(term)) score += 5;
        if (fields.tags.includes(term)) score += 4;
        if (fields.category.includes(term)) score += 3;
        if (fields.summary.includes(term)) score += 2;
        if (fields.text.includes(term)) score += 1;
      }
      const firstTerm = terms[0];
      const snippetSource = fields.text.includes(firstTerm) ? String(fullText || item.corrected_text || '') : String(item.summary || '');
      const lowerSnippet = snippetSource.toLocaleLowerCase('zh-CN');
      const index = Math.max(0, lowerSnippet.indexOf(firstTerm));
      const start = Math.max(0, index - 65);
      const snippet = snippetSource ? `${start ? '…' : ''}${snippetSource.slice(start, start + 180).replace(/\s+/g, ' ').trim()}${start + 180 < snippetSource.length ? '…' : ''}` : '';
      results.push({ id: item.id, score, snippet });
    }
    return results.sort((a, b) => b.score - a.score);
  }

  async savedViews() { return readJsonArray(this.savedViewsFile); }

  async addSavedView(payload) {
    const name = String(payload?.name || '').trim().slice(0, 80);
    if (!name) throw new Error('Saved view name is required');
    const views = await this.savedViews();
    const view = {
      id: randomUUID(), name,
      query: String(payload.query || '').slice(0, 500),
      scope: String(payload.scope || 'all'),
      category: String(payload.category || ''),
      filters: payload.filters && typeof payload.filters === 'object' && !Array.isArray(payload.filters) ? payload.filters : {},
      created_at: new Date().toISOString(),
    };
    views.push(view);
    await writeFile(this.savedViewsFile, json(views));
    return view;
  }

  async deleteSavedView(id) {
    const views = await this.savedViews();
    const index = views.findIndex(view => view.id === id);
    if (index < 0) return null;
    const [removed] = views.splice(index, 1);
    await writeFile(this.savedViewsFile, json(views));
    return removed;
  }

  async relations() { return readJsonArray(this.relationsFile); }

  async addRelation(payload) {
    const sourceId = String(payload?.source_id || '');
    const targetId = String(payload?.target_id || '');
    const type = RELATION_TYPES.has(payload?.type) ? payload.type : 'related';
    if (!sourceId || !targetId || sourceId === targetId) throw new Error('Relation requires two different items');
    const ids = new Set((await this.items()).map(item => item.id));
    if (!ids.has(sourceId) || !ids.has(targetId)) throw new Error('Related item not found');
    const relations = await this.relations();
    const duplicate = relations.find(relation => ((relation.source_id === sourceId && relation.target_id === targetId) || (relation.source_id === targetId && relation.target_id === sourceId)) && relation.type === type);
    if (duplicate) return duplicate;
    const relation = { id: randomUUID(), source_id: sourceId, target_id: targetId, type, created_at: new Date().toISOString() };
    relations.push(relation);
    await writeFile(this.relationsFile, json(relations));
    return relation;
  }

  async deleteRelation(id) {
    const relations = await this.relations();
    const index = relations.findIndex(relation => relation.id === id);
    if (index < 0) return null;
    const [removed] = relations.splice(index, 1);
    await writeFile(this.relationsFile, json(relations));
    return removed;
  }

  async folders() {
    return (await readJsonArray(this.foldersFile))
      .map(value => String(value || '').split('/').map(safePart).filter(Boolean).join('/'))
      .filter(Boolean);
  }

  async categories() {
    const paths = new Set();
    const add = value => {
      const parts = String(value || '').split('/').map(safePart).filter(Boolean);
      parts.forEach((_, index) => paths.add(parts.slice(0, index + 1).join('/')));
    };
    (await this.folders()).forEach(add);
    (await this.items()).filter(item => item.status === 'ready').forEach(item => add(item.category));
    return [...paths].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  async tags() {
    return [...new Set((await this.items()).filter(item => item.status === 'ready').flatMap(item => item.tags || []).map(value => String(value).trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  async addFolder(payload) {
    const rawName = String(payload?.name || '').trim();
    const name = safePart(rawName);
    if (!name || name !== rawName || name.includes('/')) throw new Error('Folder name is invalid');
    const parent = String(payload?.parent || '').split('/').map(safePart).filter(Boolean).join('/');
    const categories = await this.categories();
    if (parent && !categories.includes(parent)) throw new Error('Parent folder does not exist');
    const path = parent ? `${parent}/${name}` : name;
    if (categories.includes(path)) throw new Error('Folder already exists');
    const folders = await this.folders();
    folders.push(path);
    folders.sort((a, b) => a.localeCompare(b, 'zh-CN'));
    await mkdir(join(this.library, ...path.split('/')), { recursive: true });
    await writeFile(this.foldersFile, json(folders));
    return { name, parent, path };
  }

  async restructureHistory() {
    return (await readJsonArray(this.restructureHistoryFile)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async writeRestructureHistory(records) {
    await writeFile(this.restructureHistoryFile, json(records));
  }

  normalizeCategory(value) {
    const raw = String(value || '').trim();
    const parts = raw.split('/').map(safePart).filter(Boolean);
    if (!raw || parts.length < 1 || parts.length > 32 || parts.join('/') !== raw) throw new Error('Category must contain valid folder levels');
    return parts.join('/');
  }

  async structureSnapshot() {
    const [folders, categories, items, views] = await Promise.all([this.folders(), this.categories(), this.items(), this.savedViews()]);
    return {
      created_at: new Date().toISOString(), folders, categories,
      items: items.filter(item => item.status === 'ready').map(item => ({ item_id: item.id, category: item.category })),
      views: views.map(view => ({ id: view.id, category: view.category || '' })),
    };
  }

  proposalChanges(items, proposal) {
    const byId = new Map(items.map(item => [item.id, item]));
    const seen = new Set();
    const changes = [];
    for (const candidate of proposal.changes || []) {
      const item = byId.get(String(candidate.item_id || ''));
      if (!item || seen.has(item.id)) continue;
      const to = this.normalizeCategory(candidate.category);
      seen.add(item.id);
      if (to === item.category) continue;
      changes.push({
        item_id: item.id, title: item.title, from: item.category, to,
        reason: String(candidate.reason || '').trim().slice(0, 500),
        confidence: Math.max(0, Math.min(1, Number(candidate.confidence) || 0)),
      });
    }
    return changes;
  }

  generatedFolderPaths(changes, snapshot) {
    const existing = new Set(snapshot.categories || []);
    const generated = new Set();
    for (const change of changes) {
      const parts = change.to.split('/');
      parts.forEach((_, index) => {
        const path = parts.slice(0, index + 1).join('/');
        if (!existing.has(path)) generated.add(path);
      });
    }
    return [...generated].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  async previewRestructure(payload = {}) {
    const scope = String(payload.scope || '').trim();
    if (scope && !(await this.categories()).includes(scope)) throw new Error('Restructure scope folder does not exist');
    const items = (await this.items()).filter(item => item.status === 'ready' && (!scope || item.category === scope || item.category.startsWith(`${scope}/`)));
    if (!items.length) throw new Error('Restructure scope contains no items');
    const proposal = await this.restructure(items, { categories: await this.categories(), scope });
    const changes = this.proposalChanges(items, proposal);
    return {
      id: randomUUID(), scope, rationale: String(proposal.rationale || '').trim().slice(0, 3000),
      changes, created_at: new Date().toISOString(), provider: proposal.provider || null, model: proposal.model || null,
    };
  }

  async moveItems(changes, direction = 'forward') {
    const applied = [];
    try {
      for (const change of changes) {
        const category = direction === 'forward' ? change.to : change.from;
        const item = await this.patchItem(change.item_id, { category });
        if (!item) throw new Error(`Item not found: ${change.item_id}`);
        applied.push(change);
      }
    } catch (error) {
      for (const change of applied.reverse()) {
        const category = direction === 'forward' ? change.from : change.to;
        await this.patchItem(change.item_id, { category }).catch(() => {});
      }
      throw error;
    }
  }

  async applyRestructure(payload = {}) {
    if (!Array.isArray(payload.changes) || !payload.changes.length) throw new Error('Restructure plan contains no changes');
    const items = new Map((await this.items()).filter(item => item.status === 'ready').map(item => [item.id, item]));
    const seen = new Set();
    const changes = payload.changes.map(change => {
      const item = items.get(String(change.item_id || ''));
      if (!item) throw new Error('Restructure item no longer exists');
      if (seen.has(item.id)) throw new Error('Restructure plan contains a duplicate item');
      seen.add(item.id);
      const from = this.normalizeCategory(change.from);
      const to = this.normalizeCategory(change.to);
      if (item.category !== from) throw new Error(`Item moved after preview: ${item.title}`);
      if (from === to) throw new Error('Restructure change must move an item');
      return { item_id: item.id, title: item.title, from, to, reason: String(change.reason || '').slice(0, 500), confidence: Math.max(0, Math.min(1, Number(change.confidence) || 0)) };
    });
    const snapshot = await this.structureSnapshot();
    await this.moveItems(changes);
    const record = {
      id: randomUUID(), type: 'agent', status: 'applied', scope: String(payload.scope || ''),
      rationale: String(payload.rationale || '').slice(0, 3000), changes, snapshot,
      generated_folders: this.generatedFolderPaths(changes, snapshot),
      created_at: new Date().toISOString(), undone_at: null,
    };
    const history = await readJsonArray(this.restructureHistoryFile);
    history.push(record);
    try {
      await this.writeRestructureHistory(history);
    } catch (error) {
      await this.moveItems([...changes].reverse(), 'reverse').catch(() => {});
      throw error;
    }
    return record;
  }

  async runRestructure(payload = {}) {
    const categories = await this.categories();
    const requested = Array.isArray(payload.scopes) ? payload.scopes : [];
    const normalized = [...new Set(requested.map(value => String(value || '').trim()).map(value => value ? this.normalizeCategory(value) : ''))];
    if (!normalized.length) throw new Error('Select at least one folder to restructure');
    if (normalized.some(scope => scope && !categories.includes(scope))) throw new Error('Restructure scope folder does not exist');
    const scopes = normalized.filter(scope => !normalized.some(parent => parent !== scope && (!parent || scope.startsWith(`${parent}/`))));
    const items = (await this.items()).filter(item => item.status === 'ready' && scopes.some(scope => !scope || item.category === scope || item.category.startsWith(`${scope}/`)));
    if (!items.length) throw new Error('Selected folders contain no items');
    const proposal = await this.restructure(items, { categories, scopes });
    const changes = this.proposalChanges(items, proposal);
    if (!changes.length) return { status: 'unchanged', scopes, changes: [], rationale: String(proposal.rationale || '').slice(0, 3000) };
    const snapshot = await this.structureSnapshot();
    await this.moveItems(changes);
    const record = {
      id: randomUUID(), type: 'agent', status: 'applied', scopes,
      rationale: String(proposal.rationale || '').slice(0, 3000), changes, snapshot,
      generated_folders: this.generatedFolderPaths(changes, snapshot),
      created_at: new Date().toISOString(), undone_at: null,
    };
    const history = await readJsonArray(this.restructureHistoryFile);
    history.push(record);
    try {
      await this.writeRestructureHistory(history);
    } catch (error) {
      await this.moveItems([...changes].reverse(), 'reverse').catch(() => {});
      throw error;
    }
    return record;
  }

  async moveFolder(payload = {}) {
    const source = this.normalizeCategory(payload.source);
    const rawName = String(payload.name || '').trim();
    const name = safePart(rawName);
    if (!name || name !== rawName || name.includes('/')) throw new Error('Folder name is invalid');
    const parent = String(payload.parent || '').trim();
    const parentPath = parent ? this.normalizeCategory(parent) : '';
    const target = parentPath ? `${parentPath}/${name}` : name;
    if (source === target) throw new Error('Folder location is unchanged');
    const categories = await this.categories();
    if (!categories.includes(source)) throw new Error('Folder does not exist');
    if (parentPath && !categories.includes(parentPath)) throw new Error('Parent folder does not exist');
    if (target === source || target.startsWith(`${source}/`)) throw new Error('Folder cannot be moved inside itself');
    if (categories.includes(target)) throw new Error('Target folder already exists');
    const affectedPaths = categories.filter(path => path === source || path.startsWith(`${source}/`));
    const folderMapping = affectedPaths.map(from => ({ from, to: `${target}${from.slice(source.length)}` }));
    const items = (await this.items()).filter(item => item.status === 'ready' && (item.category === source || item.category.startsWith(`${source}/`)));
    const changes = items.map(item => ({ item_id: item.id, title: item.title, from: item.category, to: `${target}${item.category.slice(source.length)}`, reason: '文件夹调整', confidence: 1 }));
    const foldersBefore = await this.folders();
    const foldersAfter = [...new Set(foldersBefore.map(path => path === source || path.startsWith(`${source}/`) ? `${target}${path.slice(source.length)}` : path).concat(target))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const views = await this.savedViews();
    const viewsBefore = JSON.parse(JSON.stringify(views));
    const viewChanges = views.filter(view => view.category === source || view.category?.startsWith(`${source}/`)).map(view => ({ id: view.id, from: view.category, to: `${target}${view.category.slice(source.length)}` }));
    const snapshot = await this.structureSnapshot();
    await this.moveItems(changes);
    try {
      await writeFile(this.foldersFile, json(foldersAfter));
      for (const change of viewChanges) {
        const view = views.find(value => value.id === change.id);
        if (view) view.category = change.to;
      }
      await writeFile(this.savedViewsFile, json(views));
      await mkdir(join(this.library, ...target.split('/')), { recursive: true });
      for (const path of [...affectedPaths].sort((a, b) => b.length - a.length)) await rmdir(join(this.library, ...path.split('/'))).catch(() => {});
    } catch (error) {
      await this.moveItems(changes, 'reverse').catch(() => {});
      await writeFile(this.foldersFile, json(foldersBefore)).catch(() => {});
      await writeFile(this.savedViewsFile, json(viewsBefore)).catch(() => {});
      throw error;
    }
    const record = {
      id: randomUUID(), type: 'folder', status: 'applied', scope: source,
      rationale: `文件夹 ${source} 调整为 ${target}`, changes, snapshot,
      generated_folders: [...new Set([
        ...this.generatedFolderPaths(changes, snapshot),
        ...folderMapping.map(change => change.to).filter(path => !snapshot.categories.includes(path)),
      ])],
      folder_change: { source, target, folder_mapping: folderMapping, view_changes: viewChanges },
      created_at: new Date().toISOString(), undone_at: null,
    };
    const history = await readJsonArray(this.restructureHistoryFile);
    history.push(record);
    try {
      await this.writeRestructureHistory(history);
    } catch (error) {
      await this.moveItems([...changes].reverse(), 'reverse').catch(() => {});
      await writeFile(this.foldersFile, json(foldersBefore)).catch(() => {});
      await writeFile(this.savedViewsFile, json(viewsBefore)).catch(() => {});
      throw error;
    }
    return record;
  }

  async undoRestructure(id) {
    const history = await readJsonArray(this.restructureHistoryFile);
    const record = history.find(value => value.id === id);
    if (!record) return null;
    if (record.status !== 'applied') throw new Error('This structure change has already been undone');
    if (record.snapshot) {
      const currentItems = new Map((await this.items()).filter(item => item.status === 'ready').map(item => [item.id, item]));
      const restoreChanges = record.snapshot.items.flatMap(saved => {
        const item = currentItems.get(saved.item_id);
        return item && item.category !== saved.category ? [{ item_id: item.id, title: item.title, from: saved.category, to: item.category }] : [];
      });
      await this.moveItems(restoreChanges, 'reverse');
      const generated = new Set(record.generated_folders || []);
      const folders = [...new Set((await this.folders()).filter(path => !generated.has(path)).concat(record.snapshot.folders || []))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
      await writeFile(this.foldersFile, json(folders));
      const views = await this.savedViews();
      for (const saved of record.snapshot.views || []) {
        const view = views.find(value => value.id === saved.id);
        if (view) view.category = saved.category;
      }
      await writeFile(this.savedViewsFile, json(views));
      for (const path of [...folders, ...record.snapshot.items.map(item => item.category)]) await mkdir(join(this.library, ...path.split('/')), { recursive: true });
      for (const path of [...generated].sort((a, b) => b.split('/').length - a.split('/').length)) await rmdir(join(this.library, ...path.split('/'))).catch(() => {});
      record.status = 'undone';
      record.undone_at = new Date().toISOString();
      await this.writeRestructureHistory(history);
      return record;
    }
    const items = new Map((await this.items()).map(item => [item.id, item]));
    for (const change of record.changes) {
      const item = items.get(change.item_id);
      if (!item || item.category !== change.to) throw new Error(`Cannot undo because an item moved later: ${change.title}`);
    }
    if (record.folder_change) {
      const recordedIds = new Set(record.changes.map(change => change.item_id));
      const laterItems = [...items.values()].filter(item => (item.category === record.folder_change.target || item.category.startsWith(`${record.folder_change.target}/`)) && !recordedIds.has(item.id));
      if (laterItems.length) throw new Error('Cannot undo because new items were added to the moved folder');
      const allowedPaths = new Set((record.folder_change.folder_mapping || []).map(change => change.to));
      const laterFolders = (await this.categories()).filter(path => (path === record.folder_change.target || path.startsWith(`${record.folder_change.target}/`)) && !allowedPaths.has(path));
      if (laterFolders.length) throw new Error('Cannot undo because new folders were added below the moved folder');
    }
    await this.moveItems([...record.changes].reverse(), 'reverse');
    if (record.folder_change) {
      const { source, target, view_changes: viewChanges = [] } = record.folder_change;
      const folders = await this.folders();
      const restored = [...new Set(folders.map(path => path === target || path.startsWith(`${target}/`) ? `${source}${path.slice(target.length)}` : path).concat(source))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
      await writeFile(this.foldersFile, json(restored));
      const views = await this.savedViews();
      for (const change of viewChanges) {
        const view = views.find(value => value.id === change.id);
        if (view?.category === change.to) view.category = change.from;
      }
      await writeFile(this.savedViewsFile, json(views));
      await mkdir(join(this.library, ...source.split('/')), { recursive: true });
      const targetPaths = (record.folder_change.folder_mapping || []).map(change => change.to).sort((a, b) => b.length - a.length);
      for (const path of targetPaths) await rmdir(join(this.library, ...path.split('/'))).catch(() => {});
    }
    record.status = 'undone';
    record.undone_at = new Date().toISOString();
    await this.writeRestructureHistory(history);
    return record;
  }

  async inboxFiles() {
    const entries = await readdir(this.inbox, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter(entry => entry.isFile() && !entry.name.startsWith('.') && !entry.name.endsWith('.partial'))
      .map(async entry => {
        const path = join(this.inbox, entry.name);
        const details = await stat(path);
        const extension = extname(entry.name).toLowerCase();
        return {
          name: entry.name,
          extension,
          size: details.size,
          modified_at: details.mtime.toISOString(),
          supported: SUPPORTED_INBOX_EXTENSIONS.has(extension),
          processing: this.pending.has(resolve(path)),
        };
      }));
    return files.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  }

  async enqueueInbox() {
    const jobs = [];
    const skipped = [];
    for (const file of await this.inboxFiles()) {
      if (!file.supported) {
        skipped.push({ name: file.name, reason: 'unsupported' });
        continue;
      }
      const job = await this.enqueue(join(this.inbox, file.name));
      if (job) jobs.push(job);
      else skipped.push({ name: file.name, reason: 'already_processing' });
    }
    return { jobs, skipped };
  }

  async deleteInboxFile(name) {
    if (typeof name !== 'string' || !name || basename(name) !== name || name.startsWith('.') || name.endsWith('.partial')) {
      throw new Error('Invalid inbox filename');
    }
    const path = resolve(join(this.inbox, name));
    if (this.pending.has(path)) throw new Error('Cannot delete a file while it is being classified');
    const details = await stat(path).catch(() => null);
    if (!details?.isFile()) return null;
    await rm(path);
    return { name };
  }

  async tree() {
    const root = { name: 'Library', path: '', count: 0, children: [] };
    const ensurePath = parts => {
      let node = root;
      for (let index = 0; index < parts.length; index++) {
        const path = parts.slice(0, index + 1).join('/');
        let child = node.children.find(value => value.name === parts[index]);
        if (!child) {
          child = { name: parts[index], path, count: 0, children: [] };
          node.children.push(child);
        }
        node = child;
      }
      return node;
    };
    for (const folder of await this.folders()) ensurePath(folder.split('/').filter(Boolean));
    for (const item of (await this.items()).filter(value => value.status === 'ready')) {
      root.count += 1;
      const parts = String(item.category || '未分类').split('/').filter(Boolean);
      let node = root;
      for (let index = 0; index < parts.length; index++) {
        const child = ensurePath(parts.slice(0, index + 1));
        child.count += 1;
        node = child;
      }
    }
    const sort = node => {
      node.children.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      node.children.forEach(sort);
      return node;
    };
    return sort(root);
  }

  async notesFor(id) {
    if (!(await this.items()).some(item => item.id === id)) return null;
    return JSON.parse(await readFile(join(this.notesDirectory, `${id}.json`), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '[]';
      throw error;
    }));
  }

  async addNote(id, anchor) {
    const notes = await this.notesFor(id);
    if (!notes) return null;
    const type = anchor?.type;
    const x = Number(anchor?.x);
    const y = Number(anchor?.y);
    const page = Number(anchor?.page);
    if (!['document', 'pdf'].includes(type) || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1 || (type === 'pdf' && (!Number.isInteger(page) || page < 1))) {
      throw new Error('Invalid note anchor');
    }
    const now = new Date().toISOString();
    const note = { id: randomUUID(), content: '', anchor: { type, x, y, ...(type === 'pdf' ? { page } : {}) }, created_at: now, updated_at: now };
    notes.push(note);
    await writeFile(join(this.notesDirectory, `${id}.json`), json(notes));
    return note;
  }

  async updateNote(id, noteId, changes) {
    const notes = await this.notesFor(id);
    if (!notes) return null;
    const note = notes.find(value => value.id === noteId);
    if (!note) return null;
    if (typeof changes?.content !== 'string' || changes.content.length > 20000) throw new Error('Note content must be text under 20,000 characters');
    note.content = changes.content;
    note.updated_at = new Date().toISOString();
    await writeFile(join(this.notesDirectory, `${id}.json`), json(notes));
    return note;
  }

  async deleteNote(id, noteId) {
    const notes = await this.notesFor(id);
    if (!notes) return null;
    const index = notes.findIndex(value => value.id === noteId);
    if (index < 0) return null;
    const [removed] = notes.splice(index, 1);
    await writeFile(join(this.notesDirectory, `${id}.json`), json(notes));
    return removed;
  }

  async findDuplicate(fingerprint) {
    return (await this.items()).find(item => item.fingerprint === fingerprint && item.status === 'ready');
  }

  async process(job, path) {
    job.status = 'processing';
    await this.writeJob(job);
    const receivedAt = new Date().toISOString();
    try {
      const raw = await readFile(path);
      const fingerprint = createHash('sha256').update(extname(path).toLowerCase() === '.url' ? raw.toString('utf8').trim() : raw).digest('hex');
      const duplicate = await this.findDuplicate(fingerprint);
      if (duplicate) throw new Error(`Duplicate of ${duplicate.id}`);
      const extracted = await extractFile(path);
      if (extracted.kind === 'pdf' && extracted.text.length < 80) throw new Error('PDF has no usable text; scanned documents need manual review');
      if (extracted.kind === 'article' && extracted.text.length < 100) throw new Error('Webpage has too little article text');
      if (extracted.kind === 'video' && !extracted.title && !extracted.description) throw new Error('Video has no accessible title or description');
      const [categories, tags] = await Promise.all([this.categories(), this.tags()]);
      const analysis = await this.analyze(extracted, { categories, tags });
      const decision = await this.decide(extracted, analysis, { categories });
      const category = String(decision.category || analysis.category || '未分类').split('/').map(safePart).filter(Boolean).slice(0, 32).join('/') || '未分类';
      const title = safePart(analysis.title || extracted.title || basename(path, extname(path))) || 'Untitled';
      const sourceDate = publicationDate(extracted.publishedAt?.slice(0, 10));
      const evidence = String(analysis.publication_evidence || '').trim();
      const evidenceText = [extracted.text, analysis.extraction?.visible_text].filter(Boolean).join('\n');
      const publishedAt = sourceDate || (evidence && evidenceText.includes(evidence) ? publicationDate(analysis.published_at) : null);
      const datePrefix = (publishedAt || receivedAt).slice(0, 7);
      const status = decision.needs_review ? 'review' : 'ready';
      const folder = status === 'ready' ? join(this.library, ...category.split('/')) : join(this.review, job.id);
      await mkdir(folder, { recursive: true });
      let stem = `${datePrefix}-${title}`;
      if (await exists(join(folder, `${stem}.json`))) stem += `-${job.id.slice(0, 8)}`;
      const extension = extracted.assetExtension || extname(path).toLowerCase();
      const assetPath = join(folder, `${stem}${extension}`);
      if (extracted.assetBuffer) await writeFile(assetPath, extracted.assetBuffer);
      else await copyFile(path, assetPath);
      const item = {
        id: job.id, status, title, kind: extracted.kind, source_url: extracted.sourceUrl || null,
        original_name: job.original_name, asset_path: assetPath, category,
        summary: String(analysis.summary || '').trim(), tags: [...new Set((decision.tags || []).map(safePart).filter(Boolean))].slice(0, 8),
        quality_score: null, published_at: publishedAt, publication_evidence: sourceDate ? '页面元数据' : publishedAt ? evidence : '', received_at: receivedAt.slice(0, 10),
        summary_basis: extracted.basis, fingerprint,
        analysis_provider: analysis.provider || null, analysis_model: analysis.model || null,
        decision_provider: decision.provider || 'analysis_model', decision_confidence: decision.confidence ?? null,
        review_reason: decision.review_reason || '', extraction: analysis.extraction || null,
        corrected_text: null,
      };
      const metaPath = join(folder, `${stem}.json`);
      await writeFile(metaPath, json(item));
      await writeFile(join(folder, `${stem}.md`), renderNote(item));
      const text = extracted.text || [analysis.extraction?.description, analysis.extraction?.visible_text].filter(Boolean).join('\n\n');
      if (text) await writeFile(join(folder, `${stem}.txt`), text);
      await rm(path);
      job.status = status;
      job.item_id = item.id;
      job.metadata_path = metaPath;
      await this.writeJob(job);
    } catch (error) {
      const folder = join(this.review, job.id);
      await mkdir(folder, { recursive: true });
      const movedPath = join(folder, basename(path));
      if (await exists(path)) await rename(path, movedPath);
      const item = {
        id: job.id, status: 'review', title: basename(path), kind: 'unknown', source_url: null,
        original_name: job.original_name, asset_path: await exists(movedPath) ? movedPath : null,
        category: '未分类', summary: '', tags: [], quality_score: null, published_at: null, publication_evidence: '',
        received_at: receivedAt.slice(0, 10), summary_basis: 'unavailable', fingerprint: null,
        analysis_provider: null, analysis_model: null,
        decision_provider: null, decision_confidence: null, review_reason: error.message,
        extraction: null, corrected_text: null,
      };
      await writeFile(join(folder, 'item.json'), json(item));
      await writeFile(join(folder, 'item.md'), renderNote(item));
      job.status = 'review';
      job.error = error.message;
      job.item_id = item.id;
      await this.writeJob(job);
    }
  }

  async patchItem(id, changes) {
    const item = (await this.items()).find(value => value.id === id);
    if (!item) return null;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Item update must be an object');
    const allowed = ['quality_score', 'title', 'summary', 'category', 'tags', 'published_at', 'corrected_text', 'favorite', 'reading_status', 'last_opened_at', 'reading_progress'];
    if (Object.keys(changes).some(key => !allowed.includes(key))) throw new Error('Unsupported item field');
    if (item.status === 'ready' && ['published_at', 'corrected_text'].some(key => key in changes)) throw new Error('Correction edits are only available for review items');
    const previousTitle = item.title;
    const previousCategory = item.category;
    const previousPath = item.metadata_path;
    if ('quality_score' in changes) {
      const score = changes.quality_score;
      if (score !== null && (!Number.isInteger(score) || score < 1 || score > 5)) throw new Error('quality_score must be null or an integer from 1 to 5');
      item.quality_score = score;
    }
    if ('title' in changes) item.title = safePart(changes.title) || 'Untitled';
    if ('summary' in changes) item.summary = String(changes.summary).trim();
    if ('category' in changes) item.category = this.normalizeCategory(changes.category || '未分类');
    if ('tags' in changes) {
      if (!Array.isArray(changes.tags)) throw new Error('tags must be an array');
      item.tags = [...new Set(changes.tags.map(safePart).filter(Boolean))].slice(0, 8);
    }
    if ('published_at' in changes) {
      if (changes.published_at !== null && !publicationDate(changes.published_at)) throw new Error('published_at must be YYYY-MM-DD or null');
      item.published_at = changes.published_at;
    }
    if ('corrected_text' in changes) {
      if (typeof changes.corrected_text !== 'string' || changes.corrected_text.length > 100000) throw new Error('corrected_text must be text under 100,000 characters');
      item.corrected_text = changes.corrected_text.trim();
      await writeFile(item.metadata_path.slice(0, -5) + '.txt', item.corrected_text);
    }
    if ('favorite' in changes) {
      if (typeof changes.favorite !== 'boolean') throw new Error('favorite must be a boolean');
      item.favorite = changes.favorite;
    }
    if ('reading_status' in changes) {
      if (!READING_STATUSES.has(changes.reading_status)) throw new Error('reading_status must be unread, reading, or read');
      item.reading_status = changes.reading_status;
    }
    if ('last_opened_at' in changes) {
      if (changes.last_opened_at !== null && (typeof changes.last_opened_at !== 'string' || Number.isNaN(Date.parse(changes.last_opened_at)))) throw new Error('last_opened_at must be an ISO date or null');
      item.last_opened_at = changes.last_opened_at;
    }
    if ('reading_progress' in changes) {
      if (changes.reading_progress !== null && (!Number.isFinite(changes.reading_progress) || changes.reading_progress < 0 || changes.reading_progress > 1)) throw new Error('reading_progress must be null or between 0 and 1');
      item.reading_progress = changes.reading_progress;
    }
    let path = previousPath;
    if (item.status === 'ready' && (item.title !== previousTitle || item.category !== previousCategory)) {
      const folder = item.category !== previousCategory ? join(this.library, ...item.category.split('/')) : dirname(previousPath);
      await mkdir(folder, { recursive: true });
      const extension = extname(item.asset_path || '') || '.url';
      const baseStem = item.title !== previousTitle
        ? `${(item.published_at || item.received_at).slice(0, 7)}-${safePart(item.title) || 'Untitled'}`
        : basename(previousPath, '.json');
      let stem = baseStem;
      let counter = 0;
      while ((await exists(join(folder, `${stem}.json`)) && join(folder, `${stem}.json`) !== previousPath) || (await exists(join(folder, `${stem}${extension}`)) && join(folder, `${stem}${extension}`) !== item.asset_path)) {
        counter += 1;
        stem = `${baseStem}-${id.slice(0, 8)}${counter > 1 ? `-${counter}` : ''}`;
      }
      path = join(folder, `${stem}.json`);
      if (path !== previousPath) {
        const assetPath = join(folder, `${stem}${extension}`);
        if (!item.asset_path || !await exists(item.asset_path)) throw new Error('Original asset is missing');
        if (assetPath !== item.asset_path) await rename(item.asset_path, assetPath);
        item.asset_path = assetPath;
        const previousText = previousPath.slice(0, -5) + '.txt';
        const nextText = join(folder, `${stem}.txt`);
        if (await exists(previousText) && previousText !== nextText) await rename(previousText, nextText);
      }
    }
    delete item.metadata_path;
    await writeFile(path, json(item));
    await writeFile(path.slice(0, -5) + '.md', renderNote(item));
    if (path !== previousPath) {
      await rm(previousPath);
      const previousNote = previousPath.slice(0, -5) + '.md';
      if (await exists(previousNote)) await rm(previousNote);
      const job = await this.getJob(id).catch(() => null);
      if (job) {
        job.metadata_path = path;
        await this.writeJob(job);
      }
    }
    return item;
  }

  async deleteItem(id) {
    const item = (await this.items()).find(value => value.id === id);
    if (!item) return null;
    const metadataPath = resolve(item.metadata_path);
    const storageRoot = item.status === 'ready' ? resolve(this.library) : resolve(this.review);
    if (!metadataPath.startsWith(`${storageRoot}\\`) && !metadataPath.startsWith(`${storageRoot}/`)) {
      throw new Error('Item metadata is outside the library');
    }
    const assetPath = item.asset_path ? resolve(item.asset_path) : null;
    if (assetPath && !assetPath.startsWith(`${storageRoot}\\`) && !assetPath.startsWith(`${storageRoot}/`)) throw new Error('Item asset is outside the library');
    const base = metadataPath.slice(0, -5);
    const paths = new Set([
      assetPath,
      metadataPath,
      `${base}.md`,
      `${base}.txt`,
      join(this.notesDirectory, `${id}.json`),
      join(this.jobs, `${id}.json`),
    ].filter(Boolean));
    for (const path of paths) await rm(path, { force: true });

    const relations = await this.relations();
    const remainingRelations = relations.filter(relation => relation.source_id !== id && relation.target_id !== id);
    if (remainingRelations.length !== relations.length) await writeFile(this.relationsFile, json(remainingRelations));

    let directory = dirname(metadataPath);
    while (directory !== storageRoot && (directory.startsWith(`${storageRoot}\\`) || directory.startsWith(`${storageRoot}/`))) {
      try { await rmdir(directory); }
      catch (error) {
        if (error.code === 'ENOENT') { directory = dirname(directory); continue; }
        if (error.code === 'ENOTEMPTY') break;
        throw error;
      }
      directory = dirname(directory);
    }
    return { id: item.id, title: item.title };
  }

  async reanalyze(id) {
    const item = (await this.items()).find(value => value.id === id);
    if (!item || item.status !== 'review') return null;
    if (!item.corrected_text) throw new Error('Add corrected_text before reanalyzing');
    const extracted = { kind: item.kind, basis: 'manual_correction', title: item.title, description: '', text: item.corrected_text, publishedAt: item.published_at, sourceUrl: item.source_url };
    const [categories, tags] = await Promise.all([this.categories(), this.tags()]);
    const analysis = await this.analyze(extracted, { categories, tags });
    const decision = await this.decide(extracted, analysis, { categories });
    const changes = {
      title: analysis.title, summary: analysis.summary, category: decision.category,
      tags: decision.tags, published_at: publicationDate(item.published_at) || (analysis.publication_evidence && item.corrected_text.includes(analysis.publication_evidence) ? publicationDate(analysis.published_at) : null),
    };
    await this.patchItem(id, changes);
    const updated = (await this.items()).find(value => value.id === id);
    updated.summary_basis = 'manual_correction';
    updated.analysis_provider = analysis.provider || null;
    updated.analysis_model = analysis.model || null;
    updated.publication_evidence = analysis.publication_evidence && item.corrected_text.includes(analysis.publication_evidence) ? analysis.publication_evidence : updated.publication_evidence;
    updated.decision_provider = decision.provider || 'analysis_model';
    updated.decision_confidence = decision.confidence ?? null;
    updated.review_reason = decision.needs_review ? decision.review_reason || '仍需人工检查' : '';
    await writeFile(updated.metadata_path, json({ ...updated, metadata_path: undefined }));
    await writeFile(updated.metadata_path.slice(0, -5) + '.md', renderNote(updated));
    return decision.needs_review ? updated : this.approve(id);
  }

  async approve(id) {
    const item = (await this.items()).find(value => value.id === id);
    if (!item || item.status !== 'review') return null;
    if (!item.summary?.trim()) throw new Error('Add a summary before approving');
    const category = String(item.category || '未分类').split('/').map(safePart).filter(Boolean);
    const folder = join(this.library, ...category);
    await mkdir(folder, { recursive: true });
    let stem = `${(item.published_at || item.received_at).slice(0, 7)}-${safePart(item.title) || 'Untitled'}`;
    if (await exists(join(folder, `${stem}.json`))) stem += `-${id.slice(0, 8)}`;
    const oldFolder = join(this.review, id);
    const oldMeta = item.metadata_path;
    const oldText = oldMeta.slice(0, -5) + '.txt';
    const oldNote = oldMeta.slice(0, -5) + '.md';
    const assetPath = join(folder, `${stem}${extname(item.asset_path || '') || '.url'}`);
    if (item.asset_path && await exists(item.asset_path)) await rename(item.asset_path, assetPath);
    else throw new Error('Original asset is missing');
    if (await exists(oldText)) await rename(oldText, join(folder, `${stem}.txt`));
    item.status = 'ready';
    item.review_reason = '';
    item.asset_path = assetPath;
    delete item.metadata_path;
    await writeFile(join(folder, `${stem}.json`), json(item));
    await writeFile(join(folder, `${stem}.md`), renderNote(item));
    await rm(oldMeta);
    if (await exists(oldNote)) await rm(oldNote);
    await rmdir(oldFolder);
    const job = await this.getJob(id).catch(() => null);
    if (job) {
      job.status = 'ready';
      job.metadata_path = join(folder, `${stem}.json`);
      delete job.error;
      await this.writeJob(job);
    }
    return item;
  }
}

