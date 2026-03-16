import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { BridgeConfig } from '../types';

function latencyColor(ms: number | null): string {
  if (ms == null) return '#666';
  if (ms < 50) return '#4ade80';   // green
  if (ms < 150) return '#facc15';  // yellow
  return '#f87171';                 // red
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return `${Math.round(ms).toLocaleString()}ms`;
}

function sparkline(samples: number[]): string {
  if (samples.length === 0) return '';
  const blocks = ' ▁▂▃▄▅▆▇█';
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const range = max - min || 1;
  return samples
    .map(v => blocks[Math.round(((v - min) / range) * 8)])
    .join('');
}

interface Props {
  bridgeId: string;
}

export function BridgeLatencyOverlay({ bridgeId }: Props) {
  const [expanded, setExpanded] = useState(false);

  const { data: bridges } = useQuery({
    queryKey: ['bridges'],
    queryFn: () => api.listBridges(),
    staleTime: 10_000,
    refetchInterval: 10_000,
  });

  const bridge: BridgeConfig | undefined = bridges?.find(b => b.id === bridgeId);
  const latency = bridge?.latencyLastMs ?? null;

  if (!bridge?.connected || latency == null) return null;

  const color = latencyColor(latency);

  return (
    <div className="relative">
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-1 px-1.5 py-1.5 rounded bg-gray-800/80 text-gray-500 hover:text-gray-200 hover:bg-gray-700/90 transition-colors font-mono text-xs"
        title="Bridge latency"
      >
        <span
          className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: color }}
        />
        <span>{formatMs(latency)}</span>
      </button>
      {expanded && (
        <div
          className="absolute top-full right-0 mt-1 rounded-lg text-xs font-mono select-none"
          style={{ background: 'rgba(0,0,0,0.9)', backdropFilter: 'blur(4px)', padding: '8px 12px', minWidth: 180, zIndex: 50 }}
        >
          <div className="flex items-center gap-2 mb-2">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: color }}
            />
            <span style={{ color: '#e4e4e7', fontWeight: 600 }}>Bridge Latency</span>
          </div>
          <div className="grid gap-1" style={{ gridTemplateColumns: 'auto 1fr', color: '#a1a1aa' }}>
            <span>Current</span><span style={{ color: '#e4e4e7', textAlign: 'right' }}>{formatMs(bridge.latencyLastMs)}</span>
            <span>Min</span><span style={{ color: '#e4e4e7', textAlign: 'right' }}>{formatMs(bridge.latencyMinMs)}</span>
            <span>Max</span><span style={{ color: '#e4e4e7', textAlign: 'right' }}>{formatMs(bridge.latencyMaxMs)}</span>
            <span>P90</span><span style={{ color: '#e4e4e7', textAlign: 'right' }}>{formatMs(bridge.latencyP90Ms)}</span>
            <span>P95</span><span style={{ color: '#e4e4e7', textAlign: 'right' }}>{formatMs(bridge.latencyP95Ms)}</span>
            <span>P99</span><span style={{ color: '#e4e4e7', textAlign: 'right' }}>{formatMs(bridge.latencyP99Ms)}</span>
            <span>Jitter</span><span style={{ color: '#e4e4e7', textAlign: 'right' }}>{formatMs(bridge.latencyJitterMs)}</span>
          </div>
          {bridge.latencyHistory.length > 0 && (
            <div className="mt-2 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.1)', color: '#e4e4e7', letterSpacing: '0.5px' }}>
              {sparkline(bridge.latencyHistory)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
