import { getDocument, GlobalWorkerOptions } from '/vendor/pdf.mjs';
import { markdownToHtml as renderMarkdownHtml } from '/markdown.js';
import { createMarkdownEditor } from '/vendor/codemirror-editor.js';
import { api } from '/api/client.js';
import { renderMathIn } from '/editor/math.js';
import { activeFilterCount as countActiveFilters, filterItems, isRecent, scopeItems } from '/library/filtering.js';
import { basisNames, kindNames, readingNames, relationNames, state } from '/state/app-state.js';
import { elements, escapeHtml, formatBytes, inboxType, typeClass } from '/ui/dom.js';

GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';

function navigationSnapshot() {
  return {
    graphMode: state.graphMode,
    graphFocusId: state.graphFocusId,
    scope: state.scope,
    category: state.category,
    selectedId: state.selectedId,
    selectedFolderId: state.selectedFolderId,
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
  state.selectedFolderId = snapshot.selectedFolderId || null;
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

function scopedItems() {
  return scopeItems(state);
}

function filteredItems() {
  return filterItems(state);
}

function activeFilterCount() {
  return countActiveFilters(state.filters);
}

function folderCreatorHtml(parent, depth) {
  if (state.creatingFolderParent !== parent) return '';
  return `<div class="tree-inline-creator" style="--depth:${depth}"><input data-folder-name maxlength="80" placeholder="文件夹名称" aria-label="文件夹名称"><button type="button" data-folder-create data-parent="${escapeHtml(parent)}">创建</button><button type="button" data-folder-cancel>×</button></div>`;
}

function folderAddButton(path, name) {
  if (state.restructureSelecting) return '';
  if (!path) return `<button class="tree-add-child" type="button" data-library-create-toggle aria-expanded="${state.libraryCreateMenuOpen}" aria-label="在 Library 中新建内容" title="新建内容">＋</button>`;
  return `<button class="tree-add-child" type="button" data-new-folder-parent="${escapeHtml(path)}" aria-label="在 ${escapeHtml(name)} 中新建文件夹" title="新建子文件夹">＋</button>`;
}

function libraryCreateMenuHtml() {
  if (!state.libraryCreateMenuOpen || state.restructureSelecting) return '';
  return `<div class="library-create-menu">
    <button type="button" data-library-create-folder><span>▱</span><span><strong>新建文件夹</strong><small>在 Library 下建立分类</small></span></button>
    <button type="button" data-library-import-urls><span>↗</span><span><strong>导入网址</strong><small>批量加入收件箱</small></span></button>
  </div>`;
}

function initializeCollapsedFolders() {
  if (state.folderCollapseInitialized || !state.tree) return;
  const paths = [''];
  const collect = nodes => nodes.forEach(node => {
    paths.push(node.path);
    collect(node.children || []);
  });
  collect(state.tree.children || []);
  state.collapsedFolders = new Set(paths);
  state.folderCollapseInitialized = true;
}

function structureSelectionState(path) {
  const direct = state.selectedStructureFolders.has(path);
  const locked = [...state.selectedStructureFolders].some(value => value !== path && (!value || path.startsWith(`${value}/`)));
  return { checked: direct || locked, locked };
}

function treeHtml(nodes, depth = 1) {
  return nodes.map(node => {
    const collapsed = state.collapsedFolders.has(node.path);
    const hasChildren = Boolean(node.children?.length);
    const selection = structureSelectionState(node.path);
    return `
    <div class="tree-branch" role="treeitem">
      <div class="tree-node-shell">
        <button class="tree-node ${state.scope === 'category' && state.category === node.path ? 'is-active' : ''}"
          data-category="${escapeHtml(node.path)}" style="--depth:${depth}">
          <span class="folder ${hasChildren ? '' : 'is-leaf'} ${collapsed ? 'is-collapsed' : ''}" ${hasChildren ? `data-tree-toggle="${escapeHtml(node.path)}"` : ''}>${hasChildren ? '▾' : '▱'}</span>
          <span class="node-name">${escapeHtml(node.name)}</span><span class="node-count">${node.count}</span>
          ${state.restructureSelecting ? `<span class="restructure-checkbox ${selection.checked ? 'is-checked' : ''} ${selection.locked ? 'is-locked' : ''}" role="checkbox" aria-checked="${selection.checked}" data-restructure-folder="${escapeHtml(node.path)}">${selection.checked ? '✓' : ''}</span>` : ''}
        </button>
        ${!state.restructureSelecting ? `<button class="tree-note-action" type="button" data-new-note-category="${escapeHtml(node.path)}" aria-label="在 ${escapeHtml(node.name)} 中新建笔记" title="新建笔记">✎</button>` : ''}
        ${folderAddButton(node.path, node.name)}
      </div>
      ${!collapsed ? `<div class="tree-children ${hasChildren ? '' : 'is-empty'}" role="group">${folderCreatorHtml(node.path, depth + 1)}${treeHtml(node.children || [], depth + 1)}</div>` : ''}
    </div>`;
  }).join('');
}

function libraryRootHtml() {
  const collapsed = state.collapsedFolders.has('');
  const selection = structureSelectionState('');
  const children = state.tree?.children || [];
  return `
    <div class="tree-branch library-root" role="treeitem" aria-level="1">
      <div class="tree-node-shell">
        <button class="tree-node tree-root-node ${state.scope === 'all' ? 'is-active' : ''}" data-scope="all" style="--depth:0">
          <span class="folder ${collapsed ? 'is-collapsed' : ''}" data-tree-toggle="">▾</span>
          <span class="node-name">Library</span><span class="node-count">${state.tree?.count || 0}</span>
          ${state.restructureSelecting ? `<span class="restructure-checkbox ${selection.checked ? 'is-checked' : ''}" role="checkbox" aria-checked="${selection.checked}" data-restructure-folder="">${selection.checked ? '✓' : ''}</span>` : ''}
        </button>
        ${!state.restructureSelecting ? '<button class="tree-note-action" type="button" data-new-temporary-note aria-label="在 Library 中新建笔记" title="新建笔记">✎</button>' : ''}
        ${folderAddButton('', 'Library')}
      </div>
      ${libraryCreateMenuHtml()}
      ${!collapsed ? `<div class="tree-children library-root-children" role="group">${folderCreatorHtml('', 1)}${children.length ? treeHtml(children) : '<div class="tree-empty-note">暂无分类</div>'}</div>` : ''}
    </div>`;
}

function renderNavigation() {
  const readyCount = state.items.filter(item => item.status === 'ready').length;
  const inboxCount = state.inboxFiles.length;
  const supportedInboxCount = state.inboxFiles.filter(file => file.supported).length;
  elements.allCount.textContent = state.items.length;
  elements.inboxCount.textContent = inboxCount;
  elements.temporaryNoteCount.textContent = state.temporaryNotes.length;
  elements.recentCount.textContent = state.items.filter(isRecent).length;
  elements.reviewCount.textContent = state.items.filter(item => item.status === 'review').length;
  elements.favoriteCount.textContent = state.items.filter(item => item.favorite).length;
  elements.unreadCount.textContent = state.items.filter(item => item.reading_status === 'unread').length;
  elements.libraryCount.textContent = readyCount;
  elements.tree.classList.toggle('is-restructure-mode', state.restructureSelecting);
  elements.tree.closest('.tree-section')?.classList.toggle('is-restructure-mode', state.restructureSelecting);
  elements.tree.innerHTML = `${state.restructureSelecting ? '<div class="tree-restructure-hint"><span>选择需要重构的目录</span><small>勾选父级会包含全部子级</small></div>' : ''}${libraryRootHtml()}`;
  const selectedCount = state.selectedStructureFolders.size;
  elements.structureButton.setAttribute('aria-pressed', String(state.restructureSelecting));
  elements.structureButton.innerHTML = state.structureBusy ? '<span>◌</span> 正在重构…' : state.restructureSelecting ? `<span>✓</span> 执行重构${selectedCount ? ` (${selectedCount})` : ''}` : '<span>⌘</span> 重构';
  elements.structureButton.disabled = state.structureBusy;
  elements.structureCancelButton.hidden = !state.restructureSelecting;
  elements.rollbackButton.disabled = state.structureBusy || state.restructureSelecting;
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
  const folders = [];
  const collectFolders = nodes => nodes.forEach(node => { folders.push(node.path); collectFolders(node.children || []); });
  collectFolders(state.tree?.children || []);
  const selectedFolder = state.filters.folder || (state.scope === 'category' ? state.category : '');
  elements.folderFilter.value = selectedFolder;
  elements.folderFilterSelection.textContent = selectedFolder ? `Library / ${selectedFolder}` : 'Library';
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
    folder: elements.folderFilter.value, kinds: checked('kinds'), tags: checked('tags'), tagMode: document.querySelector('#tagMode').value,
    status: document.querySelector('#statusFilter').value, readingStatuses: checked('readingStatuses'),
    favorite: document.querySelector('#favoriteFilter').value, scoreMin: Number(document.querySelector('#scoreFilter').value),
    publishedFrom: document.querySelector('#publishedFrom').value, publishedTo: document.querySelector('#publishedTo').value,
    receivedFrom: document.querySelector('#receivedFrom').value, receivedTo: document.querySelector('#receivedTo').value,
    sort: document.querySelector('#sortFilter').value,
  };
}

function resetFilters() {
  state.filters = { folder: '', kinds: [], tags: [], tagMode: 'and', status: '', readingStatuses: [], favorite: 'any', scoreMin: 0, publishedFrom: '', publishedTo: '', receivedFrom: '', receivedTo: '', sort: 'received_desc' };
  renderFilterPanel();
  render();
  pushNavigation();
}

function toggleFilterPanel(show = elements.filterPanel.hidden) {
  elements.filterPanel.hidden = !show;
  elements.filterButton.setAttribute('aria-expanded', String(show));
  if (!show) closeFolderFilterMenu();
  if (show) {
    toggleRollbackPanel(false);
    renderFilterPanel();
  }
}

function renderRollbackHistory() {
  const records = state.restructureHistory.slice(0, 30);
  elements.structureHistory.innerHTML = records.length ? records.map(record => {
    const folderChange = record.folder_change;
    const title = folderChange ? `${folderChange.source} → ${folderChange.target}` : `${record.item_count ?? record.changes?.length ?? 0} 项资料重构`;
    const date = new Date(record.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<article class="rollback-row ${record.status === 'undone' ? 'is-undone' : ''}"><span class="history-mark">${folderChange ? '夹' : 'AI'}</span><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(record.rationale || '')}</p><small>${date}${record.status === 'undone' ? ' · 已恢复' : ''}</small></div>${record.status === 'applied' ? `<button type="button" data-undo-restructure="${record.id}">恢复</button>` : '<span class="history-status">已恢复</span>'}</article>`;
  }).join('') : '<div class="structure-empty">还没有可回退的结构快照</div>';
}

function toggleRollbackPanel(show = elements.rollbackPanel.hidden) {
  elements.rollbackPanel.hidden = !show;
  elements.rollbackButton.setAttribute('aria-expanded', String(show));
  if (show) {
    elements.filterPanel.hidden = true;
    elements.filterButton.setAttribute('aria-expanded', 'false');
    renderRollbackHistory();
  }
}

function cancelRestructureSelection() {
  state.restructureSelecting = false;
  state.selectedStructureFolders.clear();
  renderNavigation();
}

async function runSelectedRestructure() {
  if (state.structureBusy) return;
  if (!state.selectedStructureFolders.size) return showToast('请先在左侧勾选要重构的文件夹');
  state.structureBusy = true;
  renderNavigation();
  try {
    const result = await api('/api/restructure/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scopes: [...state.selectedStructureFolders] }) });
    state.restructureSelecting = false;
    state.selectedStructureFolders.clear();
    await load({ quiet: true });
    showToast(`已重新分类 ${result.item_count ?? result.changes.length} 项资料，快照已保存`);
  } catch (error) { showToast(error.message); }
  finally { state.structureBusy = false; renderNavigation(); }
}

async function undoRestructure(id) {
  if (state.structureBusy) return;
  state.structureBusy = true;
  try {
    await api(`/api/restructure/${id}/undo`, { method: 'POST' });
    await load({ quiet: true });
    renderRollbackHistory();
    showToast('已恢复旧目录，新加入的资料保持原位');
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
    const view = await api('/api/views', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim(), query: state.query, scope: state.filters.folder ? 'all' : state.scope, category: state.filters.folder ? '' : state.category, filters: state.filters }) });
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

function findFolderNode(path, nodes = state.tree?.children || []) {
  for (const node of nodes) {
    if (node.path === path) return node;
    const found = findFolderNode(path, node.children || []);
    if (found) return found;
  }
  return null;
}

function itemRowHtml(item) {
  return `<div class="item-row file-browser-row ${item.kind === 'note' ? 'notebook-row' : ''} ${item.id === state.selectedId ? 'is-active' : ''}" data-id="${item.id}" tabindex="0">
    <span class="item-type ${typeClass(item)}">${escapeHtml(kindNames[item.kind] || 'FILE')}</span>
    <span class="item-title">
      <strong>${item.favorite ? '<span class="item-favorite">★</span>' : ''}${escapeHtml(item.title)}</strong>
      <small class="${state.query && state.searchMatches.get(item.id)?.snippet ? 'search-snippet' : ''}">${state.query && state.searchMatches.get(item.id)?.snippet ? escapeHtml(state.searchMatches.get(item.id).snippet) : item.status === 'review' ? `待检查 · ${escapeHtml(item.review_reason || item.category || '需要人工复查')}` : `<span class="reading-dot ${item.reading_status === 'read' ? 'read' : ''}"></span>${escapeHtml(readingNames[item.reading_status] || '未读')} · ${escapeHtml(item.category || '未分类')}`}</small>
    </span>
    <span class="item-tags">${(item.tags || []).slice(0, 2).map(tag => `<span class="mini-tag">${escapeHtml(tag)}</span>`).join('')}</span>
    <span class="item-date ${item.status === 'review' ? 'review-badge' : ''}">${escapeHtml(item.published_at || item.received_at || '日期未知')}</span>
    <span class="row-actions">
      ${item.status === 'ready' ? `<button class="row-action-button row-move-button" type="button" data-move-item="${item.id}" aria-label="移动 ${escapeHtml(item.title)}">移动</button>` : ''}
      <button class="row-action-button row-delete-button" type="button" data-delete-list-item="${item.id}" aria-label="删除 ${escapeHtml(item.title)}">删除</button>
    </span>
  </div>`;
}

function folderRowHtml(folder) {
  return `<div class="item-row folder-browser-row" data-open-folder="${escapeHtml(folder.path)}" tabindex="0">
    <span class="item-type folder-type">夹</span>
    <span class="item-title"><strong>${escapeHtml(folder.name)}</strong><small>${folder.children?.length || 0} 个子文件夹 · ${folder.count} 项资料</small></span>
    <span class="item-tags"><span class="mini-tag">文件夹</span></span>
    <span class="item-date">进入 ›</span>
    <span class="row-actions">
      <button class="row-action-button row-move-button" type="button" data-move-folder="${escapeHtml(folder.path)}" aria-label="移动 ${escapeHtml(folder.name)}">移动</button>
      <button class="row-action-button row-delete-button" type="button" data-delete-list-folder="${escapeHtml(folder.path)}" aria-label="删除 ${escapeHtml(folder.name)}">删除</button>
    </span>
  </div>`;
}

function linkedMaterialId(note) {
  const ownership = state.relations.find(relation => relation.type === 'belongs_to' && (relation.source_id === note?.id || relation.target_id === note?.id));
  if (ownership) return ownership.source_id === note.id ? ownership.target_id : ownership.source_id;
  return Array.isArray(note?.linked_item_ids) && note.linked_item_ids.length ? note.linked_item_ids[0] : note?.bound_item_id || null;
}

function renderList() {
  if (state.scope === 'temporary-notes') {
    const query = state.query.trim().toLocaleLowerCase('zh-CN');
    const notes = query ? state.temporaryNotes.filter(note => note.title.toLocaleLowerCase('zh-CN').includes(query)) : state.temporaryNotes;
    state.selectedId = null;
    elements.collectionTitle.textContent = '临时笔记';
    elements.collectionPath.textContent = 'NOTE DRAFTS';
    elements.resultCount.textContent = `${notes.length} 篇草稿`;
    elements.list.closest('.catalog')?.querySelector('.catalog-hint')?.replaceChildren(document.createTextNode('完成后可手动送入收件箱分类'));
    elements.contentColumn.classList.remove('is-folder-browser');
    elements.list.innerHTML = `<button class="temporary-note-create" type="button" data-new-temporary-note>＋ 新建临时笔记</button>${notes.map(note => `<div class="item-row notebook-row" data-open-notebook="${note.id}" tabindex="0"><span class="item-type note">笔</span><span class="item-title"><strong>${escapeHtml(note.title)}</strong><small>临时草稿 · ${new Date(note.updated_at).toLocaleString('zh-CN')}</small></span><span class="item-tags"><span class="mini-tag">Markdown</span></span><span class="item-date">编辑 ›</span><span class="row-actions"><button class="row-action-button row-delete-button" type="button" data-delete-temporary-note="${note.id}" aria-label="删除 ${escapeHtml(note.title)}">删除</button></span></div>`).join('') || '<div class="empty-list">还没有临时笔记</div>'}`;
    return;
  }
  if (state.scope === 'inbox') {
    const query = state.query.trim().toLocaleLowerCase('zh-CN');
    const files = query ? state.inboxFiles.filter(file => (file.display_name || file.name).toLocaleLowerCase('zh-CN').includes(query)) : state.inboxFiles;
    state.selectedId = null;
    elements.collectionTitle.textContent = '收件箱';
    elements.collectionPath.textContent = 'PENDING INBOX';
    elements.resultCount.textContent = `${files.length} 个待分类文件`;
    elements.list.closest('.catalog')?.querySelector('.catalog-hint')?.replaceChildren(document.createTextNode('文件会保留到手动执行分类'));
    elements.list.innerHTML = files.length ? files.map(file => `
      <div class="item-row inbox-file-row">
        <span class="item-type">${escapeHtml(inboxType(file))}</span>
        <span class="item-title">
          <strong>${escapeHtml(file.display_name || file.name)}</strong>
          <small>${file.supported ? file.processing ? '正在分类' : '等待分类' : '暂不支持此格式'}</small>
        </span>
        <span class="item-tags"><span class="mini-tag">${file.size == null ? '笔记草稿' : escapeHtml(formatBytes(file.size))}</span></span>
        <span class="item-date inbox-row-actions ${file.supported ? '' : 'review-badge'}">
          <span>${file.supported ? '收件箱' : '需移除'}</span>
          <button class="inbox-delete-button" type="button" data-inbox-delete="${escapeHtml(file.name)}" aria-label="删除 ${escapeHtml(file.name)}" ${file.processing ? 'disabled' : ''}>×</button>
        </span>
      </div>`).join('') : '<div class="empty-list">拖动文件到左侧收件箱，即可在这里暂存</div>';
    return;
  }
  const directoryScope = state.scope === 'all' || state.scope === 'category';
  const browsingDirectory = directoryScope && !state.query.trim() && activeFilterCount() === 0;
  const currentPath = state.scope === 'category' ? state.category : '';
  const currentNode = currentPath ? findFolderNode(currentPath) : state.tree;
  const folders = browsingDirectory ? currentNode?.children || [] : [];
  const items = browsingDirectory
    ? state.items.filter(item => item.status === 'ready' && item.category === currentPath)
    : filteredItems();
  const title = state.scope === 'review' ? '待检查' : state.scope === 'recent' ? '最近添加' : state.scope === 'favorites' ? '收藏' : state.scope === 'unread' ? '未读' : state.scope === 'category' ? state.category.split('/').at(-1) : 'Library';
  const filtering = Boolean(state.query.trim() || activeFilterCount());
  const filterFolder = state.filters.folder || currentPath || 'Library';
  elements.collectionTitle.textContent = filtering ? '筛选结果' : state.graphMode ? '知识图谱' : title;
  elements.collectionPath.textContent = filtering ? `筛选文件夹 · ${filterFolder === 'Library' ? 'Library' : `Library / ${filterFolder}`}` : state.graphMode ? 'KNOWLEDGE HOME' : currentPath ? `LIBRARY / ${currentPath.toUpperCase()}` : 'KNOWLEDGE LIBRARY';
  elements.resultCount.textContent = browsingDirectory ? `${folders.length} 个文件夹 · ${items.length} 个文件` : `${items.length} 项资料`;
  elements.list.closest('.catalog')?.querySelector('.catalog-hint')?.replaceChildren(document.createTextNode(browsingDirectory ? '进入文件夹，或选择文件打开预览' : '选择一项即可在下方阅读'));
  if (!items.some(item => item.id === state.selectedId)) state.selectedId = null;
  elements.contentColumn.classList.toggle('is-folder-browser', browsingDirectory && !state.selectedId && !state.graphMode);
  const rows = [...folders.map(folderRowHtml), ...items.map(itemRowHtml)];
  elements.list.innerHTML = rows.length ? rows.join('') : `<div class="empty-list">${filtering ? '当前筛选条件下没有资料' : '当前文件夹为空，可从左侧新建子文件夹'}</div>`;
}

function graphData() {
  const matchedItems = filteredItems();
  const matchingIds = new Set(matchedItems.map(item => item.id));
  const filtering = Boolean(state.query.trim() || activeFilterCount());
  let items = filtering
    ? [...matchedItems, ...scopedItems().filter(item => !matchingIds.has(item.id))].slice(0, 100)
    : matchedItems.slice(0, 100);
  const allItemsById = new Map(state.items.map(item => [item.id, item]));
  const includedIds = new Set(items.map(item => item.id));
  for (const note of [...items]) {
    const materialId = linkedMaterialId(note);
    if (!materialId || includedIds.has(materialId)) continue;
    const source = allItemsById.get(materialId);
    if (source?.status !== 'ready') continue;
    items.push(source);
    includedIds.add(source.id);
  }
  const palette = ['#2f7668', '#bd7047', '#607db0', '#9a7a32', '#7d6098', '#64854b'];
  const rootFolder = folderRecordByPath('');
  const nodes = [{ id: 'root', entityId: rootFolder?.id, type: 'root', label: 'Library', path: '', depth: 0, color: '#173f35' }];
  const edges = [];
  const known = new Set(['root']);
  const entityToGraph = new Map(rootFolder ? [[rootFolder.id, 'root']] : []);
  const topFolders = [];
  const addFolderPath = pathValue => {
    let parent = 'root';
    const parts = String(pathValue || '').split('/').filter(Boolean);
    const topPath = parts[0];
    if (!topPath) return parent;
    if (!topFolders.includes(topPath)) topFolders.push(topPath);
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/');
      const folder = folderRecordByPath(path);
      const id = `folder:${folder?.id || path}`;
      if (!known.has(id)) {
        known.add(id);
        nodes.push({ id, entityId: folder?.id, type: 'folder', label: part, path, topPath, depth: index + 1 });
        edges.push({ source: parent, target: id, type: 'structure' });
        if (folder?.id) entityToGraph.set(folder.id, id);
      }
      parent = id;
    });
    return parent;
  };
  const addTreeFolders = nodesToAdd => nodesToAdd.forEach(node => { addFolderPath(node.path); addTreeFolders(node.children || []); });
  addTreeFolders(state.tree?.children || []);
  const boundNotes = [];
  for (const item of items) {
    if (item.kind === 'note' && linkedMaterialId(item)) {
      boundNotes.push(item);
      continue;
    }
    const parts = String(item.category || '未分类').split('/').filter(Boolean).length ? String(item.category || '未分类').split('/').filter(Boolean) : ['未分类'];
    const topPath = parts[0];
    const parent = addFolderPath(parts.join('/'));
    nodes.push({ id: item.id, entityId: item.id, type: 'item', label: item.title, item, topPath, depth: parts.length + 1 });
    entityToGraph.set(item.id, item.id);
    edges.push({ source: parent, target: item.id, type: 'structure' });
  }
  for (const item of boundNotes) {
    const sourceNode = nodes.find(node => node.id === linkedMaterialId(item));
    const parts = String(item.category || '未分类').split('/').filter(Boolean).length ? String(item.category || '未分类').split('/').filter(Boolean) : ['未分类'];
    const topPath = sourceNode?.topPath || parts[0];
    const fallbackParent = addFolderPath(parts.join('/'));
    const parent = sourceNode?.id || fallbackParent;
    nodes.push({ id: item.id, entityId: item.id, type: 'item', label: item.title, item, topPath, depth: sourceNode ? sourceNode.depth + 1 : parts.length + 1 });
    entityToGraph.set(item.id, item.id);
    edges.push({ source: parent, target: item.id, type: 'structure', ownership: Boolean(sourceNode), bidirectional: Boolean(sourceNode), label: sourceNode ? '资料 ↔ 笔记' : '文件夹层级' });
  }
  const colors = new Map(topFolders.map((folder, index) => [folder, palette[index % palette.length]]));
  nodes.forEach(node => { if (node.type !== 'root') node.color = colors.get(node.topPath) || palette[0]; });
  for (const relation of state.relations) {
    const source = entityToGraph.get(relation.source_id);
    const target = entityToGraph.get(relation.target_id);
    if (!source || !target) continue;
    if (relation.type === 'belongs_to' && edges.some(edge => edge.ownership && ((edge.source === source && edge.target === target) || (edge.source === target && edge.target === source)))) continue;
    edges.push({ source, target, type: 'relation', relationType: relation.type, bidirectional: true, label: relationNames[relation.type] || '相关' });
  }
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
  return { nodes, edges, items, matchingIds, filtering, entityToGraph };
}

function renderGraph() {
  if (!state.graphMode) return;
  const { nodes, edges, items, matchingIds, filtering } = graphData();
  if (nodes.length === 1) {
    elements.graphCanvas.innerHTML = '<div class="graph-empty">当前条件下没有可绘制的资料</div>';
    return;
  }
  const width = Math.max(620, elements.graphCanvas.clientWidth || 900);
  const height = Math.max(430, elements.graphCanvas.clientHeight || 620);
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (!byId.has(state.graphFocusId)) state.graphFocusId = 'root';
  const structuralEdges = edges.filter(edge => edge.type === 'structure');
  const children = new Map();
  for (const edge of structuralEdges) {
    if (!children.has(edge.source)) children.set(edge.source, []);
    children.get(edge.source).push(edge.target);
  }
  const focusIds = new Set();
  const focusEdges = new Set();
  if (state.graphFocusId === 'root') {
    nodes.forEach(node => focusIds.add(node.id));
    edges.forEach(edge => focusEdges.add(edge));
  }
  else {
    const focusedNode = byId.get(state.graphFocusId);
    focusIds.add(state.graphFocusId);
    if (focusedNode?.type === 'folder') {
      const pending = [state.graphFocusId];
      while (pending.length) {
        const id = pending.shift();
        for (const child of children.get(id) || []) {
          focusIds.add(child);
          pending.push(child);
          const edge = structuralEdges.find(value => value.source === id && value.target === child);
          if (edge) focusEdges.add(edge);
        }
      }
    }
    for (const edge of edges) {
      if (edge.source !== state.graphFocusId && edge.target !== state.graphFocusId) continue;
      focusEdges.add(edge);
      focusIds.add(edge.source);
      focusIds.add(edge.target);
    }
  }
  const filterIds = new Set(['root']);
  if (filtering) for (const item of items) {
    if (!matchingIds.has(item.id)) continue;
    filterIds.add(item.id);
    if (item.kind === 'note' && linkedMaterialId(item)) filterIds.add(linkedMaterialId(item));
    const parts = String(item.category || '未分类').split('/').filter(Boolean);
    parts.forEach((_, index) => {
      const folder = folderRecordByPath(parts.slice(0, index + 1).join('/'));
      if (folder) filterIds.add(`folder:${folder.id}`);
    });
  }
  const activeIds = filtering ? new Set([...focusIds].filter(id => filterIds.has(id))) : focusIds;
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
  const orderedEdges = [...edges].sort((a, b) => Number(a.type === 'structure') - Number(b.type === 'structure'));
  const edgeHtml = orderedEdges.map(edge => {
    const a = byId.get(edge.source), b = byId.get(edge.target);
    if (!a || !b) return '';
    const focusMuted = state.graphFocusId !== 'root' && !focusEdges.has(edge);
    const muted = focusMuted || !activeIds.has(edge.source) || !activeIds.has(edge.target);
    const highlighted = state.graphFocusId !== 'root' && focusEdges.has(edge);
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
    return `<path class="graph-edge ${edge.type} ${edge.ownership ? 'note-link' : ''} ${edge.bidirectional ? 'bidirectional' : ''} ${highlighted ? 'is-highlighted' : ''} ${muted ? 'is-muted' : ''}" d="${path}" ${stroke ? `style="stroke:${stroke}"` : ''}><title>${escapeHtml(edge.label || (edge.type === 'structure' ? '文件夹层级' : '双向连接'))}</title></path>`;
  }).join('');
  const nodeHtml = nodes.map(node => {
    const radius = node.type === 'root' ? 15 : node.type === 'folder' && node.depth === 1 ? 13 : node.type === 'folder' ? 10 : 6;
    const shortLimit = node.type === 'item' ? 7 : 10;
    const shortLabel = node.label.length > shortLimit ? `${node.label.slice(0, shortLimit)}…` : node.label;
    const detailLabel = node.label.length > 28 ? `${node.label.slice(0, 28)}…` : node.label;
    const detailWidth = Math.min(265, Math.max(92, detailLabel.length * 10 + 20));
    const data = node.type === 'item' ? `data-graph-item="${node.id}"` : node.type === 'folder' ? `data-graph-category="${escapeHtml(node.path)}" data-graph-folder-id="${node.entityId || ''}" data-graph-node="${node.id}"` : `data-graph-root data-graph-folder-id="${node.entityId || ''}" data-graph-node="root"`;
    const detailY = node.y < 70 ? 15 : -41;
    const detail = node.type === 'item' ? `<g class="graph-detail-label"><rect x="${(-detailWidth / 2).toFixed(1)}" y="${detailY}" width="${detailWidth}" height="26" rx="6"></rect><text x="0" y="${detailY + 17}" text-anchor="middle">${escapeHtml(detailLabel)}</text></g>` : '';
    return `<g class="graph-node ${node.type} ${node.id === state.selectedId || node.entityId === state.selectedFolderId ? 'is-selected' : ''} ${node.id === state.graphFocusId ? 'is-focused' : ''} ${activeIds.has(node.id) ? '' : 'is-muted'}" style="--node-color:${node.color}" transform="translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})" ${data}><circle class="graph-hit-area" r="${radius + 5}"></circle><circle class="graph-node-dot" r="${radius}"></circle><text class="graph-short-label" x="${radius + 7}" y="3">${escapeHtml(shortLabel)}</text>${detail}<title>${escapeHtml(node.label)}</title></g>`;
  }).join('');
  elements.graphCanvas.innerHTML = `<svg class="knowledge-graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="文件夹与资料关系图"><defs><marker id="graph-relation-arrow" viewBox="0 0 8 8" refX="6.4" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 8 4 L 0 8 z"></path></marker><marker id="graph-highlight-arrow" viewBox="0 0 8 8" refX="6.4" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 8 4 L 0 8 z"></path></marker><marker id="graph-note-link-arrow" viewBox="0 0 8 8" refX="6.4" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 8 4 L 0 8 z"></path></marker></defs><g class="graph-stage">${edgeHtml}${nodeHtml}</g></svg>`;
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
  state.selectedFolderId = null;
  state.graphFocusId = 'root';
  state.query = '';
  state.searchMatches = new Map();
  state.filters = { folder: '', kinds: [], tags: [], tagMode: 'and', status: '', readingStatuses: [], favorite: 'any', scoreMin: 0, publishedFrom: '', publishedTo: '', receivedFrom: '', receivedTo: '', sort: 'received_desc' };
  elements.search.value = '';
  setGraphMode(true);
  render();
  resetGraphViewport();
  if (record) pushNavigation();
}

function focusGraphNode(id, selectedId = null, selectedFolderId = null) {
  state.graphFocusId = id || 'root';
  state.selectedId = selectedId;
  state.selectedFolderId = selectedFolderId;
  state.editingItemId = null;
  state.editingFolderId = null;
  renderInspector();
  renderGraph();
  pushNavigation();
}

function openGraphItem(id) {
  state.selectedId = id;
  state.selectedFolderId = null;
  state.graphFocusId = id;
  state.tab = state.items.find(item => item.id === id)?.reading_position?.view || 'asset';
  state.notes = [];
  state.notesItemId = null;
  setGraphMode(false);
  render();
  pushNavigation();
  const item = selectedItem();
  if (item?.kind === 'note') return openNotebook(item.id);
  if (item?.reading_status === 'unread') patchOrganization({ reading_status: 'reading', last_opened_at: new Date().toISOString() });
}

function openGraphFolder(path = '') {
  state.scope = path ? 'category' : 'all';
  state.category = path;
  state.selectedId = null;
  state.selectedFolderId = folderRecordByPath(path)?.id || null;
  state.editingItemId = null;
  state.query = '';
  state.searchMatches = new Map();
  state.filters = { folder: '', kinds: [], tags: [], tagMode: 'and', status: '', readingStatuses: [], favorite: 'any', scoreMin: 0, publishedFrom: '', publishedTo: '', receivedFrom: '', receivedTo: '', sort: 'received_desc' };
  elements.search.value = '';
  setGraphMode(false);
  render();
  pushNavigation();
}

function selectedItem() {
  return state.items.find(item => item.id === state.selectedId) || null;
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
  elements.viewer.innerHTML = `<article class="document-page">${variant === 'markdown' ? renderMarkdownHtml(text) : `<p>${escapeHtml(text)}</p>`}</article>`;
  await restoreReadingPosition(item, token);
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
    await restoreReadingPosition(item, token);
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
  elements.readingToggle.disabled = state.scope === 'inbox' || state.scope === 'temporary-notes';
  document.querySelectorAll('.tab').forEach(tab => {
    tab.classList.toggle('is-active', tab.dataset.tab === state.tab);
    tab.disabled = state.scope === 'inbox' || state.scope === 'temporary-notes';
  });
  if (state.scope === 'temporary-notes') {
    elements.readerKind.textContent = 'NOTE';
    elements.readerTitle.textContent = '临时笔记区';
    elements.readerSubtitle.textContent = '草稿保存在本地，完成后由你送入收件箱';
    elements.openOriginal.classList.add('is-disabled');
    elements.openOriginal.removeAttribute('href');
    elements.viewer.innerHTML = '<div class="viewer-empty"><div class="empty-glyph">笔</div><p>选择草稿继续编辑</p><span>支持 Markdown、粘贴图片与实时预览</span></div>';
    return;
  }
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
        <span>${state.inboxAvailable === false ? '关闭现有工作台窗口，再重新双击启动程序' : '把文档、图片、音频、压缩包或网址文件拖到左侧上传区'}</span>
        ${state.inboxAvailable === false ? '' : `<button type="button" data-inbox-choose>${state.inboxFiles.length ? '继续添加文件' : '选择文件'}</button>`}
      </div>`;
    return;
  }
  if (!item) {
    elements.readerKind.textContent = '—';
    elements.readerTitle.textContent = '选择一项资料开始阅读';
    elements.readerSubtitle.textContent = '文档、图片、音频、压缩包和视频链接都可以在这里查看';
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
  } else if (item.kind === 'audio') {
    elements.viewer.innerHTML = `<div class="video-card"><div class="video-info"><div class="video-play">♪</div><h3>${escapeHtml(item.title)}</h3><p>音频不会自动转写。播放原件后，可在右侧填写内容校正并重新分析。</p><audio controls preload="metadata" src="/api/items/${item.id}/asset"></audio></div></div>`;
  } else if (['article', 'markdown', 'text', 'code', 'document', 'presentation', 'spreadsheet', 'ebook', 'archive'].includes(item.kind)) {
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

function folderRecordByPath(path = '') {
  return state.folderRecords.find(folder => folder.path === path) || null;
}

function selectedFolderRecord() {
  if (state.selectedId) return null;
  const explicit = state.folderRecords.find(folder => folder.id === state.selectedFolderId);
  if (explicit) return explicit;
  if (!state.graphMode && (state.scope === 'all' || state.scope === 'category')) return folderRecordByPath(state.scope === 'category' ? state.category : '');
  return null;
}

function relationEntity(id) {
  const item = state.items.find(value => value.id === id);
  if (item) return { ...item, entity_type: item.kind === 'note' ? 'note' : 'item' };
  const folder = state.folderRecords.find(value => value.id === id);
  return folder ? { ...folder, title: folder.name, category: folder.path, entity_type: 'folder' } : null;
}

function relationCandidatesFor(entity) {
  return [
    ...state.folderRecords.map(folder => ({ ...folder, title: folder.name, category: folder.path, entity_type: 'folder' })),
    ...state.items.filter(item => item.status === 'ready').map(item => ({ ...item, entity_type: item.kind === 'note' ? 'note' : 'item' })),
  ].filter(candidate => candidate.id !== entity.id);
}

function relationListHtml(entity, editing) {
  const relations = state.relations.filter(relation => relation.source_id === entity.id || relation.target_id === entity.id);
  return `<section class="inspector-section">
    <p class="inspector-label">双向连接</p>
    <div class="relation-list">${relations.length ? relations.map(relation => {
      const otherId = relation.source_id === entity.id ? relation.target_id : relation.source_id;
      const other = relationEntity(otherId);
      const type = other?.entity_type === 'folder' ? '文件夹' : other?.entity_type === 'note' ? '笔记' : '资料';
      return `<div class="relation-row ${editing ? 'is-editing' : ''}"><span class="relation-type">${escapeHtml(relationNames[relation.type] || '相关')}</span><span class="relation-title" title="${escapeHtml(other?.title || '节点已删除')}"><small>${type}</small>${escapeHtml(other?.title || '节点已删除')}</span>${editing ? `<button class="relation-delete" data-relation-delete="${relation.id}" aria-label="删除关联">×</button>` : ''}</div>`;
    }).join('') : '<span class="summary">尚未建立连接</span>'}</div>
  </section>`;
}

function relationBuilderHtml(candidates, sourceEntity) {
  if (!candidates.length) return '<p class="workflow-hint">知识库中还没有其他可连接的节点。</p>';
  const grouped = new Map();
  for (const candidate of candidates) {
    const parts = String(candidate.category || '').split('/').filter(Boolean);
    const top = parts[0] || 'Library';
    const sub = candidate.entity_type === 'folder' ? (parts.slice(1, -1).join('/') || '__folders__') : (parts.slice(1).join('/') || '__direct__');
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
              <button class="relation-cascade-option" type="button"><span>${sub === '__direct__' ? '本级资料' : sub === '__folders__' ? '文件夹' : escapeHtml(sub)}</span><span>‹</span></button>
              <div class="relation-cascade-menu relation-level-three">
                ${files.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN')).map(file => `<button class="relation-file-option" type="button" data-relation-target="${escapeHtml(file.id)}" data-relation-kind="${file.entity_type}" data-relation-title="${escapeHtml(file.title)}" title="${escapeHtml(file.title)}"><small>${file.entity_type === 'folder' ? '文件夹' : file.entity_type === 'note' ? '笔记' : '资料'}</small>${file.entity_type === 'folder' ? '▱ ' : ''}${escapeHtml(file.title)}</button>`).join('')}
              </div>
            </div>`).join('')}
        </div>
      </div>`).join('');
  return `
    <div class="relation-cascade">
      <button class="relation-cascade-trigger" type="button" data-relation-cascade-toggle aria-expanded="false"><span data-relation-selection>选择文件夹、资料或笔记</span><span>⌄</span></button>
      <div class="relation-cascade-popover" data-relation-cascade-popover hidden>
        <div class="relation-cascade-menu relation-level-one">${topMenus}</div>
      </div>
      <div class="relation-add" data-relation-confirm hidden>
        <select id="relationType" aria-label="连接类型">${Object.entries(relationNames).map(([value, label]) => `<option value="${value}" ${value === 'belongs_to' && sourceEntity.entity_type !== 'note' ? 'hidden disabled' : ''}>${label}</option>`).join('')}</select>
        <button class="secondary-action" type="button" data-relation-add>建立连接</button>
      </div>
    </div>`;
}

function folderMenuBranchHtml(nodes, { sourceFolder = '', mode = 'move' } = {}) {
  return nodes.map(node => {
    if (sourceFolder && (node.path === sourceFolder || node.path.startsWith(`${sourceFolder}/`))) return '';
    const children = folderMenuBranchHtml(node.children || [], { sourceFolder, mode });
    const attribute = mode === 'filter' ? 'data-filter-folder' : 'data-move-destination';
    return `<div class="move-menu-branch"><button type="button" ${attribute}="${escapeHtml(node.path)}"><span>▱ ${escapeHtml(node.name)}</span>${children ? '<b class="menu-direction">›</b>' : ''}</button>${children ? `<div class="move-menu-submenu">${children}</div>` : ''}</div>`;
  }).join('');
}

function folderMenuDepth(nodes) {
  if (!nodes?.length) return 1;
  return 1 + Math.max(0, ...nodes.map(node => folderMenuDepth(node.children || [])));
}

function positionFolderMenu(popover, anchor, nodes) {
  const rect = anchor.getBoundingClientRect();
  const depth = Math.min(3, folderMenuDepth(nodes));
  const requiredWidth = 220 + (depth - 1) * 213;
  const roomRight = window.innerWidth - rect.left - 8;
  const roomLeft = rect.right - 8;
  const direction = roomRight >= Math.min(requiredWidth, window.innerWidth - 16) || roomRight >= roomLeft ? 'right' : 'left';
  popover.dataset.cascadeDirection = direction;
  popover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 230))}px`;
  popover.style.top = `${Math.max(8, Math.min(rect.bottom + 5, window.innerHeight - 330))}px`;
}

function openMoveMenu(entity, anchor) {
  closeFolderFilterMenu();
  document.querySelectorAll('[data-relation-cascade-popover]').forEach(value => { value.hidden = true; });
  state.moveEntity = entity;
  const nodes = state.tree?.children || [];
  const branches = folderMenuBranchHtml(nodes, { sourceFolder: entity.type === 'folder' ? entity.path : '' });
  elements.movePopover.innerHTML = `${entity.type === 'folder' ? '<button class="move-root-option" type="button" data-move-destination=""><span>⌂ Library</span></button>' : ''}<div class="move-menu-tree">${branches || '<div class="move-menu-empty">没有可用的目标文件夹</div>'}</div>`;
  elements.movePopover.hidden = false;
  positionFolderMenu(elements.movePopover, anchor, nodes);
}

function closeMoveMenu() {
  state.moveEntity = null;
  elements.movePopover.hidden = true;
}

function openFolderFilterMenu() {
  closeMoveMenu();
  const nodes = state.tree?.children || [];
  const branches = folderMenuBranchHtml(nodes, { mode: 'filter' });
  elements.folderFilterPopover.innerHTML = `<button class="move-root-option" type="button" data-filter-folder=""><span>⌂ Library</span></button><div class="move-menu-tree">${branches || '<div class="move-menu-empty">暂无文件夹</div>'}</div>`;
  elements.folderFilterPopover.hidden = false;
  elements.folderFilterButton.setAttribute('aria-expanded', 'true');
  positionFolderMenu(elements.folderFilterPopover, elements.folderFilterButton, nodes);
}

function closeFolderFilterMenu() {
  elements.folderFilterPopover.hidden = true;
  elements.folderFilterButton?.setAttribute('aria-expanded', 'false');
}

function renderFolderInspector(folder) {
  const editing = state.editingFolderId === folder.id;
  const entity = { ...folder, title: folder.name, category: folder.path, entity_type: 'folder' };
  const pathLabel = folder.path ? `Library / ${folder.path}` : 'Library';
  const body = editing ? `
    <section class="inspector-section edit-panel">
      <p class="inspector-label">编辑文件夹资料</p>
      <label class="edit-label" for="editFolderSummary">简介</label>
      <textarea class="edit-textarea" id="editFolderSummary" maxlength="20000" placeholder="说明这个文件夹收录的主题与范围">${escapeHtml(folder.summary || '')}</textarea>
      <label class="edit-label" for="editFolderTags">标签</label>
      <input class="edit-input" id="editFolderTags" value="${escapeHtml((folder.tags || []).join('，'))}" placeholder="使用逗号分隔">
      <div class="edit-relation-block">
        <p class="inspector-label">建立双向连接</p>
        ${relationBuilderHtml(relationCandidatesFor(entity), entity)}
      </div>
      <p class="workflow-hint">文件夹名称与位置继续通过资料列表中的“移动”操作调整，稳定 ID 和已有连接不会改变。</p>
      <div class="edit-actions">
        <button class="secondary-action" type="button" data-cancel-folder-edit>取消</button>
        <button class="primary-action" type="button" data-save-folder ${state.busyAction || state.backendCompatible === false ? 'disabled' : ''}>保存资料</button>
      </div>
    </section>` : `
    <section class="inspector-section">
      <p class="inspector-label">简介</p>
      <p class="summary">${escapeHtml(folder.summary || '暂无简介')}</p>
    </section>
    <section class="inspector-section">
      <p class="inspector-label">标签</p>
      <div class="tag-list">${folder.tags?.length ? folder.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('') : '<span class="summary">暂无标签</span>'}</div>
    </section>`;
  elements.inspector.innerHTML = `
    <header class="inspector-head folder-inspector-head">
      <div class="inspector-number"><span>FOLDER / ${escapeHtml(folder.id.slice(0, 8).toUpperCase())}</span><span class="status-pill">文件夹</span></div>
      <h3>${escapeHtml(folder.name)}</h3>
      <div class="inspector-subline"><span class="inspector-kind" title="${escapeHtml(pathLabel)}">${escapeHtml(pathLabel)}</span><span class="inspector-head-actions"><button class="edit-item-button" type="button" data-edit-folder ${state.backendCompatible === false ? 'disabled' : ''}>${editing ? '退出编辑' : '编辑资料'}</button></span></div>
    </header>
    ${body}
    ${relationListHtml(entity, editing)}
    <section class="inspector-section"><p class="inspector-label">稳定身份</p><p class="summary">文件夹改名或移动后，资料卡与双向连接会继续保留。</p></section>`;
}

async function performMove(destination) {
  const entity = state.moveEntity;
  if (!entity || state.busyAction) return;
  closeMoveMenu();
  state.busyAction = true;
  try {
    if (entity.type === 'item') {
      if (!destination) throw new Error('资料必须放在一个文件夹中');
      await api(`/api/items/${entity.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: destination }) });
    } else {
      await api('/api/library/folders', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: entity.path, name: entity.path.split('/').at(-1), parent: destination }) });
    }
    state.selectedId = entity.type === 'item' ? entity.id : null;
    await load({ quiet: true });
    showToast(entity.type === 'item' ? '资料已移动' : '文件夹已移动，双向连接保持不变');
  } catch (error) { showToast(error.message); }
  finally { state.busyAction = false; }
}

