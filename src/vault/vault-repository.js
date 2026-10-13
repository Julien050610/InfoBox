import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { Document, isMap, parseDocument } from 'yaml';
import { ConflictError, NotFoundError, StorageError, ValidationError } from '../errors.js';
import { recoverPendingWrites, writeTextFile } from '../storage/local-json-store.js';

const NOTE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const queues = new Map();

const serialize = (path, operation) => {
  const key = resolve(path).toLowerCase();
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  queues.set(key, next);
  return next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
};

const revisionOf = source => createHash('sha256').update(source).digest('hex');
const uniqueStrings = values => [...new Set((Array.isArray(values) ? values : []).map(value => String(value || '').trim()).filter(Boolean))];
const mergedTags = metadata => uniqueStrings([
  ...uniqueStrings(metadata.manual_tags),
  ...uniqueStrings(metadata.zotero_tags),
  ...uniqueStrings(metadata.agent_tags),
]);
const safeFilename = value => String(value || '').normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 120);

function assertId(id) {
  const value = String(id || '');
  if (!NOTE_ID.test(value)) throw new ValidationError('Invalid vault note ID', 'INVALID_VAULT_NOTE_ID');
  return value;
}

function frontmatterDocument(metadata = {}) {
  const document = new Document();
  document.contents = document.createNode({});
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) document.set(key, value);
  }
  return document;
}

export function parseVaultMarkdown(source, path = '') {
  const normalized = String(source ?? '').replace(/^\uFEFF/, '');
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new StorageError(`Vault note is missing YAML frontmatter${path ? `: ${path}` : ''}`, { code: 'INVALID_VAULT_FRONTMATTER' });
  const document = parseDocument(match[1], { keepSourceTokens: true, prettyErrors: true });
  if (document.errors.length || !isMap(document.contents)) {
    throw new StorageError(`Vault note has invalid YAML frontmatter${path ? `: ${path}` : ''}`, {
      code: 'INVALID_VAULT_FRONTMATTER', cause: document.errors[0],
    });
  }
  const metadata = document.toJS() || {};
  return { document, metadata, content: normalized.slice(match[0].length), revision: revisionOf(normalized), source: normalized };
}

