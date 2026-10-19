import { AppError, ValidationError } from '../errors.js';

const KEY = /^[A-Z0-9]{8}$/;
const pageNumber = (value, fallback, max) => {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 0 || number > max) throw new ValidationError('Invalid Zotero page parameter');
  return number;
};

export class ZoteroClient {
  constructor({ fetchImpl = fetch, baseUrl = 'http://127.0.0.1:23119/api' } = {}) {
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async get(path, query = {}) {
    const url = new URL(`${this.baseUrl}/users/0/${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    let response;
    try { response = await this.fetch(url, { headers: { 'Zotero-API-Version': '3' }, signal: AbortSignal.timeout(5000) }); }
    catch (cause) { throw new AppError('ZOTERO_UNAVAILABLE', 'Zotero 未运行或尚未启用本地 API', { status: 503, cause }); }
    if (response.status === 404) throw new AppError('ZOTERO_NOT_FOUND', 'Zotero 条目不存在', { status: 404 });
    if (!response.ok) throw new AppError('ZOTERO_API_ERROR', `Zotero 本地 API 返回 ${response.status}`, { status: 502 });
    try { return await response.json(); }
    catch (cause) { throw new AppError('ZOTERO_INVALID_RESPONSE', 'Zotero 返回了无效数据', { status: 502, cause }); }
  }

  async status() {
    try { await this.get('items/top', { limit: 1 }); return { connected: true, read_only: true }; }
    catch (error) { return { connected: false, read_only: true, reason: error.message }; }
  }

  async collections({ start = 0, limit = 100 } = {}) {
    return this.get('collections', { start: pageNumber(start, 0, 100000), limit: pageNumber(limit, 100, 100) });
  }

  async items({ collectionKey = null, start = 0, limit = 50 } = {}) {
    const path = collectionKey ? `collections/${this.key(collectionKey)}/items/top` : 'items/top';
    return this.get(path, { start: pageNumber(start, 0, 100000), limit: pageNumber(limit, 50, 100) });
  }

  async item(key) { return this.get(`items/${this.key(key)}`); }
  async children(key, { start = 0, limit = 100 } = {}) {
    return this.get(`items/${this.key(key)}/children`, { start: pageNumber(start, 0, 100000), limit: pageNumber(limit, 100, 100) });
  }
  async annotations(key) {
    const children = await this.children(key);
    const attachments = children.filter(entry => (entry.data || entry).itemType === 'attachment').slice(0, 20);
    const nested = await Promise.all(attachments.map(entry => this.children((entry.data || entry).key)));
    return nested.flat().filter(entry => (entry.data || entry).itemType === 'annotation');
  }
  async tags({ start = 0, limit = 100 } = {}) {
    return this.get('tags', { start: pageNumber(start, 0, 100000), limit: pageNumber(limit, 100, 100) });
  }

  key(value) {
    const key = String(value || '').toUpperCase();
    if (!KEY.test(key)) throw new ValidationError('Invalid Zotero item key');
    return key;
  }
}
