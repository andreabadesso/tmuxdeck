import { useState, useCallback } from 'react';

const SESSION_EXPANDED_KEY = 'sessionExpanded';

function loadExpandedMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SESSION_EXPANDED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persistExpandedMap(map: Record<string, boolean>) {
  try {
    localStorage.setItem(SESSION_EXPANDED_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

export function useSessionExpandedState() {
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>(loadExpandedMap);

  const isSessionExpanded = useCallback((containerId: string, sessionId: string): boolean => {
    return expandedMap[`${containerId}:${sessionId}`] ?? true;
  }, [expandedMap]);

  const setSessionExpanded = useCallback((containerId: string, sessionId: string, expanded: boolean) => {
    setExpandedMap((prev) => {
      const key = `${containerId}:${sessionId}`;
      const next = { ...prev, [key]: expanded };
      persistExpandedMap(next);
      return next;
    });
  }, []);

  return { isSessionExpanded, setSessionExpanded };
}
