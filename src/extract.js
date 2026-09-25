import { readFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { basename, extname, posix } from 'node:path';
import { load } from 'cheerio';
import { parseBuffer as parseAudioBuffer } from 'music-metadata';
import { fromBufferPromise } from 'yauzl';

const IMAGE_TYPES = new Map([['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp'], ['.gif', 'image/gif']]);
const TEXT_TYPES = new Map([['.md', 'markdown'], ['.markdown', 'markdown'], ['.txt', 'text']]);
const CODE_TYPES = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php',
  '.swift', '.kt', '.kts', '.scala', '.sh', '.ps1', '.bat', '.cmd', '.sql', '.json', '.yaml', '.yml', '.toml', '.xml', '.css', '.scss',
  '.less', '.vue', '.svelte', '.r', '.lua',
]);
const AUDIO_TYPES = new Map([
  ['.mp3', 'audio/mpeg'], ['.m4a', 'audio/mp4'], ['.aac', 'audio/aac'], ['.wav', 'audio/wav'], ['.flac', 'audio/flac'],
  ['.ogg', 'audio/ogg'], ['.opus', 'audio/ogg'], ['.wma', 'audio/x-ms-wma'],
]);
const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|bilibili\.com|vimeo\.com|tiktok\.com|douyin\.com)$/i;
const MAX_WEB_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_TEXT = 300000;
const MAX_ZIP_ENTRIES = 10000;
const MAX_ZIP_UNCOMPRESSED = 512 * 1024 * 1024;
const MAX_ZIP_READ = 64 * 1024 * 1024;

function publicAddress(address) {
  if (address.startsWith('::ffff:')) return publicAddress(address.slice(7));
  if (isIP(address) === 6) return !/^(::1$|::$|f[cd]|fe[89ab]|ff)/i.test(address);
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127));
}

export async function validateRemoteUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are supported');
  if (url.username || url.password) throw new Error('URLs with credentials are not supported');
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
    throw new Error('Private or local network URLs are not supported');
  }
  return url;
}

export async function fetchPage(raw, fetchImpl = fetch) {
  let url = await validateRemoteUrl(raw);
  for (let redirect = 0; redirect < 5; redirect++) {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
      headers: { 'user-agent': 'PersonalInfoBox/0.1 (+local knowledge inbox)', accept: 'text/html,application/pdf;q=0.9' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirect has no destination');
      url = await validateRemoteUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
    const size = Number(response.headers.get('content-length') || 0);
    if (size > MAX_WEB_BYTES) throw new Error('Remote content is too large');
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_WEB_BYTES) { await reader.cancel(); throw new Error('Remote content is too large'); }
      chunks.push(value);
    }
    return { url: url.toString(), type: response.headers.get('content-type') || '', body: Buffer.concat(chunks) };
  }
  throw new Error('Too many redirects');
}

function cleanText(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n').trim();
}

function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    for (let index = 0; index + 1 < swapped.length; index += 2) [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
    return new TextDecoder('utf-16le').decode(swapped);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\ufeff/, ''); }
  catch { return new TextDecoder('gb18030').decode(buffer); }
}

function naturalPathSort(a, b) {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

async function readZip(buffer, shouldRead = () => false) {
  const zip = await fromBufferPromise(buffer, { lazyEntries: true, validateEntrySizes: true });
  const entries = [];
  const files = new Map();
  let declaredSize = 0;
  let readSize = 0;
  for await (const entry of zip.eachEntry()) {
    if (entries.length >= MAX_ZIP_ENTRIES) throw new Error(`Archive contains more than ${MAX_ZIP_ENTRIES} entries`);
    const name = entry.fileName;
    const directory = name.endsWith('/');
    entries.push({ name, directory, size: entry.uncompressedSize });
    if (directory) continue;
    declaredSize += entry.uncompressedSize;
    if (declaredSize > MAX_ZIP_UNCOMPRESSED) throw new Error('Archive uncompressed size is too large');
    if (!shouldRead(name)) continue;
    if (readSize + entry.uncompressedSize > MAX_ZIP_READ) throw new Error('Document text content is too large to extract safely');
    const stream = await zip.openReadStreamPromise(entry);
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      readSize += chunk.length;
      if (readSize > MAX_ZIP_READ) throw new Error('Document text content is too large to extract safely');
      chunks.push(chunk);
    }
    files.set(name, Buffer.concat(chunks, size));
  }
  return { entries, files };
}

