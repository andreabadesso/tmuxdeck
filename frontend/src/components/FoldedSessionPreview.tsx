import { useState, useEffect, useCallback } from 'react';
import type { TmuxWindow, Container, FoldedSessionTarget, ContainerListResponse } from '../types';
import { useQueryClient } from '@tanstack/react-query';

type PaneState = 'idle' | 'busy' | 'waiting' | 'attention';

const IDLE_COMMANDS = [
  'bash', 'zsh', 'sh', 'fish', 'dash', 'tcsh', 'csh', 'login', '-bash', '-zsh', '-sh', '-fish',
  'vim', 'nvim', 'vi', 'nano', 'emacs', 'micro', 'helix', 'hx', 'joe', 'ne', 'kakoune', 'kak',
  'less', 'more', 'most', 'bat', 'man',
  'htop', 'btop', 'top', 'atop', 'glances',
  'tmux', 'screen',
  'mc', 'tig', 'lazygit', 'lazydocker',
  'python', 'python3', 'ipython', 'node', 'irb', 'ghci', 'lua',
];

function getPaneState(win: TmuxWindow): PaneState {
  if (win.paneStatus === 'attention') return 'attention';
  if (win.paneStatus === 'waiting') return 'waiting';
  if (win.paneStatus === 'running') return 'busy';
  if (win.paneStatus === 'idle') return 'idle';
  if (!win.command || IDLE_COMMANDS.includes(win.command)) return 'idle';
  return 'busy';
}

const stateColors: Record<PaneState, string> = {
  idle: 'text-gray-500',
  busy: 'text-amber-400',
  waiting: 'text-green-400',
  attention: 'text-blue-400',
};

const stateLabels: Record<PaneState, string> = {
  idle: 'idle',
  busy: 'running',
  waiting: 'waiting',
  attention: 'attention',
};

interface FoldedSessionPreviewProps {
  selection: FoldedSessionTarget;
  onUnfoldAndSelect: (windowIndex: number) => void;
}

export function FoldedSessionPreview({ selection, onUnfoldAndSelect }: FoldedSessionPreviewProps) {
  const queryClient = useQueryClient();
  const [focusedRow, setFocusedRow] = useState(0);

  const containers: Container[] | undefined = queryClient.getQueryData<ContainerListResponse>(['containers'])?.containers;
  const container = containers?.find((c) => c.id === selection.containerId);
  const session = container?.sessions.find((s) => s.id === selection.sessionId);
  const windows = session?.windows ? [...session.windows].sort((a, b) => a.index - b.index) : [];

  const handleSelect = useCallback((idx: number) => {
    if (windows[idx]) {
      onUnfoldAndSelect(windows[idx].index);
    }
  }, [windows, onUnfoldAndSelect]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        setFocusedRow((prev) => Math.max(0, prev - 1));
      } else if (e.key === 'ArrowDown' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        setFocusedRow((prev) => Math.min(windows.length - 1, prev + 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleSelect(focusedRow);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [focusedRow, windows.length, handleSelect]);

  // Clamp focused row if window list shrinks
  useEffect(() => {
    if (focusedRow >= windows.length && windows.length > 0) {
      setFocusedRow(windows.length - 1);
    }
  }, [focusedRow, windows.length]);

  if (!session) {
    return (
      <div className="flex items-center justify-center h-full bg-[#0a0a0a] text-gray-600 text-sm">
        Session not found
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full bg-[#0a0a0a]">
      <div className="font-mono text-sm max-w-lg w-full px-8">
        <div className="text-gray-500 mb-4">
          <span className="text-gray-400">{container?.displayName ?? selection.containerId}</span>
          <span className="text-gray-700"> / </span>
          <span className="text-gray-400">{selection.sessionName}</span>
          <span className="text-gray-600"> ({windows.length} window{windows.length !== 1 ? 's' : ''})</span>
        </div>

        <div className="space-y-0.5">
          {windows.map((win, i) => {
            const state = getPaneState(win);
            const isFocused = i === focusedRow;
            return (
              <div
                key={win.index}
                className={`flex items-center gap-3 px-3 py-1 rounded cursor-pointer transition-colors ${
                  isFocused ? 'bg-blue-900/40 text-blue-200' : 'text-gray-400 hover:bg-gray-800/50'
                }`}
                onClick={() => handleSelect(i)}
                onMouseEnter={() => setFocusedRow(i)}
              >
                <span className="text-gray-600 w-4 text-right shrink-0">{win.index}:</span>
                <span className={`flex-1 truncate ${isFocused ? 'text-blue-200' : 'text-gray-300'}`}>
                  {win.name}
                </span>
                <span className={`truncate max-w-[140px] text-xs ${isFocused ? 'text-blue-300/60' : 'text-gray-600'}`}>
                  {win.command ?? ''}
                </span>
                <span className={`text-xs shrink-0 ${stateColors[state]}`}>
                  {state === 'busy' || state === 'attention' ? '◉' : '●'} {stateLabels[state]}
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-4 text-[11px] text-gray-700">
          ↑↓ navigate · Enter to select · Ctrl+→ unfold
        </div>
      </div>
    </div>
  );
}
