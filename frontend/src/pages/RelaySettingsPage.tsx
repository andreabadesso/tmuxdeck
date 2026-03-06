import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, ToggleLeft, ToggleRight, Pencil, Check, X } from 'lucide-react';
import { api } from '../api/client';
import { SettingsTabs } from '../components/SettingsTabs';
import type { RelayConfig } from '../types';

const INPUT_CLS =
  'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500 font-mono';

export function RelaySettingsPage() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingRelay, setEditingRelay] = useState<RelayConfig | null>(null);
  const [deletingRelay, setDeletingRelay] = useState<RelayConfig | null>(null);

  const { data: relays = [], error } = useQuery({
    queryKey: ['relays'],
    queryFn: () => api.listRelays(),
    refetchInterval: 5000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['relays'] });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updateRelay(id, { enabled }),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteRelay(id),
    onSuccess: () => {
      setDeletingRelay(null);
      invalidate();
    },
  });

  return (
    <div className="px-6 py-8">
      <SettingsTabs />
      <div className="max-w-2xl">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-xl font-semibold text-gray-100">Cloud Relays</h1>
          <button
            onClick={() => { setShowForm(true); setEditingRelay(null); }}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-500 transition-colors"
          >
            <Plus size={14} />
            Add Relay
          </button>
        </div>

        <p className="text-xs text-gray-500 mb-6">
          Relays let you access TmuxDeck from anywhere — no port forwarding or VPN needed.
          Each relay connects outbound to a relay server and proxies traffic to this backend.
        </p>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-red-900/30 border border-red-800 text-sm text-red-400">
            Failed to load relays: {error.message}
          </div>
        )}

        {/* Relay list */}
        {relays.length === 0 ? (
          <div className="text-center py-12 border border-dashed border-gray-800 rounded-xl">
            <p className="text-gray-500 text-sm mb-1">No relays configured</p>
            <p className="text-gray-600 text-xs">
              Add a relay to access TmuxDeck remotely via a relay server.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {relays.map((relay) => (
              <div
                key={relay.id}
                className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        !relay.enabled
                          ? 'bg-gray-600'
                          : relay.connected
                          ? 'bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)]'
                          : 'bg-gray-600'
                      }`}
                      title={!relay.enabled ? 'Disabled' : relay.connected ? 'Connected' : 'Disconnected'}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-medium ${relay.enabled ? 'text-gray-200' : 'text-gray-500'}`}>
                          {relay.name}
                        </span>
                        <span className={`text-xs ${
                          !relay.enabled ? 'text-gray-600' : relay.connected ? 'text-green-400' : 'text-gray-500'
                        }`}>
                          {!relay.enabled ? 'disabled' : relay.connected ? 'connected' : 'disconnected'}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 font-mono truncate mt-0.5">{relay.url}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => { setEditingRelay(relay); setShowForm(true); }}
                      className="p-1.5 text-gray-500 hover:text-gray-300 transition-colors"
                      title="Edit relay"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => toggleMutation.mutate({ id: relay.id, enabled: !relay.enabled })}
                      disabled={toggleMutation.isPending}
                      className={`p-1.5 transition-colors ${
                        relay.enabled ? 'text-green-400 hover:text-green-300' : 'text-gray-600 hover:text-gray-400'
                      }`}
                      title={relay.enabled ? 'Disable relay' : 'Enable relay'}
                    >
                      {relay.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                    </button>
                    <button
                      onClick={() => setDeletingRelay(relay)}
                      className="p-1.5 text-gray-500 hover:text-red-400 transition-colors"
                      title="Delete relay"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add/Edit form modal */}
      {showForm && (
        <RelayFormModal
          relay={editingRelay}
          onClose={() => { setShowForm(false); setEditingRelay(null); }}
          onSaved={invalidate}
        />
      )}

      {/* Delete confirmation modal */}
      {deletingRelay && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md mx-4">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">Delete Relay</h2>
            <p className="text-sm text-gray-400 mb-6">
              Remove <span className="text-gray-200 font-medium">{deletingRelay.name}</span>?
              The connection will be dropped immediately.
            </p>
            {deleteMutation.isError && (
              <p className="text-xs text-red-400 mb-3">{deleteMutation.error.message}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeletingRelay(null)}
                className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMutation.mutate(deletingRelay.id)}
                disabled={deleteMutation.isPending}
                className="px-4 py-2 rounded-lg text-sm bg-red-600 text-white hover:bg-red-500 transition-colors disabled:opacity-50"
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RelayFormModal({
  relay,
  onClose,
  onSaved,
}: {
  relay: RelayConfig | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(relay?.name ?? '');
  const [url, setUrl] = useState(relay?.url ?? '');
  const [token, setToken] = useState(relay?.token ?? '');
  const [enabled, setEnabled] = useState(relay?.enabled ?? true);

  const isEdit = !!relay;

  const mutation = useMutation({
    mutationFn: () =>
      isEdit
        ? api.updateRelay(relay.id, { name, url, token, enabled })
        : api.createRelay({ name, url, token, enabled }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !url.trim() || !token.trim()) return;
    mutation.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-lg mx-4">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-gray-100">
            {isEdit ? 'Edit Relay' : 'Add Relay'}
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider">Name</label>
            <input
              className={`w-full ${INPUT_CLS}`}
              style={{ fontFamily: 'inherit' }}
              placeholder="e.g. Home server"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider">Relay URL</label>
            <input
              className={`w-full ${INPUT_CLS}`}
              placeholder="wss://relay.tmuxdeck.io/ws/tunnel"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
            <p className="text-xs text-gray-600 mt-1">Use wss:// for production, ws:// for local testing</p>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5 uppercase tracking-wider">Token</label>
            <input
              className={`w-full ${INPUT_CLS}`}
              placeholder="tdck_..."
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
            />
            <p className="text-xs text-gray-600 mt-1">Get this from your relay dashboard after creating an instance</p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setEnabled(!enabled)}
              className={`transition-colors ${enabled ? 'text-green-400' : 'text-gray-600'}`}
            >
              {enabled ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
            </button>
            <span className="text-sm text-gray-400">
              {enabled ? 'Enabled — will connect on save' : 'Disabled — will not connect'}
            </span>
          </div>

          {mutation.isError && (
            <p className="text-xs text-red-400">{mutation.error.message}</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending || !name.trim() || !url.trim() || !token.trim()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Check size={14} />
              {mutation.isPending ? 'Saving...' : isEdit ? 'Save Changes' : 'Add Relay'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