function xmlParagraphs(xml, paragraphTag, textTag) {
  const $ = load(xml, { xmlMode: true });
  const paragraphSelector = paragraphTag.replace(':', '\\:');
  const textSelector = textTag.replace(':', '\\:');
  return $(paragraphSelector).map((_, paragraph) => cleanText($(paragraph).find(textSelector).map((__, node) => $(node).text()).get().join(''))).get().filter(Boolean);
}

async function extractDocx(buffer) {
  const { files } = await readZip(buffer, name => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/i.test(name));
  const names = [...files.keys()].sort((a, b) => a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : naturalPathSort(a, b));
  const text = cleanText(names.flatMap(name => xmlParagraphs(decodeText(files.get(name)), 'w:p', 'w:t')).join('\n\n')).slice(0, MAX_EXTRACTED_TEXT);
  return { kind: 'document', title: '', description: '', text, publishedAt: null, basis: 'full_text' };
}

async function extractPptx(buffer) {
  const { files } = await readZip(buffer, name => /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/i.test(name));
  const names = [...files.keys()].sort(naturalPathSort);
  const sections = names.map(name => {
    const label = name.includes('/slides/') ? `幻灯片 ${name.match(/\d+/)?.[0] || ''}` : `演讲者备注 ${name.match(/\d+/)?.[0] || ''}`;
    const paragraphs = xmlParagraphs(decodeText(files.get(name)), 'a:p', 'a:t');
    return paragraphs.length ? `${label}\n${paragraphs.join('\n')}` : '';
  }).filter(Boolean);
  return { kind: 'presentation', title: '', description: '', text: cleanText(sections.join('\n\n')).slice(0, MAX_EXTRACTED_TEXT), publishedAt: null, basis: 'full_text' };
}

function worksheetRows(xml, sharedStrings) {
  const $ = load(xml, { xmlMode: true });
  return $('row').map((_, row) => {
    const cells = $(row).find('c').map((__, cell) => {
      const type = $(cell).attr('t');
      const reference = $(cell).attr('r') || '';
      const raw = type === 'inlineStr' ? $(cell).find('t').map((___, node) => $(node).text()).get().join('') : $(cell).find('v').first().text();
      const value = type === 's' ? sharedStrings[Number(raw)] || '' : type === 'b' ? raw === '1' ? 'TRUE' : 'FALSE' : raw;
      return value ? `${reference}: ${value}` : '';
    }).get().filter(Boolean);
    return cells.join(' | ');
  }).get().filter(Boolean);
}