export function stringifyVaultMarkdown(document, content = '') {
  const yaml = document.toString({ lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${String(content ?? '')}`;
}

function normalizeMetadata(metadata, { creating = false } = {}) {
  const now = new Date().toISOString();
  const result = { ...metadata };
  if (creating) {
    result.type ??= 'note';
    result.title ??= '未命名笔记';
    result.manual_tags ??= [];
    result.zotero_tags ??= [];
    result.agent_tags ??= [];
    result.category ??= '未分类';
    result.status ??= 'processed';
    result.created_at ??= now;
    result.received_at ??= now.slice(0, 10);
  }
  for (const field of ['manual_tags', 'zotero_tags', 'agent_tags']) {
    if (field in result) result[field] = uniqueStrings(result[field]);
  }
  if (creating || ['manual_tags', 'zotero_tags', 'agent_tags'].some(field => field in metadata)) result.tags = mergedTags(result);
  result.updated_at = now;
  return result;
}

export class VaultRepository {
  constructor({ root }) {
    this.root = resolve(root);
    this.notesDirectory = join(this.root, 'notes');
    this.attachmentsDirectory = join(this.root, 'attachments');
    this.templatesDirectory = join(this.root, 'templates');
    this.watcher = null;
  }

  async init() {
    await Promise.all([this.notesDirectory, this.attachmentsDirectory, this.templatesDirectory].map(path => mkdir(path, { recursive: true })));
    await recoverPendingWrites(this.root);
  }

  notePath(id) { return join(this.notesDirectory, `${assertId(id)}.md`); }
  attachmentDirectory(id) { return join(this.attachmentsDirectory, assertId(id)); }

  async exists(id) { return access(this.notePath(id)).then(() => true, () => false); }

  async create(metadata, content = '') {
    const id = assertId(metadata?.id);
    const path = this.notePath(id);
    if (await this.exists(id)) throw new ConflictError('A vault note with this ID already exists', 'VAULT_NOTE_EXISTS');
    const normalized = normalizeMetadata({ ...metadata, id }, { creating: true });
    const document = frontmatterDocument(normalized);
    await writeTextFile(path, stringifyVaultMarkdown(document, content));
    return this.read(id);
  }

  async read(id) {
    const path = this.notePath(id);
    let source;
    try { source = await readFile(path, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new StorageError('Failed to read vault note', { cause: error });
    }
    const parsed = parseVaultMarkdown(source, path);
    if (String(parsed.metadata.id || '') !== String(id)) throw new StorageError('Vault note ID does not match its filename', { code: 'VAULT_ID_MISMATCH' });
    return { ...parsed, path, id: String(id) };
  }

  async list() {
    const entries = await readdir(this.notesDirectory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const notes = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const id = entry.name.slice(0, -3);
      if (!NOTE_ID.test(id)) continue;
      notes.push(await this.read(id));
    }
    return notes;
  }

  async update(id, { metadata = {}, content, expectedRevision } = {}) {
    const path = this.notePath(id);
    return serialize(path, async () => {
      const current = await this.read(id);
      if (!current) throw new NotFoundError('Vault note not found', 'VAULT_NOTE_NOT_FOUND');
      if (!expectedRevision || current.revision !== expectedRevision) {
        throw new ConflictError('笔记已被外部程序修改，请重新加载后再保存。', 'VAULT_WRITE_CONFLICT');
      }
      const changes = normalizeMetadata(metadata);
      const combinedForTags = { ...current.metadata, ...changes };
      if (['manual_tags', 'zotero_tags', 'agent_tags'].some(field => field in metadata)) changes.tags = mergedTags(combinedForTags);
      for (const [key, value] of Object.entries(changes)) {
        if (key === 'id') continue;
        if (value === undefined) current.document.delete(key);
        else current.document.set(key, value);
      }
      current.document.set('id', String(id));
      const source = stringifyVaultMarkdown(current.document, content === undefined ? current.content : content);
      await writeTextFile(path, source);
      return this.read(id);
    });
  }

  async addAttachment(id, filename, bytes) {
    if (!await this.exists(id)) throw new NotFoundError('Vault note not found', 'VAULT_NOTE_NOT_FOUND');
    const extension = extname(filename).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) throw new ValidationError('Notebook images must be PNG, JPEG, GIF, or WebP');
    const base = safeFilename(basename(filename, extension)) || 'image';
    const directory = this.attachmentDirectory(id);
    await mkdir(directory, { recursive: true });
    let name = `${base}${extension}`;
    let index = 1;
    while (await access(join(directory, name)).then(() => true, () => false)) name = `${base}-${++index}${extension}`;
    await writeFile(join(directory, name), bytes);
    return { name, relativePath: `../attachments/${id}/${encodeURIComponent(name)}` };
  }

  async copyAttachmentsFrom(id, sourceDirectory) {
    const entries = await readdir(sourceDirectory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    if (!entries.some(entry => entry.isFile())) return [];
    const destination = this.attachmentDirectory(id);
    await mkdir(destination, { recursive: true });
    const copied = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = safeFilename(entry.name);
      if (!name) continue;
      await copyFile(join(sourceDirectory, entry.name), join(destination, name));
      copied.push(name);
    }
    return copied;
  }

  async remove(id) {
    const path = this.notePath(id);
    const existed = await access(path).then(() => true, () => false);
    await Promise.all([rm(path, { force: true }), rm(this.attachmentDirectory(id), { recursive: true, force: true })]);
    return existed;
  }

  watch(listener) {
    this.watcher?.close();
    this.watcher = watch(this.notesDirectory, (_event, filename) => {
      if (!filename || !String(filename).endsWith('.md')) return;
      const id = String(filename).slice(0, -3);
      if (NOTE_ID.test(id)) listener({ id, path: this.notePath(id) });
    });
    return this.watcher;
  }

  close() { this.watcher?.close(); this.watcher = null; }
}
