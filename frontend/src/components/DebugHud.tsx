import { useEffect, useState, useRef, type MutableRefObject } from 'react';
import { E2EWebSocket } from '../utils/e2eCrypto';

const DEBUG_STORAGE_KEY = 'tmuxdeck-debug-hud';
const PING_INTERVAL_MS = 3000;

export function useDebugMode(): [boolean, () => void] {
  const [enabled, setEnabled] = useState(
    () => localStorage.getItem(DEBUG_STORAGE_KEY) === '1',
  );
  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    if (next) {
      localStorage.setItem(DEBUG_STORAGE_KEY, '1');
    } else {
      localStorage.removeItem(DEBUG_STORAGE_KEY);
    }
  };
  return [enabled, toggle];
}

type WsLike = {
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  readonly readyState: number;
};

interface DebugHudProps {
  wsRef: MutableRefObject<WsLike | null>;
}

export function DebugHud({ wsRef }: DebugHudProps) {
  const [latency, setLatency] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [e2eInfo, setE2eInfo] = useState<{ encrypted: boolean; cipher: string; messagesSent: number; messagesReceived: number } | null>(null);
  const pendingPings = useRef<Map<string, number>>(new Map());

  // Ping interval — reads wsRef.current each tick so it always uses the latest WS
  useEffect(() => {
    const interval = setInterval(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        setConnected(false);
        return;
      }
      setConnected(true);

      // Update E2E info
      if (ws instanceof E2EWebSocket) {
        setE2eInfo(ws.debugInfo);
      }

      const id = String(performance.now());
      pendingPings.current.set(id, performance.now());
      ws.send(`PING:${id}`);
    }, PING_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [wsRef]);

  // Expose pong handler for the Terminal to call
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__debugHudPong = (timestamp: string) => {
      const sent = pendingPings.current.get(timestamp);
      if (sent !== undefined) {
        pendingPings.current.delete(timestamp);
        setLatency(Math.round(performance.now() - sent));
      }
    };
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).__debugHudPong;
    };
  }, []);

  return (
    <div
      className="absolute top-1 right-1 z-30 flex items-center gap-2 px-2 py-1 rounded text-[10px] font-mono select-none pointer-events-none"
      style={{
        background: 'rgba(0, 0, 0, 0.7)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        backdropFilter: 'blur(4px)',
      }}
    >
      {/* Connection status */}
      <span className={connected ? 'text-green-400' : 'text-red-400'}>
        {connected ? 'CONN' : 'DISC'}
      </span>

      {/* Latency */}
      <span className={
        latency === null ? 'text-gray-500' :
        latency < 50 ? 'text-green-400' :
        latency < 150 ? 'text-yellow-400' :
        'text-red-400'
      }>
        {latency !== null ? `${latency}ms` : '--'}
      </span>

      {/* E2E status */}
      {e2eInfo ? (
        <span className={e2eInfo.encrypted ? 'text-green-400' : 'text-yellow-400'}>
          {e2eInfo.encrypted ? `E2E ${e2eInfo.cipher}` : 'E2E...'}
        </span>
      ) : (
        <span className="text-gray-500">NO E2E</span>
      )}

      {/* Message counts when E2E is active */}
      {e2eInfo?.encrypted && (
        <span className="text-gray-500">
          tx:{e2eInfo.messagesSent} rx:{e2eInfo.messagesReceived}
        </span>
      )}
    </div>
  );
}