async function extractXlsx(buffer) {
  const { files } = await readZip(buffer, name => /^xl\/(sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/sheet\d+\.xml)$/i.test(name));
  const sharedXml = files.get('xl/sharedStrings.xml');
  const sharedStrings = sharedXml ? (() => {
    const $ = load(decodeText(sharedXml), { xmlMode: true });
    return $('si').map((_, item) => $(item).find('t').map((__, node) => $(node).text()).get().join('')).get();
  })() : [];
  const sheetNames = new Map();
  const workbook = files.get('xl/workbook.xml');
  const relationships = files.get('xl/_rels/workbook.xml.rels');
  if (workbook && relationships) {
    const relationshipMap = new Map();
    const rel$ = load(decodeText(relationships), { xmlMode: true });
    rel$('Relationship').each((_, node) => relationshipMap.set(rel$(node).attr('Id'), rel$(node).attr('Target')));
    const book$ = load(decodeText(workbook), { xmlMode: true });
    book$('sheet').each((_, node) => {
      const target = relationshipMap.get(book$(node).attr('r:id'));
      if (target) sheetNames.set(posix.normalize(posix.join('xl', target.replace(/^\//, '').replace(/^xl\//, ''))), book$(node).attr('name'));
    });
  }
  const sheets = [...files.keys()].filter(name => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).sort(naturalPathSort);
  const text = sheets.map((name, index) => {
    const rows = worksheetRows(decodeText(files.get(name)), sharedStrings);
    return rows.length ? `工作表：${sheetNames.get(name) || `Sheet ${index + 1}`}\n${rows.join('\n')}` : '';
  }).filter(Boolean).join('\n\n');
  return { kind: 'spreadsheet', title: '', description: '', text: cleanText(text).slice(0, MAX_EXTRACTED_TEXT), publishedAt: null, basis: 'full_text' };
}

async function extractEpub(buffer) {
  const { files } = await readZip(buffer, name => /(^|\/)(container\.xml|[^/]+\.opf|[^/]+\.(xhtml|html|htm))$/i.test(name));
  const container = files.get('META-INF/container.xml');
  let opfPath = [...files.keys()].find(name => name.toLowerCase().endsWith('.opf')) || '';
  if (container) {
    const $ = load(decodeText(container), { xmlMode: true });
    opfPath = $('rootfile').first().attr('full-path') || opfPath;
  }
  const opf = files.get(opfPath);
  let title = '';
  let contentPaths = [];
  if (opf) {
    const $ = load(decodeText(opf), { xmlMode: true });
    title = $('dc\\:title, title').first().text().trim();
    const manifest = new Map();
    $('manifest item').each((_, node) => manifest.set($(node).attr('id'), $(node).attr('href')));
    const base = posix.dirname(opfPath);
    contentPaths = $('spine itemref').map((_, node) => manifest.get($(node).attr('idref'))).get().filter(Boolean).map(href => posix.normalize(posix.join(base, href.split('#')[0])));
  }
  if (!contentPaths.length) contentPaths = [...files.keys()].filter(name => /\.(xhtml|html|htm)$/i.test(name)).sort(naturalPathSort);
  const chapters = [...new Set(contentPaths)].map(name => {
    const value = files.get(name);
    if (!value) return '';
    const $ = load(decodeText(value));
    $('script,style,noscript,nav,svg').remove();
    return cleanText($('body').text());
  }).filter(Boolean);
  return { kind: 'ebook', title, description: '', text: cleanText(chapters.join('\n\n')).slice(0, MAX_EXTRACTED_TEXT), publishedAt: null, basis: 'full_text' };
}

async function extractAudio(buffer, extension, path) {
  let metadata = null;
  try { metadata = await parseAudioBuffer(buffer, { mimeType: AUDIO_TYPES.get(extension), size: buffer.length, path }, { duration: true, skipCovers: true }); }
  catch { /* An unreadable tag must not prevent manual review. */ }
  const common = metadata?.common || {};
  const format = metadata?.format || {};
  const duration = Number.isFinite(format.duration) ? `${Math.floor(format.duration / 60)}:${String(Math.round(format.duration % 60)).padStart(2, '0')}` : '';
  const fields = [
    ['标题', common.title], ['艺术家/作者', common.artist], ['专辑', common.album], ['年份', common.year], ['时长', duration],
    ['格式', format.container || format.codec], ['采样率', format.sampleRate ? `${format.sampleRate} Hz` : ''],
  ].filter(([, value]) => value !== undefined && value !== null && String(value).trim());
  const text = fields.map(([label, value]) => `${label}：${value}`).join('\n');
  return {
    kind: 'audio', title: String(common.title || basename(path, extension)), description: text || '未读取到音频元数据', text,
    publishedAt: null, basis: 'audio_metadata', forceReview: true,
    reviewReason: '音频未转写，请填写内容校正后重新分析', metadata: Object.fromEntries(fields),
  };
}

async function extractArchive(buffer, path) {
  const { entries } = await readZip(buffer);
  const files = entries.filter(entry => !entry.directory).map(entry => entry.name);
  const shown = files.slice(0, 5000);
  const text = cleanText([`压缩包：${basename(path)}`, `文件数量：${files.length}`, '', ...shown, ...(files.length > shown.length ? [`…另有 ${files.length - shown.length} 个文件`] : [])].join('\n'));
  return { kind: 'archive', title: basename(path, extname(path)), description: `压缩包内含 ${files.length} 个文件`, text, publishedAt: null, basis: 'archive_listing' };
}

export function extractHtml(html, url) {
  const $ = load(html);
  const meta = (key) => $(`meta[property="${key}"], meta[name="${key}"]`).first().attr('content')?.trim() || '';
  const structured = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const walk = value => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') {
          structured.push(value);
          if (value['@graph']) walk(value['@graph']);
        }
      };
      walk(JSON.parse($(element).html() || 'null'));
    } catch { /* Ignore invalid structured data. */ }
  });
  const primary = structured.find(item => /Article|VideoObject/i.test(String(item['@type'] || ''))) || structured[0] || {};
  const title = meta('og:title') || $('title').first().text().trim() || $('h1').first().text().trim() || String(primary.headline || primary.name || '');
  const description = meta('og:description') || meta('description') || String(primary.description || '');
  let publishedAt = meta('article:published_time') || primary.datePublished || primary.uploadDate || $('time[datetime]').first().attr('datetime') || null;
  if (typeof publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(publishedAt)) publishedAt = null;
  const video = VIDEO_HOSTS.test(new URL(url).hostname) || Boolean(meta('og:video') || meta('og:video:url')) || /VideoObject/i.test(String(primary['@type'] || ''));
  if (video) return { kind: 'video', title, description, text: cleanText(`${title}\n${description}`), publishedAt, basis: description ? 'title_description' : 'title_only', sourceUrl: url, snapshot: html };

  $('script,style,noscript,nav,footer,header,aside,form,svg').remove();
  const root = $('article').first().length ? $('article').first() : $('main').first().length ? $('main').first() : $('body').first();
  root.find('[aria-hidden="true"], .advertisement, .ads, .sidebar, .comments').remove();
  const paragraphs = root.find('h1,h2,h3,p,li,blockquote').map((_, el) => $(el).text().trim()).get().filter(text => text.length > 20);
  const text = cleanText(paragraphs.join('\n\n') || root.text());
  return { kind: 'article', title, description, text, publishedAt, basis: 'full_text', sourceUrl: url, snapshot: html };
}