function renderInspector() {
  const item = selectedItem();
  const folder = selectedFolderRecord();
  elements.notesPanel.hidden = !state.readingMode;
  if (state.readingMode) {
    elements.inspectorEmpty.hidden = true;
    elements.inspector.hidden = true;
    return;
  }
  if (state.scope === 'inbox' && !item) {
    elements.inspectorEmpty.innerHTML = '<span class="inspector-index">IN</span><p>等待分类</p><small>文件只会暂存。点击左侧“执行收件箱分类”后才会调用分析模型并归档。</small>';
  } else if (!item && !folder) {
    elements.inspectorEmpty.innerHTML = '<span class="inspector-index">00</span><p>资料信息</p><small>选择资料后查看摘要、标签与日期</small>';
  }
  elements.inspectorEmpty.hidden = Boolean(item || folder);
  elements.inspector.hidden = !item && !folder;
  if (!item && folder) return renderFolderInspector(folder);
  if (!item) return;
  const source = item.source_url
    ? `<a class="source-link" href="${escapeHtml(item.source_url)}" target="_blank" rel="noreferrer">查看来源 ↗</a>`
    : escapeHtml(item.original_name || '本地文件');
  const editing = state.editingItemId === item.id;
  const itemEntity = { ...item, entity_type: item.kind === 'note' ? 'note' : 'item' };
  const relationSection = relationListHtml(itemEntity, editing);
  const reviewWorkflow = item.status === 'review' ? `
    <section class="inspector-section review-workflow">
      <p class="inspector-label">人工复查</p>
      <label class="edit-label" for="correctedText">正文或内容校正</label>
      <textarea class="edit-textarea correction-textarea" id="correctedText" data-corrected-text placeholder="输入校正后的完整正文；重新分析会以这里的内容为依据。">${escapeHtml(item.corrected_text || '')}</textarea>
      <div class="review-actions">
        <button class="secondary-action" type="button" data-save-correction ${state.busyAction || state.backendCompatible === false ? 'disabled' : ''}>保存校正</button>
        <button class="primary-action" type="button" data-reanalyze ${state.busyAction || state.backendCompatible === false ? 'disabled' : ''}>重新分析</button>
      </div>
      <button class="approve-button" type="button" data-approve ${state.busyAction || state.backendCompatible === false || !item.summary?.trim() ? 'disabled' : ''}>批准并存入知识库</button>
      <p class="workflow-hint">音频、内容不足或提取有误时，可填写完整说明后重新分析；已有可靠摘要时可直接批准。</p>
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
      <div class="edit-relation-block">
        <p class="inspector-label">建立双向连接</p>
        ${relationBuilderHtml(relationCandidatesFor(itemEntity), itemEntity)}
      </div>
      <div class="edit-actions">
        <button class="secondary-action" type="button" data-cancel-edit>取消</button>
        <button class="primary-action" type="button" data-save-edit ${state.busyAction || state.backendCompatible === false ? 'disabled' : ''}>保存修改</button>
      </div>
      <div class="delete-item-zone">
        <div><strong>删除资料</strong><span>删除原件与阅读记录；绑定笔记会解除绑定并送入收件箱</span></div>
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
  state.boundNotebookNotes = item ? state.items.filter(value => value.kind === 'note' && linkedMaterialId(value) === item.id) : [];
  elements.anchorMarkers.innerHTML = state.notes.map(note => `<span class="anchor-dot" data-marker-id="${note.id}" hidden></span>`).join('');
  renderLinkedNotebookPopover();
  if (!item) {
    elements.notesTrack.innerHTML = '<div class="notes-empty">选择资料后即可建立阅读便签。</div>';
    return layoutNotes();
  }
  const stickyHtml = state.notes.map(note => `
    <article class="note-card" data-note-id="${note.id}">
      <div class="note-card-head">
        <button class="note-anchor-link" data-note-jump="${note.id}">${note.anchor.type === 'pdf' ? `PDF · 第 ${note.anchor.page} 页` : '正文锚点'}</button>
        <span><button class="note-convert" data-note-convert="${note.id}">转为笔记</button><button class="note-delete" data-note-delete="${note.id}" aria-label="删除便签">×</button></span>
      </div>
      <textarea data-note-content="${note.id}" placeholder="在这里记下想法…">${escapeHtml(note.content)}</textarea>
      <span class="note-saving" data-note-status="${note.id}">${note.content ? '已保存' : '空白便签'}</span>
    </article>`).join('');
  elements.notesTrack.innerHTML = stickyHtml || '<div class="notes-empty">还没有阅读便签。点击右上角“便签”，再点击正文中的位置。</div>';
  requestAnimationFrame(layoutNotes);
}

function renderLinkedNotebookPopover() {
  const item = selectedItem();
  const notes = item ? state.items.filter(value => value.kind === 'note' && linkedMaterialId(value) === item.id) : [];
  state.boundNotebookNotes = notes;
  elements.linkedNotebookCount.textContent = notes.length;
  elements.newNotebookButton.setAttribute('aria-expanded', String(state.linkedNotebookOpen));
  elements.linkedNotebookPopover.hidden = !state.linkedNotebookOpen;
  if (!state.linkedNotebookOpen) return;
  elements.linkedNotebookPopover.innerHTML = `
    <header class="linked-notebook-head"><div><span>链接笔记</span><small>${notes.length} 篇与当前资料双向链接</small></div><button type="button" data-new-linked-notebook>＋ 添加笔记</button></header>
    <div class="linked-notebook-list">${notes.length ? notes.map(note => `
      <article class="linked-notebook-row">
        <button type="button" data-preview-notebook="${note.id}" title="预览 ${escapeHtml(note.title)}"><strong>${escapeHtml(note.title)}</strong><small>${escapeHtml(note.summary || '点击查看笔记预览')}</small></button>
        <button type="button" data-edit-notebook="${note.id}" aria-label="编辑 ${escapeHtml(note.title)}">编辑</button>
      </article>`).join('') : '<p class="linked-notebook-empty">当前资料还没有链接笔记。</p>'}</div>`;
}

function setLinkedNotebookOpen(value) {
  clearTimeout(state.linkedNotebookCloseTimer);
  const next = Boolean(value && state.readingMode && selectedItem());
  if (state.linkedNotebookOpen === next) return;
  state.linkedNotebookOpen = next;
  renderLinkedNotebookPopover();
}

function bookmarkLocation(bookmark) {
  if (bookmark.anchor.type === 'pdf') return `PDF · 第 ${bookmark.anchor.page} 页`;
  return `正文 · ${Math.round(bookmark.anchor.y * 100)}%`;
}

function renderBookmarks() {
  elements.bookmarkCount.textContent = state.bookmarks.length;
  elements.bookmarkButton.setAttribute('aria-expanded', String(state.bookmarksOpen));
  elements.bookmarkPopover.hidden = !state.bookmarksOpen;
  if (!state.bookmarksOpen) return;
  elements.bookmarkPopover.innerHTML = `
    <header class="bookmark-popover-head">
      <div><span>阅读书签</span><small>${state.bookmarks.length} 个位置</small></div>
      <button type="button" data-bookmark-add>＋ 当前位置</button>
    </header>
    ${state.bookmarkNaming ? `<form class="bookmark-form" data-bookmark-form>
      <input name="name" maxlength="80" placeholder="为当前位置命名" autocomplete="off" required>
      <button type="submit">保存</button>
      <button type="button" data-bookmark-cancel>取消</button>
    </form>` : ''}
    <div class="bookmark-list">
      ${state.bookmarks.length ? state.bookmarks.map(bookmark => `<div class="bookmark-row">
        <button type="button" data-bookmark-jump="${bookmark.id}" title="跳转到 ${escapeHtml(bookmark.name)}"><span>${escapeHtml(bookmark.name)}</span><small>${bookmarkLocation(bookmark)}</small></button>
        <button type="button" data-bookmark-delete="${bookmark.id}" aria-label="删除书签 ${escapeHtml(bookmark.name)}">×</button>
      </div>`).join('') : '<div class="bookmark-empty">还没有书签。滚动到目标位置后添加。</div>'}
    </div>`;
}

function currentReadingAnchor() {
  const viewerRect = elements.viewer.getBoundingClientRect();
  const sheets = [...elements.viewer.querySelectorAll('.pdf-sheet')];
  if (sheets.length) {
    const focusY = viewerRect.top + Math.min(elements.viewer.clientHeight * .28, 180);
    const sheet = sheets.find(value => {
      const rect = value.getBoundingClientRect();
      return rect.top <= focusY && rect.bottom >= focusY;
    }) || sheets.reduce((closest, value) => {
      const distance = Math.abs(value.getBoundingClientRect().top - focusY);
      return distance < closest.distance ? { value, distance } : closest;
    }, { value: sheets[0], distance: Infinity }).value;
    const rect = sheet.getBoundingClientRect();
    return { type: 'pdf', page: Number(sheet.dataset.page), x: .5, y: Math.max(0, Math.min(1, (focusY - rect.top) / rect.height)), view: state.tab };
  }
  const scrollHeight = Math.max(1, elements.viewer.scrollHeight);
  return { type: 'document', x: .5, y: Math.max(0, Math.min(1, (elements.viewer.scrollTop + elements.viewer.clientHeight * .28) / scrollHeight)), view: state.tab };
}

async function saveReadingPosition({ immediate = false } = {}) {
  const item = selectedItem();
  if (!item || item.kind === 'note' || state.restoringReadingPosition) return;
  const position = currentReadingAnchor();
  const pdfPages = elements.viewer.querySelectorAll('.pdf-sheet').length;
  const progress = position.type === 'pdf' && pdfPages ? Math.max(0, Math.min(1, (position.page - 1 + position.y) / pdfPages)) : position.y;
  const persist = async () => {
    const current = state.items.find(value => value.id === item.id);
    if (!current) return;
    current.reading_position = position;
    current.reading_progress = progress;
    await api(`/api/items/${item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reading_position: position, reading_progress: progress }) });
  };
  clearTimeout(state.readingPositionTimer);
  if (immediate) return persist();
  state.readingPositionTimer = setTimeout(() => persist().catch(error => showToast(error.message)), 650);
}

