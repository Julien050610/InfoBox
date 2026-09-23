import { readFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { extname } from 'node:path';
import { load } from 'cheerio';

const IMAGE_TYPES = new Map([['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp'], ['.gif', 'image/gif']]);
const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|bilibili\.com|vimeo\.com|tiktok\.com|douyin\.com)$/i;
const MAX_WEB_BYTES = 10 * 1024 * 1024;

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
  throw new Error('Supported files: PDF, JPG, PNG, WebP, GIF, and .url');
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
