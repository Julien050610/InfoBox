const DEFAULTS = { sidebar: 246, inspector: 324, catalog: 242 };
const LIMITS = {
  sidebar: [210, 380],
  inspector: [280, 460],
  catalog: [150, 520],
};

export function clampWorkspaceSize(kind, value, available = Infinity) {
  const [minimum, configuredMaximum] = LIMITS[kind] || [0, Infinity];
  const maximum = kind === 'catalog'
    ? Math.max(minimum, Math.min(configuredMaximum, Number.isFinite(available) ? available - 250 : configuredMaximum))
    : configuredMaximum;
  return Math.round(Math.max(minimum, Math.min(maximum, Number(value) || DEFAULTS[kind] || minimum)));
}

function storedNumber(storage, key, fallback) {
  const value = Number(storage?.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function createWorkspaceLayout({
  workspace,
  sidebarToggle,
  inspectorToggle,
  sidebarResizer,
  inspectorResizer,
  catalogResizer,
  contentColumn,
  storage = window.localStorage,
  onLayout = () => {},
} = {}) {
  const root = document.documentElement;
  const state = {
    sidebar: clampWorkspaceSize('sidebar', storedNumber(storage, 'infobox.sidebarWidth', DEFAULTS.sidebar)),
    inspector: clampWorkspaceSize('inspector', storedNumber(storage, 'infobox.inspectorWidth', DEFAULTS.inspector)),
    catalog: clampWorkspaceSize('catalog', storedNumber(storage, 'infobox.catalogHeight', DEFAULTS.catalog), contentColumn?.clientHeight),
    sidebarCollapsed: storage?.getItem('infobox.sidebarCollapsed') === '1',
    inspectorCollapsed: storage?.getItem('infobox.inspectorCollapsed') === '1',
  };

  const apply = () => {
    root.style.setProperty('--sidebar-width', `${state.sidebar}px`);
    root.style.setProperty('--inspector-width', `${state.inspector}px`);
    root.style.setProperty('--catalog-height', `${state.catalog}px`);
    workspace?.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
    workspace?.classList.toggle('inspector-collapsed', state.inspectorCollapsed);
    sidebarToggle?.classList.toggle('is-collapsed', state.sidebarCollapsed);
    inspectorToggle?.classList.toggle('is-collapsed', state.inspectorCollapsed);
    if (sidebarToggle) {
      sidebarToggle.textContent = state.sidebarCollapsed ? '›' : '‹';
      sidebarToggle.setAttribute('aria-label', state.sidebarCollapsed ? '展开左侧栏' : '收起左侧栏');
      sidebarToggle.title = state.sidebarCollapsed ? '展开左侧栏' : '收起左侧栏';
    }
    if (inspectorToggle) {
      inspectorToggle.textContent = state.inspectorCollapsed ? '‹' : '›';
      inspectorToggle.setAttribute('aria-label', state.inspectorCollapsed ? '展开右侧栏' : '收起右侧栏');
      inspectorToggle.title = state.inspectorCollapsed ? '展开右侧栏' : '收起右侧栏';
    }
    onLayout(state);
  };

  const persist = kind => storage?.setItem(`infobox.${kind}${kind === 'catalog' ? 'Height' : 'Width'}`, String(state[kind]));
  const resize = (kind, delta) => {
    const available = kind === 'catalog' ? contentColumn?.clientHeight : Infinity;
    state[kind] = clampWorkspaceSize(kind, state[kind] + delta, available);
    persist(kind);
    apply();
  };

  const bindDrag = (element, kind, direction) => {
    if (!element) return;
    element.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const start = kind === 'catalog' ? event.clientY : event.clientX;
      const initial = state[kind];
      element.classList.add('is-dragging');
      document.body.classList.add(kind === 'catalog' ? 'is-resizing-row' : 'is-resizing-column');
      const move = moveEvent => {
        const current = kind === 'catalog' ? moveEvent.clientY : moveEvent.clientX;
        const available = kind === 'catalog' ? contentColumn?.clientHeight : Infinity;
        state[kind] = clampWorkspaceSize(kind, initial + (current - start) * direction, available);
        apply();
      };
      const finish = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', finish);
        element.classList.remove('is-dragging');
        document.body.classList.remove('is-resizing-row', 'is-resizing-column');
        persist(kind);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', finish, { once: true });
    });
    element.addEventListener('keydown', event => {
      const axisKey = kind === 'catalog' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
      if (!axisKey.includes(event.key)) return;
      event.preventDefault();
      const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
      resize(kind, (forward ? 12 : -12) * direction);
    });
  };

  sidebarToggle?.addEventListener('click', () => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    storage?.setItem('infobox.sidebarCollapsed', state.sidebarCollapsed ? '1' : '0');
    apply();
  });
  inspectorToggle?.addEventListener('click', () => {
    state.inspectorCollapsed = !state.inspectorCollapsed;
    storage?.setItem('infobox.inspectorCollapsed', state.inspectorCollapsed ? '1' : '0');
    apply();
  });
  bindDrag(sidebarResizer, 'sidebar', 1);
  bindDrag(inspectorResizer, 'inspector', -1);
  bindDrag(catalogResizer, 'catalog', 1);
  apply();
  return { state, apply, resize };
}
