import { useState, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Trash2,
  Pencil,
  X,
  ChevronUp,
  ChevronDown,
  Monitor,
  Radio,
  TerminalSquare,
  Terminal as TerminalIcon,
} from 'lucide-react';
import { api } from '../api/client';
import { SettingsTabs } from '../components/SettingsTabs';
import { WorkspaceAddMemberDialog } from '../components/WorkspaceAddMemberDialog';
import { DockerIcon } from '../components/icons/DockerIcon';
import type { Workspace, WorkspaceMember, Container } from '../types';

function MemberIcon({ member, containers }: { member: WorkspaceMember; containers: Container[] }) {
  if (member.type === 'session') {
    return <TerminalIcon size={14} className="text-gray-400 shrink-0" />;
  }
  const container = containers.find((c) => c.id === member.sourceId);
  const ctype = container?.containerType;
  switch (ctype) {
    case 'host': return <Monitor size={14} className="text-blue-400 shrink-0" />;
    case 'local': return <TerminalSquare size={14} className="text-green-400 shrink-0" />;
    case 'bridge': return <Radio size={14} className="text-purple-400 shrink-0" />;
    default: return <DockerIcon size={14} />;
  }
}

export function WorkspacesPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingWs, setDeletingWs] = useState<Workspace | null>(null);
  const [addingMembersTo, setAddingMembersTo] = useState<Workspace | null>(null);
  const createRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  const { data: workspacesData, error } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.listWorkspaces(),
    staleTime: 10_000,
  });

  const { data: containersData } = useQuery({
    queryKey: ['containers'],
    queryFn: () => api.listContainers(),
  });

  const workspaces = workspacesData?.workspaces ?? [];
  const workspaceOrder = workspacesData?.workspaceOrder ?? [];
  const containers = containersData?.containers ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['workspaces'] });

  // Order workspaces by workspaceOrder
  const ordered = workspaceOrder
    .map((id) => workspaces.find((w) => w.id === id))
    .filter((w): w is Workspace => !!w);
  const orderedIds = new Set(workspaceOrder);
  for (const ws of workspaces) {
    if (!orderedIds.has(ws.id)) ordered.push(ws);
  }

  useEffect(() => {
    if (creating && createRef.current) createRef.current.focus();
  }, [creating]);

  useEffect(() => {
    if (renamingId && renameRef.current) renameRef.current.focus();
  }, [renamingId]);

  const handleCreate = async () => {
    const name = createName.trim();
    if (name) {
      await api.createWorkspace(name);
      invalidate();
    }
    setCreating(false);
    setCreateName('');
  };

  const handleRename = async (id: string) => {
    const name = renameValue.trim();
    if (name) {
      await api.updateWorkspace(id, { name });
      invalidate();
    }
    setRenamingId(null);
    setRenameValue('');
  };

  const handleDelete = async (id: string) => {
    await api.deleteWorkspace(id);
    setDeletingWs(null);
    invalidate();
  };

  const handleRemoveMember = async (ws: Workspace, member: WorkspaceMember) => {
    const newMembers = ws.members.filter((m) => {
      if (member.type === 'source') {
        return !(m.type === 'source' && m.sourceId === member.sourceId);
      }
      return !(m.type === 'session' && m.sourceId === member.sourceId && 'sessionId' in m && 'sessionId' in member && m.sessionId === member.sessionId);
    });
    await api.updateWorkspace(ws.id, { members: newMembers });
    invalidate();
  };

  const handleMoveWorkspace = async (wsId: string, direction: -1 | 1) => {
    const currentOrder = ordered.map((w) => w.id);
    const idx = currentOrder.indexOf(wsId);
    const targetIdx = idx + direction;
    // Don't move past "all" (index 0) or out of bounds
    if (targetIdx < 1 || targetIdx >= currentOrder.length) return;
    const newOrder = [...currentOrder];
    [newOrder[idx], newOrder[targetIdx]] = [newOrder[targetIdx], newOrder[idx]];
    await api.saveWorkspaceOrder(newOrder);
    invalidate();
  };

  const handleUpdateMembers = async (members: WorkspaceMember[]) => {
    if (!addingMembersTo) return;
    await api.updateWorkspace(addingMembersTo.id, { members });
    invalidate();
  };

  return (
    <div className="px-6 py-8">
      <SettingsTabs />
      <div className="max-w-2xl">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-xl font-semibold text-gray-100">Workspaces</h1>
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-500 transition-colors"
          >
            <Plus size={14} />
            New Workspace
          </button>
        </div>

        <p className="text-xs text-gray-500 mb-6">
          Workspaces filter the sidebar to show only selected sources and sessions.
          Adding a source includes all its current and future sessions.
        </p>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-red-900/30 border border-red-800 text-sm text-red-400">
            Failed to load workspaces: {error.message}
          </div>
        )}

        {creating && (
          <div className="mb-4 bg-gray-800 border border-gray-700 rounded-lg px-4 py-3">
            <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider">Workspace name</label>
            <div className="flex items-center gap-2">
              <input
                ref={createRef}
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                  if (e.key === 'Escape') { setCreating(false); setCreateName(''); }
                }}
                placeholder="e.g. Work, Personal"
                className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500"
                autoFocus
              />
              <button
                onClick={handleCreate}
                disabled={!createName.trim()}
                className="px-3 py-2 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-50"
              >
                Create
              </button>
              <button
                onClick={() => { setCreating(false); setCreateName(''); }}
                className="px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="space-y-3">
          {ordered.map((ws, wsIndex) => (
            <div key={ws.id} className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-3">
              {/* Workspace header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  {renamingId === ws.id ? (
                    <input
                      ref={renameRef}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => handleRename(ws.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRename(ws.id);
                        if (e.key === 'Escape') { setRenamingId(null); setRenameValue(''); }
                      }}
                      className="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm text-gray-200 outline-none focus:border-blue-500"
                    />
                  ) : (
                    <span className="text-sm font-medium text-gray-200">{ws.name}</span>
                  )}
                  {ws.isDefault && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-700 text-gray-400">default</span>
                  )}
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  {!ws.isDefault && (
                    <>
                      <button
                        onClick={() => handleMoveWorkspace(ws.id, -1)}
                        disabled={wsIndex <= 1} // can't move above "all" (index 0) or if already at index 1
                        className="p-1 text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-30 disabled:cursor-default"
                        title="Move up"
                      >
                        <ChevronUp size={14} />
                      </button>
                      <button
                        onClick={() => handleMoveWorkspace(ws.id, 1)}
                        disabled={wsIndex >= ordered.length - 1}
                        className="p-1 text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-30 disabled:cursor-default"
                        title="Move down"
                      >
                        <ChevronDown size={14} />
                      </button>
                      <button
                        onClick={() => { setRenameValue(ws.name); setRenamingId(ws.id); }}
                        className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
                        title="Rename workspace"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => setDeletingWs(ws)}
                        className="p-1 text-gray-500 hover:text-red-400 transition-colors"
                        title="Delete workspace"
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Members */}
              {!ws.isDefault && (
                <div className="mt-3 border-t border-gray-700 pt-3">
                  {ws.members.length === 0 ? (
                    <p className="text-xs text-gray-600 italic">No members</p>
                  ) : (
                    <div className="space-y-1">
                      {ws.members.map((member) => {
                        const key = member.type === 'source'
                          ? `source:${member.sourceId}`
                          : `session:${member.sourceId}:${member.sessionId}`;
                        return (
                          <div key={key} className="flex items-center gap-2 group py-0.5">
                            <MemberIcon member={member} containers={containers} />
                            <span className="text-sm text-gray-300 truncate flex-1">{member.displayName}</span>
                            <span className="text-[10px] text-gray-600 shrink-0">{member.type}</span>
                            <button
                              onClick={() => handleRemoveMember(ws, member)}
                              className="p-0.5 text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                              title="Remove member"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <button
                    onClick={() => setAddingMembersTo(ws)}
                    className="flex items-center gap-1.5 mt-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                  >
                    <Plus size={12} />
                    Add member
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Delete confirmation */}
      {deletingWs && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md mx-4">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">Delete Workspace</h2>
            <p className="text-sm text-gray-400 mb-6">
              Remove <span className="text-gray-200 font-medium">{deletingWs.name}</span>?
              This will not affect any containers or sessions.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeletingWs(null)}
                className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deletingWs.id)}
                className="px-4 py-2 rounded-lg text-sm bg-red-600 text-white hover:bg-red-500 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add member dialog */}
      {addingMembersTo && (
        <WorkspaceAddMemberDialog
          workspace={addingMembersTo}
          containers={containers}
          onClose={() => setAddingMembersTo(null)}
          onUpdateMembers={handleUpdateMembers}
        />
      )}
    </div>
  );
}
