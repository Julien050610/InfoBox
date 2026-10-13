import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { StorageError } from '../errors.js';

const queues = new Map();
const serialize = (path, operation) => {
  const key = resolve(path).toLowerCase();
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  queues.set(key, next);
  return next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
};

const encodeJson = value => `${JSON.stringify(value, null, 2)}\n`;

async function recoverBackup(path) {
  const backup = `${path}.backup`;
  const targetExists = await access(path).then(() => true, () => false);
  if (targetExists) return;
  const backupExists = await access(backup).then(() => true, () => false);
  if (backupExists) await rename(backup, path);
}

export async function recoverPendingWrites(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await recoverPendingWrites(path);
    else if (entry.isFile() && entry.name.endsWith('.backup')) {
      const target = path.slice(0, -'.backup'.length);
      if (await access(target).then(() => true, () => false)) await rm(path, { force: true });
      else await rename(path, target);
    }
  }
}

async function replaceFile(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const backup = `${path}.backup`;
  let handle = null;
  let existingMoved = false;
  try {
    await recoverBackup(path);
    handle = await open(temporary, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rm(backup, { force: true });
    try {
      await rename(path, backup);
      existingMoved = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await rename(temporary, path);
    if (existingMoved) await rm(backup, { force: true });
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    if (existingMoved) {
      await rm(path, { force: true }).catch(() => {});
      await rename(backup, path).catch(() => {});
    }
    throw new StorageError('Failed to save local data', { cause: error });
  }
}

export async function readJsonFile(path, fallback) {
  let source;
  try {
    await recoverBackup(path);
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback);
    throw new StorageError('Failed to read local JSON data', { cause: error });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new StorageError('Stored JSON is invalid', { code: 'CORRUPT_JSON', cause: error });
  }
}

export async function readJsonArray(path) {
  const value = await readJsonFile(path, []);
  if (!Array.isArray(value)) throw new StorageError('Stored JSON must contain an array', { code: 'CORRUPT_JSON' });
  return value;
}

export function writeJsonFile(path, value) {
  return serialize(path, () => replaceFile(path, encodeJson(value)));
}

export function writeTextFile(path, value) {
  return serialize(path, () => replaceFile(path, String(value)));
}

export function updateJsonArray(path, update) {
  return serialize(path, async () => {
    const value = await readJsonArray(path);
    const result = await update(value);
    await replaceFile(path, encodeJson(value));
    return result;
  });
}
