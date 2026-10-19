import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  canOpenExternal,
  isExternalTarget,
  readDesktopConfig,
  requestedPort,
  resolveDataRoot,
  writeDesktopConfig,
} from '../desktop/runtime-config.js';

test('desktop data root prefers environment, then saved config, then Documents default', () => {
  assert.equal(resolveDataRoot({ environmentRoot: 'D:\\Portable', configuredRoot: 'D:\\Saved', documentsPath: 'D:\\Docs' }).path, 'D:\\Portable');
  assert.equal(resolveDataRoot({ configuredRoot: 'D:\\Saved', documentsPath: 'D:\\Docs' }).path, 'D:\\Saved');
  assert.equal(resolveDataRoot({ documentsPath: 'D:\\Docs' }).path, 'D:\\Docs\\InfoBox');
});

test('desktop service only accepts a valid optional local port', () => {
  assert.equal(requestedPort('3210'), 3210);
  assert.equal(requestedPort('70000'), 0);
  assert.equal(requestedPort('not-a-port'), 0);
});

test('desktop config writes and reads a selected data root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'infobox-desktop-'));
  const configPath = join(directory, 'desktop-config.json');
  await writeDesktopConfig(configPath, { dataRoot: 'D:\\Knowledge' });
  assert.deepEqual(await readDesktopConfig(configPath), { dataRoot: 'D:\\Knowledge' });
  assert.match(await readFile(configPath, 'utf8'), /"dataRoot": "D:\\\\Knowledge"/);
  await writeDesktopConfig(configPath, { dataRoot: 'D:\\Second' });
  assert.deepEqual(await readDesktopConfig(configPath), { dataRoot: 'D:\\Second' });
});

test('desktop external target detection keeps local pages inside the app', () => {
  const origin = 'http://127.0.0.1:3210';
  assert.equal(isExternalTarget(`${origin}/api/items`, origin), false);
  assert.equal(isExternalTarget('https://example.com/article', origin), true);
  assert.equal(isExternalTarget('zotero://select/library/items/ABCD1234', origin), true);
  assert.equal(canOpenExternal('https://example.com/article'), true);
  assert.equal(canOpenExternal('zotero://select/library/items/ABCD1234'), true);
  assert.equal(canOpenExternal('javascript:alert(1)'), false);
  assert.equal(canOpenExternal('file:///C:/Windows/System32'), false);
});
