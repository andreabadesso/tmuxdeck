import { useState, useEffect, useCallback } from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { X, RotateCcw, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../api/client';
import type { Snapshot, SnapshotContainer, SnapshotSession, ContainerListResponse } from '../types';

interface RestoreDialogProps {
  onClose: () => void;
}

interface MissingSession {
  containerId: string;
  containerName: string;
  session: SnapshotSession;
}

export function RestoreDialog({ onClose }: RestoreDialogProps) {
  const queryClient = useQueryClient();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [result, setResult] = useState<{ restored: string[]; errors: string[] } | null>(null);
  const [collapsedContainers, setCollapsedContainers] = useState<Set<string>>(new Set());

  const containersData = queryClient.getQueryData<ContainerListResponse>(['containers']);

  useEffect(() => {
    api.getSnapshot().then((s) => {
      setSnapshot(s);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Compute missing sessions
  const liveSessionNames = new Map<string, Set<string>>();
  if (containersData) {
    for (const c of containersData.containers) {
      liveSessionNames.set(c.id, new Set(c.sessions.map((s) => s.name)));
    }
  }

  const missingByContainer = new Map<string, MissingSession[]>();
  const skippedContainers: string[] = [];

  if (snapshot) {
    for (const sc of snapshot.containers) {
      if (sc.container_type === 'bridge') {
        skippedContainers.push(`${sc.display_name} (bridge)`);
        continue;
      }
      if (!liveSessionNames.has(sc.id)) {
        if (sc.sessions.length > 0) {
          skippedContainers.push(`${sc.display_name} (not running)`);
        }
        continue;
      }
      const liveNames = liveSessionNames.get(sc.id)!;
      const missing: MissingSession[] = [];
      for (const session of sc.sessions) {
        if (!liveNames.has(session.name)) {
          missing.push({ containerId: sc.id, containerName: sc.display_name, session });
        }
      }
      if (missing.length > 0) {
        missingByContainer.set(sc.id, missing);
      }
    }
  }

  const totalMissing = Array.from(missingByContainer.values()).reduce((sum, arr) => sum + arr.length, 0);

  const handleRestore = useCallback(async () => {
    setRestoring(true);
    try {
      const res = await api.restoreSnapshot();
      setResult({ restored: res.restored, errors: res.errors });
      queryClient.invalidateQueries({ queryKey: ['containers'] });
      // Refresh snapshot
      const fresh = await api.getSnapshot();
      setSnapshot(fresh);
    } catch {
      setResult({ restored: [], errors: ['Failed to restore'] });
    } finally {
      setRestoring(false);
    }
  }, [queryClient]);

  const handleDismiss = useCallback(async (containerId: string, sessionName: string) => {
    try {
      await api.dismissSnapshotSession(containerId, sessionName);
      const fresh = await api.getSnapshot();
      setSnapshot(fresh);
      queryClient.invalidateQueries({ queryKey: ['containers'] });
    } catch {
      // ignore
    }
  }, [queryClient]);

  const toggleContainer = (id: string) => {
    setCollapsedContainers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md shadow-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-lg font-semibold text-gray-100">Snapshot Restore</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {loading && <p className="text-sm text-gray-400">Loading snapshot...</p>}

          {!loading && totalMissing === 0 && !result && (
            <p className="text-sm text-gray-400">All sessions are live. Nothing to restore.</p>
          )}

          {result && (
            <div className="space-y-2">
              {result.restored.length > 0 && (
                <div className="text-sm text-green-400">
                  Restored: {result.restored.join(', ')}
                </div>
              )}
              {result.errors.length > 0 && (
                <div className="text-sm text-red-400">
                  Errors: {result.errors.join(', ')}
                </div>
              )}
            </div>
          )}

          {!loading && totalMissing > 0 && !result && (
            <>
              {Array.from(missingByContainer.entries()).map(([containerId, sessions]) => {
                const isCollapsed = collapsedContainers.has(containerId);
                const containerName = sessions[0]?.containerName ?? containerId;
                return (
                  <div key={containerId} className="border border-gray-800 rounded-lg overflow-hidden">
                    <button
                      onClick={() => toggleContainer(containerId)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-200 hover:bg-gray-800 transition-colors"
                    >
                      {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      <span className="font-medium">{containerName}</span>
                      <span className="text-gray-500 ml-auto">{sessions.length} session{sessions.length !== 1 ? 's' : ''}</span>
                    </button>
                    {!isCollapsed && (
                      <div className="border-t border-gray-800">
                        {sessions.map((ms) => (
                          <div
                            key={ms.session.name}
                            className="flex items-center justify-between px-3 py-2 text-sm hover:bg-gray-800/50"
                          >
                            <div className="min-w-0">
                              <div className="text-gray-200 truncate">{ms.session.name}</div>
                              <div className="text-xs text-gray-500 truncate">
                                {ms.session.windows.length} window{ms.session.windows.length !== 1 ? 's' : ''}
                                {ms.session.windows[0]?.path && ` · ${ms.session.windows[0].path}`}
                              </div>
                            </div>
                            <button
                              onClick={() => handleDismiss(ms.containerId, ms.session.name)}
                              className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-gray-800 transition-colors flex-shrink-0 ml-2"
                              title="Dismiss"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {skippedContainers.length > 0 && (
            <p className="text-xs text-gray-600 mt-2">
              Skipped: {skippedContainers.join(', ')}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-800">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
          >
            Close
          </button>
          {totalMissing > 0 && !result && (
            <button
              onClick={handleRestore}
              disabled={restoring}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <RotateCcw size={14} />
              {restoring ? 'Restoring...' : `Restore All (${totalMissing})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
