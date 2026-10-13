import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ConflictError, StorageError, ValidationError } from '../errors.js';
import { readJsonFile, writeJsonFile } from './local-json-store.js';

const exists = path => access(path).then(() => true, () => false);
const validId = value => /^[0-9a-f-]{36}$/i.test(String(value || ''));

function publicEntry(manifest) {
  return {
    id: manifest.id,
    kind: manifest.kind,
    title: manifest.title,
    deleted_at: manifest.deleted_at,
    original_location: manifest.original_location || '',
    item_count: manifest.item_ids?.length || 0,
  };
}

export class TrashStore {
  constructor(root) {
    this.root = resolve(root);
    this.directory = join(this.root, 'trash');
  }

  async init() { await mkdir(this.directory, { recursive: true }); }

  relativePath(path) {
    const value = relative(this.root, resolve(path));
    if (!value || value.startsWith(`..${sep}`) || value === '..' || isAbsolute(value)) {
      throw new ValidationError('Trash source must be inside the data directory', 'INVALID_TRASH_PATH');
    }
    if (value === 'trash' || value.startsWith(`trash${sep}`)) {
      throw new ValidationError('Trash source cannot be inside the recycle bin', 'INVALID_TRASH_PATH');
    }
    return value;
  }

  async list() {
    const entries = await readdir(this.directory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const manifests = [];
    for (const entry of entries.filter(value => value.isDirectory() && validId(value.name))) {
      const manifest = await readJsonFile(join(this.directory, entry.name, 'manifest.json'), null);
      if (manifest) manifests.push(publicEntry(manifest));
    }
    return manifests.sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)));
  }

  async get(id) {
    if (!validId(id)) throw new ValidationError('Invalid trash entry id', 'INVALID_TRASH_ID');
    return readJsonFile(join(this.directory, id, 'manifest.json'), null);
  }

  async put({ kind, title, paths, itemIds = [], folderEntries = [], relations = [], originalLocation = '' }) {
    const candidates = [];
    for (const source of paths.filter(Boolean)) {
      const absolute = resolve(source);
      const info = await stat(absolute).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!info) continue;
      candidates.push({ absolute, relative: this.relativePath(absolute), directory: info.isDirectory() });
    }
    candidates.sort((a, b) => a.absolute.length - b.absolute.length);
    const sources = candidates.filter((candidate, index) => !candidates.slice(0, index).some(parent => parent.directory && candidate.absolute.toLowerCase().startsWith(`${parent.absolute.toLowerCase()}${sep}`)));
    if (!sources.length) return null;

    const id = randomUUID();
    const partial = join(this.directory, `.${id}.partial`);
    const destination = join(this.directory, id);
    const filesDirectory = join(partial, 'files');
    const records = sources.map((source, index) => ({
      original_path: source.relative,
      stored_path: join('files', String(index).padStart(4, '0')),
      directory: source.directory,
    }));
    const manifest = {
      id,
      kind: String(kind || 'item'),
      title: String(title || '未命名项目'),
      deleted_at: new Date().toISOString(),
      original_location: String(originalLocation || ''),
      item_ids: [...new Set(itemIds.map(String))],
      folder_entries: [...new Set(folderEntries.map(String))],
      relations,
      paths: records,
    };
    const moved = [];
    try {
      await mkdir(filesDirectory, { recursive: true });
      await writeJsonFile(join(partial, 'manifest.json'), manifest);
      for (let index = 0; index < sources.length; index++) {
        const target = join(partial, records[index].stored_path);
        await rename(sources[index].absolute, target);
        moved.push({ source: sources[index].absolute, target });
      }
      await rename(partial, destination);
      return publicEntry(manifest);
    } catch (error) {
      for (const record of moved.reverse()) {
        await mkdir(dirname(record.source), { recursive: true }).catch(() => {});
        await rename(record.target, record.source).catch(() => {});
      }
      await rm(partial, { recursive: true, force: true }).catch(() => {});
      throw new StorageError('Failed to move data to the recycle bin', { cause: error });
    }
  }

  async restore(id) {
    const manifest = await this.get(id);
    if (!manifest) return null;
    const bundle = join(this.directory, id);
    const targets = manifest.paths.map(record => ({
      source: join(bundle, record.stored_path),
      target: resolve(this.root, record.original_path),
    }));
    for (const record of targets) {
      this.relativePath(record.target);
      if (await exists(record.target)) throw new ConflictError('原位置已存在同名文件或文件夹，无法恢复', 'TRASH_RESTORE_CONFLICT');
    }
    const moved = [];
    try {
      for (const record of targets) {
        await mkdir(dirname(record.target), { recursive: true });
        await rename(record.source, record.target);
        moved.push(record);
      }
      await rm(bundle, { recursive: true, force: true });
      return manifest;
    } catch (error) {
      for (const record of moved.reverse()) {
        await mkdir(dirname(record.source), { recursive: true }).catch(() => {});
        await rename(record.target, record.source).catch(() => {});
      }
      if (error instanceof ConflictError) throw error;
      throw new StorageError('Failed to restore data from the recycle bin', { cause: error });
    }
  }

  async permanentlyDelete(id) {
    const manifest = await this.get(id);
    if (!manifest) return null;
    await rm(join(this.directory, id), { recursive: true, force: true });
    return manifest;
  }
}
