import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Pencil, Search } from 'lucide-react';
import type { Workspace } from '../types';

interface WorkspaceTabsProps {
  workspaces: Workspace[];
  workspaceOrder: string[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onAddMember?: () => void;
}

export function WorkspaceTabs({
  workspaces,
  workspaceOrder,
  activeId,
  onSelect,
  onCreate,
  onAddMember,
}: WorkspaceTabsProps) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState('');
  const createRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating && createRef.current) createRef.current.focus();
  }, [creating]);

  const ordered = workspaceOrder
    .map((id) => workspaces.find((w) => w.id === id))
    .filter((w): w is Workspace => !!w);

  const orderedIds = new Set(workspaceOrder);
  for (const ws of workspaces) {
    if (!orderedIds.has(ws.id)) ordered.push(ws);
  }

  const handleCreate = () => {
    const name = createName.trim();
    if (name) {
      onCreate(name);
    }
    setCreating(false);
    setCreateName('');
  };

  return (
    <div className="flex items-center gap-0.5 px-2 py-1 border-b border-gray-800 overflow-x-auto scrollbar-hide">
      {ordered.map((ws) => (
        <button
          key={ws.id}
          onClick={() => onSelect(ws.id)}
          className={`text-xs px-2 py-0.5 rounded transition-colors shrink-0 ${
            activeId === ws.id
              ? 'bg-gray-800 text-blue-400 border-b-2 border-blue-500'
              : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
          }`}
        >
          {ws.name}
        </button>
      ))}

      {creating ? (
        <input
          ref={createRef}
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          onBlur={handleCreate}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCreate();
            if (e.key === 'Escape') { setCreating(false); setCreateName(''); }
          }}
          placeholder="name"
          className="bg-gray-800 text-xs text-gray-200 px-1.5 py-0.5 rounded border border-gray-600 outline-none focus:border-blue-500 w-20 shrink-0"
        />
      ) : (
        <button
          onClick={() => setCreating(true)}
          className="p-0.5 text-gray-500 hover:text-gray-300 transition-colors shrink-0"
          title="New workspace"
        >
          <Plus size={12} />
        </button>
      )}

      {onAddMember && (
        <button
          onClick={onAddMember}
          className="p-0.5 text-gray-500 hover:text-gray-300 transition-colors shrink-0"
          title="Add source or session"
        >
          <Search size={11} />
        </button>
      )}

      <button
        onClick={() => navigate('/settings/workspaces')}
        className="p-0.5 ml-auto text-gray-600 hover:text-gray-400 transition-colors shrink-0"
        title="Manage workspaces"
      >
        <Pencil size={10} />
      </button>
    </div>
  );
}
