import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Copy, Check, ToggleLeft, ToggleRight, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../api/client';
import { SettingsTabs } from '../components/SettingsTabs';
import { InfoTooltip } from '../components/InfoTooltip';
import type { BridgeConfig, BridgeSettings } from '../types';

function latencyColor(ms: number | null): string {
  if (ms == null) return '#666';
  if (ms < 50) return '#4ade80';
  if (ms < 150) return '#facc15';
  return '#f87171';
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '\u2014';
  return `${Math.round(ms).toLocaleString()}ms`;
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function sparkline(samples: number[]): string {
  if (samples.length === 0) return '';
  const blocks = ' \u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const range = max - min || 1;
  return samples.map(v => blocks[Math.round(((v - min) / range) * 8)]).join('');
}

function autoTuneExplanation(
  setting: 'compression' | 'reportIntervalSec' | 'pingIntervalSec' | 'coalesceMs',
  bridge: BridgeConfig,
): string | null {
  if (!bridge.autoTune || !bridge.connected) return null;
  const p90 = bridge.latencyP90Ms;
  const jitter = bridge.latencyJitterMs;
  if (p90 == null || jitter == null) return null;

  switch (setting) {
    case 'compression':
      return p90 > 150
        ? `Enabled: P90 latency (${Math.round(p90)}ms) > 150ms suggests a slow link`
        : `Disabled: P90 latency (${Math.round(p90)}ms) \u2264 150ms, saving CPU`;
    case 'coalesceMs':
      if (p90 < 40) return `0ms: low P90 (${Math.round(p90)}ms), no buffering needed`;
      if (p90 <= 100) return `Low coalesce: moderate P90 (${Math.round(p90)}ms)`;
      if (jitter > 50) return `Higher coalesce: jitter (${Math.round(jitter)}ms) > 50ms adds extra buffer`;
      return `Scaled with P90 (${Math.round(p90)}ms) to reduce frame overhead`;
    case 'pingIntervalSec':
      if (jitter > 50) return `Fast pings: high jitter (${Math.round(jitter)}ms) needs close monitoring`;
      if (jitter > 20) return `Moderate pings: jitter (${Math.round(jitter)}ms) warrants frequent checks`;
      return `Relaxed pings: low jitter (${Math.round(jitter)}ms), connection is stable`;
    case 'reportIntervalSec':
      return jitter > 50
        ? `Faster reports: high jitter (${Math.round(jitter)}ms) needs quicker status updates`
        : `Standard interval: jitter (${Math.round(jitter)}ms) is acceptable`;
  }
}

export function BridgeSettingsPage() {
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState('');
  const [createdBridge, setCreatedBridge] = useState<BridgeConfig | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [deletingBridge, setDeletingBridge] = useState<BridgeConfig | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');

  const { data: bridges = [], error } = useQuery({
    queryKey: ['bridges'],
    queryFn: () => api.listBridges(),
    refetchInterval: 10_000,
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => api.createBridge(name),
    onSuccess: (bridge) => {
      setCreatedBridge(bridge);
      setNewName('');
      queryClient.invalidateQueries({ queryKey: ['bridges'] });
    },
  });

  const [expandedBridge, setExpandedBridge] = useState<string | null>(null);

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updateBridge(id, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bridges'] });
    },
  });

  const settingsMutation = useMutation({
    mutationFn: ({ id, settings }: { id: string; settings: BridgeSettings }) =>
      api.updateBridge(id, { settings }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bridges'] });
    },
  });

  const autoTuneMutation = useMutation({
    mutationFn: ({ id, autoTune }: { id: string; autoTune: boolean }) =>
      api.updateBridge(id, { autoTune }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bridges'] });
    },
  });

  const lanModeMutation = useMutation({
    mutationFn: ({ id, lanMode }: { id: string; lanMode: boolean }) =>
      api.updateBridge(id, { lanMode }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bridges'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteBridge(id),
    onSuccess: () => {
      setDeletingBridge(null);
      setDeleteConfirmName('');
      queryClient.invalidateQueries({ queryKey: ['bridges'] });
    },
  });

  const fallbackCopy = (text: string) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  };

  const copyToken = (token: string) => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(token).catch(() => fallbackCopy(token));
    } else {
      fallbackCopy(token);
    }
    setTokenCopied(true);
    setTimeout(() => setTokenCopied(false), 2000);
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setCreatedBridge(null);
    createMutation.mutate(name);
  };

  return (
    <div className="px-6 py-8">
      <SettingsTabs />
      <div className="max-w-2xl">
        <h1 className="text-xl font-semibold text-gray-100 mb-8">Bridges</h1>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-red-900/30 border border-red-800 text-sm text-red-400">
            Failed to load bridges: {error.message}
          </div>
        )}

        {/* Create form */}
        <form onSubmit={handleCreate} className="flex items-center gap-2 mb-6">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Bridge name"
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500"
          />
          <button
            type="submit"
            disabled={!newName.trim() || createMutation.isPending}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus size={14} />
            Create
          </button>
        </form>

        {createMutation.isError && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-red-900/30 border border-red-800 text-sm text-red-400">
            {createMutation.error.message}
          </div>
        )}

        {/* Token display (shown once on creation) */}
        {createdBridge?.token && (
          <div className="mb-6 px-4 py-3 rounded-lg bg-yellow-900/20 border border-yellow-800/50">
            <p className="text-sm text-yellow-300 mb-2">
              Bridge token for <span className="font-medium">{createdBridge.name}</span> — copy it now, it won't be shown again:
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-gray-900 rounded px-3 py-2 text-sm text-gray-200 font-mono break-all select-all">
                {createdBridge.token}
              </code>
              <button
                onClick={() => copyToken(createdBridge.token!)}
                className="flex items-center gap-1 px-2.5 py-2 rounded-md text-xs text-gray-400 hover:text-gray-200 transition-colors"
                title="Copy token"
              >
                {tokenCopied ? (
                  <>
                    <Check size={14} className="text-green-400" />
                    <span className="text-green-400">Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy size={14} />
                    <span>Copy</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Bridge list */}
        <div>
          <label className="block text-sm text-gray-400 mb-2">Configured Bridges</label>
          {bridges.length === 0 ? (
            <p className="text-xs text-gray-600">
              No bridges configured yet. Create one above to connect a remote agent.
            </p>
          ) : (
            <div className="space-y-1">
              {bridges.map((bridge) => {
                const isExpanded = expandedBridge === bridge.id;
                const s = bridge.settings ?? {};
                const neg = bridge.negotiatedSettings;
                return (
                <div
                  key={bridge.id}
                  className="bg-gray-800 border border-gray-700 rounded-lg"
                >
                  <div className="flex items-center justify-between px-3 py-2">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => setExpandedBridge(isExpanded ? null : bridge.id)}
                        className="text-gray-500 hover:text-gray-300 transition-colors"
                      >
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                      <span
                        className={`w-2 h-2 rounded-full ${
                          !bridge.enabled ? 'bg-gray-600' : bridge.connected ? 'bg-green-500' : 'bg-gray-600'
                        }`}
                        title={!bridge.enabled ? 'Disabled' : bridge.connected ? 'Online' : 'Offline'}
                      />
                      <span className={`text-sm ${bridge.enabled ? 'text-gray-200' : 'text-gray-500'}`}>
                        {bridge.name}
                      </span>
                      <span className={`text-xs ${
                        !bridge.enabled ? 'text-gray-600' : bridge.connected ? 'text-green-400' : 'text-gray-500'
                      }`}>
                        {!bridge.enabled ? 'Disabled' : bridge.connected ? 'Online' : 'Offline'}
                      </span>
                      {bridge.lanMode && <span className="text-xs text-green-400 bg-green-900/30 px-1.5 rounded font-medium">LAN</span>}
                      <span className="text-xs text-gray-600">
                        {new Date(bridge.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => toggleMutation.mutate({ id: bridge.id, enabled: !bridge.enabled })}
                        disabled={toggleMutation.isPending}
                        className={`p-1 transition-colors ${
                          bridge.enabled
                            ? 'text-green-400 hover:text-green-300'
                            : 'text-gray-600 hover:text-gray-400'
                        }`}
                        title={bridge.enabled ? 'Disable bridge' : 'Enable bridge'}
                      >
                        {bridge.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                      </button>
                      <button
                        onClick={() => {
                          setDeletingBridge(bridge);
                          setDeleteConfirmName('');
                          deleteMutation.reset();
                        }}
                        className="p-1 text-gray-500 hover:text-red-400 transition-colors"
                        title="Delete bridge"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="border-t border-gray-700 px-4 py-3 space-y-3">
                      <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide">Settings</h3>
                      {/* LAN mode toggle */}
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="text-sm text-gray-300">LAN mode</span>
                          <InfoTooltip text="Optimizes for low-latency local networks: disables compression, sets zero coalescing, and disables auto-tune. Use when the bridge is on the same LAN." />
                        </div>
                        <button
                          onClick={() => lanModeMutation.mutate({ id: bridge.id, lanMode: !bridge.lanMode })}
                          disabled={lanModeMutation.isPending}
                          className={`p-1 transition-colors ${
                            bridge.lanMode ? 'text-green-400 hover:text-green-300' : 'text-gray-600 hover:text-gray-400'
                          }`}
                        >
                          {bridge.lanMode ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                        </button>
                      </div>
                      {bridge.lanMode && (
                        <p className="text-xs text-green-400/70 italic -mt-1 pl-1">Compression off, zero coalescing, auto-tune disabled</p>
                      )}
                      {/* Auto-tune toggle */}
                      <div className="flex items-center justify-between">
                        <div>
                          <span className={`text-sm ${bridge.lanMode ? 'text-gray-500' : 'text-gray-300'}`}>Auto-tune</span>
                          <InfoTooltip text="Automatically adjusts settings based on measured latency and jitter. Requires at least 5 latency samples." />
                          {bridge.lanMode && <span className="ml-2 text-xs text-gray-600">disabled by LAN mode</span>}
                        </div>
                        <button
                          onClick={() => autoTuneMutation.mutate({ id: bridge.id, autoTune: !bridge.autoTune })}
                          disabled={autoTuneMutation.isPending || bridge.lanMode}
                          className={`p-1 transition-colors ${
                            bridge.lanMode
                              ? 'text-gray-600 cursor-not-allowed'
                              : bridge.autoTune ? 'text-blue-400 hover:text-blue-300' : 'text-gray-600 hover:text-gray-400'
                          }`}
                        >
                          {bridge.autoTune && !bridge.lanMode ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        {/* Compression toggle */}
                        {(() => { const locked = !!(bridge.lanMode || bridge.autoTune); return (
                        <div className="flex items-center justify-between col-span-2">
                          <div>
                            <span className={`text-sm ${locked ? 'text-gray-400' : 'text-gray-300'}`}>Compression</span>
                            <InfoTooltip text="Compresses WebSocket frames. Reduces bandwidth at the cost of CPU. Best for high-latency or bandwidth-constrained links." />
                            {bridge.lanMode && <span className="ml-2 text-green-400 bg-green-900/30 px-1 rounded text-xs">LAN</span>}
                            {!bridge.lanMode && bridge.autoTune && <span className="ml-2 text-blue-400 bg-blue-900/30 px-1 rounded text-xs">auto</span>}
                            {neg && <span className="ml-2 text-xs text-gray-500">active: {neg.compression ? 'on' : 'off'}</span>}
                          </div>
                          <button
                            onClick={() => settingsMutation.mutate({
                              id: bridge.id,
                              settings: { compression: !(s.compression ?? false) },
                            })}
                            disabled={settingsMutation.isPending || locked}
                            className={`p-1 transition-colors ${
                              locked
                                ? (neg?.compression ?? s.compression ?? false) ? 'text-green-400/50 cursor-not-allowed' : 'text-gray-600 cursor-not-allowed'
                                : (s.compression ?? false) ? 'text-green-400 hover:text-green-300' : 'text-gray-600 hover:text-gray-400'
                            }`}
                          >
                            {(locked ? (neg?.compression ?? s.compression ?? false) : (s.compression ?? false))
                              ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
                          </button>
                        </div>
                        ); })()}
                        {bridge.autoTune && !bridge.lanMode && autoTuneExplanation('compression', bridge) && (
                          <p className="col-span-2 -mt-2 text-xs text-blue-400/70 italic pl-1">{autoTuneExplanation('compression', bridge)}</p>
                        )}
                        {/* Report interval */}
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">
                            Report interval (sec)
                            <InfoTooltip text="How often the bridge reports session/terminal status. Lower = faster UI updates but more traffic." />
                            {bridge.autoTune && <span className="ml-1 text-blue-400 bg-blue-900/30 px-1 rounded text-xs">auto</span>}
                            {!bridge.autoTune && neg && <span className="ml-1 text-gray-600">active: {neg.reportIntervalSec}</span>}
                          </label>
                          <input
                            type="number"
                            min={1}
                            max={60}
                            step={0.5}
                            {...(bridge.autoTune
                              ? { value: neg?.reportIntervalSec ?? s.reportIntervalSec ?? 5, readOnly: true }
                              : { defaultValue: s.reportIntervalSec ?? 5, key: `report-${bridge.id}-manual` }
                            )}
                            onBlur={(e) => {
                              if (bridge.autoTune) return;
                              const v = parseFloat(e.target.value);
                              if (!isNaN(v) && v >= 1 && v <= 60) {
                                settingsMutation.mutate({ id: bridge.id, settings: { reportIntervalSec: v } });
                              }
                            }}
                            disabled={bridge.autoTune}
                            className={`w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm outline-none ${bridge.autoTune ? 'text-blue-300/70 cursor-not-allowed' : 'text-gray-200 focus:border-blue-500'}`}
                          />
                          {bridge.autoTune && autoTuneExplanation('reportIntervalSec', bridge) && (
                            <p className="mt-1 text-xs text-blue-400/70 italic">{autoTuneExplanation('reportIntervalSec', bridge)}</p>
                          )}
                        </div>
                        {/* Ping interval */}
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">
                            Ping interval (sec)
                            <InfoTooltip text="How often the server pings the bridge for latency measurement. Lower = faster detection of connection issues." />
                            {bridge.autoTune && <span className="ml-1 text-blue-400 bg-blue-900/30 px-1 rounded text-xs">auto</span>}
                            {!bridge.autoTune && neg && <span className="ml-1 text-gray-600">active: {neg.pingIntervalSec}</span>}
                          </label>
                          <input
                            type="number"
                            min={2}
                            max={120}
                            step={1}
                            {...(bridge.autoTune
                              ? { value: neg?.pingIntervalSec ?? s.pingIntervalSec ?? 10, readOnly: true }
                              : { defaultValue: s.pingIntervalSec ?? 10, key: `ping-${bridge.id}-manual` }
                            )}
                            onBlur={(e) => {
                              if (bridge.autoTune) return;
                              const v = parseFloat(e.target.value);
                              if (!isNaN(v) && v >= 2 && v <= 120) {
                                settingsMutation.mutate({ id: bridge.id, settings: { pingIntervalSec: v } });
                              }
                            }}
                            disabled={bridge.autoTune}
                            className={`w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm outline-none ${bridge.autoTune ? 'text-blue-300/70 cursor-not-allowed' : 'text-gray-200 focus:border-blue-500'}`}
                          />
                          {bridge.autoTune && autoTuneExplanation('pingIntervalSec', bridge) && (
                            <p className="mt-1 text-xs text-blue-400/70 italic">{autoTuneExplanation('pingIntervalSec', bridge)}</p>
                          )}
                        </div>
                        {/* Coalesce ms */}
                        {(() => { const locked = !!(bridge.lanMode || bridge.autoTune); return (
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">
                            I/O coalesce (ms)
                            <InfoTooltip text="Buffers terminal output before sending to reduce frame overhead. Higher = fewer frames but more output latency." />
                            {bridge.lanMode && <span className="ml-1 text-green-400 bg-green-900/30 px-1 rounded text-xs">LAN</span>}
                            {!bridge.lanMode && bridge.autoTune && <span className="ml-1 text-blue-400 bg-blue-900/30 px-1 rounded text-xs">auto</span>}
                            {!locked && neg && <span className="ml-1 text-gray-600">active: {neg.coalesceMs}</span>}
                          </label>
                          <input
                            type="number"
                            min={0}
                            max={50}
                            step={1}
                            {...(locked
                              ? { value: bridge.lanMode ? 0 : (neg?.coalesceMs ?? s.coalesceMs ?? 0), readOnly: true }
                              : { defaultValue: s.coalesceMs ?? 0, key: `coalesce-${bridge.id}-manual` }
                            )}
                            onBlur={(e) => {
                              if (locked) return;
                              const v = parseInt(e.target.value, 10);
                              if (!isNaN(v) && v >= 0 && v <= 50) {
                                settingsMutation.mutate({ id: bridge.id, settings: { coalesceMs: v } });
                              }
                            }}
                            disabled={locked}
                            className={`w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm outline-none ${locked ? (bridge.lanMode ? 'text-green-300/70 cursor-not-allowed' : 'text-blue-300/70 cursor-not-allowed') : 'text-gray-200 focus:border-blue-500'}`}
                          />
                          {bridge.autoTune && !bridge.lanMode && autoTuneExplanation('coalesceMs', bridge) && (
                            <p className="mt-1 text-xs text-blue-400/70 italic">{autoTuneExplanation('coalesceMs', bridge)}</p>
                          )}
                        </div>
                        ); })()}
                      </div>
                      {settingsMutation.isError && (
                        <p className="text-xs text-red-400">{settingsMutation.error.message}</p>
                      )}

                      {/* Network Statistics */}
                      <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide pt-3 border-t border-gray-700">
                        Network Statistics
                      </h3>
                      {bridge.connected && bridge.latencyLastMs != null ? (
                        <>
                          <div className="grid grid-cols-4 gap-2">
                            {([
                              ['Current', bridge.latencyLastMs],
                              ['Min', bridge.latencyMinMs],
                              ['Max', bridge.latencyMaxMs],
                              ['Jitter', bridge.latencyJitterMs],
                              ['P90', bridge.latencyP90Ms],
                              ['P95', bridge.latencyP95Ms],
                              ['P99', bridge.latencyP99Ms],
                            ] as const).map(([label, val]) => (
                              <div key={label} className="text-center">
                                <div className="text-xs text-gray-500">{label}</div>
                                <div
                                  className="text-sm font-mono"
                                  style={{ color: label === 'Current' ? latencyColor(val ?? null) : '#e4e4e7' }}
                                >
                                  {formatMs(val)}
                                </div>
                              </div>
                            ))}
                          </div>
                          {bridge.latencyHistory.length > 0 && (
                            <div className="font-mono text-sm tracking-wider text-gray-300" title="Latency history">
                              {sparkline(bridge.latencyHistory)}
                            </div>
                          )}
                          {(bridge.wsRxBinFrames > 0 || bridge.wsRxTextFrames > 0) && (
                            <div className="grid grid-cols-3 gap-2">
                              <div className="text-center">
                                <div className="text-xs text-gray-500">RX binary</div>
                                <div className="text-sm font-mono text-gray-200">
                                  {bridge.wsRxBinFrames} <span className="text-gray-500">({formatBytes(bridge.wsRxBinBytes)})</span>
                                </div>
                              </div>
                              <div className="text-center">
                                <div className="text-xs text-gray-500">RX text</div>
                                <div className="text-sm font-mono text-gray-200">{bridge.wsRxTextFrames}</div>
                              </div>
                              <div className="text-center">
                                <div className="text-xs text-gray-500">Fwd tasks</div>
                                <div className="text-sm font-mono text-gray-200">{bridge.wsFwdTasks}</div>
                              </div>
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="text-xs text-gray-600">
                          {bridge.connected ? 'Waiting for latency data\u2026' : 'Bridge is offline'}
                        </p>
                      )}
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation modal */}
      {deletingBridge && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md mx-4">
            <h2 className="text-lg font-semibold text-gray-100 mb-2">Delete Bridge</h2>
            <p className="text-sm text-gray-400 mb-4">
              This will permanently delete the bridge and revoke its token. Type{' '}
              <code className="text-gray-200 bg-gray-800 px-1.5 py-0.5 rounded">{deletingBridge.name}</code>{' '}
              to confirm.
            </p>
            <input
              type="text"
              value={deleteConfirmName}
              onChange={(e) => setDeleteConfirmName(e.target.value)}
              placeholder={deletingBridge.name}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-red-500 mb-4"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setDeletingBridge(null);
                  setDeleteConfirmName('');
                }
              }}
            />
            {deleteMutation.isError && (
              <p className="text-xs text-red-400 mb-3">{deleteMutation.error.message}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setDeletingBridge(null);
                  setDeleteConfirmName('');
                }}
                className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMutation.mutate(deletingBridge.id)}
                disabled={deleteConfirmName !== deletingBridge.name || deleteMutation.isPending}
                className="px-4 py-2 rounded-lg text-sm bg-red-600 text-white hover:bg-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