export async function extractPdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false });
  const document = await loadingTask.promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 300); pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => item.str || '').join(' '));
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  const text = cleanText(pages.join('\n\n'));
  return { kind: 'pdf', title: '', description: '', text, publishedAt: null, basis: 'full_text' };
}

export async function extractFile(path) {
  const extension = extname(path).toLowerCase();
  if (extension === '.url' || extension === '.webloc') {
    const raw = (await readFile(path, 'utf8')).trim();
    const match = raw.match(/^URL=(.+)$/im);
    return extractUrl((match ? match[1] : raw).trim());
  }
  const buffer = await readFile(path);
  if (extension === '.pdf') return { ...await extractPdf(buffer), assetExtension: '.pdf', assetBuffer: buffer };
  if (IMAGE_TYPES.has(extension)) return { kind: 'image', title: '', description: '', text: '', publishedAt: null, basis: 'image', imageMime: IMAGE_TYPES.get(extension), imageBuffer: buffer, assetExtension: extension, assetBuffer: buffer };
  if (TEXT_TYPES.has(extension) || CODE_TYPES.has(extension)) {
    const text = cleanText(decodeText(buffer)).slice(0, MAX_EXTRACTED_TEXT);
    return { kind: TEXT_TYPES.get(extension) || 'code', title: basename(path, extension), description: '', text, publishedAt: null, basis: 'full_text', assetExtension: extension, assetBuffer: buffer };
  }
  if (extension === '.html' || extension === '.htm') {
    const item = extractHtml(decodeText(buffer), 'https://local.invalid/');
    return { ...item, kind: 'article', sourceUrl: undefined, snapshot: undefined, title: item.title || basename(path, extension), assetExtension: extension, assetBuffer: buffer };
  }
  if (extension === '.docx') return { ...await extractDocx(buffer), title: basename(path, extension), assetExtension: extension, assetBuffer: buffer };
  if (extension === '.pptx') return { ...await extractPptx(buffer), title: basename(path, extension), assetExtension: extension, assetBuffer: buffer };
  if (extension === '.xlsx') return { ...await extractXlsx(buffer), title: basename(path, extension), assetExtension: extension, assetBuffer: buffer };
  if (extension === '.epub') {
    const item = await extractEpub(buffer);
    return { ...item, title: item.title || basename(path, extension), assetExtension: extension, assetBuffer: buffer };
  }
  if (AUDIO_TYPES.has(extension)) return { ...await extractAudio(buffer, extension, path), assetExtension: extension, assetBuffer: buffer };
  if (extension === '.zip') return { ...await extractArchive(buffer, path), assetExtension: extension, assetBuffer: buffer };
  throw new Error('Unsupported file type');
}

export async function extractUrl(raw) {
  const { url, type, body } = await fetchPage(raw);
  if (type.includes('pdf') || new URL(url).pathname.toLowerCase().endsWith('.pdf')) {
    return { ...await extractPdf(body), sourceUrl: url, assetExtension: '.pdf', assetBuffer: body };
  }
  if (!type.includes('html') && !type.includes('text')) throw new Error('URL must resolve to a webpage or PDF');
  const item = extractHtml(body.toString('utf8'), url);
  return { ...item, assetExtension: item.kind === 'video' ? '.url' : '.html', assetBuffer: item.kind === 'video' ? Buffer.from(`${url}\n`) : body };
}
