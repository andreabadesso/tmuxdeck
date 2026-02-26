const SIDEBAR_COLLAPSED_KEY = 'sidebarCollapsed';
const SECTIONS_COLLAPSED_KEY = 'sidebarSectionsCollapsed';
const CONTAINER_EXPANDED_KEY = 'containerExpanded';
const SESSION_EXPANDED_KEY = 'sessionExpanded';

export function getSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  } catch { return false; }
}

export function saveSidebarCollapsed(collapsed: boolean) {
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed)); } catch { /* ignore */ }
}

export function getSectionsCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SECTIONS_COLLAPSED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function saveSectionsCollapsed(state: Record<string, boolean>) {
  try { localStorage.setItem(SECTIONS_COLLAPSED_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

export function getContainerExpanded(containerId: string): boolean | null {
  try {
    const raw = localStorage.getItem(CONTAINER_EXPANDED_KEY);
    if (raw) {
      const map = JSON.parse(raw);
      if (containerId in map) return map[containerId];
    }
  } catch { /* ignore */ }
  return null;
}

export function saveContainerExpanded(containerId: string, expanded: boolean) {
  try {
    const raw = localStorage.getItem(CONTAINER_EXPANDED_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[containerId] = expanded;
    localStorage.setItem(CONTAINER_EXPANDED_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

export function getSessionExpanded(containerId: string, sessionId: string): boolean | null {
  try {
    const raw = localStorage.getItem(SESSION_EXPANDED_KEY);
    if (raw) {
      const map = JSON.parse(raw);
      const key = `${containerId}:${sessionId}`;
      if (key in map) return map[key];
    }
  } catch { /* ignore */ }
  return null;
}

export function saveSessionExpanded(containerId: string, sessionId: string, expanded: boolean) {
  try {
    const raw = localStorage.getItem(SESSION_EXPANDED_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[`${containerId}:${sessionId}`] = expanded;
    localStorage.setItem(SESSION_EXPANDED_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}
