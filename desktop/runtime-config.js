import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export const DESKTOP_CONFIG_NAME = 'desktop-config.json';

export async function readDesktopConfig(configPath) {
  try {
    let source;
    try {
      source = await readFile(configPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const backupPath = `${configPath}.backup`;
      source = await readFile(backupPath, 'utf8');
      await rename(backupPath, configPath);
    }
    const value = JSON.parse(source);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}

export async function writeDesktopConfig(configPath, value) {
  await mkdir(dirname(configPath), { recursive: true });
  const temporaryPath = join(dirname(configPath), `.${basename(configPath)}.${randomUUID()}.tmp`);
  const backupPath = `${configPath}.backup`;
  let existingMoved = false;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rm(backupPath, { force: true });
    try {
      await rename(configPath, backupPath);
      existingMoved = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await rename(temporaryPath, configPath);
    if (existingMoved) await rm(backupPath, { force: true });
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    if (existingMoved) {
      await rm(configPath, { force: true }).catch(() => {});
      await rename(backupPath, configPath).catch(() => {});
    }
    throw error;
  }
}

export function resolveDataRoot({ environmentRoot, configuredRoot, documentsPath }) {
  const environment = String(environmentRoot || '').trim();
  if (environment) return { path: resolve(environment), source: 'environment' };
  const configured = String(configuredRoot || '').trim();
  if (configured) return { path: resolve(configured), source: 'configured' };
  return { path: resolve(documentsPath, 'InfoBox'), source: 'default' };
}

export function configPathFor(userDataPath) {
  return join(userDataPath, DESKTOP_CONFIG_NAME);
}

export function isExternalTarget(target, localOrigin) {
  try {
    const url = new URL(target);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin !== localOrigin;
    return url.protocol !== 'about:';
  } catch {
    return false;
  }
}

export function canOpenExternal(target) {
  try {
    return ['http:', 'https:', 'mailto:', 'zotero:'].includes(new URL(target).protocol);
  } catch {
    return false;
  }
}

export function requestedPort(value) {
  const port = Number(value || 0);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0;
}
