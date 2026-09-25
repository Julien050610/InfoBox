import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Library, SUPPORTED_INBOX_EXTENSIONS } from './library.js';
import { markdownToHtml } from '../web/markdown.js';

try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }

const MAX_UPLOAD = 32 * 1024 * 1024;
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const PDFJS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'pdfjs-dist', 'build');
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.gif', 'image/gif'], ['.html', 'text/html; charset=utf-8'],
  ['.jpeg', 'image/jpeg'], ['.jpg', 'image/jpeg'], ['.js', 'text/javascript; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'], ['.pdf', 'application/pdf'], ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'], ['.txt', 'text/plain; charset=utf-8'], ['.url', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'], ['.mp3', 'audio/mpeg'], ['.m4a', 'audio/mp4'], ['.aac', 'audio/aac'],
  ['.wav', 'audio/wav'], ['.flac', 'audio/flac'], ['.ogg', 'audio/ogg'], ['.opus', 'audio/ogg'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.epub', 'application/epub+zip'], ['.zip', 'application/zip'],
]);

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function sendBuffer(response, status, bytes, headers = {}) {
  response.writeHead(status, { 'content-length': bytes.length, 'cache-control': 'no-store', ...headers });
  response.end(bytes);
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

async function bodyBuffer(request) {
  if (Number(request.headers['content-length'] || 0) > MAX_UPLOAD) throw new Error('Upload exceeds 32 MB');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_UPLOAD) throw new Error('Upload exceeds 32 MB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function safeName(name) {
  return String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 120);
}

async function availableInboxPath(directory, name) {
  const extension = extname(name);
  const stem = basename(name, extension);
  let candidate = join(directory, name);
  if (!await stat(candidate).catch(() => null)) return candidate;
  candidate = join(directory, `${stem}-${randomUUID().slice(0, 8)}${extension}`);
  return candidate;
}

function within(path, roots) {
  const target = resolve(path).toLowerCase();
  return roots.some(root => target === resolve(root).toLowerCase() || target.startsWith(`${resolve(root).toLowerCase()}${sep}`));
}

