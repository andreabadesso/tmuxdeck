import { forwardRef, useImperativeHandle, useState, useEffect, useCallback, createRef } from 'react';
import { Terminal } from './Terminal';
import type { TerminalHandle } from './Terminal';
import type { PoolEntry } from '../hooks/useTerminalPool';
import { Loader2 } from 'lucide-react';

export interface TerminalPoolHandle {
  focusActive: () => void;
  refitActive: () => void;
  clearBufferActive: () => void;
}

interface TerminalPoolProps {
  entries: PoolEntry[];
  activeKey: string | null;
  onOpenFile?: (containerId: string, path: string) => void;
}

export const TerminalPool = forwardRef<TerminalPoolHandle, TerminalPoolProps>(
  function TerminalPool({ entries, activeKey, onOpenFile }, ref) {
    // Use useState with lazy init to hold the refs map — avoids useRef.current access during render
    const [refsMap] = useState(() => new Map<string, React.RefObject<TerminalHandle | null>>());
    // Track which terminals have received their first data
    const [readyKeys, setReadyKeys] = useState<Set<string>>(() => new Set());
    // Track which terminals have been detected as gone (session removed)
    const [goneKeys, setGoneKeys] = useState<Set<string>>(() => new Set());

    // Sync refs map with entries (add new, remove stale)
    const currentKeys = new Set(entries.map((e) => e.key));
    for (const key of refsMap.keys()) {
      if (!currentKeys.has(key)) {
        refsMap.delete(key);
      }
    }
    for (const entry of entries) {
      if (!refsMap.has(entry.key)) {
        refsMap.set(entry.key, createRef<TerminalHandle>());
      }
    }

    // Clean up readyKeys and goneKeys for evicted entries
    useEffect(() => {
      setReadyKeys(prev => {
        const next = new Set(prev);
        let changed = false;
        for (const key of next) {
          if (!currentKeys.has(key)) {
            next.delete(key);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      setGoneKeys(prev => {
        const next = new Set(prev);
        let changed = false;
        for (const key of next) {
          if (!currentKeys.has(key)) {
            next.delete(key);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entries]);

    // Refit the newly active terminal when activeKey changes
    useEffect(() => {
      if (!activeKey) return;
      const termRef = refsMap.get(activeKey);
      if (termRef?.current) {
        // Double-rAF so the visibility CSS is processed before measuring
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            termRef.current?.refit();
          });
        });
      }
    }, [activeKey, refsMap]);

    const getActiveRef = useCallback(() => {
      if (!activeKey) return null;
      return refsMap.get(activeKey)?.current ?? null;
    }, [activeKey, refsMap]);

    useImperativeHandle(ref, () => ({
      focusActive: () => getActiveRef()?.focus(),
      refitActive: () => getActiveRef()?.refit(),
      clearBufferActive: () => getActiveRef()?.clearBuffer(),
    }), [getActiveRef]);

    const isActiveGone = activeKey != null && goneKeys.has(activeKey);
    const showLoading = activeKey != null && !readyKeys.has(activeKey) && !isActiveGone;

    return (
      <div className="relative w-full h-full">
        {entries.map((entry) => {
          const isActive = entry.key === activeKey;
          return (
            <div
              key={entry.key}
              className="absolute inset-0"
              style={{
                visibility: isActive ? 'visible' : 'hidden',
                zIndex: isActive ? 10 : 0,
                pointerEvents: isActive ? 'auto' : 'none',
              }}
            >
              <Terminal
                ref={refsMap.get(entry.key)}
                containerId={entry.containerId}
                sessionName={entry.sessionName}
                windowIndex={entry.windowIndex}
                autoFocus={false}
                visible={isActive}
                onOpenFile={onOpenFile ? (path) => onOpenFile(entry.containerId, path) : undefined}
                onReady={() => setReadyKeys(prev => {
                  if (prev.has(entry.key)) return prev;
                  const next = new Set(prev);
                  next.add(entry.key);
                  return next;
                })}
                onSessionGone={() => setGoneKeys(prev => {
                  if (prev.has(entry.key)) return prev;
                  const next = new Set(prev);
                  next.add(entry.key);
                  return next;
                })}
              />
            </div>
          );
        })}
        {showLoading && (
          <div
            className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none"
            style={{ background: '#0a0a0a' }}
          >
            <div className="flex items-center gap-2 text-zinc-500">
              <Loader2 size={18} className="animate-spin" />
              <span className="text-sm">Loading terminal...</span>
            </div>
          </div>
        )}
        {isActiveGone && (
          <div
            className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none"
            style={{ background: '#0a0a0a' }}
          >
            <div className="flex flex-col items-center gap-2 text-zinc-400">
              <span className="text-sm">Terminal no longer exists — the session was removed</span>
            </div>
          </div>
        )}
      </div>
    );
  }
);
