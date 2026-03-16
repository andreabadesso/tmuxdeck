import { useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X, RotateCcw, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../api/client';
import type { Snapshot, SnapshotSession, SnapshotWindow, ContainerListResponse } from '../types';

interface RestoreDialogProps {
  onClose: () => void;
}

interface MissingSession {
  containerId: string;
  containerName: string;
  containerType: string;
  session: SnapshotSession;
}

interface DriftedSession {
  containerId: string;
  containerName: string;
  session: SnapshotSession;
  livePaths: Set<string>;
  missingPaths: string[];
  liveWindowCount: number;
}

export function RestoreDialog({ onClose }: RestoreDialogProps) {
  const queryClient = useQueryClient();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [result, setResult] = useState<{ restored: string[]; errors: string[] } | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

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

  // Build live state maps
  const liveSessionNames = new Map<string, Set<string>>();
  const liveSessionPaths = new Map<string, Map<string, Set<string>>>();
  const liveSessionWindowCounts = new Map<string, Map<string, number>>();
  if (containersData) {
    for (const c of containersData.containers) {
      liveSessionNames.set(c.id, new Set(c.sessions.map((s) => s.name)));
      const pathMap = new Map<string, Set<string>>();
      const countMap = new Map<string, number>();
      for (const s of c.sessions) {
        pathMap.set(s.name, new Set(s.windows.map((w) => w.path).filter(Boolean) as string[]));
        countMap.set(s.name, s.windows.length);
      }
      liveSessionPaths.set(c.id, pathMap);
      liveSessionWindowCounts.set(c.id, countMap);
    }
  }

  // Categorize sessions
  const missingByContainer = new Map<string, MissingSession[]>();
  const driftedByContainer = new Map<string, DriftedSession[]>();
  const skippedContainers: string[] = [];

  if (snapshot) {
    for (const sc of snapshot.containers) {
      if (!liveSessionNames.has(sc.id)) {
        if (sc.sessions.length > 0) {
          skippedContainers.push(`${sc.display_name} (not running)`);
        }
        continue;
      }

      const liveNames = liveSessionNames.get(sc.id)!;

      for (const session of sc.sessions) {
        if (!liveNames.has(session.name)) {
          // Missing session
          const arr = missingByContainer.get(sc.id) ?? [];
          arr.push({
            containerId: sc.id,
            containerName: sc.display_name,
            containerType: sc.container_type,
            session,
          });
          missingByContainer.set(sc.id, arr);
        } else {
          // Session exists — check for drift
          const snapPaths = new Set(
            session.windows.map((w: SnapshotWindow) => w.path).filter(Boolean)
          );
          const livePaths = liveSessionPaths.get(sc.id)?.get(session.name) ?? new Set<string>();
          const missing = [...snapPaths].filter((p) => !livePaths.has(p));
          if (missing.length > 0) {
            const arr = driftedByContainer.get(sc.id) ?? [];
            arr.push({
              containerId: sc.id,
              containerName: sc.display_name,
              session,
              livePaths,
              missingPaths: missing,
              liveWindowCount: liveSessionWindowCounts.get(sc.id)?.get(session.name) ?? 0,
            });
            driftedByContainer.set(sc.id, arr);
          }
        }
      }
    }
  }

  const totalMissing = Array.from(missingByContainer.values()).reduce((sum, arr) => sum + arr.length, 0);
  const totalDrifted = Array.from(driftedByContainer.values()).reduce((sum, arr) => sum + arr.length, 0);
  const totalIssues = totalMissing + totalDrifted;

  const handleRestore = useCallback(async (includeDrifted: boolean) => {
    setRestoring(true);
    try {
      const res = await api.restoreSnapshot({ includeDrifted });
      setResult({ restored: res.restored, errors: res.errors });
      queryClient.invalidateQueries({ queryKey: ['containers'] });
      const fresh = await api.getSnapshot();
      setSnapshot(fresh);
    } catch {
      setResult({ restored: [], errors: ['Failed to restore'] });
    } finally {
      setRestoring(false);
    }
  }, [queryClient]);

  const handleRestoreSession = useCallback(async (containerId: string, sessionName: string, isDrifted: boolean) => {
    setRestoring(true);
    try {
      const res = await api.restoreSnapshot({
        containerId,
        sessionName,
        includeDrifted: isDrifted,
      });
      setResult({ restored: res.restored, errors: res.errors });
      queryClient.invalidateQueries({ queryKey: ['containers'] });
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

  const toggleSection = (id: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderSessionRow = (
    containerId: string,
    session: SnapshotSession,
    subtitle: string,
    showDismiss: boolean,
    onRestore?: () => void,
  ) => (
    <div
      key={session.name}
      className="flex items-start justify-between px-3 py-2 text-sm hover:bg-gray-800/50"
    >
      <div className="min-w-0">
        <div className="text-gray-200 truncate">{session.name}</div>
        <div className="text-xs text-gray-500 whitespace-pre-line">{subtitle}</div>
      </div>
      <div className="flex items-center flex-shrink-0 ml-2 gap-1">
        {onRestore && (
          <button
            onClick={onRestore}
            disabled={restoring}
            className="p-1 rounded text-gray-500 hover:text-blue-400 hover:bg-gray-800 transition-colors disabled:opacity-50"
            title="Restore session"
          >
            <RotateCcw size={14} />
          </button>
        )}
        {showDismiss && (
          <button
            onClick={() => handleDismiss(containerId, session.name)}
            className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-gray-800 transition-colors"
            title="Dismiss"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );

  const renderContainerGroup = (
    sectionId: string,
    label: string,
    count: number,
    children: React.ReactNode,
  ) => {
    const isCollapsed = collapsedSections.has(sectionId);
    return (
      <div key={sectionId} className="border border-gray-800 rounded-lg overflow-hidden">
        <button
          onClick={() => toggleSection(sectionId)}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-200 hover:bg-gray-800 transition-colors"
        >
          {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <span className="font-medium">{label}</span>
          <span className="text-gray-500 ml-auto">{count} session{count !== 1 ? 's' : ''}</span>
        </button>
        {!isCollapsed && (
          <div className="border-t border-gray-800">{children}</div>
        )}
      </div>
    );
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

          {!loading && totalIssues === 0 && !result && (
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

          {!loading && !result && (
            <>
              {/* Missing sessions (restorable) */}
              {totalMissing > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Missing Sessions</h3>
                  {Array.from(missingByContainer.entries()).map(([containerId, sessions]) => {
                    const containerName = sessions[0]?.containerName ?? containerId;
                    return renderContainerGroup(
                      `missing-${containerId}`,
                      containerName,
                      sessions.length,
                      sessions.map((ms) => {
                        const paths = ms.session.windows.map((w) => w.path).filter(Boolean);
                        const subtitle = paths.length > 0
                          ? paths.map((p) => `  ${p}`).join('\n')
                          : `${ms.session.windows.length} window${ms.session.windows.length !== 1 ? 's' : ''}`;
                        return renderSessionRow(
                          ms.containerId,
                          ms.session,
                          subtitle,
                          true,
                          () => handleRestoreSession(ms.containerId, ms.session.name, false),
                        );
                      }),
                    );
                  })}
                </div>
              )}

              {/* Drifted sessions */}
              {totalDrifted > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold text-yellow-400/80 uppercase tracking-wide">Drifted Sessions</h3>
                  {Array.from(driftedByContainer.entries()).map(([containerId, sessions]) => {
                    const containerName = sessions[0]?.containerName ?? containerId;
                    return renderContainerGroup(
                      `drifted-${containerId}`,
                      containerName,
                      sessions.length,
                      sessions.map((ds) => (
                        <div
                          key={ds.session.name}
                          className="flex items-start justify-between px-3 py-2 text-sm hover:bg-gray-800/50"
                        >
                          <div className="min-w-0">
                            <div className="text-gray-200 truncate">{ds.session.name}</div>
                            <div className="text-xs text-yellow-400/70">
                              {ds.liveWindowCount} live / {ds.session.windows.length} snapshot windows
                            </div>
                            {ds.missingPaths.map((p) => (
                              <div key={p} className="text-xs text-gray-500">
                                &nbsp;&nbsp;{p} <span className="text-yellow-500/60">(missing)</span>
                              </div>
                            ))}
                          </div>
                          <div className="flex items-center flex-shrink-0 ml-2 gap-1">
                            <button
                              onClick={() => handleRestoreSession(ds.containerId, ds.session.name, true)}
                              disabled={restoring}
                              className="p-1 rounded text-gray-500 hover:text-blue-400 hover:bg-gray-800 transition-colors disabled:opacity-50"
                              title="Restore session"
                            >
                              <RotateCcw size={14} />
                            </button>
                            <button
                              onClick={() => handleDismiss(ds.containerId, ds.session.name)}
                              className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-gray-800 transition-colors"
                              title="Dismiss"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      )),
                    );
                  })}
                </div>
              )}

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
          {(totalMissing > 0 || totalDrifted > 0) && !result && (
            <button
              onClick={() => handleRestore(totalDrifted > 0)}
              disabled={restoring}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <RotateCcw size={14} />
              {restoring ? 'Restoring...' : `Restore All (${totalMissing + totalDrifted})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