async function restoreReadingPosition(item, token = state.renderToken) {
  const anchor = item?.reading_position;
  if (!anchor || anchor.view && anchor.view !== state.tab || token !== state.renderToken) return;
  await new Promise(resolve => requestAnimationFrame(resolve));
  if (token !== state.renderToken) return;
  state.restoringReadingPosition = true;
  if (anchor.type === 'pdf') {
    const sheet = elements.viewer.querySelector(`.pdf-sheet[data-page="${anchor.page}"]`);
    if (sheet) {
      const viewerRect = elements.viewer.getBoundingClientRect();
      const sheetRect = sheet.getBoundingClientRect();
      elements.viewer.scrollTop = Math.max(0, elements.viewer.scrollTop + sheetRect.top - viewerRect.top + anchor.y * sheetRect.height - elements.viewer.clientHeight * .28);
    }
  } else {
    elements.viewer.scrollTop = Math.max(0, anchor.y * elements.viewer.scrollHeight - elements.viewer.clientHeight * .28);
  }
  requestAnimationFrame(() => { state.restoringReadingPosition = false; state.updatePdfPage?.(); layoutNotes(); });
}

async function jumpToAnchor(anchor, { smooth = true } = {}) {
  if (anchor.view && anchor.view !== state.tab) {
    state.tab = anchor.view;
    await renderViewer();
  }
  if (anchor.type === 'pdf') {
    const sheet = elements.viewer.querySelector(`.pdf-sheet[data-page="${anchor.page}"]`);
    if (!sheet) return showToast('当前视图中找不到书签页');
    const viewerRect = elements.viewer.getBoundingClientRect();
    const sheetRect = sheet.getBoundingClientRect();
    const target = elements.viewer.scrollTop + sheetRect.top - viewerRect.top + anchor.y * sheetRect.height - elements.viewer.clientHeight * .28;
    elements.viewer.scrollTo({ top: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
    return;
  }
  elements.viewer.scrollTo({ top: Math.max(0, anchor.y * elements.viewer.scrollHeight - elements.viewer.clientHeight * .28), behavior: smooth ? 'smooth' : 'auto' });
}

async function loadNotes() {
  const item = selectedItem();
  if (!item) {
    state.notes = [];
    state.notesItemId = null;
    state.bookmarks = [];
    renderBookmarks();
    return renderNotes();
  }
  const itemId = item.id;
  if (state.notesItemId !== itemId) {
    state.notes = [];
    state.bookmarks = [];
    state.bookmarkNaming = false;
    state.pendingBookmarkAnchor = null;
    renderBookmarks();
  }
  state.notesItemId = itemId;
  try {
    const [notes, bookmarks] = await Promise.all([api(`/api/items/${itemId}/notes`), api(`/api/items/${itemId}/bookmarks`)]);
    if (state.notesItemId !== itemId || selectedItem()?.id !== itemId) return;
    state.notes = notes;
    state.bookmarks = bookmarks;
    renderBookmarks();
    renderNotes();
  } catch (error) {
    showToast(error.message);
  }
}

function setPinning(value) {
  if (value) setLinkedNotebookOpen(false);
  state.pinning = Boolean(value && state.readingMode && selectedItem());
  elements.workspace.classList.toggle('is-pinning', state.pinning);
  elements.newNoteButton.classList.toggle('is-pinning', state.pinning);
  elements.newNoteButton.textContent = state.pinning ? '取消锚定' : '＋ 新建便签';
  elements.pinHint.hidden = !state.pinning;
}

function setReadingMode(value) {
  if (state.readingMode && !value) saveReadingPosition({ immediate: true }).catch(() => {});
  state.readingMode = Boolean(value && selectedItem());
  elements.workspace.classList.toggle('is-reading', state.readingMode);
  elements.readingToggle.setAttribute('aria-pressed', String(state.readingMode));
  elements.readingToggle.innerHTML = state.readingMode ? '<span>□</span> 退出阅读' : '<span>▣</span> 阅读模式';
  setPinning(false);
  setLinkedNotebookOpen(false);
  if (!state.readingMode) {
    state.bookmarksOpen = false;
    state.bookmarkNaming = false;
    state.pendingBookmarkAnchor = null;
    renderBookmarks();
  }
  renderInspector();
  if (state.readingMode) loadNotes();
  else updateNoteLines();
  requestAnimationFrame(layoutNotes);
}

function jumpToNote(note) {
  jumpToAnchor(note.anchor);
}

async function deleteBookmark(bookmarkId) {
  const item = selectedItem();
  if (!item || !window.confirm('删除这个书签？')) return;
  await api(`/api/items/${item.id}/bookmarks/${bookmarkId}`, { method: 'DELETE' });
  state.bookmarks = state.bookmarks.filter(bookmark => bookmark.id !== bookmarkId);
  renderBookmarks();
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

function showNoteNameDialog(options) {
  state.pendingNoteCreate = options;
  elements.noteNameInput.value = '';
  elements.noteNameHelp.textContent = options.type === 'linked' ? '笔记将与当前资料建立双向链接，并保存在同一文件夹。' : options.type === 'folder' ? `笔记将直接保存在 Library / ${options.category}。` : '笔记将先保存在临时笔记区，由你决定何时送入收件箱。';
  elements.noteNameDialog.hidden = false;
  requestAnimationFrame(() => elements.noteNameInput.focus());
}

function closeNoteNameDialog() {
  elements.noteNameDialog.hidden = true;
  state.pendingNoteCreate = null;
}

async function createNamedNote(title) {
  const options = state.pendingNoteCreate;
  if (!options) return;
  const endpoint = options.type === 'temporary' ? '/api/notebook/temporary' : '/api/notebook/notes';
  const payload = options.type === 'temporary' ? { title } : { title, category: options.category, bound_item_id: options.boundItemId };
  const note = await api(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  closeNoteNameDialog();
  setLinkedNotebookOpen(false);
  if (options.type === 'temporary') state.temporaryNotes.unshift(note);
  else {
    state.items.unshift(note);
    state.relations = await api('/api/relations');
  }
  renderNavigation();
  renderList();
  if (state.readingMode) renderNotes();
  await openNotebook(note.id, { mode: 'edit' });
}

function notebookEditorHtml(note, content, { close = true } = {}) {
  const temporary = note.state === 'temporary';
  return `<header class="notebook-pane-head"><div><strong>${temporary ? '临时笔记' : linkedMaterialId(note) ? '链接笔记' : '知识笔记'}</strong><small>${temporary ? '自动保存于本地草稿区' : escapeHtml(note.category || '')}</small></div><div class="notebook-head-actions">
    ${temporary ? '<button type="button" data-notebook-submit>送入收件箱</button>' : `<a href="/api/notebook/notes/${note.id}/export/markdown">导出 MD 包</a><a href="/api/notebook/notes/${note.id}/export/pdf" target="_blank">导出 PDF</a>`}
    ${close ? '<button type="button" data-notebook-close>关闭</button>' : ''}
  </div></header><div class="notebook-editor-wrap">
    <input class="notebook-title-input" data-notebook-title maxlength="80" value="${escapeHtml(note.title)}" aria-label="笔记标题">
    <div class="notebook-toolbar" role="toolbar" aria-label="Markdown 格式工具">
      <span class="notebook-tool-group"><button type="button" data-editor-command="undo" title="撤销 Ctrl+Z">↶</button><button type="button" data-editor-command="redo" title="重做 Ctrl+Y">↷</button><button type="button" data-editor-command="search" title="查找与替换 Ctrl+F">查找</button></span>
      <span class="notebook-tool-group"><button type="button" data-editor-command="heading-2" title="二级标题 Ctrl+Alt+2">H2</button><button type="button" data-editor-command="bold" title="粗体 Ctrl+B"><strong>B</strong></button><button type="button" data-editor-command="italic" title="斜体 Ctrl+I"><em>I</em></button><button type="button" data-editor-command="link" title="链接 Ctrl+Shift+K">链接</button></span>
      <span class="notebook-tool-group"><button type="button" data-editor-command="task">任务</button><button type="button" data-editor-command="table">表格</button><button type="button" data-editor-command="code-block">代码</button><button type="button" data-editor-command="math">公式</button></span>
      <button class="notebook-outline-toggle" type="button" data-notebook-outline-toggle aria-expanded="false">大纲</button>
    </div>
    <div class="notebook-editor-stage"><div class="notebook-editor" data-notebook-editor></div><aside class="notebook-outline" data-notebook-outline hidden><header>文档大纲</header><nav data-notebook-outline-list></nav></aside></div>
    <span class="notebook-save-status" data-notebook-save-status>已保存 · Markdown 真源</span>
  </div>`;
}

function notebookPreviewHtml(note, content, { close = false, edit = false } = {}) {
  return `<header class="notebook-pane-head"><div><strong>${escapeHtml(note.title || 'Markdown 预览')}</strong><small>${linkedMaterialId(note) ? '与原资料双向链接' : 'Markdown 预览 · 图片随笔记保存在本地'}</small></div><div class="notebook-head-actions">${edit ? '<button type="button" data-notebook-edit>编辑</button>' : ''}${close ? '<button type="button" data-notebook-close>关闭</button>' : ''}</div></header><div class="notebook-preview"><article>${renderMarkdownHtml(content, { assetUrl: name => `/api/notebook/notes/${note.id}/assets/${encodeURIComponent(name)}` }) || '<p>这篇笔记还没有正文。</p>'}</article></div>`;
}

function renderNotebookOutline(outline = []) {
  const list = elements.notebookWorkspace.querySelector('[data-notebook-outline-list]');
  if (!list) return;
  list.innerHTML = outline.length
    ? outline.map(item => `<button type="button" data-outline-offset="${item.from}" style="--outline-level:${item.level}">${escapeHtml(item.text)}</button>`).join('')
    : '<p>添加标题后会在这里形成大纲。</p>';
}

function renderNotebookPreview() {
  if (!state.activeNotebook) return;
  const html = renderMarkdownHtml(state.notebookContent, { assetUrl: name => `/api/notebook/notes/${state.activeNotebook.id}/assets/${encodeURIComponent(name)}` }) || '<p>开始书写后，这里会实时显示排版结果。</p>';
  for (const preview of elements.notebookWorkspace.querySelectorAll('.notebook-preview article')) {
    preview.innerHTML = html;
    renderMathIn(preview);
  }
}

function mountNotebookEditor() {
  state.notebookEditor?.destroy();
  const parent = elements.notebookWorkspace.querySelector('[data-notebook-editor]');
  if (!parent) { state.notebookEditor = null; return; }
  state.notebookEditor = createMarkdownEditor({
    parent,
    value: state.notebookContent,
    onChange(content) {
      state.notebookContent = content;
      renderNotebookPreview();
      scheduleNotebookSave();
    },
    onOutlineChange: renderNotebookOutline,
    onPasteImage: uploadNotebookImage,
  });
}

async function renderNotebookWorkspace() {
  const active = state.activeNotebook;
  if (!active) { elements.notebookWorkspace.hidden = true; return; }
  elements.notebookWorkspace.hidden = false;
  if (linkedMaterialId(active)) {
    const source = state.items.find(item => item.id === linkedMaterialId(active));
    const editActions = state.notebookMode === 'edit' ? '<button type="button" data-notebook-toggle-preview>预览笔记</button>' : '';
    elements.notebookLeft.innerHTML = `<header class="notebook-pane-head"><div><strong>${escapeHtml(source?.title || '原资料')}</strong><small>资料与笔记双向链接 · 保留当前阅读位置</small></div><div class="notebook-head-actions">${editActions}<button type="button" data-notebook-close>关闭</button></div></header><div class="notebook-source-host"></div><div class="notebook-preview notebook-source-preview" hidden><article>${renderMarkdownHtml(state.notebookContent, { assetUrl: name => `/api/notebook/notes/${active.id}/assets/${encodeURIComponent(name)}` }) || '<p>这篇笔记还没有正文。</p>'}</article></div>`;
    if (!state.notebookReaderPlaceholder) {
      state.notebookReaderPlaceholder = document.createComment('infobox-reader-position');
      elements.reader.before(state.notebookReaderPlaceholder);
    }
    elements.notebookLeft.querySelector('.notebook-source-host').append(elements.reader);
    elements.reader.classList.add('notebook-embedded-reader');
    elements.notebookRight.innerHTML = state.notebookMode === 'preview'
      ? notebookPreviewHtml(active, state.notebookContent, { edit: true })
      : notebookEditorHtml(active, state.notebookContent, { close: false });
    await restoreReadingPosition(source);
  } else {
    elements.notebookLeft.innerHTML = notebookEditorHtml(active, state.notebookContent);
    elements.notebookRight.innerHTML = notebookPreviewHtml(active, state.notebookContent);
  }
  if (state.notebookMode === 'edit') mountNotebookEditor();
  else { state.notebookEditor?.destroy(); state.notebookEditor = null; }
  renderNotebookPreview();
}

async function toggleNotebookSourcePreview() {
  if (!linkedMaterialId(state.activeNotebook) || state.notebookMode !== 'edit') return;
  if (!state.notebookPreview) await saveReadingPosition({ immediate: true });
  state.notebookPreview = !state.notebookPreview;
  const source = elements.notebookLeft.querySelector('.notebook-source-host');
  const preview = elements.notebookLeft.querySelector('.notebook-source-preview');
  const button = elements.notebookLeft.querySelector('[data-notebook-toggle-preview]');
  if (source) source.hidden = state.notebookPreview;
  if (preview) {
    preview.hidden = !state.notebookPreview;
    preview.querySelector('article').innerHTML = renderMarkdownHtml(state.notebookContent, { assetUrl: name => `/api/notebook/notes/${state.activeNotebook.id}/assets/${encodeURIComponent(name)}` }) || '<p>开始书写后，这里会显示排版结果。</p>';
    renderMathIn(preview);
  }
  if (button) button.textContent = state.notebookPreview ? '返回原资料' : '预览笔记';
  if (!state.notebookPreview) await restoreReadingPosition(selectedItem());
}

async function editActiveNotebook() {
  if (!state.activeNotebook) return;
  state.notebookMode = 'edit';
  state.notebookPreview = false;
  await renderNotebookWorkspace();
  requestAnimationFrame(() => state.notebookEditor?.focus());
}

async function openNotebook(id, { mode = 'edit' } = {}) {
  try {
    const record = await api(`/api/notebook/notes/${id}`);
    const materialId = linkedMaterialId(record.note);
    if (materialId) {
      const source = state.items.find(item => item.id === materialId);
      if (!source) throw new Error('链接的原资料暂时不可用');
      if (selectedItem()?.id === source.id) await saveReadingPosition({ immediate: true });
      else {
        state.selectedId = source.id;
        state.tab = source.reading_position?.view || 'asset';
        state.graphMode = false;
        setGraphMode(false);
        renderList();
        renderInspector();
        await renderViewer();
      }
    }
    state.activeNotebook = record.note;
    state.notebookContent = record.content || '';
    state.notebookMode = mode === 'preview' ? 'preview' : 'edit';
    state.notebookPreview = false;
    await renderNotebookWorkspace();
    if (state.notebookMode === 'edit') requestAnimationFrame(() => state.notebookEditor?.focus());
  } catch (error) { showToast(error.message); }
}

async function closeNotebook() {
  clearTimeout(state.notebookSaveTimer);
  if (state.activeNotebook && state.notebookMode === 'edit') {
    try { await persistActiveNotebook(); }
    catch (error) { showToast(error.message); return; }
  }
  if (linkedMaterialId(state.activeNotebook)) await saveReadingPosition({ immediate: true }).catch(error => showToast(error.message));
  if (state.notebookReaderPlaceholder?.isConnected) state.notebookReaderPlaceholder.replaceWith(elements.reader);
  elements.reader.classList.remove('notebook-embedded-reader');
  await restoreReadingPosition(selectedItem());
  state.notebookReaderPlaceholder = null;
  state.notebookEditor?.destroy();
  state.notebookEditor = null;
  state.activeNotebook = null;
  state.notebookContent = '';
  state.notebookMode = 'edit';
  state.notebookPreview = false;
  elements.notebookWorkspace.hidden = true;
  renderNavigation();
  renderList();
  renderInspector();
  if (state.readingMode) renderNotes();
  if (state.graphMode) renderGraph();
}

async function persistActiveNotebook() {
  if (!state.activeNotebook || state.notebookMode !== 'edit') return;
  const noteId = state.activeNotebook.id;
  const save = async () => {
    if (state.activeNotebook?.id !== noteId) return;
    const status = elements.notebookWorkspace.querySelector('[data-notebook-save-status]');
    if (status) status.textContent = '保存中…';
    const title = elements.notebookWorkspace.querySelector('[data-notebook-title]')?.value.trim() || '未命名笔记';
    const content = state.notebookEditor?.getValue() ?? state.notebookContent;
    const saved = await api(`/api/notebook/notes/${noteId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, content, ...(state.activeNotebook.vault_revision ? { expected_revision: state.activeNotebook.vault_revision } : {}) }),
    });
    if (state.activeNotebook?.id !== noteId) return saved;
    state.activeNotebook = { ...state.activeNotebook, ...saved, title };
    state.notebookContent = content;
    const item = state.items.find(value => value.id === noteId);
    if (item) Object.assign(item, state.activeNotebook);
    const temporary = state.temporaryNotes.find(value => value.id === noteId);
    if (temporary) Object.assign(temporary, state.activeNotebook);
    const currentStatus = elements.notebookWorkspace.querySelector('[data-notebook-save-status]');
    if (currentStatus) currentStatus.textContent = '已保存 · Markdown 真源 · 可粘贴图片';
    renderNotebookPreview();
    return saved;
  };
  const previous = state.notebookSaveChain || Promise.resolve();
  const queued = previous.catch(() => {}).then(save);
  state.notebookSaveChain = queued;
  try { return await queued; }
  finally { if (state.notebookSaveChain === queued) state.notebookSaveChain = null; }
}

function scheduleNotebookSave() {
  clearTimeout(state.notebookSaveTimer);
  const status = elements.notebookWorkspace.querySelector('[data-notebook-save-status]');
  if (status) status.textContent = '保存中…';
  state.notebookSaveTimer = setTimeout(() => persistActiveNotebook().catch(error => { if (status) status.textContent = '保存失败'; showToast(error.message); }), 450);
}

async function uploadNotebookImage(file) {
  if (!file || !state.activeNotebook) return '';
  try {
    const response = await fetch(`/api/notebook/notes/${state.activeNotebook.id}/assets?filename=${encodeURIComponent(file.name || `image-${Date.now()}.png`)}`, { method: 'POST', body: file });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '图片保存失败');
    const asset = await response.json();
    showToast('图片已保存到笔记资料包');
    return asset.markdown;
  } catch (error) { showToast(error.message); }
  return '';
}

async function submitActiveNotebook() {
  if (!state.activeNotebook || state.activeNotebook.state !== 'temporary') return;
  try {
    clearTimeout(state.notebookSaveTimer);
    await persistActiveNotebook();
    await api(`/api/notebook/notes/${state.activeNotebook.id}/submit`, { method: 'POST' });
    showToast('笔记已送入收件箱，等待手动分类');
    await closeNotebook();
    const [inboxFiles, temporaryNotes] = await Promise.all([
      api('/api/inbox'),
      api('/api/notebook/temporary')
    ]);
    state.inboxFiles = inboxFiles;
    state.temporaryNotes = temporaryNotes;
    state.scope = 'inbox';
    render();
  } catch (error) { showToast(error.message); }
}

async function convertSticky(noteId) {
  const item = selectedItem();
  const sticky = state.notes.find(note => note.id === noteId);
  if (!item || !sticky) return;
  const title = window.prompt('给这篇笔记命名：', sticky.content.trim().slice(0, 30) || '阅读笔记');
  if (!title?.trim()) return;
  try {
    const note = await api(`/api/items/${item.id}/notes/${noteId}/convert`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
    state.notes = state.notes.filter(value => value.id !== noteId);
    state.items.unshift(note);
    state.relations = await api('/api/relations');
    renderNotes();
    await openNotebook(note.id);
  } catch (error) { showToast(error.message); }
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
  const entity = selectedItem() || selectedFolderRecord();
  const targetId = elements.inspector.querySelector('[data-relation-confirm]')?.dataset.relationSelected;
  const type = elements.inspector.querySelector('#relationType')?.value;
  if (!entity || !targetId) return showToast('请选择要连接的节点');
  try {
    await api('/api/relations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source_id: entity.id, target_id: targetId, type }) });
    await load({ quiet: true });
    if (state.readingMode) renderNotes();
    showToast(type === 'belongs_to' ? '笔记所属关系已建立' : '双向连接已建立');
  } catch (error) { showToast(error.message); }
}

async function deleteRelation(id) {
  try {
    await api(`/api/relations/${id}`, { method: 'DELETE' });
    await load({ quiet: true });
    if (state.readingMode) renderNotes();
  } catch (error) { showToast(error.message); }
}

async function saveFolderEdits() {
  const folder = selectedFolderRecord();
  if (!folder || state.busyAction) return;
  const summary = elements.inspector.querySelector('#editFolderSummary')?.value || '';
  const tags = (elements.inspector.querySelector('#editFolderTags')?.value || '').split(/[,，、\n]/).map(tag => tag.trim()).filter(Boolean);
  state.busyAction = true;
  try {
    const updated = await api(`/api/library/folder-records/${folder.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ summary, tags }),
    });
    Object.assign(folder, updated);
    state.editingFolderId = null;
    renderInspector();
    if (state.graphMode) renderGraph();
    showToast('文件夹资料已保存');
  } catch (error) { showToast(error.message); }
  finally { state.busyAction = false; }
}

async function saveItemEdits() {
  const item = selectedItem();
  if (!item || state.busyAction) return;
  const title = elements.inspector.querySelector('#editTitle')?.value.trim();
  const summary = elements.inspector.querySelector('#editSummary')?.value || '';
  const tags = (elements.inspector.querySelector('#editTags')?.value || '').split(/[,，、\n]/).map(tag => tag.trim()).filter(Boolean);
  if (!title) return showToast('标题不能为空');
  state.busyAction = true;
  try {
    await api(`/api/items/${item.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, summary, tags }),
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

async function createFolder(parent = state.creatingFolderParent || '') {
  const input = elements.tree.querySelector('[data-folder-name]');
  const name = input?.value.trim() || '';
  if (!name) return showToast('请输入文件夹名称');
  try {
    const folder = await api('/api/library/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, parent }) });
    state.creatingFolderParent = null;
    await load({ quiet: true });
    state.scope = 'category';
    state.category = folder.path;
    state.selectedFolderId = folder.id || folderRecordByPath(folder.path)?.id || null;
    setGraphMode(false);
    render();
    pushNavigation();
    showToast(`已创建文件夹：${folder.path}`);
  } catch (error) { showToast(error.message); }
}

function closeUrlImportDialog() {
  if (state.importingUrls) return;
  elements.urlImportDialog.hidden = true;
  elements.urlImportInput.value = '';
  elements.urlImportFeedback.textContent = '最多 50 个 HTTP(S) 网址';
  elements.urlImportFeedback.classList.remove('is-error');
}

function openUrlImportDialog() {
  state.libraryCreateMenuOpen = false;
  renderNavigation();
  elements.urlImportDialog.hidden = false;
  requestAnimationFrame(() => elements.urlImportInput.focus());
}

function readImportUrls() {
  const lines = elements.urlImportInput.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const urls = [];
  const invalid = [];
  for (const [index, raw] of lines.entries()) {
    try {
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
      if (!urls.includes(url.toString())) urls.push(url.toString());
    } catch { invalid.push(index + 1); }
  }
  if (!lines.length) throw new Error('请至少粘贴一个网址');
  if (invalid.length) throw new Error(`第 ${invalid.join('、')} 行不是有效的 HTTP(S) 网址`);
  if (urls.length > 50) throw new Error('一次最多导入 50 个网址');
  return urls;
}

async function importUrlsToInbox() {
  if (state.importingUrls) return;
  let urls;
  try { urls = readImportUrls(); }
  catch (error) {
    elements.urlImportFeedback.textContent = error.message;
    elements.urlImportFeedback.classList.add('is-error');
    return;
  }
  state.importingUrls = true;
  elements.urlImportSubmit.disabled = true;
  elements.urlImportInput.disabled = true;
  elements.urlImportSubmit.textContent = '正在加入…';
  elements.urlImportFeedback.classList.remove('is-error');
  elements.urlImportFeedback.textContent = `正在加入 ${urls.length} 个网址`;
  try {
    const result = await api('/api/inbox/urls?defer=1', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ urls }),
    });
    elements.urlImportDialog.hidden = true;
    elements.urlImportInput.value = '';
    state.scope = 'inbox';
    state.category = '';
    state.selectedId = null;
    setGraphMode(false);
    await load({ quiet: true });
    render();
    pushNavigation();
    showToast(`${result.files.length} 个网址已加入收件箱`);
  } catch (error) {
    elements.urlImportFeedback.textContent = error.message;
    elements.urlImportFeedback.classList.add('is-error');
  } finally {
    state.importingUrls = false;
    elements.urlImportSubmit.disabled = false;
    elements.urlImportInput.disabled = false;
    elements.urlImportSubmit.textContent = '加入收件箱';
  }
}

async function deleteLibraryItemById(itemId) {
  const item = state.items.find(value => value.id === itemId);
  if (!item || state.busyAction) return;
  const message = item.kind === 'note'
    ? `确定将笔记“${item.title}”移入回收站吗？`
    : `确定将“${item.title}”移入回收站吗？原件和阅读记录会一并移入；绑定笔记会解除绑定并送入收件箱。`;
  if (!window.confirm(message)) return;
  state.busyAction = true;
  if (state.selectedId === item.id) renderInspector();
  try {
    await api(`/api/items/${item.id}`, { method: 'DELETE' });
    state.editingItemId = null;
    if (state.selectedId === item.id) state.selectedId = null;
    await load({ quiet: true });
    showToast('已移入回收站');
  } catch (error) {
    showToast(error.message);
  } finally {
    state.busyAction = false;
    renderInspector();
  }
}

async function deleteLibraryItem() {
  const item = selectedItem();
  if (item) await deleteLibraryItemById(item.id);
}

async function deleteTemporaryNote(noteId) {
  const note = state.temporaryNotes.find(value => value.id === noteId);
  if (!note || state.busyAction) return;
  if (!window.confirm(`确定将临时笔记“${note.title}”移入回收站吗？`)) return;
  state.busyAction = true;
  try {
    await api(`/api/notebook/notes/${note.id}`, { method: 'DELETE' });
    await load({ quiet: true });
    showToast('临时笔记已移入回收站');
  } catch (error) {
    showToast(error.message);
  } finally {
    state.busyAction = false;
  }
}

async function deleteLibraryFolder(path) {
  const folder = findFolderNode(path);
  if (!folder || state.busyAction) return;
  const details = [folder.count ? `${folder.count} 项资料` : '', folder.children?.length ? `${folder.children.length} 个直接子文件夹` : ''].filter(Boolean).join('、');
  const message = `确定将文件夹“${folder.name}”${details ? `及其中的${details}` : ''}移入回收站吗？`;
  if (!window.confirm(message)) return;
  state.busyAction = true;
  try {
    await api(`/api/library/folders?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    for (const collapsed of [...state.collapsedFolders]) {
      if (collapsed === path || collapsed.startsWith(`${path}/`)) state.collapsedFolders.delete(collapsed);
    }
    state.selectedId = null;
    await load({ quiet: true });
    showToast('文件夹已移入回收站');
  } catch (error) {
    showToast(error.message);
  } finally {
    state.busyAction = false;
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
    const [healthResult, itemsResult, treeResult, folderRecordsResult, inboxResult, viewsResult, relationsResult, historyResult, temporaryNotesResult] = await Promise.allSettled([api('/health'), api('/api/items'), api('/api/library/tree'), api('/api/library/folder-records'), api('/api/inbox'), api('/api/views'), api('/api/relations'), api('/api/restructure/history'), api('/api/notebook/temporary')]);
    if (itemsResult.status === 'rejected') throw itemsResult.reason;
    if (treeResult.status === 'rejected') throw treeResult.reason;
    state.items = itemsResult.value;
    state.tree = treeResult.value;
    state.folderRecords = folderRecordsResult.status === 'fulfilled' ? folderRecordsResult.value : [];
    initializeCollapsedFolders();
    state.backendCompatible = healthResult.status === 'fulfilled' && Number(healthResult.value.api_version) >= 13;
    state.inboxAvailable = state.backendCompatible && inboxResult.status === 'fulfilled';
    state.inboxFiles = state.inboxAvailable ? inboxResult.value : [];
    state.savedViews = viewsResult.status === 'fulfilled' ? viewsResult.value : [];
    state.relations = relationsResult.status === 'fulfilled' ? relationsResult.value : [];
    state.restructureHistory = historyResult.status === 'fulfilled' ? historyResult.value : [];
    state.temporaryNotes = temporaryNotesResult.status === 'fulfilled' ? temporaryNotesResult.value : [];
    elements.statusDot.className = 'status-dot is-online';
    elements.connectionStatus.textContent = state.inboxAvailable ? `${state.items.length} 项资料 · 本地连接正常` : `${state.items.length} 项资料 · 后台需要重启`;
    render();
    setGraphMode(state.graphMode);
    renderFilterPanel();
    if (!elements.rollbackPanel.hidden) renderRollbackHistory();
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

document.addEventListener('click', async event => {
  if (state.libraryCreateMenuOpen && !event.target.closest('[data-library-create-toggle], .library-create-menu')) {
    state.libraryCreateMenuOpen = false;
    elements.tree.querySelector('.library-create-menu')?.remove();
    elements.tree.querySelector('[data-library-create-toggle]')?.setAttribute('aria-expanded', 'false');
  }
  const undoStructure = event.target.closest('[data-undo-restructure]');
  if (undoStructure) { undoRestructure(undoStructure.dataset.undoRestructure); return; }
  const restructureFolder = event.target.closest('[data-restructure-folder]');
  if (restructureFolder) {
    event.preventDefault(); event.stopPropagation();
    const path = restructureFolder.dataset.restructureFolder ?? '';
    const selection = structureSelectionState(path);
    if (selection.locked) return;
    if (state.selectedStructureFolders.has(path)) state.selectedStructureFolders.delete(path);
    else {
      state.selectedStructureFolders.add(path);
      for (const selected of [...state.selectedStructureFolders]) if (selected !== path && selected.startsWith(`${path}/`)) state.selectedStructureFolders.delete(selected);
    }
    renderNavigation();
    return;
  }
  const newFolder = event.target.closest('[data-new-folder-parent]');
  if (newFolder) {
    state.creatingFolderParent = newFolder.dataset.newFolderParent;
    state.collapsedFolders.delete(state.creatingFolderParent);
    renderNavigation();
    requestAnimationFrame(() => elements.tree.querySelector('[data-folder-name]')?.focus());
    return;
  }
  const folderNote = event.target.closest('[data-new-note-category]');
  if (folderNote) { event.stopPropagation(); showNoteNameDialog({ type: 'folder', category: folderNote.dataset.newNoteCategory }); return; }
  if (event.target.closest('[data-new-temporary-note]')) {
    state.libraryCreateMenuOpen = false;
    showNoteNameDialog({ type: 'temporary' });
    return;
  }
  if (event.target.closest('[data-library-create-toggle]')) {
    state.libraryCreateMenuOpen = !state.libraryCreateMenuOpen;
    renderNavigation();
    return;
  }
  if (event.target.closest('[data-library-create-folder]')) {
    state.libraryCreateMenuOpen = false;
    state.creatingFolderParent = '';
    state.collapsedFolders.delete('');
    renderNavigation();
    requestAnimationFrame(() => elements.tree.querySelector('[data-folder-name]')?.focus());
    return;
  }
  if (event.target.closest('[data-library-import-urls]')) { openUrlImportDialog(); return; }
  const folderCreate = event.target.closest('[data-folder-create]');
  if (folderCreate) { createFolder(folderCreate.dataset.parent || ''); return; }
  if (event.target.closest('[data-folder-cancel]')) {
    state.creatingFolderParent = null;
    renderNavigation();
    return;
  }
  const deleteTemporary = event.target.closest('[data-delete-temporary-note]');
  if (deleteTemporary) {
    event.stopPropagation();
    await deleteTemporaryNote(deleteTemporary.dataset.deleteTemporaryNote);
    return;
  }
  const deleteListItem = event.target.closest('[data-delete-list-item]');
  if (deleteListItem) {
    event.stopPropagation();
    await deleteLibraryItemById(deleteListItem.dataset.deleteListItem);
    return;
  }
  const deleteListFolder = event.target.closest('[data-delete-list-folder]');
  if (deleteListFolder) {
    event.stopPropagation();
    await deleteLibraryFolder(deleteListFolder.dataset.deleteListFolder);
    return;
  }
  const moveItem = event.target.closest('[data-move-item]');
  if (moveItem) {
    event.stopPropagation();
    const item = state.items.find(value => value.id === moveItem.dataset.moveItem);
    if (item) openMoveMenu({ type: 'item', id: item.id, title: item.title }, moveItem);
    return;
  }
  const moveFolderButton = event.target.closest('[data-move-folder]');
  if (moveFolderButton) {
    event.stopPropagation();
    openMoveMenu({ type: 'folder', path: moveFolderButton.dataset.moveFolder }, moveFolderButton);
    return;
  }
  const moveDestination = event.target.closest('[data-move-destination]');
  if (moveDestination) {
    performMove(moveDestination.dataset.moveDestination);
    return;
  }
  if (!event.target.closest('#movePopover')) closeMoveMenu();
  const folderFilterToggle = event.target.closest('#folderFilterButton');
  if (folderFilterToggle) {
    event.stopPropagation();
    if (elements.folderFilterPopover.hidden) openFolderFilterMenu();
    else closeFolderFilterMenu();
    return;
  }
  const filterFolder = event.target.closest('[data-filter-folder]');
  if (filterFolder) {
    elements.folderFilter.value = filterFolder.dataset.filterFolder;
    elements.folderFilterSelection.textContent = filterFolder.dataset.filterFolder ? `Library / ${filterFolder.dataset.filterFolder}` : 'Library';
    closeFolderFilterMenu();
    return;
  }
  if (!event.target.closest('#folderFilterPopover')) closeFolderFilterMenu();
  const openFolder = event.target.closest('[data-open-folder]');
  if (openFolder) {
    state.scope = 'category';
    state.category = openFolder.dataset.openFolder;
    state.selectedId = null;
    state.selectedFolderId = folderRecordByPath(state.category)?.id || null;
    state.editingItemId = null;
    setGraphMode(false);
    render();
    pushNavigation();
    return;
  }
  const relationCascadeToggle = event.target.closest('[data-relation-cascade-toggle]');
  if (relationCascadeToggle) {
    closeMoveMenu();
    closeFolderFilterMenu();
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
    const typeSelect = cascade?.querySelector('#relationType');
    const popover = cascade?.querySelector('[data-relation-cascade-popover]');
    if (selection) { selection.textContent = relationTarget.dataset.relationTitle; selection.title = relationTarget.dataset.relationTitle; }
    if (confirm) {
      confirm.dataset.relationSelected = relationTarget.dataset.relationTarget;
      confirm.dataset.relationTargetKind = relationTarget.dataset.relationKind;
      confirm.hidden = false;
    }
    if (typeSelect) {
      const source = selectedItem() || selectedFolderRecord();
      const sourceKind = source?.kind === 'note' ? 'note' : source?.path != null ? 'folder' : 'item';
      const targetKind = relationTarget.dataset.relationKind;
      const allowBelongs = (sourceKind === 'note' && targetKind === 'item') || (sourceKind === 'item' && targetKind === 'note');
      const option = typeSelect.querySelector('option[value="belongs_to"]');
      if (option) { option.hidden = !allowBelongs; option.disabled = !allowBelongs; }
      if (!allowBelongs && typeSelect.value === 'belongs_to') typeSelect.value = 'related';
    }
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
  if (event.target.closest('[data-edit-folder]')) {
    const folder = selectedFolderRecord();
    if (folder) state.editingFolderId = state.editingFolderId === folder.id ? null : folder.id;
    renderInspector();
    return;
  }
  if (event.target.closest('[data-cancel-folder-edit]')) {
    state.editingFolderId = null;
    renderInspector();
    return;
  }
  if (event.target.closest('[data-save-folder]')) {
    saveFolderEdits();
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
    if (state.readingMode) setReadingMode(false);
    state.scope = nav.dataset.scope;
    state.category = '';
    state.selectedId = null;
    state.selectedFolderId = null;
    state.editingItemId = null;
    setGraphMode(false);
    render();
    pushNavigation();
    return;
  }
  const category = event.target.closest('[data-category]');
  if (category) {
    if (state.readingMode) setReadingMode(false);
    state.scope = 'category';
    state.category = category.dataset.category;
    state.selectedId = null;
    state.selectedFolderId = folderRecordByPath(state.category)?.id || null;
    state.editingItemId = null;
    setGraphMode(false);
    render();
    pushNavigation();
    return;
  }
  const row = event.target.closest('[data-id]');
  if (row) {
    const chosen = state.items.find(item => item.id === row.dataset.id);
    if (chosen?.kind === 'note') { openNotebook(chosen.id); return; }
    await saveReadingPosition({ immediate: true }).catch(() => {});
    state.selectedId = row.dataset.id;
    state.selectedFolderId = null;
    state.tab = chosen?.reading_position?.view || 'asset';
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
    await saveReadingPosition({ immediate: true }).catch(() => {});
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
  const notebookOpen = event.target.closest('[data-open-notebook]');
  if (notebookOpen) { openNotebook(notebookOpen.dataset.openNotebook); return; }
  const noteConvert = event.target.closest('[data-note-convert]');
  if (noteConvert) { event.stopPropagation(); convertSticky(noteConvert.dataset.noteConvert); return; }
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
elements.urlImportSubmit.addEventListener('click', importUrlsToInbox);
elements.urlImportDialog.addEventListener('click', event => {
  if (event.target === elements.urlImportDialog || event.target.closest('[data-url-import-cancel]')) closeUrlImportDialog();
});
elements.urlImportInput.addEventListener('input', () => {
  elements.urlImportFeedback.textContent = '最多 50 个 HTTP(S) 网址';
  elements.urlImportFeedback.classList.remove('is-error');
});
elements.urlImportInput.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') importUrlsToInbox();
});
elements.noteNameForm.addEventListener('submit', event => {
  event.preventDefault();
  const title = elements.noteNameInput.value.trim();
  if (title) createNamedNote(title).catch(error => showToast(error.message));
});
elements.noteNameDialog.addEventListener('click', event => {
  if (event.target === elements.noteNameDialog || event.target.closest('[data-note-name-cancel]')) { closeNoteNameDialog(); setLinkedNotebookOpen(false); }
});
elements.notebookWorkspace.addEventListener('input', event => {
  if (event.target.matches('[data-notebook-title]')) scheduleNotebookSave();
});
elements.notebookWorkspace.addEventListener('click', async event => {
  if (event.target.closest('[data-notebook-close]')) return closeNotebook();
  if (event.target.closest('[data-notebook-submit]')) return submitActiveNotebook();
  if (event.target.closest('[data-notebook-edit]')) return editActiveNotebook();
  const command = event.target.closest('[data-editor-command]')?.dataset.editorCommand;
  if (command) { state.notebookEditor?.run(command); return; }
  const outlineOffset = event.target.closest('[data-outline-offset]')?.dataset.outlineOffset;
  if (outlineOffset !== undefined) { state.notebookEditor?.goToOffset(Number(outlineOffset)); return; }
  if (event.target.closest('[data-notebook-outline-toggle]')) {
    const outline = elements.notebookWorkspace.querySelector('[data-notebook-outline]');
    const button = event.target.closest('[data-notebook-outline-toggle]');
    if (outline) {
      outline.hidden = !outline.hidden;
      button.setAttribute('aria-expanded', String(!outline.hidden));
      button.classList.toggle('is-active', !outline.hidden);
    }
    return;
  }
  if (event.target.closest('[data-notebook-toggle-preview]')) {
    toggleNotebookSourcePreview();
    return;
  }
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!elements.urlImportDialog.hidden) closeUrlImportDialog();
  if (!elements.noteNameDialog.hidden) { closeNoteNameDialog(); setLinkedNotebookOpen(false); }
  if (state.linkedNotebookOpen) setLinkedNotebookOpen(false);
  if (state.bookmarksOpen) {
    state.bookmarksOpen = false;
    state.bookmarkNaming = false;
    state.pendingBookmarkAnchor = null;
    renderBookmarks();
  }
});
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
elements.newNotebookButton.addEventListener('click', () => {
  setPinning(false);
  setLinkedNotebookOpen(true);
});
elements.linkedNotebookMenu.addEventListener('mouseenter', () => setLinkedNotebookOpen(true));
elements.linkedNotebookMenu.addEventListener('mouseleave', () => {
  clearTimeout(state.linkedNotebookCloseTimer);
  state.linkedNotebookCloseTimer = setTimeout(() => {
    if (elements.linkedNotebookMenu.matches(':hover') || elements.linkedNotebookMenu.contains(document.activeElement)) return;
    setLinkedNotebookOpen(false);
  }, 240);
});
elements.linkedNotebookMenu.addEventListener('focusin', () => setLinkedNotebookOpen(true));
elements.linkedNotebookMenu.addEventListener('focusout', () => {
  clearTimeout(state.linkedNotebookCloseTimer);
  state.linkedNotebookCloseTimer = setTimeout(() => {
    if (elements.linkedNotebookMenu.matches(':hover') || elements.linkedNotebookMenu.contains(document.activeElement)) return;
    setLinkedNotebookOpen(false);
  }, 240);
});
elements.linkedNotebookPopover.addEventListener('click', async event => {
  event.stopPropagation();
  if (event.target.closest('[data-new-linked-notebook]')) {
    const item = selectedItem();
    if (item) {
      setLinkedNotebookOpen(false);
      showNoteNameDialog({ type: 'linked', boundItemId: item.id, category: item.category });
    }
    return;
  }
  const previewNotebook = event.target.closest('[data-preview-notebook]');
  if (previewNotebook) {
    const id = previewNotebook.dataset.previewNotebook;
    setLinkedNotebookOpen(false);
    await openNotebook(id, { mode: 'preview' });
    return;
  }
  const editNotebook = event.target.closest('[data-edit-notebook]');
  if (editNotebook) {
    const id = editNotebook.dataset.editNotebook;
    setLinkedNotebookOpen(false);
    await openNotebook(id, { mode: 'edit' });
  }
});
elements.bookmarkButton.addEventListener('click', event => {
  event.stopPropagation();
  state.bookmarksOpen = !state.bookmarksOpen;
  if (!state.bookmarksOpen) {
    state.bookmarkNaming = false;
    state.pendingBookmarkAnchor = null;
  }
  renderBookmarks();
});

elements.bookmarkPopover.addEventListener('click', async event => {
  event.stopPropagation();
  if (event.target.closest('[data-bookmark-add]')) {
    state.pendingBookmarkAnchor = currentReadingAnchor();
    state.bookmarkNaming = true;
    renderBookmarks();
    requestAnimationFrame(() => elements.bookmarkPopover.querySelector('input[name="name"]')?.focus());
    return;
  }
  if (event.target.closest('[data-bookmark-cancel]')) {
    state.bookmarkNaming = false;
    state.pendingBookmarkAnchor = null;
    renderBookmarks();
    return;
  }
  const jump = event.target.closest('[data-bookmark-jump]');
  if (jump) {
    const bookmark = state.bookmarks.find(value => value.id === jump.dataset.bookmarkJump);
    if (bookmark) await jumpToAnchor(bookmark.anchor);
    state.bookmarksOpen = false;
    renderBookmarks();
    return;
  }
  const remove = event.target.closest('[data-bookmark-delete]');
  if (remove) deleteBookmark(remove.dataset.bookmarkDelete).catch(error => showToast(error.message));
});

elements.bookmarkPopover.addEventListener('submit', async event => {
  if (!event.target.matches('[data-bookmark-form]')) return;
  event.preventDefault();
  const item = selectedItem();
  const name = new FormData(event.target).get('name')?.toString().trim();
  if (!item || !name || !state.pendingBookmarkAnchor) return;
  try {
    const bookmark = await api(`/api/items/${item.id}/bookmarks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, anchor: state.pendingBookmarkAnchor }),
    });
    if (selectedItem()?.id !== item.id) return;
    state.bookmarks.push(bookmark);
    state.bookmarkNaming = false;
    state.pendingBookmarkAnchor = null;
    renderBookmarks();
    showToast('书签已添加');
  } catch (error) {
    showToast(error.message);
  }
});

document.addEventListener('click', event => {
  if (state.linkedNotebookOpen && !event.target.closest('#linkedNotebookMenu')) setLinkedNotebookOpen(false);
  if (!state.bookmarksOpen || event.target.closest('#bookmarkButton, #bookmarkPopover')) return;
  state.bookmarksOpen = false;
  state.bookmarkNaming = false;
  state.pendingBookmarkAnchor = null;
  renderBookmarks();
});

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
    saveReadingPosition();
    viewerScrollFrame = null;
  });
});

window.addEventListener('resize', () => requestAnimationFrame(() => { layoutNotes(); if (state.graphMode) renderGraph(); }));

document.addEventListener('change', event => {
  if (event.target.matches('[data-reading-status]')) patchOrganization({ reading_status: event.target.value, last_opened_at: new Date().toISOString() }, `已设为${readingNames[event.target.value]}`);
});

document.addEventListener('pointerover', event => {
  const moveOption = event.target.closest('.move-menu-branch > button');
  const moveSubmenu = moveOption?.nextElementSibling;
  if (moveSubmenu?.matches('.move-menu-submenu')) {
    const rect = moveOption.getBoundingClientRect();
    const openLeft = moveOption.closest('[data-cascade-direction]')?.dataset.cascadeDirection === 'left';
    moveSubmenu.style.left = `${openLeft ? Math.max(8, rect.left - 212) : rect.right + 3}px`;
    moveSubmenu.style.top = `${Math.max(8, Math.min(rect.top - 5, window.innerHeight - 295))}px`;
  }
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
elements.structureButton.addEventListener('click', () => {
  if (state.restructureSelecting) runSelectedRestructure();
  else {
    toggleRollbackPanel(false);
    state.restructureSelecting = true;
    state.selectedStructureFolders.clear();
    renderNavigation();
    showToast('请在左侧勾选需要重构的文件夹');
  }
});
elements.structureCancelButton.addEventListener('click', cancelRestructureSelection);
elements.rollbackButton.addEventListener('click', () => toggleRollbackPanel());
document.querySelector('#rollbackClose').addEventListener('click', () => toggleRollbackPanel(false));
elements.tree.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.matches('[data-folder-name]')) createFolder(); });
elements.list.addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (event.target.closest('button, input, select, textarea, a')) return;
  const row = event.target.closest('[data-open-folder], [data-id], [data-open-notebook]');
  if (!row) return;
  event.preventDefault();
  row.click();
});
elements.backButton.addEventListener('click', goBack);
elements.forwardButton.addEventListener('click', goForward);
elements.filterButton.addEventListener('click', () => toggleFilterPanel());
document.querySelector('#filterClose').addEventListener('click', () => toggleFilterPanel(false));
document.querySelector('#applyFilters').addEventListener('click', () => { readFilterPanel(); if (state.filters.folder) { state.scope = 'all'; state.category = ''; } toggleFilterPanel(false); render(); if (state.graphMode) renderGraph(); pushNavigation(); });
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
const graphClickDelay = 180;
elements.graphCanvas.addEventListener('click', event => {
  event.stopPropagation();
  if (state.graphMoved) { state.graphMoved = false; return; }
  const item = event.target.closest('[data-graph-item]');
  if (item) {
    clearTimeout(graphClickTimer);
    graphClickTimer = setTimeout(() => focusGraphNode(item.dataset.graphItem, item.dataset.graphItem), graphClickDelay);
    return;
  }
  const folder = event.target.closest('[data-graph-category]');
  if (folder) {
    clearTimeout(graphClickTimer);
    graphClickTimer = setTimeout(() => focusGraphNode(folder.dataset.graphNode, null, folder.dataset.graphFolderId || null), graphClickDelay);
    return;
  }
  if (event.target.closest('[data-graph-root]')) {
    clearTimeout(graphClickTimer);
    const root = event.target.closest('[data-graph-root]');
    graphClickTimer = setTimeout(() => focusGraphNode('root', null, root.dataset.graphFolderId || null), graphClickDelay);
  }
});
elements.graphCanvas.addEventListener('dblclick', event => {
  const item = event.target.closest('[data-graph-item]');
  const folder = event.target.closest('[data-graph-category]');
  const root = event.target.closest('[data-graph-root]');
  if (!item && !folder && !root) return;
  event.preventDefault();
  event.stopPropagation();
  clearTimeout(graphClickTimer);
  if (item) openGraphItem(item.dataset.graphItem);
  else if (folder) openGraphFolder(folder.dataset.graphCategory);
  else openGraphFolder('');
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