async function sendFile(request, response, path, options = {}) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return send(response, 404, { error: 'File not found' });
  const type = options.type || MIME_TYPES.get(extname(path).toLowerCase()) || 'application/octet-stream';
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': options.cache || 'private, max-age=60' };
  const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= info.size) {
      response.writeHead(416, { 'content-range': `bytes */${info.size}` });
      return response.end();
    }
    response.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${info.size}` });
    return createReadStream(path, { start, end }).pipe(response);
  }
  response.writeHead(200, { ...headers, 'content-length': info.size });
  createReadStream(path).pipe(response);
}

export function createApi(library) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { status: 'ok', api_version: 13 });
      if (request.method === 'GET' && url.pathname === '/api/library/tree') return send(response, 200, await library.tree());
      if (request.method === 'POST' && url.pathname === '/api/library/folders') {
        const payload = JSON.parse((await bodyBuffer(request)).toString('utf8'));
        return send(response, 201, await library.addFolder(payload));
      }
      if (request.method === 'PATCH' && url.pathname === '/api/library/folders') {
        const payload = JSON.parse((await bodyBuffer(request)).toString('utf8'));
        return send(response, 200, await library.moveFolder(payload));
      }
      if (request.method === 'GET' && url.pathname === '/api/restructure/history') return send(response, 200, await library.restructureHistory());
      if (request.method === 'POST' && url.pathname === '/api/restructure/preview') {
        const payload = JSON.parse((await bodyBuffer(request)).toString('utf8'));
        return send(response, 200, await library.previewRestructure(payload));
      }
      if (request.method === 'POST' && url.pathname === '/api/restructure/apply') {
        const payload = JSON.parse((await bodyBuffer(request)).toString('utf8'));
        return send(response, 201, await library.applyRestructure(payload));
      }
      if (request.method === 'POST' && url.pathname === '/api/restructure/run') {
        const payload = JSON.parse((await bodyBuffer(request)).toString('utf8'));
        return send(response, 201, await library.runRestructure(payload));
      }
      const restructureUndoMatch = url.pathname.match(/^\/api\/restructure\/([0-9a-f-]{36})\/undo$/);
      if (request.method === 'POST' && restructureUndoMatch) {
        const record = await library.undoRestructure(restructureUndoMatch[1]);
        return send(response, record ? 200 : 404, record || { error: 'Structure change not found' });
      }
      if (request.method === 'GET' && url.pathname === '/api/search') return send(response, 200, await library.search(url.searchParams.get('q')));
      if (request.method === 'GET' && url.pathname === '/api/views') return send(response, 200, await library.savedViews());
      if (request.method === 'POST' && url.pathname === '/api/views') {
        const payload = JSON.parse((await bodyBuffer(request)).toString('utf8'));
        return send(response, 201, await library.addSavedView(payload));
      }
      const viewMatch = url.pathname.match(/^\/api\/views\/([0-9a-f-]{36})$/);
      if (request.method === 'DELETE' && viewMatch) {
        const view = await library.deleteSavedView(viewMatch[1]);
        return send(response, view ? 200 : 404, view || { error: 'Saved view not found' });
      }
      if (request.method === 'GET' && url.pathname === '/api/relations') return send(response, 200, await library.relations());
      if (request.method === 'POST' && url.pathname === '/api/relations') {
        const payload = JSON.parse((await bodyBuffer(request)).toString('utf8'));
        return send(response, 201, await library.addRelation(payload));
      }
      const relationMatch = url.pathname.match(/^\/api\/relations\/([0-9a-f-]{36})$/);
      if (request.method === 'DELETE' && relationMatch) {
        const relation = await library.deleteRelation(relationMatch[1]);
        return send(response, relation ? 200 : 404, relation || { error: 'Relation not found' });
      }
      if (request.method === 'GET' && url.pathname === '/api/items') {
        const items = await library.items();
        return send(response, 200, url.searchParams.get('status') ? items.filter(item => item.status === url.searchParams.get('status')) : items);
      }
      if (request.method === 'GET' && url.pathname === '/api/notebook/temporary') return send(response, 200, await library.temporaryNotes());
      if (request.method === 'POST' && url.pathname === '/api/notebook/temporary') {
        const payload = JSON.parse((await bodyBuffer(request)).toString('utf8'));
        return send(response, 201, await library.createTemporaryNote(payload));
      }
      if (request.method === 'POST' && url.pathname === '/api/notebook/notes') {
        const payload = JSON.parse((await bodyBuffer(request)).toString('utf8'));
        return send(response, 201, await library.createLibraryNote(payload));
      }
      const notebookMatch = url.pathname.match(/^\/api\/notebook\/notes\/([0-9a-f-]{36})$/);
      if (request.method === 'GET' && notebookMatch) {
        const note = await library.noteContent(notebookMatch[1]);
        return send(response, note ? 200 : 404, note || { error: 'Notebook note not found' });
      }
      if (request.method === 'PATCH' && notebookMatch) {
        const payload = JSON.parse((await bodyBuffer(request)).toString('utf8'));
        const note = await library.updateNotebookNote(notebookMatch[1], payload);
        return send(response, note ? 200 : 404, note || { error: 'Notebook note not found' });
      }
      if (request.method === 'DELETE' && notebookMatch) {
        const record = await library.noteRecord(notebookMatch[1]);
        const removed = record?.type === 'temporary' ? await library.deleteTemporaryNote(notebookMatch[1]) : await library.deleteItem(notebookMatch[1]);
        return send(response, removed ? 200 : 404, removed || { error: 'Notebook note not found' });
      }
      const notebookSubmitMatch = url.pathname.match(/^\/api\/notebook\/notes\/([0-9a-f-]{36})\/submit$/);
      if (request.method === 'POST' && notebookSubmitMatch) {
        const note = await library.submitTemporaryNote(notebookSubmitMatch[1]);
        return send(response, note ? 200 : 404, note || { error: 'Temporary note not found' });
      }
      const notebookAssetMatch = url.pathname.match(/^\/api\/notebook\/notes\/([0-9a-f-]{36})\/assets\/([^/]+)$/);
      if (request.method === 'GET' && notebookAssetMatch) {
        const path = await library.notebookAsset(notebookAssetMatch[1], decodeURIComponent(notebookAssetMatch[2]));
        return path ? sendFile(request, response, path) : send(response, 404, { error: 'Notebook image not found' });
      }
      const notebookAssetsMatch = url.pathname.match(/^\/api\/notebook\/notes\/([0-9a-f-]{36})\/assets$/);
      if (request.method === 'POST' && notebookAssetsMatch) {
        const bytes = await bodyBuffer(request);
        if (!bytes.length) throw new Error('File is empty');
        const asset = await library.addNotebookAsset(notebookAssetsMatch[1], safeName(url.searchParams.get('filename')), bytes);
        return send(response, asset ? 201 : 404, asset || { error: 'Notebook note not found' });
      }
      const notebookZipMatch = url.pathname.match(/^\/api\/notebook\/notes\/([0-9a-f-]{36})\/export\/markdown$/);
      if (request.method === 'GET' && notebookZipMatch) {
        const archive = await library.notebookZip(notebookZipMatch[1]);
        if (!archive) return send(response, 404, { error: 'Notebook note not found' });
        return sendBuffer(response, 200, archive.bytes, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(archive.name)}` });
      }
      const notebookPrintMatch = url.pathname.match(/^\/api\/notebook\/notes\/([0-9a-f-]{36})\/export\/pdf$/);
      if (request.method === 'GET' && notebookPrintMatch) {
        const record = await library.noteContent(notebookPrintMatch[1]);
        if (!record) return send(response, 404, { error: 'Notebook note not found' });
        const body = markdownToHtml(record.content, { assetUrl: name => `/api/notebook/notes/${notebookPrintMatch[1]}/assets/${encodeURIComponent(name)}` });
        const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(record.note.title)}</title><style>body{max-width:820px;margin:40px auto;padding:0 28px;color:#222;font:16px/1.75 system-ui,"Microsoft YaHei",sans-serif}h1,h2,h3{line-height:1.3}img{max-width:100%;height:auto}pre{padding:16px;overflow:auto;background:#f3f1eb}code{font-family:ui-monospace,monospace}button{position:fixed;right:24px;top:20px;padding:10px 16px;border:0;border-radius:4px;color:white;background:#173f35}@media print{button{display:none}body{margin:0;max-width:none}}</style></head><body><button onclick="window.print()">保存为 PDF</button><article>${body}</article></body></html>`;
        return sendBuffer(response, 200, Buffer.from(html), { 'content-type': 'text/html; charset=utf-8' });
      }
      const stickyConvertMatch = url.pathname.match(/^\/api\/items\/([0-9a-f-]{36})\/notes\/([0-9a-f-]{36})\/convert$/);
      if (request.method === 'POST' && stickyConvertMatch) {
        const payload = JSON.parse((await bodyBuffer(request)).toString('utf8'));
        const note = await library.convertStickyNote(stickyConvertMatch[1], stickyConvertMatch[2], payload.title);
        return send(response, note ? 201 : 404, note || { error: 'Sticky note not found' });
      }
      const itemMatch = url.pathname.match(/^\/api\/items\/([0-9a-f-]{36})$/);
      if (request.method === 'GET' && itemMatch) {
        const item = (await library.items()).find(value => value.id === itemMatch[1]);
        return send(response, item ? 200 : 404, item || { error: 'Item not found' });
      }
      if (request.method === 'PATCH' && itemMatch) {
        const payload = JSON.parse((await bodyBuffer(request)).toString('utf8'));
        const item = await library.patchItem(itemMatch[1], payload);
        return send(response, item ? 200 : 404, item || { error: 'Item not found' });
      }
      if (request.method === 'DELETE' && itemMatch) {
        const item = await library.deleteItem(itemMatch[1]);
        return send(response, item ? 200 : 404, item || { error: 'Item not found' });
      }
      const contentMatch = url.pathname.match(/^\/api\/items\/([0-9a-f-]{36})\/(asset|markdown|text)$/);
      if (request.method === 'GET' && contentMatch) {
        const item = (await library.items()).find(value => value.id === contentMatch[1]);
        if (!item) return send(response, 404, { error: 'Item not found' });
        const base = item.metadata_path?.slice(0, -5);
        let path = contentMatch[2] === 'asset' ? item.asset_path : `${base}${contentMatch[2] === 'markdown' ? '.summary.md' : '.txt'}`;
        if (contentMatch[2] === 'markdown' && !await stat(path).catch(() => null)) {
          const legacy = `${base}.md`;
          if (legacy !== item.asset_path) path = legacy;
        }
        if (!path || !within(path, [library.library, library.review])) return send(response, 404, { error: 'File not found' });
        const type = extname(path).toLowerCase() === '.html' ? 'text/plain; charset=utf-8' : undefined;
        return sendFile(request, response, path, { type });
      }
      const notesMatch = url.pathname.match(/^\/api\/items\/([0-9a-f-]{36})\/notes$/);
      if (request.method === 'GET' && notesMatch) {
        const notes = await library.notesFor(notesMatch[1]);
        return send(response, notes ? 200 : 404, notes || { error: 'Item not found' });
      }
      if (request.method === 'POST' && notesMatch) {
        const payload = JSON.parse((await bodyBuffer(request)).toString('utf8'));
        const note = await library.addNote(notesMatch[1], payload.anchor);
        return send(response, note ? 201 : 404, note || { error: 'Item not found' });
      }
      const noteMatch = url.pathname.match(/^\/api\/items\/([0-9a-f-]{36})\/notes\/([0-9a-f-]{36})$/);
      if (request.method === 'PATCH' && noteMatch) {
        const payload = JSON.parse((await bodyBuffer(request)).toString('utf8'));
        const note = await library.updateNote(noteMatch[1], noteMatch[2], payload);
        return send(response, note ? 200 : 404, note || { error: 'Note not found' });
      }
      if (request.method === 'DELETE' && noteMatch) {
        const note = await library.deleteNote(noteMatch[1], noteMatch[2]);
        return send(response, note ? 200 : 404, note || { error: 'Note not found' });
      }
      const bookmarksMatch = url.pathname.match(/^\/api\/items\/([0-9a-f-]{36})\/bookmarks$/);
      if (request.method === 'GET' && bookmarksMatch) {
        const bookmarks = await library.bookmarksFor(bookmarksMatch[1]);
        return send(response, bookmarks ? 200 : 404, bookmarks || { error: 'Item not found' });
      }
      if (request.method === 'POST' && bookmarksMatch) {
        const payload = JSON.parse((await bodyBuffer(request)).toString('utf8'));
        const bookmark = await library.addBookmark(bookmarksMatch[1], payload);
        return send(response, bookmark ? 201 : 404, bookmark || { error: 'Item not found' });
      }
      const bookmarkMatch = url.pathname.match(/^\/api\/items\/([0-9a-f-]{36})\/bookmarks\/([0-9a-f-]{36})$/);
      if (request.method === 'DELETE' && bookmarkMatch) {
        const bookmark = await library.deleteBookmark(bookmarkMatch[1], bookmarkMatch[2]);
        return send(response, bookmark ? 200 : 404, bookmark || { error: 'Bookmark not found' });
      }
      const actionMatch = url.pathname.match(/^\/api\/items\/([0-9a-f-]{36})\/(approve|reanalyze)$/);
      if (request.method === 'POST' && actionMatch) {
        const item = actionMatch[2] === 'approve' ? await library.approve(actionMatch[1]) : await library.reanalyze(actionMatch[1]);
        return send(response, item ? 200 : 404, item || { error: 'Review item not found' });
      }
      const jobMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/);
      if (request.method === 'GET' && jobMatch) {
        const job = await library.getJob(jobMatch[1]).catch(() => null);
        return send(response, job ? 200 : 404, job || { error: 'Job not found' });
      }
      if (request.method === 'GET' && url.pathname === '/api/inbox') {
        return send(response, 200, await library.inboxFiles());
      }
      if (request.method === 'POST' && url.pathname === '/api/inbox/process') {
        return send(response, 202, await library.enqueueInbox());
      }
      if (request.method === 'DELETE' && url.pathname === '/api/inbox/files') {
        const deleted = await library.deleteInboxFile(url.searchParams.get('filename'));
        return send(response, deleted ? 200 : 404, deleted || { error: 'Inbox file not found' });
      }
      if (request.method === 'POST' && url.pathname === '/api/inbox/urls') {
        const payload = JSON.parse((await bodyBuffer(request)).toString('utf8'));
        const values = Array.isArray(payload.urls) ? payload.urls : [payload.url];
        if (!values.length || values.length > 50) throw new TypeError('Provide between 1 and 50 URLs');
        const sources = [];
        for (const value of values) {
          const source = new URL(value);
          if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password) throw new TypeError('Only credential-free HTTP(S) URLs are supported');
          if (!sources.some(existing => existing.toString() === source.toString())) sources.push(source);
        }
        const files = [];
        for (const source of sources) {
          const host = safeName(source.hostname.replace(/^www\./i, '')) || 'webpage';
          const path = await availableInboxPath(library.inbox, `${host}-${randomUUID().slice(0, 8)}.url`);
          await writeFile(path, `${source.toString()}\n`);
          files.push({ name: basename(path), url: source.toString() });
        }
        if (url.searchParams.get('defer') === '1' || Array.isArray(payload.urls)) return send(response, 202, { status: 'pending', files });
        return send(response, 202, await library.enqueue(join(library.inbox, files[0].name), files[0].url));
      }
      if (request.method === 'POST' && url.pathname === '/api/inbox/files') {
        const name = safeName(url.searchParams.get('filename'));
        const extension = extname(name).toLowerCase();
        if (!SUPPORTED_INBOX_EXTENSIONS.has(extension)) throw new Error('Unsupported upload format');
        const bytes = await bodyBuffer(request);
        if (!bytes.length) throw new Error('File is empty');
        const path = await availableInboxPath(library.inbox, name);
        const partial = `${path}.partial`;
        await writeFile(partial, bytes);
        await rename(partial, path);
        if (url.searchParams.get('defer') === '1') return send(response, 202, { status: 'pending', name: basename(path) });
        return send(response, 202, await library.enqueue(path, name));
      }
      const staticFiles = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/styles.css', 'styles.css'], ['/app.js', 'app.js'], ['/markdown.js', 'markdown.js'], ['/favicon.svg', 'favicon.svg']]);
      const vendorFiles = new Map([['/vendor/pdf.mjs', 'pdf.mjs'], ['/vendor/pdf.worker.mjs', 'pdf.worker.mjs']]);
      if (request.method === 'GET' && vendorFiles.has(url.pathname)) {
        return sendFile(request, response, join(PDFJS_ROOT, vendorFiles.get(url.pathname)), { type: 'text/javascript; charset=utf-8', cache: 'public, max-age=86400' });
      }
      if (request.method === 'GET' && staticFiles.has(url.pathname)) {
        return sendFile(request, response, join(WEB_ROOT, staticFiles.get(url.pathname)), { cache: url.pathname === '/' ? 'no-store' : 'public, max-age=300' });
      }
      send(response, 404, { error: 'Route not found' });
    } catch (error) {
      send(response, error instanceof SyntaxError || error instanceof TypeError || /^Only |^Supported |^File |^Upload |^quality_score|^tags |^published_at|^corrected_text|^favorite |^reading_|^last_opened|^Add |^Unsupported |^Item update|^Move or |^Correction |^Folder |^Parent folder|^Invalid note|^Invalid bookmark|^Bookmark name|^Invalid inbox|^Invalid notebook|^Notebook |^Empty notes|^Bound item|^Cannot delete|^Note content|^Saved view|^Relation |^Related item|^Category |^Restructure |^Select at least|^Selected folders|^Target folder|^This move|^This structure/.test(error.message) ? 400 : 500, { error: error.message });
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  const library = new Library();
  await library.init({ watchInbox: false });
  const server = createApi(library);
  const port = Number(process.env.PORT || 3000);
  server.listen(port, '127.0.0.1', () => console.log(`InfoBox 工作台：http://127.0.0.1:${port}`));
  process.on('SIGINT', () => { library.close(); server.close(); });
}
