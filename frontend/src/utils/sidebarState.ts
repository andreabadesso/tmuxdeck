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

const ACTIVE_WORKSPACE_KEY = 'activeWorkspaceId';

export function getActiveWorkspaceId(): string {
  try {
    // Per-tab: sessionStorage first, fall back to localStorage
    return sessionStorage.getItem(ACTIVE_WORKSPACE_KEY)
      ?? localStorage.getItem(ACTIVE_WORKSPACE_KEY)
      ?? 'all';
  } catch { return 'all'; }
}

export function saveActiveWorkspaceId(id: string) {
  try { sessionStorage.setItem(ACTIVE_WORKSPACE_KEY, id); } catch { /* ignore */ }
  try { localStorage.setItem(ACTIVE_WORKSPACE_KEY, id); } catch { /* ignore */ }
  // Dispatch event so Sidebar can sync within the same tab
  window.dispatchEvent(new CustomEvent('workspace-changed', { detail: id }));
}

const SELECTED_SESSION_KEY = 'selectedSession';
const WORKSPACE_SESSIONS_KEY = 'workspaceSelectedSessions';

export function getSelectedSession(): { containerId: string; sessionName: string; windowIndex: number } | null {
  try {
    const raw = sessionStorage.getItem(SELECTED_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function saveSelectedSession(session: { containerId: string; sessionName: string; windowIndex: number } | null) {
  try {
    if (session) {
      sessionStorage.setItem(SELECTED_SESSION_KEY, JSON.stringify(session));
    } else {
      sessionStorage.removeItem(SELECTED_SESSION_KEY);
    }
  } catch { /* ignore */ }
  // Also save under the current workspace
  try {
    const wsId = getActiveWorkspaceId();
    const map = JSON.parse(sessionStorage.getItem(WORKSPACE_SESSIONS_KEY) ?? '{}');
    if (session) {
      map[wsId] = session;
    } else {
      delete map[wsId];
    }
    sessionStorage.setItem(WORKSPACE_SESSIONS_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

export function getWorkspaceSelectedSession(workspaceId: string): { containerId: string; sessionName: string; windowIndex: number } | null {
  try {
    const map = JSON.parse(sessionStorage.getItem(WORKSPACE_SESSIONS_KEY) ?? '{}');
    return map[workspaceId] ?? null;
  } catch { return null; }
}

const NATURAL_TOUCH_SCROLL_KEY = 'naturalTouchScroll';

export function getNaturalTouchScroll(): boolean {
  try {
    const val = localStorage.getItem(NATURAL_TOUCH_SCROLL_KEY);
    return val === null ? true : val === 'true';
  } catch { return true; }
}

export function saveNaturalTouchScroll(value: boolean) {
  try { localStorage.setItem(NATURAL_TOUCH_SCROLL_KEY, String(value)); } catch { /* ignore */ }
}
