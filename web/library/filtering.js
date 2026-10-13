export function isRecent(item, now = Date.now()) {
  if (!item.received_at) return false;
  return now - new Date(`${item.received_at}T00:00:00`).getTime() <= 30 * 24 * 60 * 60 * 1000;
}

export function scopeItems(state, now = Date.now()) {
  return state.items.filter(item => {
    if (state.scope === 'review' && item.status !== 'review') return false;
    if (state.scope === 'recent' && !isRecent(item, now)) return false;
    if (state.scope === 'favorites' && !item.favorite) return false;
    if (state.scope === 'unread' && item.reading_status !== 'unread') return false;
    if (state.scope === 'category' && item.status !== 'ready') return false;
    if (state.scope === 'category' && item.category !== state.category && !item.category?.startsWith(`${state.category}/`)) return false;
    return true;
  });
}

export function filterItems(state, now = Date.now()) {
  const query = state.query.trim();
  const filters = state.filters;
  const results = scopeItems(state, now).filter(item => {
    if (filters.folder && item.category !== filters.folder && !item.category?.startsWith(`${filters.folder}/`)) return false;
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

export function activeFilterCount(filters) {
  return Number(Boolean(filters.folder)) + filters.kinds.length + filters.tags.length + filters.readingStatuses.length + Number(Boolean(filters.status)) + Number(filters.favorite !== 'any') + Number(filters.scoreMin > 0) + Number(Boolean(filters.publishedFrom)) + Number(Boolean(filters.publishedTo)) + Number(Boolean(filters.receivedFrom)) + Number(Boolean(filters.receivedTo)) + Number(filters.sort !== 'received_desc');
}
