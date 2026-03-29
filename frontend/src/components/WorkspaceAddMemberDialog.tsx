import { useState, useEffect, useRef, useMemo } from 'react';
import { Search, Monitor, TerminalSquare, Radio, Check } from 'lucide-react';
import { fuzzyMatch } from '../utils/fuzzyMatch';
import { DockerIcon } from './icons/DockerIcon';
import type { Container, Workspace, WorkspaceMember } from '../types';

interface MemberEntry {
  type: 'source' | 'session';
  sourceId: string;
  sessionId?: string;
  displayName: string;
  searchStr: string;
  containerType?: string;
  isMember: boolean;
  isInherited: boolean; // session inherited from source membership
}

interface WorkspaceAddMemberDialogProps {
  workspace: Workspace;
  containers: Container[];
  onClose: () => void;
  onUpdateMembers: (members: WorkspaceMember[]) => void;
}

function HighlightedText({ text, indices }: { text: string; indices: number[] }) {
  const indexSet = new Set(indices);
  return (
    <span>
      {text.split('').map((char, i) =>
        indexSet.has(i) ? (
          <span key={i} className="text-blue-400 font-semibold">{char}</span>
        ) : (
          <span key={i}>{char}</span>
        )
      )}
    </span>
  );
}

function ContainerIcon({ type, size = 14 }: { type?: string; size?: number }) {
  switch (type) {
    case 'host': return <Monitor size={size} className="text-blue-400" />;
    case 'local': return <TerminalSquare size={size} className="text-green-400" />;
    case 'bridge': return <Radio size={size} className="text-purple-400" />;
    default: return <DockerIcon size={size} />;
  }
}

export function WorkspaceAddMemberDialog({
  workspace,
  containers,
  onClose,
  onUpdateMembers,
}: WorkspaceAddMemberDialogProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Track members locally for instant UI updates
  const [localMembers, setLocalMembers] = useState<WorkspaceMember[]>(workspace.members);

  const sourceIds = useMemo(
    () => new Set(localMembers.filter((m) => m.type === 'source').map((m) => m.sourceId)),
    [localMembers],
  );

  // Build flat list of sources and sessions
  const allEntries: MemberEntry[] = useMemo(() => {
    const entries: MemberEntry[] = [];
    for (const c of containers) {
      const isSourceMember = sourceIds.has(c.id);
      entries.push({
        type: 'source',
        sourceId: c.id,
        displayName: c.displayName,
        searchStr: c.displayName,
        containerType: c.containerType,
        isMember: isSourceMember,
        isInherited: false,
      });
      for (const s of c.sessions) {
        const isSessionMember = localMembers.some(
          (m) => m.type === 'session' && m.sourceId === c.id && m.sessionId === s.id,
        );
        entries.push({
          type: 'session',
          sourceId: c.id,
          sessionId: s.id,
          displayName: s.name,
          searchStr: `${c.displayName} / ${s.name}`,
          containerType: c.containerType,
          isMember: isSessionMember || isSourceMember,
          isInherited: isSourceMember && !isSessionMember,
        });
      }
    }
    return entries;
  }, [containers, localMembers, sourceIds]);

  // Filter and sort by fuzzy match
  const filtered = useMemo(() => {
    return allEntries
      .map((entry) => {
        const result = fuzzyMatch(query, entry.searchStr);
        return { ...entry, ...result };
      })
      .filter((e) => e.match)
      .sort((a, b) => {
        if (!query) return 0; // preserve natural order when no query
        return b.score - a.score;
      });
  }, [allEntries, query]);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const effectiveIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[effectiveIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [effectiveIndex]);

  const toggleMember = (entry: MemberEntry) => {
    if (entry.type === 'session' && entry.isInherited) return; // can't toggle inherited

    setLocalMembers((prev) => {
      let next: WorkspaceMember[];
      if (entry.type === 'source') {
        const exists = prev.some((m) => m.type === 'source' && m.sourceId === entry.sourceId);
        if (exists) {
          next = prev.filter((m) => !(m.type === 'source' && m.sourceId === entry.sourceId));
        } else {
          next = [...prev, { type: 'source', sourceId: entry.sourceId, displayName: entry.displayName }];
        }
      } else {
        const exists = prev.some(
          (m) => m.type === 'session' && m.sourceId === entry.sourceId && m.sessionId === entry.sessionId,
        );
        if (exists) {
          next = prev.filter(
            (m) => !(m.type === 'session' && m.sourceId === entry.sourceId && (m as { sessionId?: string }).sessionId === entry.sessionId),
          );
        } else {
          next = [...prev, { type: 'session', sourceId: entry.sourceId, sessionId: entry.sessionId!, displayName: entry.displayName }];
        }
      }
      onUpdateMembers(next);
      return next;
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (filtered[effectiveIndex]) {
          toggleMember(filtered[effectiveIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center pt-[15vh] z-50" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
          <Search size={16} className="text-gray-500 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder={`Add to "${workspace.name}"...`}
            className="flex-1 bg-transparent text-sm text-gray-200 outline-none placeholder-gray-600"
          />
          <kbd className="text-[10px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-gray-600">
              No matching sources or sessions
            </div>
          )}
          {filtered.map((entry, i) => {
            const key = entry.type === 'source'
              ? `source:${entry.sourceId}`
              : `session:${entry.sourceId}:${entry.sessionId}`;
            return (
              <button
                key={key}
                className={`flex items-center gap-3 w-full px-4 py-2 text-left transition-colors ${
                  entry.isInherited ? 'opacity-50 cursor-default' : ''
                } ${
                  i === effectiveIndex
                    ? 'bg-blue-900/40 text-blue-200'
                    : 'text-gray-400 hover:bg-gray-800/60'
                }`}
                onClick={() => toggleMember(entry)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <span className="w-4 shrink-0 flex items-center justify-center">
                  {entry.isMember && <Check size={13} className={entry.isInherited ? 'text-gray-500' : 'text-blue-400'} />}
                </span>
                {entry.type === 'source' ? (
                  <ContainerIcon type={entry.containerType} size={14} />
                ) : (
                  <span className="w-3.5" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">
                    <HighlightedText text={entry.searchStr} indices={entry.indices} />
                  </div>
                </div>
                <span className="text-[10px] text-gray-600 shrink-0">
                  {entry.type === 'source' ? 'source' : 'session'}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3 px-4 py-2 border-t border-gray-800 text-[10px] text-gray-600">
          <span><kbd className="bg-gray-800 px-1 py-0.5 rounded border border-gray-700">↑↓</kbd> navigate</span>
          <span><kbd className="bg-gray-800 px-1 py-0.5 rounded border border-gray-700">↵</kbd> toggle</span>
          <span><kbd className="bg-gray-800 px-1 py-0.5 rounded border border-gray-700">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
