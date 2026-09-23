import { getDocument, GlobalWorkerOptions } from '/vendor/pdf.mjs';

GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';

const state = {
  items: [],
  inboxFiles: [],
  inboxAvailable: null,
  backendCompatible: null,
  tree: null,
  scope: 'all',
  category: '',
  tag: '',
  query: '',
  searchMatches: new Map(),
  searchRequest: 0,
  filters: {
    kinds: [], tags: [], tagMode: 'and', status: '', readingStatuses: [], favorite: 'any',
    scoreMin: 0, publishedFrom: '', publishedTo: '', receivedFrom: '', receivedTo: '', sort: 'received_desc',
  },
  savedViews: [],
  relations: [],
  restructureHistory: [],
  restructurePreview: null,
  structureBusy: false,
  graphMode: true,
  graphFocusId: 'root',
  graphViewport: { x: 0, y: 0, scale: 1 },
  graphDrag: null,
  graphMoved: false,
  navigationHistory: [],
  navigationIndex: -1,
  restoringNavigation: false,
  selectedId: null,
  tab: 'asset',
  renderToken: 0,
  collapsedFolders: new Set(),
  sidebarCollapsed: false,
  readingMode: false,
  pinning: false,
  notes: [],
  notesItemId: null,
  noteSaveTimers: new Map(),
  updatePdfPage: null,
  uploadingInbox: false,
  processingInbox: false,
  inboxProgress: '',
  editingItemId: null,
  busyAction: false,
};

const elements = {
  workspace: document.querySelector('#workspace'),
  sidebarToggle: document.querySelector('#sidebarToggle'),
  inboxCount: document.querySelector('#inboxCount'),
  inboxDropzone: document.querySelector('#inboxDropzone'),
  inboxFileInput: document.querySelector('#inboxFileInput'),
  inboxChooseButton: document.querySelector('#inboxChooseButton'),
  processInboxButton: document.querySelector('#processInboxButton'),
  processInboxLabel: document.querySelector('#processInboxLabel'),
  inboxStatus: document.querySelector('#inboxStatus'),
  allCount: document.querySelector('#allCount'),
  recentCount: document.querySelector('#recentCount'),
  reviewCount: document.querySelector('#reviewCount'),
  favoriteCount: document.querySelector('#favoriteCount'),
  unreadCount: document.querySelector('#unreadCount'),
  savedViewCount: document.querySelector('#savedViewCount'),
  savedViewList: document.querySelector('#savedViewList'),
  libraryCount: document.querySelector('#libraryCount'),
  newFolderButton: document.querySelector('#newFolderButton'),
  structureButton: document.querySelector('#structureButton'),
  folderCreator: document.querySelector('#folderCreator'),
  folderParent: document.querySelector('#folderParent'),
  folderName: document.querySelector('#folderName'),
  tree: document.querySelector('#libraryTree'),
  collectionPath: document.querySelector('#collectionPath'),
  collectionTitle: document.querySelector('#collectionTitle'),
  search: document.querySelector('#searchInput'),
  contentColumn: document.querySelector('.content-column'),
  backButton: document.querySelector('#backButton'),
  forwardButton: document.querySelector('#forwardButton'),
  filterButton: document.querySelector('#filterButton'),
  filterCount: document.querySelector('#filterCount'),
  filterPanel: document.querySelector('#filterPanel'),
  structurePanel: document.querySelector('#structurePanel'),
  restructureScope: document.querySelector('#restructureScope'),
  restructurePreview: document.querySelector('#restructurePreview'),
  structureHistory: document.querySelector('#structureHistory'),
  structureHistoryCount: document.querySelector('#structureHistoryCount'),
  folderMoveSource: document.querySelector('#folderMoveSource'),
  folderMoveParent: document.querySelector('#folderMoveParent'),
  folderMoveName: document.querySelector('#folderMoveName'),
  graphButton: document.querySelector('#graphButton'),
  graphPanel: document.querySelector('#graphPanel'),
  graphCanvas: document.querySelector('#graphCanvas'),
  graphZoom: document.querySelector('#graphZoom'),
  resultCount: document.querySelector('#resultCount'),
  list: document.querySelector('#itemList'),
  readerKind: document.querySelector('#readerKind'),
  readerTitle: document.querySelector('#readerTitle'),
  readerSubtitle: document.querySelector('#readerSubtitle'),
  viewer: document.querySelector('#viewer'),
  openOriginal: document.querySelector('#openOriginal'),
  readingToggle: document.querySelector('#readingToggle'),
  inspectorEmpty: document.querySelector('#inspectorEmpty'),
  inspector: document.querySelector('#inspectorContent'),
  notesPanel: document.querySelector('#notesPanel'),
  newNoteButton: document.querySelector('#newNoteButton'),
  pinHint: document.querySelector('#pinHint'),
  notesScroll: document.querySelector('#notesScroll'),
  notesTrack: document.querySelector('#notesTrack'),
  noteLines: document.querySelector('#noteLines'),
  anchorMarkers: document.querySelector('#anchorMarkers'),
  statusDot: document.querySelector('#statusDot'),
  connectionStatus: document.querySelector('#connectionStatus'),
  toast: document.querySelector('#toast'),
};

const kindNames = { pdf: 'PDF', image: '图片', video: '视频', article: '网页', unknown: '文件' };
const basisNames = {
  full_text: '提取的正文', title_description: '标题与简介', title_only: '仅标题',
  image: '图片内容', manual_correction: '人工校正文本', unavailable: '未提取',
};
const readingNames = { unread: '未读', reading: '阅读中', read: '已读' };
const relationNames = { related: '相关', cites: '引用', supports: '支持', contradicts: '反驳', follow_up: '后续研究' };

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function api(path, options) {
  return fetch(path, options).then(async response => {
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `请求失败：${response.status}`);
    return response.json();
  });
}

function navigationSnapshot() {
  return {
    graphMode: state.graphMode,
    graphFocusId: state.graphFocusId,
    scope: state.scope,
    category: state.category,
    selectedId: state.selectedId,
    tab: state.tab,
    query: state.query,
    filters: structuredClone(state.filters),
  };
}

function updateHistoryButtons() {
  elements.backButton.disabled = state.navigationIndex <= 0;
  elements.forwardButton.disabled = state.navigationIndex < 0 || state.navigationIndex >= state.navigationHistory.length - 1;
}

function pushNavigation() {
  if (state.restoringNavigation) return;
  const snapshot = navigationSnapshot();
  const current = state.navigationHistory[state.navigationIndex];
  if (current && JSON.stringify(current) === JSON.stringify(snapshot)) return updateHistoryButtons();
  state.navigationHistory = state.navigationHistory.slice(0, state.navigationIndex + 1);
  state.navigationHistory.push(snapshot);
  state.navigationIndex = state.navigationHistory.length - 1;
  updateHistoryButtons();
}

async function restoreNavigation(snapshot) {
  if (!snapshot) return;
  state.restoringNavigation = true;
  state.graphMode = snapshot.graphMode;
  state.graphFocusId = snapshot.graphFocusId || 'root';
  state.scope = snapshot.scope || 'all';
  state.category = snapshot.category || '';
  state.selectedId = snapshot.selectedId || null;
  state.tab = snapshot.tab || 'asset';
  state.query = snapshot.query || '';
  state.filters = structuredClone(snapshot.filters || state.filters);
  elements.search.value = state.query;
  toggleFilterPanel(false);
  setReadingMode(false);
  setGraphMode(state.graphMode);
  if (state.query) await runSearch();
  else { state.searchMatches = new Map(); render(); }
  state.restoringNavigation = false;
  updateHistoryButtons();
}

function goBack() {
  if (state.navigationIndex <= 0) return;
  state.navigationIndex -= 1;
  restoreNavigation(state.navigationHistory[state.navigationIndex]);
}

function goForward() {
  if (state.navigationIndex >= state.navigationHistory.length - 1) return;
  state.navigationIndex += 1;
  restoreNavigation(state.navigationHistory[state.navigationIndex]);
}

function isRecent(item) {
  if (!item.received_at) return false;
  return Date.now() - new Date(`${item.received_at}T00:00:00`).getTime() <= 30 * 24 * 60 * 60 * 1000;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function inboxType(file) {
  return String(file.extension || '').replace('.', '').toUpperCase() || 'FILE';
}

function filteredItems() {
  const query = state.query.trim();
  const filters = state.filters;
  const results = state.items.filter(item => {
    if (state.scope === 'review' && item.status !== 'review') return false;
    if (state.scope === 'recent' && !isRecent(item)) return false;
    if (state.scope === 'favorites' && !item.favorite) return false;
    if (state.scope === 'unread' && item.reading_status !== 'unread') return false;
    if (state.scope === 'category' && item.status !== 'ready') return false;
    if (state.scope === 'category' && item.category !== state.category && !item.category?.startsWith(`${state.category}/`)) return false;
    if (query && !state.searchMatches.has(item.id)) return false;
    if (filters.kinds.length && !filters.kinds.includes(item.kind)) return false;
    if (filters.status && item.status !== filters.status) return false;
    if (filters.readingStatuses.length && !filters.readingStatuses.includes(item.reading_status)) return false;
    if (filters.favorite === 'yes' && !item.favorite) return false;
    if (filters.favorite === 'no' && item.favorite) return false;
    if (filters.scoreMin && (item.quality_score || 0) < filters.scoreMin) return false;
    if (filters.tags.length) {
      const matches = filters.tags.map(tag => item.tags?.includes(tag));
      if (filters.tagMode === 'and' ? !matches.every(Boolean) : !matches.some(Boolean)) return false;
    }
    if (filters.publishedFrom && (!item.published_at || item.published_at < filters.publishedFrom)) return false;
    if (filters.publishedTo && (!item.published_at || item.published_at > filters.publishedTo)) return false;
    if (filters.receivedFrom && (!item.received_at || item.received_at < filters.receivedFrom)) return false;
    if (filters.receivedTo && (!item.received_at || item.received_at > filters.receivedTo)) return false;
    return true;
  });
  return results.sort((a, b) => {
    if (query) return (state.searchMatches.get(b.id)?.score || 0) - (state.searchMatches.get(a.id)?.score || 0);
    if (filters.sort === 'published_desc') return String(b.published_at || '').localeCompare(String(a.published_at || ''));
    if (filters.sort === 'score_desc') return (b.quality_score || 0) - (a.quality_score || 0);
    if (filters.sort === 'title_asc') return a.title.localeCompare(b.title, 'zh-CN');
    return String(b.received_at || '').localeCompare(String(a.received_at || ''));
  });
}

function activeFilterCount() {
  const f = state.filters;
  return f.kinds.length + f.tags.length + f.readingStatuses.length + Number(Boolean(f.status)) + Number(f.favorite !== 'any') + Number(f.scoreMin > 0) + Number(Boolean(f.publishedFrom)) + Number(Boolean(f.publishedTo)) + Number(Boolean(f.receivedFrom)) + Number(Boolean(f.receivedTo)) + Number(f.sort !== 'received_desc');
}

function treeHtml(nodes, depth = 0) {
  return nodes.map(node => {
    const collapsed = state.collapsedFolders.has(node.path);
    const hasChildren = Boolean(node.children?.length);
    return `
    <div class="tree-branch" role="treeitem">
      <button class="tree-node ${state.scope === 'category' && state.category === node.path ? 'is-active' : ''}"
        data-category="${escapeHtml(node.path)}" style="--depth:${depth}">
        <span class="folder ${hasChildren ? '' : 'is-leaf'} ${collapsed ? 'is-collapsed' : ''}" ${hasChildren ? `data-tree-toggle="${escapeHtml(node.path)}"` : ''}>${hasChildren ? '▾' : '▱'}</span>
        <span class="node-name">${escapeHtml(node.name)}</span><span class="node-count">${node.count}</span>
      </button>
      ${hasChildren && !collapsed ? `<div class="tree-children" role="group">${treeHtml(node.children, depth + 1)}</div>` : ''}
    </div>`;
  }).join('');
}

function flatFolders(nodes = [], result = []) {
  nodes.forEach(node => {
    result.push(node);
    flatFolders(node.children || [], result);
  });
  return result;
}

function renderNavigation() {
  const readyCount = state.items.filter(item => item.status === 'ready').length;
  const inboxCount = state.inboxFiles.length;
  const supportedInboxCount = state.inboxFiles.filter(file => file.supported).length;
  elements.allCount.textContent = state.items.length;
  elements.inboxCount.textContent = inboxCount;
  elements.recentCount.textContent = state.items.filter(isRecent).length;
  elements.reviewCount.textContent = state.items.filter(item => item.status === 'review').length;
  elements.favoriteCount.textContent = state.items.filter(item => item.favorite).length;
  elements.unreadCount.textContent = state.items.filter(item => item.reading_status === 'unread').length;
  elements.libraryCount.textContent = readyCount;
  elements.tree.innerHTML = state.tree?.children?.length ? treeHtml(state.tree.children) : '<div class="empty-list">暂无分类</div>';
  const selectedParent = elements.folderParent.value;
  elements.folderParent.innerHTML = '<option value="">一级文件夹</option>' + (state.tree?.children || []).map(node => `<option value="${escapeHtml(node.path)}">${escapeHtml(node.name)} 下的二级文件夹</option>`).join('');
  if ([...elements.folderParent.options].some(option => option.value === selectedParent)) elements.folderParent.value = selectedParent;
  elements.inboxChooseButton.disabled = state.inboxAvailable === false || state.uploadingInbox;
  elements.inboxDropzone.classList.toggle('is-unavailable', state.inboxAvailable === false);
  elements.processInboxButton.disabled = !supportedInboxCount || state.inboxAvailable === false || state.processingInbox || state.uploadingInbox;
  elements.processInboxLabel.textContent = state.processingInbox ? '正在分类…' : state.uploadingInbox ? '正在接收…' : '执行收件箱分类';
  elements.inboxStatus.textContent = state.inboxProgress || (state.inboxAvailable === false ? '请重新打开工作台以更新后台' : inboxCount ? `${inboxCount} 个文件等待分类` : '收件箱为空');
  elements.savedViewCount.textContent = state.savedViews.length;
  elements.savedViewList.innerHTML = state.savedViews.length ? state.savedViews.map(view => `<button class="saved-view-row" data-view-id="${view.id}" title="${escapeHtml(view.name)}"><span>⌕</span><span class="saved-view-name">${escapeHtml(view.name)}</span><span class="saved-view-delete" data-view-delete="${view.id}" aria-label="删除保存视图">×</span></button>`).join('') : '<div class="saved-view-empty">尚未保存筛选视图</div>';
  const filterCount = activeFilterCount();
  elements.filterCount.hidden = !filterCount;
  elements.filterCount.textContent = filterCount;
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('is-active', button.dataset.scope === state.scope));
}

function renderFilterPanel() {
  const kinds = [...new Set(state.items.map(item => item.kind))].sort();
  const tags = [...new Set(state.items.flatMap(item => item.tags || []))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const chip = (group, value, label, checked) => `<label class="filter-choice"><input type="checkbox" data-filter-group="${group}" value="${escapeHtml(value)}" ${checked ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>`;
  document.querySelector('#kindFilters').innerHTML = kinds.map(kind => chip('kinds', kind, kindNames[kind] || kind, state.filters.kinds.includes(kind))).join('') || '<span class="summary">暂无类型</span>';
  document.querySelector('#readingFilters').innerHTML = Object.entries(readingNames).map(([value, label]) => chip('readingStatuses', value, label, state.filters.readingStatuses.includes(value))).join('');
  document.querySelector('#tagFilters').innerHTML = tags.map(tag => chip('tags', tag, tag, state.filters.tags.includes(tag))).join('') || '<span class="summary">暂无标签</span>';
  document.querySelector('#tagMode').value = state.filters.tagMode;
  document.querySelector('#statusFilter').value = state.filters.status;
  document.querySelector('#favoriteFilter').value = state.filters.favorite;
  document.querySelector('#scoreFilter').value = String(state.filters.scoreMin);
  document.querySelector('#sortFilter').value = state.filters.sort;
  document.querySelector('#publishedFrom').value = state.filters.publishedFrom;
  document.querySelector('#publishedTo').value = state.filters.publishedTo;
  document.querySelector('#receivedFrom').value = state.filters.receivedFrom;
  document.querySelector('#receivedTo').value = state.filters.receivedTo;
}

function readFilterPanel() {
  const checked = group => [...elements.filterPanel.querySelectorAll(`[data-filter-group="${group}"]:checked`)].map(input => input.value);
  state.filters = {
    kinds: checked('kinds'), tags: checked('tags'), tagMode: document.querySelector('#tagMode').value,
    status: document.querySelector('#statusFilter').value, readingStatuses: checked('readingStatuses'),
    favorite: document.querySelector('#favoriteFilter').value, scoreMin: Number(document.querySelector('#scoreFilter').value),
    publishedFrom: document.querySelector('#publishedFrom').value, publishedTo: document.querySelector('#publishedTo').value,
    receivedFrom: document.querySelector('#receivedFrom').value, receivedTo: document.querySelector('#receivedTo').value,
    sort: document.querySelector('#sortFilter').value,
  };
}

function resetFilters() {
  state.filters = { kinds: [], tags: [], tagMode: 'and', status: '', readingStatuses: [], favorite: 'any', scoreMin: 0, publishedFrom: '', publishedTo: '', receivedFrom: '', receivedTo: '', sort: 'received_desc' };
  renderFilterPanel();
  render();
  pushNavigation();
}

function toggleFilterPanel(show = elements.filterPanel.hidden) {
  elements.filterPanel.hidden = !show;
  elements.filterButton.setAttribute('aria-expanded', String(show));
  if (show) {
    toggleStructurePanel(false);
    renderFilterPanel();
  }
}

function renderStructurePanel() {
  const folders = flatFolders(state.tree?.children || []);
  const topFolders = (state.tree?.children || []);
  const scopeValue = elements.restructureScope.value;
  const sourceValue = elements.folderMoveSource.value;
  const parentValue = elements.folderMoveParent.value;
  elements.restructureScope.innerHTML = '<option value="">整个知识库</option>' + folders.map(folder => `<option value="${escapeHtml(folder.path)}">${escapeHtml(folder.path)}</option>`).join('');
  elements.folderMoveSource.innerHTML = folders.length ? folders.map(folder => `<option value="${escapeHtml(folder.path)}">${escapeHtml(folder.path)}</option>`).join('') : '<option value="">暂无文件夹</option>';
  elements.folderMoveParent.innerHTML = '<option value="">作为一级文件夹</option>' + topFolders.map(folder => `<option value="${escapeHtml(folder.path)}">移到 ${escapeHtml(folder.name)} 下</option>`).join('');
  if ([...elements.restructureScope.options].some(option => option.value === scopeValue)) elements.restructureScope.value = scopeValue;
  if ([...elements.folderMoveSource.options].some(option => option.value === sourceValue)) elements.folderMoveSource.value = sourceValue;
  if ([...elements.folderMoveParent.options].some(option => option.value === parentValue)) elements.folderMoveParent.value = parentValue;
  if (!elements.folderMoveName.value && elements.folderMoveSource.value) elements.folderMoveName.value = elements.folderMoveSource.value.split('/').at(-1);

  const preview = state.restructurePreview;
  elements.restructurePreview.innerHTML = !preview ? '<div class="structure-empty">尚未生成方案</div>' : `
    <div class="preview-summary"><strong>${preview.changes.length ? `${preview.changes.length} 项建议调整` : '当前结构无需调整'}</strong><p>${escapeHtml(preview.rationale || 'Agent 没有补充说明。')}</p></div>
    ${preview.changes.length ? `<div class="preview-changes">${preview.changes.map((change, index) => `
      <label class="preview-change"><input type="checkbox" data-restructure-change="${index}" checked><span class="preview-change-copy"><strong>${escapeHtml(change.title)}</strong><span><i>${escapeHtml(change.from)}</i><b>→</b><i>${escapeHtml(change.to)}</i></span><small>${escapeHtml(change.reason || '目录层级更适合这项资料')} · ${Math.round(change.confidence * 100)}%</small></span></label>`).join('')}</div>
      <div class="preview-actions"><span>取消勾选可保留原位置</span><button class="primary-action" type="button" data-apply-restructure>应用选中调整</button></div>` : ''}`;

  elements.structureHistoryCount.textContent = `${state.restructureHistory.length} 次`;
  elements.structureHistory.innerHTML = state.restructureHistory.length ? state.restructureHistory.slice(0, 12).map(record => {
    const folderChange = record.folder_change;
    const title = folderChange ? `${folderChange.source} → ${folderChange.target}` : `${record.changes.length} 项资料重分类`;
    const date = new Date(record.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<article class="structure-history-row ${record.status === 'undone' ? 'is-undone' : ''}"><span class="history-mark">${folderChange ? '夹' : 'AI'}</span><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(record.rationale || '')}</p><small>${date}${record.status === 'undone' ? ' · 已撤销' : ''}</small></div>${record.status === 'applied' ? `<button type="button" data-undo-restructure="${record.id}">撤销</button>` : '<span class="history-status">已撤销</span>'}</article>`;
  }).join('') : '<div class="structure-empty">还没有结构调整记录</div>';
}

function toggleStructurePanel(show = elements.structurePanel.hidden) {
  elements.structurePanel.hidden = !show;
  elements.structureButton.setAttribute('aria-expanded', String(show));
  if (show) {
    elements.filterPanel.hidden = true;
    elements.filterButton.setAttribute('aria-expanded', 'false');
    renderStructurePanel();
  }
}

async function generateRestructure() {
  if (state.structureBusy) return;
  state.structureBusy = true;
  const button = document.querySelector('#generateRestructure');
  button.disabled = true;
  button.textContent = 'Agent 正在分析…';
  try {
    state.restructurePreview = await api('/api/restructure/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: elements.restructureScope.value }) });
    renderStructurePanel();
    showToast(state.restructurePreview.changes.length ? '重构方案已生成，请查看对照' : 'Agent 建议保留当前结构');
  } catch (error) { showToast(error.message); }
  finally {
    state.structureBusy = false;
    button.disabled = false;
    button.textContent = '生成对照';
  }
}

async function applyRestructure() {
  const preview = state.restructurePreview;
  if (!preview || state.structureBusy) return;
  const selected = [...elements.restructurePreview.querySelectorAll('[data-restructure-change]:checked')].map(input => preview.changes[Number(input.dataset.restructureChange)]).filter(Boolean);
  if (!selected.length) return showToast('请至少选择一项调整');
  state.structureBusy = true;
  try {
    await api('/api/restructure/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: preview.scope, rationale: preview.rationale, changes: selected }) });
    state.restructurePreview = null;
    await load({ quiet: true });
    renderStructurePanel();
    showToast('目录结构已更新，知识图谱已同步');
  } catch (error) { showToast(error.message); }
  finally { state.structureBusy = false; }
}

async function moveFolder() {
  if (state.structureBusy) return;
  const source = elements.folderMoveSource.value;
  const name = elements.folderMoveName.value.trim();
  if (!source || !name) return showToast('请选择文件夹并填写新名称');
  state.structureBusy = true;
  try {
    await api('/api/library/folders', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source, name, parent: elements.folderMoveParent.value }) });
    elements.folderMoveName.value = '';
    await load({ quiet: true });
    renderStructurePanel();
    showToast('文件夹已调整，资料关联保持不变');
  } catch (error) { showToast(error.message); }
  finally { state.structureBusy = false; }
}

async function undoRestructure(id) {
  if (state.structureBusy) return;
  state.structureBusy = true;
  try {
    await api(`/api/restructure/${id}/undo`, { method: 'POST' });
    elements.folderMoveName.value = '';
    await load({ quiet: true });
    renderStructurePanel();
    showToast('结构调整已撤销，知识图谱已同步');
  } catch (error) { showToast(error.message); }
  finally { state.structureBusy = false; }
}

async function runSearch() {
  const request = ++state.searchRequest;
  const query = state.query.trim();
  if (!query) {
    state.searchMatches = new Map();
  } else {
    try {
      const matches = await api(`/api/search?q=${encodeURIComponent(query)}`);
      if (request !== state.searchRequest) return;
      state.searchMatches = new Map(matches.map(match => [match.id, match]));
    } catch (error) {
      if (request !== state.searchRequest) return;
      showToast(error.message);
    }
  }
  renderList();
  renderInspector();
  renderViewer();
  if (state.graphMode) renderGraph();
}

async function saveCurrentView() {
  const name = window.prompt('给这个筛选视图命名：');
  if (!name?.trim()) return;
  try {
    const view = await api('/api/views', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim(), query: state.query, scope: state.scope, category: state.category, filters: state.filters }) });
    state.savedViews.push(view);
    renderNavigation();
    showToast('筛选视图已保存');
  } catch (error) { showToast(error.message); }
}

function applySavedView(view) {
  state.scope = view.scope || 'all';
  state.category = view.category || '';
  state.query = view.query || '';
  state.filters = { ...state.filters, ...(view.filters || {}) };
  elements.search.value = state.query;
  toggleFilterPanel(false);
  setGraphMode(false);
  runSearch().then(pushNavigation);
  renderNavigation();
}

function typeClass(item) {
  return ['pdf', 'video', 'image'].includes(item.kind) ? item.kind : '';
}

function renderList() {
  if (state.scope === 'inbox') {
    const query = state.query.trim().toLocaleLowerCase('zh-CN');
    const files = query ? state.inboxFiles.filter(file => file.name.toLocaleLowerCase('zh-CN').includes(query)) : state.inboxFiles;
    state.selectedId = null;
    elements.collectionTitle.textContent = '收件箱';
    elements.collectionPath.textContent = 'PENDING INBOX';
    elements.resultCount.textContent = `${files.length} 个待分类文件`;
    elements.list.innerHTML = files.length ? files.map(file => `
      <div class="item-row inbox-file-row">
        <span class="item-type">${escapeHtml(inboxType(file))}</span>
        <span class="item-title">
          <strong>${escapeHtml(file.name)}</strong>
          <small>${file.supported ? file.processing ? '正在分类' : '等待分类' : '暂不支持此格式'}</small>
        </span>
        <span class="item-tags"><span class="mini-tag">${escapeHtml(formatBytes(file.size))}</span></span>
        <span class="item-date inbox-row-actions ${file.supported ? '' : 'review-badge'}">
          <span>${file.supported ? '收件箱' : '需移除'}</span>
          <button class="inbox-delete-button" type="button" data-inbox-delete="${escapeHtml(file.name)}" aria-label="删除 ${escapeHtml(file.name)}" ${file.processing ? 'disabled' : ''}>×</button>
        </span>
      </div>`).join('') : '<div class="empty-list">拖动文件到左侧收件箱，即可在这里暂存</div>';
    return;
  }
  const items = filteredItems();
  const title = state.scope === 'review' ? '待检查' : state.scope === 'recent' ? '最近添加' : state.scope === 'favorites' ? '收藏' : state.scope === 'unread' ? '未读' : state.scope === 'category' ? state.category.split('/').at(-1) : '全部资料';
  elements.collectionTitle.textContent = state.graphMode ? '知识图谱' : title;
  elements.collectionPath.textContent = state.graphMode ? 'KNOWLEDGE HOME' : state.scope === 'category' ? `LIBRARY / ${state.category.toUpperCase()}` : 'KNOWLEDGE LIBRARY';
  elements.resultCount.textContent = `${items.length} 项资料`;
  if (!items.some(item => item.id === state.selectedId)) state.selectedId = state.graphMode ? null : items[0]?.id || null;
  elements.list.innerHTML = items.length ? items.map(item => `
    <button class="item-row ${item.id === state.selectedId ? 'is-active' : ''}" data-id="${item.id}">
      <span class="item-type ${typeClass(item)}">${escapeHtml(kindNames[item.kind] || 'FILE')}</span>
      <span class="item-title">
        <strong>${item.favorite ? '<span class="item-favorite">★</span>' : ''}${escapeHtml(item.title)}</strong>
        <small class="${state.query && state.searchMatches.get(item.id)?.snippet ? 'search-snippet' : ''}">${state.query && state.searchMatches.get(item.id)?.snippet ? escapeHtml(state.searchMatches.get(item.id).snippet) : item.status === 'review' ? `待检查 · ${escapeHtml(item.review_reason || item.category || '需要人工复查')}` : `<span class="reading-dot ${item.reading_status === 'read' ? 'read' : ''}"></span>${escapeHtml(readingNames[item.reading_status] || '未读')} · ${escapeHtml(item.category || '未分类')}`}</small>
      </span>
      <span class="item-tags">${(item.tags || []).slice(0, 2).map(tag => `<span class="mini-tag">${escapeHtml(tag)}</span>`).join('')}</span>
      <span class="item-date ${item.status === 'review' ? 'review-badge' : ''}">${escapeHtml(item.published_at || item.received_at || '日期未知')}</span>
    </button>`).join('') : '<div class="empty-list">这里暂时没有资料</div>';
}

function graphData() {
  const items = filteredItems().slice(0, 100);
  const palette = ['#2f7668', '#bd7047', '#607db0', '#9a7a32', '#7d6098', '#64854b'];
  const nodes = [{ id: 'root', type: 'root', label: '知识库', depth: 0, color: '#173f35' }];
  const edges = [];
  const known = new Set(['root']);
  const topFolders = [];
  const addFolderPath = pathValue => {
    let parent = 'root';
    const parts = String(pathValue || '').split('/').filter(Boolean);
    const topPath = parts[0];
    if (!topPath) return parent;
    if (!topFolders.includes(topPath)) topFolders.push(topPath);
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/');
      const id = `folder:${path}`;
      if (!known.has(id)) {
        known.add(id);
        nodes.push({ id, type: 'folder', label: part, path, topPath, depth: index + 1 });
        edges.push({ source: parent, target: id, type: 'structure' });
      }
      parent = id;
    });
    return parent;
  };
  const addTreeFolders = nodesToAdd => nodesToAdd.forEach(node => { addFolderPath(node.path); addTreeFolders(node.children || []); });
  addTreeFolders(state.tree?.children || []);
  for (const item of items) {
    const parts = String(item.category || '未分类').split('/').filter(Boolean).length ? String(item.category || '未分类').split('/').filter(Boolean) : ['未分类'];
    const topPath = parts[0];
    const parent = addFolderPath(parts.join('/'));
    nodes.push({ id: item.id, type: 'item', label: item.title, item, topPath, depth: parts.length + 1 });
    edges.push({ source: parent, target: item.id, type: 'structure' });
  }
  const colors = new Map(topFolders.map((folder, index) => [folder, palette[index % palette.length]]));
  nodes.forEach(node => { if (node.type !== 'root') node.color = colors.get(node.topPath) || palette[0]; });
  const ids = new Set(items.map(item => item.id));
  for (const relation of state.relations) if (ids.has(relation.source_id) && ids.has(relation.target_id)) edges.push({ source: relation.source_id, target: relation.target_id, type: 'relation', label: relationNames[relation.type] });
  const similarity = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    if (items[i].category === items[j].category) continue;
    const shared = (items[i].tags || []).filter(tag => items[j].tags?.includes(tag));
    if (!shared.length) continue;
    const union = new Set([...(items[i].tags || []), ...(items[j].tags || [])]).size || 1;
    similarity.push({ source: items[i].id, target: items[j].id, type: 'similarity', score: shared.length / union, label: `共同标签：${shared.join('、')}` });
  }
  similarity.sort((a, b) => b.score - a.score);
  edges.push(...similarity.slice(0, 120));
  return { nodes, edges, items };
}

function renderGraph() {
  if (!state.graphMode) return;
  const { nodes, edges, items } = graphData();
  if (nodes.length === 1) {
    elements.graphCanvas.innerHTML = '<div class="graph-empty">当前条件下没有可绘制的资料</div>';
    return;
  }
  const width = Math.max(620, elements.graphCanvas.clientWidth || 900);
  const height = Math.max(430, elements.graphCanvas.clientHeight || 620);
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (!byId.has(state.graphFocusId)) state.graphFocusId = 'root';
  const activeIds = new Set();
  if (state.graphFocusId === 'root') nodes.forEach(node => activeIds.add(node.id));
  else {
    const children = new Map();
    for (const edge of edges.filter(edge => edge.type === 'structure')) {
      if (!children.has(edge.source)) children.set(edge.source, []);
      children.get(edge.source).push(edge.target);
    }
    const pending = [state.graphFocusId];
    while (pending.length) {
      const id = pending.shift();
      if (activeIds.has(id)) continue;
      activeIds.add(id);
      pending.push(...(children.get(id) || []));
    }
  }
  const structuralEdges = edges.filter(edge => edge.type === 'structure');
  const children = new Map();
  for (const edge of structuralEdges) {
    if (!children.has(edge.source)) children.set(edge.source, []);
    children.get(edge.source).push(edge.target);
  }
  const leafIds = [];
  const collectLeaves = id => {
    const descendants = children.get(id) || [];
    if (!descendants.length) { leafIds.push(id); return; }
    descendants.forEach(collectLeaves);
  };
  collectLeaves('root');
  const worldHeight = Math.max(height, leafIds.length * 62 + 80);
  leafIds.forEach((id, index) => { byId.get(id).y = leafIds.length === 1 ? worldHeight / 2 : 40 + index * ((worldHeight - 80) / (leafIds.length - 1)); });
  const placeParents = id => {
    const descendants = children.get(id) || [];
    if (!descendants.length) return byId.get(id).y;
    const values = descendants.map(placeParents);
    byId.get(id).y = values.reduce((sum, value) => sum + value, 0) / values.length;
    return byId.get(id).y;
  };
  placeParents('root');
  const maxDepth = Math.max(...nodes.map(node => node.depth));
  const left = 58;
  const right = width - 145;
  const columnGap = (right - left) / Math.max(1, maxDepth);
  nodes.forEach(node => { node.x = left + node.depth * columnGap; });
  if (state.graphViewport.x === 0 && state.graphViewport.y === 0 && state.graphViewport.scale === 1 && worldHeight > height) {
    state.graphViewport.scale = Math.max(.45, (height - 18) / worldHeight);
    state.graphViewport.y = (height - worldHeight * state.graphViewport.scale) / 2;
  }
  const edgeHtml = edges.map(edge => {
    const a = byId.get(edge.source), b = byId.get(edge.target);
    if (!a || !b) return '';
    const muted = !activeIds.has(edge.source) || !activeIds.has(edge.target);
    const startRadius = a.type === 'root' ? 15 : a.type === 'folder' && a.depth === 1 ? 13 : a.type === 'folder' ? 10 : 6;
    const endRadius = b.type === 'folder' && b.depth === 1 ? 13 : b.type === 'folder' ? 10 : 6;
    let path;
    if (edge.type === 'structure') {
      const startX = a.x + startRadius;
      const endX = b.x - endRadius;
      const middle = (startX + endX) / 2;
      path = `M ${startX.toFixed(1)} ${a.y.toFixed(1)} C ${middle.toFixed(1)} ${a.y.toFixed(1)}, ${middle.toFixed(1)} ${b.y.toFixed(1)}, ${endX.toFixed(1)} ${b.y.toFixed(1)}`;
    } else {
      const middleX = (a.x + b.x) / 2;
      const arcY = Math.min(a.y, b.y) - 28;
      path = `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${middleX.toFixed(1)} ${arcY.toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
    }
    const stroke = edge.type === 'structure' ? (b.color || '#718078') : '';
    return `<path class="graph-edge ${edge.type} ${muted ? 'is-muted' : ''}" d="${path}" ${stroke ? `style="stroke:${stroke}"` : ''}><title>${escapeHtml(edge.label || (edge.type === 'structure' ? '文件夹层级' : '资料关联'))}</title></path>`;
  }).join('');
  const nodeHtml = nodes.map(node => {
    const radius = node.type === 'root' ? 15 : node.type === 'folder' && node.depth === 1 ? 13 : node.type === 'folder' ? 10 : 6;
    const shortLimit = node.type === 'item' ? 7 : 10;
    const shortLabel = node.label.length > shortLimit ? `${node.label.slice(0, shortLimit)}…` : node.label;
    const detailLabel = node.label.length > 28 ? `${node.label.slice(0, 28)}…` : node.label;
    const detailWidth = Math.min(265, Math.max(92, detailLabel.length * 10 + 20));
    const data = node.type === 'item' ? `data-graph-item="${node.id}"` : node.type === 'folder' ? `data-graph-category="${escapeHtml(node.path)}" data-graph-node="${node.id}"` : 'data-graph-root data-graph-node="root"';
    const detailY = node.y < 70 ? 15 : -41;
    const detail = node.type === 'item' ? `<g class="graph-detail-label"><rect x="${(-detailWidth / 2).toFixed(1)}" y="${detailY}" width="${detailWidth}" height="26" rx="6"></rect><text x="0" y="${detailY + 17}" text-anchor="middle">${escapeHtml(detailLabel)}</text></g>` : '';
    return `<g class="graph-node ${node.type} ${node.id === state.selectedId ? 'is-selected' : ''} ${node.id === state.graphFocusId ? 'is-focused' : ''} ${activeIds.has(node.id) ? '' : 'is-muted'}" style="--node-color:${node.color}" transform="translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})" ${data}><circle r="${radius}"></circle><text class="graph-short-label" x="${radius + 7}" y="3">${escapeHtml(shortLabel)}</text>${detail}<title>${escapeHtml(node.label)}</title></g>`;
  }).join('');
  elements.graphCanvas.innerHTML = `<svg class="knowledge-graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="文件夹与资料关系图"><g class="graph-stage">${edgeHtml}${nodeHtml}</g></svg>`;
  elements.graphCanvas.querySelectorAll('.graph-node.item').forEach(node => {
    node.addEventListener('pointerenter', () => node.classList.add('is-hovered'));
    node.addEventListener('pointerleave', () => node.classList.remove('is-hovered'));
  });
  applyGraphTransform();
}

function applyGraphTransform() {
  const stage = elements.graphCanvas.querySelector('.graph-stage');
  if (stage) stage.setAttribute('transform', `translate(${state.graphViewport.x} ${state.graphViewport.y}) scale(${state.graphViewport.scale})`);
  elements.graphZoom.textContent = `${Math.round(state.graphViewport.scale * 100)}%`;
}

function zoomGraph(factor, center = null) {
  const rect = elements.graphCanvas.getBoundingClientRect();
  const point = center || { x: rect.width / 2, y: rect.height / 2 };
  const previous = state.graphViewport.scale;
  const next = Math.max(.45, Math.min(2.8, previous * factor));
  if (next === previous) return;
  state.graphViewport.x = point.x - (point.x - state.graphViewport.x) * (next / previous);
  state.graphViewport.y = point.y - (point.y - state.graphViewport.y) * (next / previous);
  state.graphViewport.scale = next;
  applyGraphTransform();
}

function resetGraphViewport() {
  state.graphViewport = { x: 0, y: 0, scale: 1 };
  if (state.graphMode) renderGraph();
  else applyGraphTransform();
}

function setGraphMode(value) {
  state.graphMode = Boolean(value);
  if (state.graphMode) setReadingMode(false);
  elements.contentColumn.classList.toggle('is-graph', state.graphMode);
  elements.graphPanel.hidden = !state.graphMode;
  elements.graphButton.setAttribute('aria-pressed', String(state.graphMode));
  elements.graphButton.innerHTML = state.graphMode ? '<span>▤</span> 资料列表' : '<span>◌</span> 主页图谱';
  if (state.graphMode) requestAnimationFrame(renderGraph);
}

function openGraphHome({ record = true } = {}) {
  state.scope = 'all';
  state.category = '';
  state.selectedId = null;
  state.graphFocusId = 'root';
  state.query = '';
  state.searchMatches = new Map();
  state.filters = { kinds: [], tags: [], tagMode: 'and', status: '', readingStatuses: [], favorite: 'any', scoreMin: 0, publishedFrom: '', publishedTo: '', receivedFrom: '', receivedTo: '', sort: 'received_desc' };
  elements.search.value = '';
  setGraphMode(true);
  render();
  resetGraphViewport();
  if (record) pushNavigation();
}

function focusGraphNode(id, selectedId = null) {
  state.graphFocusId = id || 'root';
  state.selectedId = selectedId;
  state.editingItemId = null;
  renderInspector();
  renderGraph();
  pushNavigation();
}

function openGraphItem(id) {
  state.selectedId = id;
  state.graphFocusId = id;
  state.tab = 'asset';
  state.notes = [];
  state.notesItemId = null;
  setGraphMode(false);
  render();
  pushNavigation();
  const item = selectedItem();
  if (item?.reading_status === 'unread') patchOrganization({ reading_status: 'reading', last_opened_at: new Date().toISOString() });
}

function selectedItem() {
  return state.items.find(item => item.id === state.selectedId) || null;
}

function markdownToHtml(markdown) {
  const lines = String(markdown).replace(/\r/g, '').split('\n');
  const result = [];
  let listOpen = false;
  const closeList = () => { if (listOpen) { result.push('</ul>'); listOpen = false; } };
  for (const source of lines) {
    const line = escapeHtml(source);
    if (/^### /.test(source)) { closeList(); result.push(`<h3>${line.slice(4)}</h3>`); }
    else if (/^## /.test(source)) { closeList(); result.push(`<h2>${line.slice(3)}</h2>`); }
    else if (/^# /.test(source)) { closeList(); result.push(`<h1>${line.slice(2)}</h1>`); }
    else if (/^- /.test(source)) { if (!listOpen) { result.push('<ul>'); listOpen = true; } result.push(`<li>${line.slice(2)}</li>`); }
    else if (!source.trim()) closeList();
    else { closeList(); result.push(`<p>${line}</p>`); }
  }
  closeList();
  return result.join('');
}

async function textPreview(item, variant, token) {
  const response = await fetch(`/api/items/${item.id}/${variant}`);
  if (token !== state.renderToken) return;
  if (!response.ok) {
    elements.viewer.innerHTML = `<div class="error-state"><p>没有可用的${variant === 'markdown' ? '知识笔记' : '正文内容'}</p><span>该资料目前没有生成对应内容</span></div>`;
    return;
  }
  const text = await response.text();
  if (token !== state.renderToken) return;
  elements.viewer.innerHTML = `<article class="document-page">${variant === 'markdown' ? markdownToHtml(text) : `<p>${escapeHtml(text)}</p>`}</article>`;
  requestAnimationFrame(layoutNotes);
}

async function pdfPreview(item, token) {
  elements.viewer.innerHTML = `
    <div class="pdf-reader">
      <div class="pdf-toolbar">
        <button class="pdf-control" data-pdf-action="previous" aria-label="上一页">←</button>
        <span><strong data-pdf-page>1</strong> / <span data-pdf-pages>…</span></span>
        <button class="pdf-control" data-pdf-action="next" aria-label="下一页">→</button>
        <span class="pdf-divider"></span>
        <button class="pdf-control" data-pdf-action="zoom-out" aria-label="缩小">−</button>
        <span data-pdf-zoom>100%</span>
        <button class="pdf-control" data-pdf-action="zoom-in" aria-label="放大">＋</button>
      </div>
      <div class="pdf-document"><div class="pdf-progress">正在排版连续页面…</div></div>
    </div>`;
  try {
    const pdfDocument = await getDocument({ url: `/api/items/${item.id}/asset` }).promise;
    if (token !== state.renderToken) return pdfDocument.destroy();
    const reader = elements.viewer.querySelector('.pdf-reader');
    const documentElement = reader.querySelector('.pdf-document');
    let pageNumber = 1;
    let zoom = 1;
    let buildVersion = 0;
    let observer = null;
    reader.querySelector('[data-pdf-pages]').textContent = pdfDocument.numPages;

    const updatePageNumber = () => {
      const center = elements.viewer.getBoundingClientRect().top + elements.viewer.clientHeight * .48;
      const sheets = [...documentElement.querySelectorAll('.pdf-sheet')];
      const closest = sheets.reduce((best, sheet) => Math.abs(sheet.getBoundingClientRect().top - center) < Math.abs(best.getBoundingClientRect().top - center) ? sheet : best, sheets[0]);
      if (!closest) return;
      pageNumber = Number(closest.dataset.page);
      reader.querySelector('[data-pdf-page]').textContent = pageNumber;
      reader.querySelector('[data-pdf-action="previous"]').disabled = pageNumber === 1;
      reader.querySelector('[data-pdf-action="next"]').disabled = pageNumber === pdfDocument.numPages;
    };

    const buildPages = async (focusPage = null) => {
      const version = ++buildVersion;
      observer?.disconnect();
      documentElement.innerHTML = '';
      const available = Math.max(520, reader.clientWidth - 70);
      const pageCache = new Map();
      for (let number = 1; number <= pdfDocument.numPages; number++) {
        const page = await pdfDocument.getPage(number);
        if (version !== buildVersion || token !== state.renderToken) return;
        pageCache.set(number, page);
        const natural = page.getViewport({ scale: 1 });
        const scale = Math.min(1.55, available / natural.width) * zoom;
        const viewport = page.getViewport({ scale });
        const sheet = window.document.createElement('div');
        sheet.className = 'pdf-sheet';
        sheet.dataset.page = number;
        sheet.style.width = `${Math.floor(viewport.width)}px`;
        sheet.style.height = `${Math.floor(viewport.height)}px`;
        sheet.innerHTML = `<canvas aria-label="PDF 第 ${number} 页"></canvas>`;
        documentElement.append(sheet);
      }

      const renderSheet = async sheet => {
        if (sheet.dataset.rendered || version !== buildVersion || token !== state.renderToken) return;
        sheet.dataset.rendered = 'true';
        const page = pageCache.get(Number(sheet.dataset.page));
        const natural = page.getViewport({ scale: 1 });
        const scale = Math.min(1.55, available / natural.width) * zoom;
        const viewport = page.getViewport({ scale });
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = sheet.querySelector('canvas');
        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0] }).promise;
      };

      observer = new IntersectionObserver(entries => {
        entries.filter(entry => entry.isIntersecting).forEach(entry => renderSheet(entry.target));
      }, { root: elements.viewer, rootMargin: '900px 0px' });
      documentElement.querySelectorAll('.pdf-sheet').forEach(sheet => observer.observe(sheet));
      reader.querySelector('[data-pdf-zoom]').textContent = `${Math.round(zoom * 100)}%`;
      state.updatePdfPage = updatePageNumber;
      if (focusPage) documentElement.querySelector(`[data-page="${focusPage}"]`)?.scrollIntoView({ block: 'start' });
      updatePageNumber();
      requestAnimationFrame(layoutNotes);
    };

    reader.addEventListener('click', async event => {
      const action = event.target.closest('[data-pdf-action]')?.dataset.pdfAction;
      if (!action) return;
      if (action === 'previous' || action === 'next') {
        const target = Math.max(1, Math.min(pdfDocument.numPages, pageNumber + (action === 'next' ? 1 : -1)));
        documentElement.querySelector(`[data-page="${target}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (action === 'zoom-out') zoom = Math.max(.6, zoom - .15);
      if (action === 'zoom-in') zoom = Math.min(2.2, zoom + .15);
      await buildPages(pageNumber);
    });
    await buildPages();
  } catch (error) {
    if (token !== state.renderToken) return;
    elements.viewer.innerHTML = `<div class="error-state"><p>PDF 暂时无法显示</p><span>${escapeHtml(error.message)}</span></div>`;
  }
}

function videoEmbedUrl(source) {
  if (!source) return null;
  try {
    const url = new URL(source);
    if (url.hostname.includes('youtu.be')) return `https://www.youtube.com/embed/${url.pathname.split('/').filter(Boolean)[0]}`;
    if (url.hostname.includes('youtube.com')) return url.searchParams.get('v') ? `https://www.youtube.com/embed/${url.searchParams.get('v')}` : null;
    const bilibili = url.pathname.match(/\/video\/(BV[\w]+)/i);
    if (url.hostname.includes('bilibili.com') && bilibili) return `https://player.bilibili.com/player.html?bvid=${bilibili[1]}`;
    if (url.hostname.includes('vimeo.com')) return `https://player.vimeo.com/video/${url.pathname.split('/').filter(Boolean)[0]}`;
  } catch {}
  return null;
}

async function renderViewer() {
  const item = selectedItem();
  const token = ++state.renderToken;
  state.updatePdfPage = null;
  elements.readingToggle.disabled = state.scope === 'inbox';
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('is-active', tab.dataset.tab === state.tab);
    tab.disabled = state.scope === 'inbox';
  });
  if (state.scope === 'inbox') {
    elements.readerKind.textContent = 'IN';
    elements.readerTitle.textContent = '收件箱暂存区';
    elements.readerSubtitle.textContent = state.inboxAvailable === false ? '当前后台版本过旧，请重新打开工作台' : '文件会保留在这里，直到你手动执行分类';
    elements.openOriginal.classList.add('is-disabled');
    elements.openOriginal.removeAttribute('href');
    elements.viewer.innerHTML = `
      <div class="inbox-viewer-empty">
        <div class="inbox-viewer-glyph">⇩</div>
        <p>${state.inboxAvailable === false ? '需要更新后台' : state.inboxFiles.length ? `${state.inboxFiles.length} 个文件等待处理` : '收件箱为空'}</p>
        <span>${state.inboxAvailable === false ? '关闭现有工作台窗口，再重新双击启动程序' : '把 PDF、图片或网址文件拖到左侧上传区'}</span>
        ${state.inboxAvailable === false ? '' : `<button type="button" data-inbox-choose>${state.inboxFiles.length ? '继续添加文件' : '选择文件'}</button>`}
      </div>`;
    return;
  }
  if (!item) {
    elements.readerKind.textContent = '—';
    elements.readerTitle.textContent = '选择一项资料开始阅读';
    elements.readerSubtitle.textContent = 'PDF、Markdown、图片和视频链接都可以在这里查看';
    elements.openOriginal.classList.add('is-disabled');
    elements.openOriginal.removeAttribute('href');
    elements.viewer.innerHTML = '<div class="viewer-empty"><div class="empty-glyph">文</div><p>从上方资料列表中选择一项</p><span>原件和知识笔记会显示在这里</span></div>';
    return;
  }
  elements.readerKind.textContent = kindNames[item.kind] || '文件';
  elements.readerTitle.textContent = item.title;
  elements.readerSubtitle.textContent = item.original_name || item.category || '';
  const originalUrl = item.kind === 'video' && item.source_url ? item.source_url : `/api/items/${item.id}/asset`;
  elements.openOriginal.href = originalUrl;
  elements.openOriginal.classList.remove('is-disabled');
  elements.viewer.innerHTML = '<div class="loading-state">正在准备预览…</div>';

  if (state.tab === 'markdown' || state.tab === 'text') return textPreview(item, state.tab, token);
  if (item.kind === 'pdf') {
    await pdfPreview(item, token);
  } else if (item.kind === 'image') {
    elements.viewer.innerHTML = `<div class="viewer-image"><img src="/api/items/${item.id}/asset" alt="${escapeHtml(item.title)}"></div>`;
  } else if (item.kind === 'video') {
    const embed = videoEmbedUrl(item.source_url);
    elements.viewer.innerHTML = embed
      ? `<iframe title="${escapeHtml(item.title)}" src="${escapeHtml(embed)}" allow="accelerometer; autoplay; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`
      : `<div class="video-card"><div class="video-info"><div class="video-play">▶</div><h3>${escapeHtml(item.title)}</h3><p>视频摘要来自标题和简介。当前来源需要在原网站观看。</p><a class="source-button" href="${escapeHtml(item.source_url || '#')}" target="_blank" rel="noreferrer">前往视频来源 ↗</a></div></div>`;
  } else if (item.kind === 'article') {
    await textPreview(item, 'text', token);
  } else {
    elements.viewer.innerHTML = `<div class="error-state"><p>此类型暂不支持直接预览</p><span>可以使用右上角按钮打开原始文件</span></div>`;
  }
  requestAnimationFrame(layoutNotes);
}

function stars(score, interactive = false) {
  return Array.from({ length: 5 }, (_, index) => interactive
    ? `<button class="score-star ${score && index < score ? 'is-filled' : ''}" type="button" data-score="${index + 1}" aria-label="评分 ${index + 1} 星" ${state.backendCompatible === false ? 'disabled' : ''}>★</button>`
    : `<span class="star ${score && index < score ? 'is-filled' : ''}">★</span>`).join('');
}

function relationBuilderHtml(candidates) {
  if (!candidates.length) return '<p class="workflow-hint">知识库中还没有其他可关联的资料。</p>';
  const grouped = new Map();
  for (const candidate of candidates) {
    const parts = String(candidate.category || '未分类').split('/').filter(Boolean);
    const top = parts[0] || '未分类';
    const sub = parts.slice(1).join('/') || '__direct__';
    if (!grouped.has(top)) grouped.set(top, new Map());
    if (!grouped.get(top).has(sub)) grouped.get(top).set(sub, []);
    grouped.get(top).get(sub).push(candidate);
  }
  const topMenus = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
    .map(([top, subgroups]) => `
      <div class="relation-cascade-branch">
        <button class="relation-cascade-option" type="button"><span>${escapeHtml(top)}</span><span>‹</span></button>
        <div class="relation-cascade-menu relation-level-two">
          ${[...subgroups.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN')).map(([sub, files]) => `
            <div class="relation-cascade-branch">
              <button class="relation-cascade-option" type="button"><span>${sub === '__direct__' ? '本级资料' : escapeHtml(sub)}</span><span>‹</span></button>
              <div class="relation-cascade-menu relation-level-three">
                ${files.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN')).map(file => `<button class="relation-file-option" type="button" data-relation-target="${escapeHtml(file.id)}" data-relation-title="${escapeHtml(file.title)}" title="${escapeHtml(file.title)}">${escapeHtml(file.title)}</button>`).join('')}
              </div>
            </div>`).join('')}
        </div>
      </div>`).join('');
  return `
    <div class="relation-cascade">
      <button class="relation-cascade-trigger" type="button" data-relation-cascade-toggle aria-expanded="false"><span data-relation-selection>选择关联资料</span><span>⌄</span></button>
      <div class="relation-cascade-popover" data-relation-cascade-popover hidden>
        <div class="relation-cascade-menu relation-level-one">${topMenus}</div>
      </div>
      <div class="relation-add" data-relation-confirm hidden>
        <select id="relationType" aria-label="关联类型">${Object.entries(relationNames).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>
        <button class="secondary-action" type="button" data-relation-add>建立关联</button>
      </div>
    </div>`;
}

function folderOptionsHtml(selectedCategory) {
  const folders = [];
  const visit = (nodes, depth = 0) => nodes.forEach(node => {
    folders.push({ path: node.path, name: node.name, depth });
    visit(node.children || [], depth + 1);
  });
  visit(state.tree?.children || []);
  if (selectedCategory && !folders.some(folder => folder.path === selectedCategory)) {
    folders.push({ path: selectedCategory, name: selectedCategory.split('/').at(-1), depth: selectedCategory.includes('/') ? 1 : 0 });
  }
  return folders.map(folder => `<option value="${escapeHtml(folder.path)}" ${folder.path === selectedCategory ? 'selected' : ''}>${folder.depth ? '↳ ' : ''}${escapeHtml(folder.name)}</option>`).join('');
}

function renderInspector() {
  const item = selectedItem();
  elements.notesPanel.hidden = !state.readingMode;
  if (state.readingMode) {
    elements.inspectorEmpty.hidden = true;
    elements.inspector.hidden = true;
    return;
  }
  if (state.scope === 'inbox' && !item) {
    elements.inspectorEmpty.innerHTML = '<span class="inspector-index">IN</span><p>等待分类</p><small>文件只会暂存。点击左侧“执行收件箱分类”后才会调用分析模型并归档。</small>';
  } else if (!item) {
    elements.inspectorEmpty.innerHTML = '<span class="inspector-index">00</span><p>资料信息</p><small>选择资料后查看摘要、标签与日期</small>';
  }
  elements.inspectorEmpty.hidden = Boolean(item);
  elements.inspector.hidden = !item;
  if (!item) return;
  const source = item.source_url
    ? `<a class="source-link" href="${escapeHtml(item.source_url)}" target="_blank" rel="noreferrer">查看来源 ↗</a>`
    : escapeHtml(item.original_name || '本地文件');
  const editing = state.editingItemId === item.id;
  const itemRelations = state.relations.filter(relation => relation.source_id === item.id || relation.target_id === item.id);
  const relationCandidates = state.items.filter(value => value.id !== item.id);
  const relationSection = `
    <section class="inspector-section">
      <p class="inspector-label">关联资料</p>
      <div class="relation-list">${itemRelations.length ? itemRelations.map(relation => {
        const otherId = relation.source_id === item.id ? relation.target_id : relation.source_id;
        const other = state.items.find(value => value.id === otherId);
        return `<div class="relation-row ${editing ? 'is-editing' : ''}"><span class="relation-type">${escapeHtml(relationNames[relation.type] || '相关')}</span><span class="relation-title" title="${escapeHtml(other?.title || '资料已删除')}">${escapeHtml(other?.title || '资料已删除')}</span>${editing ? `<button class="relation-delete" data-relation-delete="${relation.id}" aria-label="删除关联">×</button>` : ''}</div>`;
      }).join('') : '<span class="summary">尚未建立关联</span>'}</div>
    </section>`;
  const reviewWorkflow = item.status === 'review' ? `
    <section class="inspector-section review-workflow">
      <p class="inspector-label">人工复查</p>
      <label class="edit-label" for="correctedText">正文或手写内容校正</label>
      <textarea class="edit-textarea correction-textarea" id="correctedText" data-corrected-text placeholder="输入校正后的完整正文；重新分析会以这里的内容为依据。">${escapeHtml(item.corrected_text || '')}</textarea>
      <div class="review-actions">
        <button class="secondary-action" type="button" data-save-correction ${state.busyAction || state.backendCompatible === false ? 'disabled' : ''}>保存校正</button>
        <button class="primary-action" type="button" data-reanalyze ${state.busyAction || state.backendCompatible === false ? 'disabled' : ''}>重新分析</button>
      </div>
      <button class="approve-button" type="button" data-approve ${state.busyAction || state.backendCompatible === false || !item.summary?.trim() ? 'disabled' : ''}>批准并存入知识库</button>
      <p class="workflow-hint">重新分析适用于手写或正文识别有误；已有可靠摘要时可直接批准。</p>
    </section>` : '';
  const body = editing ? `
    <section class="inspector-section edit-panel">
      <p class="inspector-label">编辑资料</p>
      <label class="edit-label" for="editTitle">标题</label>
      <input class="edit-input" id="editTitle" value="${escapeHtml(item.title)}" maxlength="80">
      <label class="edit-label" for="editSummary">摘要</label>
      <textarea class="edit-textarea" id="editSummary" maxlength="20000">${escapeHtml(item.summary || '')}</textarea>
      <label class="edit-label" for="editTags">标签</label>
      <input class="edit-input" id="editTags" value="${escapeHtml((item.tags || []).join('，'))}" placeholder="使用逗号分隔，最多 8 个">
      <label class="edit-label" for="editCategory">所在文件夹</label>
      <select class="edit-input edit-folder-select" id="editCategory">${folderOptionsHtml(item.category)}</select>
      <div class="edit-relation-block">
        <p class="inspector-label">建立关联</p>
        ${relationBuilderHtml(relationCandidates)}
      </div>
      <div class="edit-actions">
        <button class="secondary-action" type="button" data-cancel-edit>取消</button>
        <button class="primary-action" type="button" data-save-edit ${state.busyAction || state.backendCompatible === false ? 'disabled' : ''}>保存修改</button>
      </div>
      <div class="delete-item-zone">
        <div><strong>删除资料</strong><span>同时删除原件、摘要、便签和元数据</span></div>
        <button class="delete-item-button" type="button" data-delete-item ${state.busyAction || state.backendCompatible === false ? 'disabled' : ''}>删除</button>
      </div>
    </section>` : `
    <section class="inspector-section">
      <p class="inspector-label">摘要</p>
      <p class="summary">${escapeHtml(item.summary || '暂无摘要')}</p>
    </section>
    <section class="inspector-section">
      <p class="inspector-label">标签</p>
      <div class="tag-list">${item.tags?.length ? item.tags.map(tag => `<button class="tag ${state.filters.tags.includes(tag) ? 'is-active' : ''}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join('') : '<span class="summary">暂无标签</span>'}</div>
    </section>`;
  elements.inspector.innerHTML = `
    <header class="inspector-head">
      <div class="inspector-number"><span>ENTRY / ${escapeHtml(item.id.slice(0, 8).toUpperCase())}</span><span class="status-pill ${item.status === 'review' ? 'review' : ''}">${item.status === 'ready' ? '已入库' : '待检查'}</span></div>
      <h3>${escapeHtml(item.title)}</h3>
      <div class="inspector-subline"><span class="inspector-kind">${escapeHtml(kindNames[item.kind] || item.kind)} · ${escapeHtml(item.category || '未分类')}</span><span class="inspector-head-actions"><button class="favorite-button ${item.favorite ? 'is-active' : ''}" type="button" data-favorite aria-label="${item.favorite ? '取消收藏' : '收藏'}">★</button><select class="reading-select" data-reading-status aria-label="阅读状态">${Object.entries(readingNames).map(([value, label]) => `<option value="${value}" ${item.reading_status === value ? 'selected' : ''}>${label}</option>`).join('')}</select><button class="edit-item-button" type="button" data-edit-item ${state.backendCompatible === false ? 'disabled' : ''}>${editing ? '退出编辑' : '编辑资料'}</button></span></div>
    </header>
    ${body}
    <section class="inspector-section">
      <p class="inspector-label">内容质量</p>
      <div class="score interactive-score">${stars(item.quality_score, true)}<span class="score-text">${item.quality_score ? `${item.quality_score}/5` : '点击星级评分'}</span>${item.quality_score ? `<button class="clear-score" type="button" data-score="" ${state.backendCompatible === false ? 'disabled' : ''}>清除</button>` : ''}</div>
    </section>
    ${item.review_reason ? `<section class="inspector-section"><p class="inspector-label">待检查原因</p><div class="review-note">${escapeHtml(item.review_reason)}</div></section>` : ''}
    ${reviewWorkflow}
    ${relationSection}
    <section class="inspector-section">
      <p class="inspector-label">资料信息</p>
      <dl class="metadata">
        <div class="metadata-row"><dt>发表日期</dt><dd>${escapeHtml(item.published_at || '未知')}</dd></div>
        <div class="metadata-row"><dt>收件日期</dt><dd>${escapeHtml(item.received_at || '未知')}</dd></div>
        <div class="metadata-row"><dt>摘要依据</dt><dd>${escapeHtml(basisNames[item.summary_basis] || item.summary_basis || '未知')}</dd></div>
        <div class="metadata-row"><dt>分析模型</dt><dd>${escapeHtml(item.analysis_model || item.analysis_provider || '未知')}</dd></div>
        <div class="metadata-row"><dt>决策来源</dt><dd>${escapeHtml(item.decision_provider || '分析模型')}</dd></div>
        <div class="metadata-row"><dt>置信度</dt><dd>${item.decision_confidence == null ? '未提供' : `${Math.round(item.decision_confidence * 100)}%`}</dd></div>
        <div class="metadata-row"><dt>来源</dt><dd>${source}</dd></div>
      </dl>
    </section>`;
}

function noteAnchorPosition(note) {
  const viewerRect = elements.viewer.getBoundingClientRect();
  if (note.anchor.type === 'pdf') {
    const sheet = elements.viewer.querySelector(`.pdf-sheet[data-page="${note.anchor.page}"]`);
    if (!sheet) return null;
    const rect = sheet.getBoundingClientRect();
    return {
      contentY: rect.top - viewerRect.top + elements.viewer.scrollTop + note.anchor.y * rect.height,
      viewportX: rect.left + note.anchor.x * rect.width,
      viewportY: rect.top + note.anchor.y * rect.height,
    };
  }
  const contentY = note.anchor.y * elements.viewer.scrollHeight;
  return {
    contentY,
    viewportX: viewerRect.left + note.anchor.x * viewerRect.width,
    viewportY: viewerRect.top + contentY - elements.viewer.scrollTop,
  };
}

function updateNoteLines() {
  if (!state.readingMode) {
    elements.noteLines.innerHTML = '';
    elements.anchorMarkers.innerHTML = '';
    return;
  }
  const viewerRect = elements.viewer.getBoundingClientRect();
  const lines = [];
  for (const note of state.notes) {
    const position = noteAnchorPosition(note);
    const card = elements.notesTrack.querySelector(`[data-note-id="${note.id}"]`);
    const marker = elements.anchorMarkers.querySelector(`[data-marker-id="${note.id}"]`);
    if (!position || !card || !marker) continue;
    const cardRect = card.getBoundingClientRect();
    const visible = position.viewportY >= viewerRect.top && position.viewportY <= viewerRect.bottom && cardRect.bottom > 0 && cardRect.top < window.innerHeight;
    marker.hidden = !visible;
    if (!visible) continue;
    marker.style.left = `${position.viewportX}px`;
    marker.style.top = `${position.viewportY}px`;
    lines.push(`<line x1="${position.viewportX}" y1="${position.viewportY}" x2="${cardRect.left}" y2="${cardRect.top + 23}" />`);
  }
  elements.noteLines.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);
  elements.noteLines.innerHTML = lines.join('');
}

function layoutNotes() {
  if (!state.readingMode || !selectedItem()) return updateNoteLines();
  const trackHeight = Math.max(elements.viewer.scrollHeight + 80, elements.notesScroll.clientHeight);
  elements.notesTrack.style.height = `${trackHeight}px`;
  const placements = state.notes.map(note => ({ note, position: noteAnchorPosition(note) })).filter(value => value.position).sort((a, b) => a.position.contentY - b.position.contentY);
  let nextTop = 14;
  for (const { note, position } of placements) {
    const card = elements.notesTrack.querySelector(`[data-note-id="${note.id}"]`);
    if (!card) continue;
    const preferred = Math.max(14, Math.min(position.contentY - 22, trackHeight - card.offsetHeight - 14));
    const top = Math.max(preferred, nextTop);
    card.style.top = `${top}px`;
    nextTop = top + card.offsetHeight + 12;
  }
  elements.notesScroll.scrollTop = Math.min(elements.viewer.scrollTop, Math.max(0, elements.notesTrack.scrollHeight - elements.notesScroll.clientHeight));
  requestAnimationFrame(updateNoteLines);
}

function renderNotes() {
  const item = selectedItem();
  elements.anchorMarkers.innerHTML = state.notes.map(note => `<span class="anchor-dot" data-marker-id="${note.id}" hidden></span>`).join('');
  if (!item) {
    elements.notesTrack.innerHTML = '<div class="notes-empty">选择资料后即可建立阅读便签。</div>';
    return layoutNotes();
  }
  elements.notesTrack.innerHTML = state.notes.length ? state.notes.map(note => `
    <article class="note-card" data-note-id="${note.id}">
      <div class="note-card-head">
        <button class="note-anchor-link" data-note-jump="${note.id}">${note.anchor.type === 'pdf' ? `PDF · 第 ${note.anchor.page} 页` : '正文锚点'}</button>
        <button class="note-delete" data-note-delete="${note.id}" aria-label="删除便签">×</button>
      </div>
      <textarea data-note-content="${note.id}" placeholder="在这里记下想法…">${escapeHtml(note.content)}</textarea>
      <span class="note-saving" data-note-status="${note.id}">${note.content ? '已保存' : '空白便签'}</span>
    </article>`).join('') : '<div class="notes-empty">还没有便签。点击“新建便签”，再点击文章中的位置。</div>';
  requestAnimationFrame(layoutNotes);
}

async function loadNotes() {
  const item = selectedItem();
  if (!item) {
    state.notes = [];
    state.notesItemId = null;
    return renderNotes();
  }
  const itemId = item.id;
  state.notesItemId = itemId;
  try {
    const notes = await api(`/api/items/${itemId}/notes`);
    if (state.notesItemId !== itemId || selectedItem()?.id !== itemId) return;
    state.notes = notes;
    renderNotes();
  } catch (error) {
    showToast(error.message);
  }
}

function setPinning(value) {
  state.pinning = Boolean(value && state.readingMode && selectedItem());
  elements.workspace.classList.toggle('is-pinning', state.pinning);
  elements.newNoteButton.classList.toggle('is-pinning', state.pinning);
  elements.newNoteButton.textContent = state.pinning ? '取消锚定' : '＋ 新建便签';
  elements.pinHint.hidden = !state.pinning;
}

function setReadingMode(value) {
  state.readingMode = Boolean(value && selectedItem());
  elements.workspace.classList.toggle('is-reading', state.readingMode);
  elements.readingToggle.setAttribute('aria-pressed', String(state.readingMode));
  elements.readingToggle.innerHTML = state.readingMode ? '<span>□</span> 退出阅读' : '<span>▣</span> 阅读模式';
  setPinning(false);
  renderInspector();
  if (state.readingMode) loadNotes();
  else updateNoteLines();
  requestAnimationFrame(layoutNotes);
}

function jumpToNote(note) {
  if (note.anchor.type === 'pdf') {
    elements.viewer.querySelector(`.pdf-sheet[data-page="${note.anchor.page}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  elements.viewer.scrollTo({ top: Math.max(0, note.anchor.y * elements.viewer.scrollHeight - elements.viewer.clientHeight * .35), behavior: 'smooth' });
}

async function deleteNote(noteId) {
  const item = selectedItem();
  if (!item || !window.confirm('删除这张便签？')) return;
  await api(`/api/items/${item.id}/notes/${noteId}`, { method: 'DELETE' });
  state.notes = state.notes.filter(note => note.id !== noteId);
  renderNotes();
}

function saveNote(noteId, content) {
  clearTimeout(state.noteSaveTimers.get(noteId));
  const status = elements.notesTrack.querySelector(`[data-note-status="${noteId}"]`);
  if (status) status.textContent = '保存中…';
  state.noteSaveTimers.set(noteId, setTimeout(async () => {
    const item = selectedItem();
    if (!item) return;
    try {
      const saved = await api(`/api/items/${item.id}/notes/${noteId}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }),
      });
      const note = state.notes.find(value => value.id === noteId);
      if (note) note.content = saved.content;
      const currentStatus = elements.notesTrack.querySelector(`[data-note-status="${noteId}"]`);
      if (currentStatus) currentStatus.textContent = '已保存';
    } catch (error) {
      if (status) status.textContent = '保存失败';
      showToast(error.message);
    }
  }, 500));
}

function render() {
  renderNavigation();
  renderList();
  renderInspector();
  renderViewer();
  if (state.graphMode) requestAnimationFrame(renderGraph);
  if (state.readingMode) loadNotes();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('is-visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove('is-visible'), 1800);
}

async function uploadInboxFiles(fileList) {
  const files = [...fileList];
  if (state.inboxAvailable === false) return showToast('请重新打开工作台以更新后台');
  if (!files.length || state.uploadingInbox) return;
  state.scope = 'inbox';
  state.category = '';
  setReadingMode(false);
  state.uploadingInbox = true;
  const failures = [];
  try {
    for (let index = 0; index < files.length; index++) {
      state.inboxProgress = `正在接收 ${index + 1}/${files.length}：${files[index].name}`;
      renderNavigation();
      try {
        await api(`/api/inbox/files?defer=1&filename=${encodeURIComponent(files[index].name)}`, { method: 'POST', body: files[index] });
      } catch (error) {
        failures.push(`${files[index].name}：${error.message}`);
      }
    }
    await load({ quiet: true });
    showToast(failures.length ? `${files.length - failures.length} 个文件已加入，${failures.length} 个失败` : `${files.length} 个文件已加入收件箱`);
  } finally {
    state.uploadingInbox = false;
    state.inboxProgress = '';
    elements.inboxFileInput.value = '';
    renderNavigation();
  }
}

async function waitForInboxJob(id) {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const job = await api(`/api/jobs/${id}`);
    if (job.status === 'ready' || job.status === 'review') return job;
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  throw new Error('分类等待超时，请稍后刷新查看结果');
}

async function deleteInboxFile(name) {
  const file = state.inboxFiles.find(value => value.name === name);
  if (!file) return;
  if (file.processing) return showToast('正在分类的文件不能删除');
  if (!window.confirm(`确定删除收件箱中的“${name}”吗？`)) return;
  try {
    await api(`/api/inbox/files?filename=${encodeURIComponent(name)}`, { method: 'DELETE' });
    await load({ quiet: true });
    showToast(`已删除 ${name}`);
  } catch (error) {
    showToast(error.message);
  }
}

async function setItemScore(value) {
  const item = selectedItem();
  if (!item || state.busyAction) return;
  state.busyAction = true;
  try {
    const score = value === '' ? null : Number(value);
    const updated = await api(`/api/items/${item.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quality_score: score }),
    });
    Object.assign(item, updated);
    renderInspector();
    showToast(score ? `已评分 ${score}/5` : '已清除评分');
  } catch (error) {
    showToast(error.message);
  } finally {
    state.busyAction = false;
  }
}

async function patchOrganization(changes, message = '') {
  const item = selectedItem();
  if (!item || state.busyAction) return;
  state.busyAction = true;
  try {
    const updated = await api(`/api/items/${item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(changes) });
    Object.assign(item, updated);
    renderNavigation(); renderList(); renderInspector();
    if (state.graphMode) renderGraph();
    if (message) showToast(message);
  } catch (error) { showToast(error.message); }
  finally { state.busyAction = false; }
}

async function addRelation() {
  const item = selectedItem();
  const targetId = elements.inspector.querySelector('[data-relation-confirm]')?.dataset.relationSelected;
  const type = elements.inspector.querySelector('#relationType')?.value;
  if (!item || !targetId) return showToast('请选择要关联的资料');
  try {
    const relation = await api('/api/relations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source_id: item.id, target_id: targetId, type }) });
    if (!state.relations.some(value => value.id === relation.id)) state.relations.push(relation);
    renderInspector(); if (state.graphMode) renderGraph();
    showToast('资料关联已建立');
  } catch (error) { showToast(error.message); }
}

async function deleteRelation(id) {
  try {
    await api(`/api/relations/${id}`, { method: 'DELETE' });
    state.relations = state.relations.filter(relation => relation.id !== id);
    renderInspector(); if (state.graphMode) renderGraph();
  } catch (error) { showToast(error.message); }
}

async function saveItemEdits() {
  const item = selectedItem();
  if (!item || state.busyAction) return;
  const title = elements.inspector.querySelector('#editTitle')?.value.trim();
  const summary = elements.inspector.querySelector('#editSummary')?.value || '';
  const tags = (elements.inspector.querySelector('#editTags')?.value || '').split(/[,，、\n]/).map(tag => tag.trim()).filter(Boolean);
  const category = elements.inspector.querySelector('#editCategory')?.value || item.category;
  if (!title) return showToast('标题不能为空');
  state.busyAction = true;
  try {
    await api(`/api/items/${item.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, summary, tags, category }),
    });
    state.editingItemId = null;
    await load({ quiet: true });
    showToast('资料信息已保存');
  } catch (error) {
    showToast(error.message);
  } finally {
    state.busyAction = false;
    renderInspector();
  }
}

async function createFolder() {
  const name = elements.folderName.value.trim();
  const parent = elements.folderParent.value;
  if (!name) return showToast('请输入文件夹名称');
  try {
    const folder = await api('/api/library/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, parent }) });
    elements.folderName.value = '';
    elements.folderCreator.hidden = true;
    elements.newFolderButton.setAttribute('aria-expanded', 'false');
    await load({ quiet: true });
    state.scope = 'category';
    state.category = folder.path;
    setGraphMode(false);
    render();
    pushNavigation();
    showToast(`已创建文件夹：${folder.path}`);
  } catch (error) { showToast(error.message); }
}

async function deleteLibraryItem() {
  const item = selectedItem();
  if (!item || state.busyAction) return;
  if (!window.confirm(`确定永久删除“${item.title}”吗？原件、摘要、便签和元数据都会被删除。`)) return;
  state.busyAction = true;
  renderInspector();
  try {
    await api(`/api/items/${item.id}`, { method: 'DELETE' });
    state.editingItemId = null;
    state.selectedId = null;
    await load({ quiet: true });
    showToast('资料已删除');
  } catch (error) {
    showToast(error.message);
  } finally {
    state.busyAction = false;
    renderInspector();
  }
}

async function saveCorrection({ reanalyze = false } = {}) {
  const item = selectedItem();
  if (!item || item.status !== 'review' || state.busyAction) return;
  const correctedText = elements.inspector.querySelector('[data-corrected-text]')?.value.trim() || '';
  if (reanalyze && !correctedText) return showToast('请先填写校正后的正文');
  state.busyAction = true;
  try {
    await api(`/api/items/${item.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ corrected_text: correctedText }),
    });
    if (reanalyze) await api(`/api/items/${item.id}/reanalyze`, { method: 'POST' });
    await load({ quiet: true });
    showToast(reanalyze ? '重新分析完成' : '校正内容已保存');
  } catch (error) {
    showToast(error.message);
  } finally {
    state.busyAction = false;
    renderInspector();
  }
}

async function approveReviewItem() {
  const item = selectedItem();
  if (!item || item.status !== 'review' || state.busyAction) return;
  state.busyAction = true;
  renderInspector();
  try {
    await api(`/api/items/${item.id}/approve`, { method: 'POST' });
    state.editingItemId = null;
    await load({ quiet: true });
    showToast('已批准并存入知识库');
  } catch (error) {
    showToast(error.message);
  } finally {
    state.busyAction = false;
    renderInspector();
  }
}

async function processInbox() {
  if (state.inboxAvailable === false) return showToast('请重新打开工作台以更新后台');
  if (state.processingInbox || !state.inboxFiles.length) return;
  state.processingInbox = true;
  state.inboxProgress = '正在建立分类任务…';
  renderNavigation();
  try {
    const result = await api('/api/inbox/process', { method: 'POST' });
    if (!result.jobs.length) {
      showToast(result.skipped.length ? '没有可执行的文件，请检查文件格式' : '收件箱为空');
      return;
    }
    let finished = 0;
    const jobs = await Promise.all(result.jobs.map(async job => {
      const completed = await waitForInboxJob(job.id);
      finished += 1;
      state.inboxProgress = `已完成 ${finished}/${result.jobs.length}`;
      renderNavigation();
      return completed;
    }));
    const reviewCount = jobs.filter(job => job.status === 'review').length;
    await load({ quiet: true });
    showToast(reviewCount ? `分类完成，${reviewCount} 项需要检查` : `${jobs.length} 个文件已分类入库`);
  } catch (error) {
    showToast(error.message);
    await load({ quiet: true });
  } finally {
    state.processingInbox = false;
    state.inboxProgress = '';
    renderNavigation();
  }
}

async function load({ quiet = false } = {}) {
  try {
    const [healthResult, itemsResult, treeResult, inboxResult, viewsResult, relationsResult, historyResult] = await Promise.allSettled([api('/health'), api('/api/items'), api('/api/library/tree'), api('/api/inbox'), api('/api/views'), api('/api/relations'), api('/api/restructure/history')]);
    if (itemsResult.status === 'rejected') throw itemsResult.reason;
    if (treeResult.status === 'rejected') throw treeResult.reason;
    state.items = itemsResult.value;
    state.tree = treeResult.value;
    state.backendCompatible = healthResult.status === 'fulfilled' && Number(healthResult.value.api_version) >= 8;
    state.inboxAvailable = state.backendCompatible && inboxResult.status === 'fulfilled';
    state.inboxFiles = state.inboxAvailable ? inboxResult.value : [];
    state.savedViews = viewsResult.status === 'fulfilled' ? viewsResult.value : [];
    state.relations = relationsResult.status === 'fulfilled' ? relationsResult.value : [];
    state.restructureHistory = historyResult.status === 'fulfilled' ? historyResult.value : [];
    elements.statusDot.className = 'status-dot is-online';
    elements.connectionStatus.textContent = state.inboxAvailable ? `${state.items.length} 项资料 · 本地连接正常` : `${state.items.length} 项资料 · 后台需要重启`;
    render();
    setGraphMode(state.graphMode);
    renderFilterPanel();
    if (!elements.structurePanel.hidden) renderStructurePanel();
    if (state.query) await runSearch();
    if (state.graphMode) renderGraph();
    if (state.navigationIndex < 0) pushNavigation();
    if (!quiet) showToast('知识库已更新');
  } catch (error) {
    elements.statusDot.className = 'status-dot is-error';
    elements.connectionStatus.textContent = '无法连接本地知识库';
    elements.list.innerHTML = `<div class="empty-list">${escapeHtml(error.message)}</div>`;
  }
}

document.addEventListener('click', event => {
  if (event.target.closest('[data-apply-restructure]')) { applyRestructure(); return; }
  const undoStructure = event.target.closest('[data-undo-restructure]');
  if (undoStructure) { undoRestructure(undoStructure.dataset.undoRestructure); return; }
  if (event.target.closest('[data-folder-create]')) { createFolder(); return; }
  if (event.target.closest('[data-folder-cancel]')) {
    elements.folderCreator.hidden = true;
    elements.newFolderButton.setAttribute('aria-expanded', 'false');
    elements.folderName.value = '';
    return;
  }
  const relationCascadeToggle = event.target.closest('[data-relation-cascade-toggle]');
  if (relationCascadeToggle) {
    const cascade = relationCascadeToggle.closest('.relation-cascade');
    const popover = cascade?.querySelector('[data-relation-cascade-popover]');
    if (!popover) return;
    const opening = popover.hidden;
    document.querySelectorAll('[data-relation-cascade-popover]').forEach(value => { value.hidden = true; });
    popover.hidden = !opening;
    relationCascadeToggle.setAttribute('aria-expanded', String(opening));
    if (opening) {
      const rect = relationCascadeToggle.getBoundingClientRect();
      popover.style.left = `${Math.max(8, rect.left)}px`;
      popover.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 280))}px`;
    }
    return;
  }
  const relationTarget = event.target.closest('[data-relation-target]');
  if (relationTarget) {
    const cascade = relationTarget.closest('.relation-cascade');
    const selection = cascade?.querySelector('[data-relation-selection]');
    const confirm = cascade?.querySelector('[data-relation-confirm]');
    const popover = cascade?.querySelector('[data-relation-cascade-popover]');
    if (selection) { selection.textContent = relationTarget.dataset.relationTitle; selection.title = relationTarget.dataset.relationTitle; }
    if (confirm) { confirm.dataset.relationSelected = relationTarget.dataset.relationTarget; confirm.hidden = false; }
    if (popover) popover.hidden = true;
    cascade?.querySelector('[data-relation-cascade-toggle]')?.setAttribute('aria-expanded', 'false');
    return;
  }
  if (!event.target.closest('.relation-cascade')) {
    document.querySelectorAll('[data-relation-cascade-popover]').forEach(value => { value.hidden = true; });
    document.querySelectorAll('[data-relation-cascade-toggle]').forEach(value => value.setAttribute('aria-expanded', 'false'));
  }
  const viewDelete = event.target.closest('[data-view-delete]');
  if (viewDelete) {
    event.stopPropagation();
    const view = state.savedViews.find(value => value.id === viewDelete.dataset.viewDelete);
    if (view && window.confirm(`删除保存视图“${view.name}”？`)) api(`/api/views/${view.id}`, { method: 'DELETE' }).then(() => { state.savedViews = state.savedViews.filter(value => value.id !== view.id); renderNavigation(); }).catch(error => showToast(error.message));
    return;
  }
  const savedView = event.target.closest('[data-view-id]');
  if (savedView) {
    const view = state.savedViews.find(value => value.id === savedView.dataset.viewId);
    if (view) applySavedView(view);
    return;
  }
  if (event.target.closest('[data-inbox-choose]')) {
    elements.inboxFileInput.click();
    return;
  }
  const inboxDelete = event.target.closest('[data-inbox-delete]');
  if (inboxDelete) {
    deleteInboxFile(inboxDelete.dataset.inboxDelete);
    return;
  }
  if (event.target.closest('[data-edit-item]')) {
    state.editingItemId = state.editingItemId === state.selectedId ? null : state.selectedId;
    renderInspector();
    return;
  }
  if (event.target.closest('[data-cancel-edit]')) {
    state.editingItemId = null;
    renderInspector();
    return;
  }
  if (event.target.closest('[data-save-edit]')) {
    saveItemEdits();
    return;
  }
  if (event.target.closest('[data-delete-item]')) {
    deleteLibraryItem();
    return;
  }
  if (event.target.closest('[data-favorite]')) {
    const item = selectedItem();
    if (item) patchOrganization({ favorite: !item.favorite }, item.favorite ? '已取消收藏' : '已收藏');
    return;
  }
  if (event.target.closest('[data-relation-add]')) { addRelation(); return; }
  const relationDelete = event.target.closest('[data-relation-delete]');
  if (relationDelete) { deleteRelation(relationDelete.dataset.relationDelete); return; }
  const score = event.target.closest('[data-score]');
  if (score) {
    setItemScore(score.dataset.score);
    return;
  }
  if (event.target.closest('[data-save-correction]')) {
    saveCorrection();
    return;
  }
  if (event.target.closest('[data-reanalyze]')) {
    saveCorrection({ reanalyze: true });
    return;
  }
  if (event.target.closest('[data-approve]')) {
    approveReviewItem();
    return;
  }
  const treeToggle = event.target.closest('[data-tree-toggle]');
  if (treeToggle) {
    const path = treeToggle.dataset.treeToggle;
    if (state.collapsedFolders.has(path)) state.collapsedFolders.delete(path);
    else state.collapsedFolders.add(path);
    renderNavigation();
    return;
  }
  const nav = event.target.closest('[data-scope]');
  if (nav) {
    state.scope = nav.dataset.scope;
    state.category = '';
    state.editingItemId = null;
    setGraphMode(false);
    if (state.scope === 'inbox') setReadingMode(false);
    render();
    pushNavigation();
    return;
  }
  const category = event.target.closest('[data-category]');
  if (category) {
    state.scope = 'category';
    state.category = category.dataset.category;
    state.editingItemId = null;
    setGraphMode(false);
    render();
    pushNavigation();
    return;
  }
  const row = event.target.closest('[data-id]');
  if (row) {
    state.selectedId = row.dataset.id;
    state.tab = 'asset';
    state.notes = [];
    state.notesItemId = null;
    state.editingItemId = null;
    renderList();
    renderInspector();
    renderViewer();
    if (state.readingMode) loadNotes();
    pushNavigation();
    const item = selectedItem();
    if (item?.reading_status === 'unread') patchOrganization({ reading_status: 'reading', last_opened_at: new Date().toISOString() });
    return;
  }
  const tab = event.target.closest('[data-tab]');
  if (tab) {
    state.tab = tab.dataset.tab;
    renderViewer();
    pushNavigation();
    return;
  }
  const tag = event.target.closest('[data-tag]');
  if (tag) {
    const value = tag.dataset.tag;
    state.filters.tags = state.filters.tags.includes(value) ? state.filters.tags.filter(tagValue => tagValue !== value) : [...state.filters.tags, value];
    state.scope = 'all';
    renderFilterPanel();
    render();
    pushNavigation();
    return;
  }
  const noteJump = event.target.closest('[data-note-jump]');
  if (noteJump) {
    const note = state.notes.find(value => value.id === noteJump.dataset.noteJump);
    if (note) jumpToNote(note);
    return;
  }
  const noteDelete = event.target.closest('[data-note-delete]');
  if (noteDelete) {
    deleteNote(noteDelete.dataset.noteDelete).catch(error => showToast(error.message));
  }
});

elements.sidebarToggle.addEventListener('click', () => {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  elements.workspace.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
  elements.sidebarToggle.classList.toggle('is-collapsed', state.sidebarCollapsed);
  elements.sidebarToggle.textContent = state.sidebarCollapsed ? '›' : '‹';
  elements.sidebarToggle.setAttribute('aria-label', state.sidebarCollapsed ? '展开左侧栏' : '收起左侧栏');
  elements.sidebarToggle.title = state.sidebarCollapsed ? '展开左侧栏' : '收起左侧栏';
  setTimeout(layoutNotes, 300);
});

elements.inboxChooseButton.addEventListener('click', () => elements.inboxFileInput.click());
elements.inboxFileInput.addEventListener('change', event => uploadInboxFiles(event.target.files));
elements.processInboxButton.addEventListener('click', processInbox);
for (const eventName of ['dragenter', 'dragover']) {
  elements.inboxDropzone.addEventListener(eventName, event => {
    event.preventDefault();
    if (Array.from(event.dataTransfer?.types || []).includes('Files')) elements.inboxDropzone.classList.add('is-dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  elements.inboxDropzone.addEventListener(eventName, event => {
    event.preventDefault();
    elements.inboxDropzone.classList.remove('is-dragging');
    if (eventName === 'drop' && event.dataTransfer?.files.length) uploadInboxFiles(event.dataTransfer.files);
  });
}

elements.readingToggle.addEventListener('click', () => setReadingMode(!state.readingMode));
elements.newNoteButton.addEventListener('click', () => setPinning(!state.pinning));

elements.viewer.addEventListener('click', async event => {
  if (!state.pinning) return;
  const item = selectedItem();
  if (!item) return setPinning(false);
  const sheet = event.target.closest('.pdf-sheet');
  const documentPage = event.target.closest('.document-page');
  let anchor = null;
  if (sheet) {
    const rect = sheet.getBoundingClientRect();
    anchor = { type: 'pdf', page: Number(sheet.dataset.page), x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  } else if (documentPage) {
    const rect = elements.viewer.getBoundingClientRect();
    anchor = { type: 'document', x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top + elements.viewer.scrollTop) / elements.viewer.scrollHeight)) };
  }
  if (!anchor) return showToast('请点击 PDF 页面或文章正文');
  try {
    const note = await api(`/api/items/${item.id}/notes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ anchor }),
    });
    if (selectedItem()?.id !== item.id) return;
    state.notes.push(note);
    setPinning(false);
    renderNotes();
    requestAnimationFrame(() => elements.notesTrack.querySelector(`[data-note-content="${note.id}"]`)?.focus());
  } catch (error) {
    showToast(error.message);
  }
});

elements.notesTrack.addEventListener('input', event => {
  const textarea = event.target.closest('[data-note-content]');
  if (textarea) saveNote(textarea.dataset.noteContent, textarea.value);
});

let viewerScrollFrame = null;
elements.viewer.addEventListener('scroll', () => {
  if (viewerScrollFrame) return;
  viewerScrollFrame = requestAnimationFrame(() => {
    state.updatePdfPage?.();
    if (state.readingMode) layoutNotes();
    viewerScrollFrame = null;
  });
});

window.addEventListener('resize', () => requestAnimationFrame(() => { layoutNotes(); if (state.graphMode) renderGraph(); }));

document.addEventListener('change', event => {
  if (event.target.matches('[data-reading-status]')) patchOrganization({ reading_status: event.target.value, last_opened_at: new Date().toISOString() }, `已设为${readingNames[event.target.value]}`);
});

document.addEventListener('pointerover', event => {
  const option = event.target.closest('.relation-cascade-option');
  const submenu = option?.nextElementSibling;
  if (!submenu?.matches('.relation-level-two, .relation-level-three')) return;
  const rect = option.getBoundingClientRect();
  submenu.style.left = `${Math.max(8, rect.left - 184)}px`;
  submenu.style.top = `${Math.max(8, Math.min(rect.top - 6, window.innerHeight - 270))}px`;
});

let searchTimer = null;
elements.search.addEventListener('input', event => {
  state.query = event.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
});

document.querySelector('#refreshButton').addEventListener('click', () => load());
elements.newFolderButton.addEventListener('click', () => {
  elements.folderCreator.hidden = !elements.folderCreator.hidden;
  elements.newFolderButton.setAttribute('aria-expanded', String(!elements.folderCreator.hidden));
  if (!elements.folderCreator.hidden) elements.folderName.focus();
});
elements.structureButton.addEventListener('click', () => toggleStructurePanel());
document.querySelector('#structureClose').addEventListener('click', () => toggleStructurePanel(false));
document.querySelector('#generateRestructure').addEventListener('click', generateRestructure);
document.querySelector('#moveFolderButton').addEventListener('click', moveFolder);
elements.folderMoveSource.addEventListener('change', () => {
  elements.folderMoveName.value = elements.folderMoveSource.value.split('/').at(-1) || '';
  const sourceTop = elements.folderMoveSource.value.split('/')[0];
  if (elements.folderMoveParent.value === sourceTop) elements.folderMoveParent.value = '';
});
elements.folderName.addEventListener('keydown', event => { if (event.key === 'Enter') createFolder(); });
elements.backButton.addEventListener('click', goBack);
elements.forwardButton.addEventListener('click', goForward);
elements.filterButton.addEventListener('click', () => toggleFilterPanel());
document.querySelector('#filterClose').addEventListener('click', () => toggleFilterPanel(false));
document.querySelector('#applyFilters').addEventListener('click', () => { readFilterPanel(); toggleFilterPanel(false); render(); if (state.graphMode) renderGraph(); pushNavigation(); });
document.querySelector('#clearFilters').addEventListener('click', resetFilters);
document.querySelector('#saveViewButton').addEventListener('click', () => { readFilterPanel(); saveCurrentView(); });
elements.graphButton.addEventListener('click', () => {
  if (state.graphMode) {
    setGraphMode(false);
    render();
    pushNavigation();
  } else openGraphHome();
});
document.querySelectorAll('[data-graph-action]').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.graphAction === 'zoom-in') zoomGraph(1.2);
  else if (button.dataset.graphAction === 'zoom-out') zoomGraph(1 / 1.2);
  else resetGraphViewport();
}));
let graphClickTimer = null;
elements.graphCanvas.addEventListener('click', event => {
  event.stopPropagation();
  if (state.graphMoved) { state.graphMoved = false; return; }
  const item = event.target.closest('[data-graph-item]');
  if (item) {
    clearTimeout(graphClickTimer);
    graphClickTimer = setTimeout(() => focusGraphNode(item.dataset.graphItem, item.dataset.graphItem), 220);
    return;
  }
  const folder = event.target.closest('[data-graph-category]');
  if (folder) { focusGraphNode(folder.dataset.graphNode); return; }
  if (event.target.closest('[data-graph-root]')) focusGraphNode('root');
});
elements.graphCanvas.addEventListener('dblclick', event => {
  const item = event.target.closest('[data-graph-item]');
  if (!item) return;
  event.preventDefault();
  event.stopPropagation();
  clearTimeout(graphClickTimer);
  openGraphItem(item.dataset.graphItem);
});
elements.graphCanvas.addEventListener('wheel', event => {
  event.preventDefault();
  const rect = elements.graphCanvas.getBoundingClientRect();
  zoomGraph(event.deltaY < 0 ? 1.12 : 1 / 1.12, { x: event.clientX - rect.left, y: event.clientY - rect.top });
}, { passive: false });
elements.graphCanvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || event.target.closest('.graph-node')) return;
  state.graphDrag = { x: event.clientX, y: event.clientY, startX: state.graphViewport.x, startY: state.graphViewport.y };
  state.graphMoved = false;
  elements.graphCanvas.classList.add('is-dragging');
  elements.graphCanvas.setPointerCapture(event.pointerId);
});
elements.graphCanvas.addEventListener('pointermove', event => {
  if (!state.graphDrag) return;
  const dx = event.clientX - state.graphDrag.x;
  const dy = event.clientY - state.graphDrag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) state.graphMoved = true;
  state.graphViewport.x = state.graphDrag.startX + dx;
  state.graphViewport.y = state.graphDrag.startY + dy;
  applyGraphTransform();
});
const endGraphDrag = () => {
  state.graphDrag = null;
  elements.graphCanvas.classList.remove('is-dragging');
  if (state.graphMoved) setTimeout(() => { state.graphMoved = false; }, 160);
};
elements.graphCanvas.addEventListener('pointerup', endGraphDrag);
elements.graphCanvas.addEventListener('pointercancel', endGraphDrag);
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    elements.search.focus();
  }
  if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); goBack(); }
  if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); goForward(); }
});

load({ quiet: true });
