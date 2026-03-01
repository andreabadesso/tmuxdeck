import { useEffect, useRef, useImperativeHandle, useCallback, forwardRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Keyboard, Type, MousePointer2, Copy } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

const IS_TOUCH_DEVICE = typeof window !== 'undefined' &&
  ('ontouchstart' in window || navigator.maxTouchPoints > 0);

export interface TerminalHandle {
  focus: () => void;
  refit: () => void;
}

interface TerminalProps {
  containerId: string;
  sessionName: string;
  windowIndex: number;
  autoFocus?: boolean;
  visible?: boolean;
  onOpenFile?: (path: string) => void;
}

const IS_MOCK = import.meta.env.VITE_USE_MOCK === 'true';

const RECONNECT_INITIAL_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 10_000;
const RECONNECT_BACKOFF_FACTOR = 1.5;
const RECONNECT_MAX_ATTEMPTS = 15;

const THEME = {
  background: '#0a0a0a',
  foreground: '#e4e4e7',
  cursor: '#e4e4e7',
  selectionBackground: '#3b82f680',
  black: '#09090b',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#e4e4e7',
  brightBlack: '#71717a',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#facc15',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#fafafa',
};

function setupMockTerminal(term: XTerm, containerId: string, sessionName: string) {
  term.writeln(`\x1b[1;34m[TmuxDeck]\x1b[0m Connected to \x1b[1;32m${sessionName}\x1b[0m in container \x1b[1;33m${containerId.slice(0, 12)}\x1b[0m`);
  term.writeln('');

  let currentLine = '';
  const writePrompt = () => {
    term.write(`\x1b[1;32muser@${sessionName}\x1b[0m:\x1b[1;34m/workspace\x1b[0m$ `);
  };
  writePrompt();

  term.onData((data) => {
    if (data === '\r') {
      term.writeln('');
      if (currentLine.trim()) {
        if (currentLine.trim() === 'clear') {
          term.clear();
        } else if (currentLine.trim() === 'help') {
          term.writeln('\x1b[1mMock Terminal\x1b[0m - This is a simulated terminal.');
          term.writeln('In production, this connects to a real tmux session via WebSocket.');
          term.writeln('');
          term.writeln('Try: ls, pwd, whoami, date, echo <text>');
        } else if (currentLine.trim() === 'ls') {
          term.writeln('\x1b[1;34msrc\x1b[0m  \x1b[1;34mnode_modules\x1b[0m  package.json  tsconfig.json  README.md');
        } else if (currentLine.trim() === 'pwd') {
          term.writeln('/workspace');
        } else if (currentLine.trim() === 'whoami') {
          term.writeln('root');
        } else if (currentLine.trim() === 'date') {
          term.writeln(new Date().toString());
        } else if (currentLine.trim().startsWith('tmuxdeck-open ')) {
          const file = currentLine.trim().slice('tmuxdeck-open '.length).trim();
          if (file) {
            // Write the OSC 7337 sequence so the registered handler fires
            const absPath = file.startsWith('/') ? file : `/workspace/${file}`;
            term.write(`\x1b]7337;${absPath}\x07`);
          } else {
            term.writeln('Usage: tmuxdeck-open <file>');
          }
        } else if (currentLine.trim().startsWith('echo ')) {
          term.writeln(currentLine.trim().slice(5));
        } else {
          term.writeln(`bash: ${currentLine.trim().split(' ')[0]}: command not found`);
        }
      }
      currentLine = '';
      writePrompt();
    } else if (data === '\x7f') {
      if (currentLine.length > 0) {
        currentLine = currentLine.slice(0, -1);
        term.write('\b \b');
      }
    } else if (data >= ' ') {
      currentLine += data;
      term.write(data);
    }
  });
}

interface BellWarning {
  bellAction?: string;
  visualBell?: string;
}

function connectWebSocket(
  wsUrl: string,
  term: XTerm,
  fitAddon: FitAddon,
  onMouseWarning: (enabled: boolean) => void,
  onBellWarning: (warning: BellWarning | null) => void,
  onConnected: (ws: WebSocket) => void,
  onDisconnected: () => void,
): { ws: WebSocket; close: () => void } {
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    onConnected(ws);
    // Defer RESIZE so the fit cycle measures the DOM first
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (ws.readyState === WebSocket.OPEN) {
          const dims = fitAddon.proposeDimensions();
          if (dims) {
            ws.send(`RESIZE:${dims.cols}:${dims.rows}`);
          }
        }
      });
    });
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      term.write(new Uint8Array(event.data));
    } else {
      const text = event.data as string;
      if (text.startsWith('MOUSE_WARNING:')) {
        onMouseWarning(text === 'MOUSE_WARNING:on');
        return;
      }
      if (text.startsWith('BELL_WARNING:')) {
        const payload = text.slice('BELL_WARNING:'.length);
        if (payload === 'ok') {
          onBellWarning(null);
        } else {
          try {
            onBellWarning(JSON.parse(payload) as BellWarning);
          } catch { /* ignore malformed */ }
        }
        return;
      }
      if (text.startsWith('WINDOW_STATE:')) {
        return; // Control message consumed by native clients only
      }
      term.write(text);
    }
  };

  ws.onerror = () => {
    // Error is always followed by a close event; reconnect logic lives there.
  };

  ws.onclose = () => {
    onDisconnected();
  };

  const close = () => {
    // Null out onclose before closing to prevent triggering reconnect
    ws.onclose = null;
    ws.close();
  };

  return { ws, close };
}

function setupWebSocketTerminal(
  term: XTerm,
  fitAddon: FitAddon,
  containerId: string,
  sessionName: string,
  windowIndex: number,
  onMouseWarning: (enabled: boolean) => void,
  onBellWarning: (warning: BellWarning | null) => void,
  wsRef: { current: WebSocket | null },
): { cleanup: () => void; inScrollMode: { current: boolean } } {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/terminal/${containerId}/${sessionName}/${windowIndex}`;

  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let hasConnectedOnce = false;
  let tapToReconnectActive = false;
  let currentClose: (() => void) | null = null;

  const inScrollMode = { current: false };

  // Register xterm.js disposables once — they all read wsRef.current
  const dataDisposable = term.onData((data) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  const binaryDisposable = term.onBinary((data) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const buffer = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) {
        buffer[i] = data.charCodeAt(i) & 0xff;
      }
      ws.send(buffer);
    }
  });

  const resizeDisposable = term.onResize(({ cols, rows }) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(`RESIZE:${cols}:${rows}`);
    }
  });

  // Exit scroll mode when the user types any key
  const scrollExitDisposable = term.onData(() => {
    if (inScrollMode.current) {
      inScrollMode.current = false;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send('SCROLL:exit');
      }
    }
  });

  // Intercept Shift+Enter and copy/paste shortcuts
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.shiftKey) {
      if (e.type === 'keydown') {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send('SHIFT_ENTER:');
        }
      }
      return false;
    }

    if (e.type !== 'keydown') return true;

    if (e.key === 'c' || e.key === 'C') {
      const shouldCopy = isMac ? (e.metaKey && !e.shiftKey) : (e.ctrlKey && e.shiftKey);
      if (shouldCopy && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
        return false;
      }
    }

    if (e.key === 'v' || e.key === 'V') {
      const shouldPaste = isMac ? (e.metaKey && !e.shiftKey) : (e.ctrlKey && e.shiftKey);
      if (shouldPaste) {
        navigator.clipboard.readText().then((text) => {
          const ws = wsRef.current;
          if (text && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(text);
          }
        });
        return false;
      }
    }

    if (e.key === 'PageUp' || e.key === 'PageDown') {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const pageLines = term.rows;
        if (e.key === 'PageUp') {
          inScrollMode.current = true;
          ws.send(`SCROLL:up:${pageLines}`);
        } else {
          ws.send(`SCROLL:down:${pageLines}`);
        }
      }
      return false;
    }

    if (inScrollMode.current && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        if (e.key === 'ArrowUp') {
          ws.send('SCROLL:up:1');
        } else {
          ws.send('SCROLL:down:1');
        }
      }
      return false;
    }

    return true;
  });

  function scheduleReconnect() {
    if (disposed || reconnectTimer !== null) return;
    if (reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      term.writeln('\r\n\x1b[1;31m[Connection lost \u2014 tap to reconnect]\x1b[0m');
      tapToReconnectActive = true;
      return;
    }
    const delay = Math.min(
      RECONNECT_INITIAL_DELAY_MS * Math.pow(RECONNECT_BACKOFF_FACTOR, reconnectAttempt),
      RECONNECT_MAX_DELAY_MS,
    );
    reconnectAttempt++;
    term.writeln('\r\n\x1b[1;33m[Reconnecting...]\x1b[0m');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!disposed) doConnect();
    }, delay);
  }

  function doConnect() {
    if (disposed) return;
    // Close any in-progress connection attempt
    if (currentClose) {
      currentClose();
      currentClose = null;
    }
    wsRef.current = null;

    const { close } = connectWebSocket(
      wsUrl,
      term,
      fitAddon,
      onMouseWarning,
      onBellWarning,
      (openWs) => {
        if (disposed) { close(); return; }
        wsRef.current = openWs;
        if (hasConnectedOnce) {
          term.clear();
          term.writeln('\x1b[1;32m[Reconnected]\x1b[0m');
        }
        hasConnectedOnce = true;
        reconnectAttempt = 0;
        tapToReconnectActive = false;
      },
      () => {
        if (disposed) return;
        wsRef.current = null;
        scheduleReconnect();
      },
    );
    currentClose = close;
  }

  // Tap-to-reconnect handler
  const xtermElement = term.element;
  const handleTapReconnect = () => {
    if (tapToReconnectActive && !disposed) {
      tapToReconnectActive = false;
      reconnectAttempt = 0;
      doConnect();
    }
  };
  xtermElement?.addEventListener('click', handleTapReconnect);

  // Visibility change handler — immediate reconnect on iPad wake.
  // Track when the page was hidden so we can force-reconnect even if
  // the WebSocket readyState still appears OPEN (stale socket).
  let hiddenAt = 0;
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    if (document.visibilityState !== 'visible' || disposed) return;
    const ws = wsRef.current;
    const wasHiddenLong = hiddenAt > 0 && (Date.now() - hiddenAt) > 2000;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING || wasHiddenLong) {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempt = 0;
      tapToReconnectActive = false;
      doConnect();
    }
  };
  document.addEventListener('visibilitychange', handleVisibilityChange);

  // Initial connection
  doConnect();

  const cleanup = () => {
    disposed = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    xtermElement?.removeEventListener('click', handleTapReconnect);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    dataDisposable.dispose();
    binaryDisposable.dispose();
    resizeDisposable.dispose();
    scrollExitDisposable.dispose();
    currentClose?.();
  };

  return { cleanup, inScrollMode };
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml'];

async function uploadAndInject(
  blob: File | Blob,
  containerId: string,
  ws: WebSocket | null,
  term: XTerm | null,
) {
  const formData = new FormData();
  formData.append('file', blob, (blob as File).name || 'paste.png');
  try {
    const res = await fetch(`/api/v1/containers/${containerId}/upload-image`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      term?.writeln(`\r\n\x1b[1;31m[Image upload failed: ${msg}]\x1b[0m`);
      return;
    }
    const { path } = await res.json();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(path);
    }
  } catch (err) {
    term?.writeln(`\r\n\x1b[1;31m[Image upload error: ${err}]\x1b[0m`);
  }
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal({ containerId, sessionName, windowIndex, autoFocus = true, visible = true, onOpenFile }, ref) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lastSentDimsRef = useRef<{ cols: number; rows: number } | null>(null);
  const windowIndexRef = useRef(windowIndex);
  const inScrollModeRef = useRef<{ current: boolean }>({ current: false });
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const [isDragging, setIsDragging] = useState(false);
  const [mouseWarning, setMouseWarning] = useState(false);
  const [bellWarning, setBellWarning] = useState<BellWarning | null>(null);
  const [showVirtualKeys, setShowVirtualKeys] = useState(IS_TOUCH_DEVICE);
  const [showTextInput, setShowTextInput] = useState(false);
  const textInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const prevInputRef = useRef('');
  const [selectMode, setSelectMode] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const selectModeRef = useRef(false);
  selectModeRef.current = selectMode;
  const selectStartRef = useRef<{ col: number; row: number } | null>(null);

  // Send current size to backend — skips if dimensions haven't changed
  // unless `force` is true (e.g. initial connection).
  const sendResize = useCallback((force = false) => {
    const ws = wsRef.current;
    const fitAddon = fitAddonRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && fitAddon) {
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        const last = lastSentDimsRef.current;
        if (!force && last && last.cols === dims.cols && last.rows === dims.rows) {
          return; // dimensions unchanged — skip to avoid tmux full redraw
        }
        lastSentDimsRef.current = { cols: dims.cols, rows: dims.rows };
        ws.send(`RESIZE:${dims.cols}:${dims.rows}`);
      }
    }
  }, []);

  const doFit = useCallback((retries = 3) => {
    const attempt = (remaining: number) => {
      const container = termRef.current;
      const fitAddon = fitAddonRef.current;
      if (!container || !fitAddon) return;
      const { width, height } = container.getBoundingClientRect();
      if (width > 0 && height > 0) {
        fitAddon.fit();
      } else if (remaining > 0) {
        // Container not yet laid out — retry next frame
        requestAnimationFrame(() => attempt(remaining - 1));
      }
    };
    attempt(retries);
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => xtermRef.current?.focus(),
    refit: () => {
      doFit();
      sendResize();
    },
  }));

  useEffect(() => {
    if (!wrapperRef.current || !termRef.current) return;
    const wrapper = wrapperRef.current;
    const container = termRef.current;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: THEME,
      allowProposedApi: true,
    });

    // Suppress audible bell — swallow the event so the browser stays silent.
    term.onBell(() => { /* noop */ });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(container);

    // Register custom OSC 7337 handler for tmuxdeck-open
    const oscDisposable = term.parser.registerOscHandler(7337, (data) => {
      const filePath = data.trim();
      if (filePath) {
        onOpenFileRef.current?.(filePath);
      }
      return true;
    });

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Track text selection for Copy button (touch select mode)
    const selectionDisposable = term.onSelectionChange(() => {
      setHasSelection(term.hasSelection());
    });

    // Measure container (flex-sized) and fit terminal
    const fitAndResize = (retries = 3) => {
      const { width, height } = container.getBoundingClientRect();
      if (width > 0 && height > 0) {
        fitAddon.fit();
      } else if (retries > 0) {
        requestAnimationFrame(() => fitAndResize(retries - 1));
      }
    };

    // Defer initial fit — use double-rAF to ensure layout has fully settled
    const rafId = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitAndResize();
        // Force-send dimensions on initial connection (skip dedup)
        sendResize(true);
        if (autoFocus) term.focus();
      });
    });

    if (IS_MOCK) {
      setupMockTerminal(term, containerId, sessionName);
    } else {
      const { cleanup, inScrollMode } = setupWebSocketTerminal(term, fitAddon, containerId, sessionName, windowIndexRef.current, setMouseWarning, setBellWarning, wsRef);
      inScrollModeRef.current = inScrollMode;
      // Store cleanup for unmount
      (wrapper as unknown as Record<string, () => void>).__wsCleanup = cleanup;
    }

    // Observe container (flex-sized) so fit triggers when toolbar toggles
    const resizeObserver = new ResizeObserver(() => fitAndResize());
    resizeObserver.observe(container);

    // --- Paste handler: intercept image pastes ---
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      let hasText = false;
      let imageFile: File | null = null;
      for (const item of items) {
        if (item.type === 'text/plain') hasText = true;
        if (item.kind === 'file' && IMAGE_TYPES.includes(item.type)) {
          imageFile = item.getAsFile();
        }
      }
      if (imageFile && !hasText) {
        e.preventDefault();
        e.stopPropagation();
        uploadAndInject(imageFile, containerId, wsRef.current, term);
      }
    };

    // --- Drag-and-drop handlers ---
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(true);
    };
    const handleDragLeave = (e: DragEvent) => {
      // Only hide when leaving the wrapper itself
      if (e.currentTarget === wrapper && !wrapper.contains(e.relatedTarget as Node)) {
        setIsDragging(false);
      }
    };
    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (!e.dataTransfer?.files) return;
      for (const file of e.dataTransfer.files) {
        if (IMAGE_TYPES.includes(file.type)) {
          uploadAndInject(file, containerId, wsRef.current, term);
        }
      }
    };

    // --- Wheel handler: forward scroll events to tmux ---
    // Use capture phase so we intercept before xterm.js handles the event
    let lastWheelTime = 0;
    const WHEEL_THROTTLE_MS = 50;
    const LINES_PER_TICK = 3;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const now = Date.now();
      if (now - lastWheelTime < WHEEL_THROTTLE_MS) return;
      lastWheelTime = now;

      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const lines = Math.max(1, Math.round(Math.abs(e.deltaY) / 40) * LINES_PER_TICK);
      if (e.deltaY < 0) {
        // Scroll up
        inScrollModeRef.current.current = true;
        ws.send(`SCROLL:up:${lines}`);
      } else {
        // Scroll down
        ws.send(`SCROLL:down:${lines}`);
      }
    };

    // --- Touch scroll handlers ---
    let touchStartY = 0;
    let touchLastY = 0;
    let lastTouchTime = 0;
    let touchVelocity = 0;
    const TOUCH_THROTTLE_MS = 50;
    const PX_PER_LINE = 20;
    let momentumRafId = 0;

    // Convert touch coordinates to terminal cell position
    const touchToCell = (touchX: number, touchY: number) => {
      const screen = container.querySelector('.xterm-screen');
      if (!screen) return null;
      const rect = screen.getBoundingClientRect();
      const cellWidth = rect.width / term.cols;
      const cellHeight = rect.height / term.rows;
      return {
        col: Math.min(Math.max(Math.floor((touchX - rect.left) / cellWidth), 0), term.cols - 1),
        row: Math.min(Math.max(Math.floor((touchY - rect.top) / cellHeight), 0), term.rows - 1),
      };
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (selectModeRef.current) {
        const touch = e.touches[0];
        const cell = touchToCell(touch.clientX, touch.clientY);
        if (cell) {
          selectStartRef.current = cell;
          term.clearSelection();
        }
        return;
      }
      // Don't preventDefault — allow taps for keyboard focus
      touchStartY = e.touches[0].clientY;
      touchLastY = touchStartY;
      touchVelocity = 0;
      cancelAnimationFrame(momentumRafId);
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (selectModeRef.current) {
        e.preventDefault(); // Prevent page scroll during selection
        const start = selectStartRef.current;
        if (!start) return;
        const touch = e.touches[0];
        const end = touchToCell(touch.clientX, touch.clientY);
        if (!end) return;

        // Normalize so sCol/sRow is before eCol/eRow
        let sCol = start.col, sRow = start.row, eCol = end.col, eRow = end.row;
        if (eRow < sRow || (eRow === sRow && eCol < sCol)) {
          [sCol, sRow, eCol, eRow] = [eCol, eRow, sCol, sRow];
        }
        const length = (eRow - sRow) * term.cols + (eCol - sCol + 1);
        if (length > 0) {
          term.select(sCol, sRow, length);
        }
        return;
      }

      const currentY = e.touches[0].clientY;
      const deltaFromStart = Math.abs(currentY - touchStartY);

      // Only treat as scroll if finger moved >10px
      if (deltaFromStart < 10) return;

      // Prevent iOS rubber-banding
      e.preventDefault();

      const now = Date.now();
      if (now - lastTouchTime < TOUCH_THROTTLE_MS) return;

      const deltaY = touchLastY - currentY;
      const elapsed = now - lastTouchTime || 1;
      touchVelocity = deltaY / elapsed; // px per ms
      lastTouchTime = now;
      touchLastY = currentY;

      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const lines = Math.max(1, Math.round(Math.abs(deltaY) / PX_PER_LINE));
      if (deltaY > 0) {
        inScrollModeRef.current.current = true;
        ws.send(`SCROLL:up:${lines}`);
      } else if (deltaY < 0) {
        ws.send(`SCROLL:down:${lines}`);
      }
    };

    const handleTouchEnd = () => {
      if (selectModeRef.current) {
        selectStartRef.current = null;
        return;
      }

      // Momentum scrolling based on final velocity
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Math.abs(touchVelocity) < 0.3) return;

      let velocity = touchVelocity;
      const decay = () => {
        velocity *= 0.85;
        if (Math.abs(velocity) < 0.1) return;

        const lines = Math.max(1, Math.round(Math.abs(velocity * TOUCH_THROTTLE_MS) / PX_PER_LINE));
        if (velocity > 0) {
          inScrollModeRef.current.current = true;
          ws.send(`SCROLL:up:${lines}`);
        } else {
          ws.send(`SCROLL:down:${lines}`);
        }
        momentumRafId = requestAnimationFrame(decay);
      };
      momentumRafId = requestAnimationFrame(decay);
    };

    wrapper.addEventListener('paste', handlePaste, { capture: true });
    wrapper.addEventListener('dragover', handleDragOver);
    wrapper.addEventListener('dragleave', handleDragLeave);
    wrapper.addEventListener('drop', handleDrop);
    wrapper.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    wrapper.addEventListener('touchstart', handleTouchStart, { passive: true });
    wrapper.addEventListener('touchmove', handleTouchMove, { passive: false });
    wrapper.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      cancelAnimationFrame(rafId);
      cancelAnimationFrame(momentumRafId);
      oscDisposable.dispose();
      selectionDisposable.dispose();
      const cleanup = (wrapper as unknown as Record<string, (() => void) | undefined>).__wsCleanup;
      cleanup?.();
      wsRef.current = null;
      lastSentDimsRef.current = null;
      inScrollModeRef.current = { current: false };
      resizeObserver.disconnect();
      wrapper.removeEventListener('paste', handlePaste, { capture: true });
      wrapper.removeEventListener('dragover', handleDragOver);
      wrapper.removeEventListener('dragleave', handleDragLeave);
      wrapper.removeEventListener('drop', handleDrop);
      wrapper.removeEventListener('wheel', handleWheel, { capture: true });
      wrapper.removeEventListener('touchstart', handleTouchStart);
      wrapper.removeEventListener('touchmove', handleTouchMove);
      wrapper.removeEventListener('touchend', handleTouchEnd);
      term.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- windowIndex changes are
  // handled by the SELECT_WINDOW effect below; including it here would tear down the
  // WebSocket connection instead of smoothly switching windows.
  }, [containerId, sessionName, autoFocus, sendResize]);

  // Switch tmux windows without recreating the connection.
  // When windowIndex changes (e.g. user clicks a different window in the sidebar),
  // we send a SELECT_WINDOW control message so tmux switches in-place.
  useEffect(() => {
    const prevIndex = windowIndexRef.current;
    windowIndexRef.current = windowIndex;
    if (prevIndex !== windowIndex) {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(`SELECT_WINDOW:${windowIndex}`);
        // Force resize so tmux redraws the new window content at correct size
        sendResize(true);
      }
    }
  }, [windowIndex, sendResize]);

  // Refit when text input toolbar is toggled (changes wrapper padding)
  useEffect(() => {
    requestAnimationFrame(() => {
      doFit();
      sendResize();
    });
  }, [showTextInput, showVirtualKeys, doFit, sendResize]);

  // Refit when becoming visible, blur when hidden
  useEffect(() => {
    if (!xtermRef.current || !fitAddonRef.current || !wrapperRef.current || !termRef.current) return;
    if (visible) {
      // Double-rAF: first frame processes the visibility CSS change,
      // second frame measures the now-visible element correctly
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          doFit();
          // Force tmux to redraw by re-sending current size
          sendResize();
        });
      });
    } else {
      xtermRef.current.blur();
    }
  }, [visible, doFit, sendResize]);

  const handleDisableMouse = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send('DISABLE_MOUSE:');
    }
  }, []);

  const handleFixBell = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send('FIX_BELL:');
    }
  }, []);

  const sendToWs = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }, []);

  const sendVirtualKey = useCallback((data: string, isScroll?: 'up' | 'down') => {
    if (isScroll && inScrollModeRef.current.current) {
      sendToWs(`SCROLL:${isScroll}:1`);
    } else {
      sendToWs(data);
    }
    // Restore focus to whatever had it (text input or terminal)
    const active = document.activeElement;
    requestAnimationFrame(() => {
      if (active instanceof HTMLElement) {
        active.focus();
      } else {
        xtermRef.current?.focus();
      }
    });
  }, [sendToWs]);

  // Wrapper: absolute-positioned flex column; terminal fills remaining space
  return (
    <div ref={wrapperRef} className="absolute inset-1 overflow-hidden flex flex-col">
      <div ref={termRef} className="flex-1 min-h-0" />
      {mouseWarning && (
        <div
          className="absolute top-2 left-2 right-2 flex items-center gap-2 px-3 py-2 rounded z-20 text-sm"
          style={{
            background: 'rgba(180, 83, 9, 0.85)',
            border: '1px solid rgba(245, 158, 11, 0.5)',
            backdropFilter: 'blur(4px)',
          }}
        >
          <span className="text-amber-100 flex-1">
            Tmux mouse mode is on — text selection and copy won't work.
          </span>
          <button
            onClick={handleDisableMouse}
            className="px-2 py-0.5 rounded text-xs font-medium bg-amber-200 text-amber-900 hover:bg-amber-100 transition-colors shrink-0"
          >
            Disable mouse mode
          </button>
          <button
            onClick={() => setMouseWarning(false)}
            className="text-amber-300 hover:text-amber-100 transition-colors shrink-0 text-lg leading-none"
            title="Dismiss"
          >
            &times;
          </button>
        </div>
      )}
      {bellWarning && (
        <div
          className="absolute left-2 right-2 flex items-center gap-2 px-3 py-2 rounded z-20 text-sm"
          style={{
            top: mouseWarning ? '3rem' : '0.5rem',
            background: 'rgba(180, 83, 9, 0.85)',
            border: '1px solid rgba(245, 158, 11, 0.5)',
            backdropFilter: 'blur(4px)',
          }}
        >
          <span className="text-amber-100 flex-1">
            Tmux bell notifications are disabled
            {bellWarning.bellAction ? ' — bell-action is set to none' : ''}
            {bellWarning.visualBell ? ' — visual-bell is enabled' : ''}.
          </span>
          <button
            onClick={handleFixBell}
            className="px-2 py-0.5 rounded text-xs font-medium bg-amber-200 text-amber-900 hover:bg-amber-100 transition-colors shrink-0"
          >
            Fix bell settings
          </button>
          <button
            onClick={() => setBellWarning(null)}
            className="text-amber-300 hover:text-amber-100 transition-colors shrink-0 text-lg leading-none"
            title="Dismiss"
          >
            &times;
          </button>
        </div>
      )}
      {isDragging && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none z-10"
          style={{
            background: 'rgba(59, 130, 246, 0.15)',
            border: '2px dashed rgba(59, 130, 246, 0.6)',
            borderRadius: '8px',
          }}
        >
          <span className="text-blue-400 text-lg font-medium">Drop image here</span>
        </div>
      )}
      {/* Virtual key toolbar for touch devices */}
      {IS_TOUCH_DEVICE && (
        showVirtualKeys ? (
          <div className={`shrink-0 z-20 backdrop-blur-sm border-t ${selectMode ? 'bg-blue-950/90 border-blue-500/50' : 'bg-gray-900/90 border-gray-700/50'}`}>
            {showTextInput && (
              <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-gray-700/50">
                <input
                  ref={textInputRef}
                  type="text"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="on"
                  spellCheck={false}
                  placeholder="Type here (slide/autocomplete)..."
                  className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 font-mono outline-none focus:border-blue-500"
                  onCompositionStart={() => { composingRef.current = true; }}
                  onCompositionEnd={(e) => {
                    composingRef.current = false;
                    // Send the composed text (autocomplete/slide result)
                    const composed = (e.target as HTMLInputElement).value.slice(prevInputRef.current.length);
                    if (composed) sendToWs(composed);
                    prevInputRef.current = (e.target as HTMLInputElement).value;
                  }}
                  onInput={(e) => {
                    if (composingRef.current) return; // wait for compositionEnd
                    const el = e.target as HTMLInputElement;
                    const newVal = el.value;
                    const oldVal = prevInputRef.current;
                    if (newVal.length > oldVal.length) {
                      // Characters added — send the new ones
                      sendToWs(newVal.slice(oldVal.length));
                    } else if (newVal.length < oldVal.length) {
                      // Characters deleted — send backspaces
                      const deleted = oldVal.length - newVal.length;
                      for (let i = 0; i < deleted; i++) sendToWs('\x7f');
                    }
                    prevInputRef.current = newVal;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      sendToWs('\r');
                      if (textInputRef.current) textInputRef.current.value = '';
                      prevInputRef.current = '';
                    }
                  }}
                />
              </div>
            )}
            <div className="flex items-center gap-1 px-2 py-1.5">
            {[
              { label: 'Esc', data: '\x1b' },
              { label: 'Tab', data: '\t' },
              { label: 'S-Tab', data: '\x1b[Z' },
              { label: '^C', data: '\x03', className: 'text-red-400' },
              { label: '^D', data: '\x04' },
              { label: '^Z', data: '\x1a' },
              { label: '/', data: '/' },
              { label: '/clear', data: '/clear\r' },
            ].map(({ label, data, className }) => (
              <button
                key={label}
                onMouseDown={(e) => e.preventDefault()}
                onTouchStart={(e) => e.preventDefault()}
                onClick={() => sendVirtualKey(data)}
                className={`px-2.5 py-1 rounded text-xs font-mono font-medium bg-gray-800 hover:bg-gray-700 active:bg-gray-600 transition-colors ${className || 'text-gray-200'}`}
              >
                {label}
              </button>
            ))}
            <div className="w-px h-5 bg-gray-700 mx-0.5" />
            <button
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              onClick={() => sendVirtualKey('\x1b[D')}
              className="px-2 py-1 rounded text-xs bg-gray-800 hover:bg-gray-700 active:bg-gray-600 transition-colors text-gray-200"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              onClick={() => sendVirtualKey('\x1b[B', 'down')}
              className="px-2 py-1 rounded text-xs bg-gray-800 hover:bg-gray-700 active:bg-gray-600 transition-colors text-gray-200"
            >
              <ChevronDown size={14} />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              onClick={() => sendVirtualKey('\x1b[A', 'up')}
              className="px-2 py-1 rounded text-xs bg-gray-800 hover:bg-gray-700 active:bg-gray-600 transition-colors text-gray-200"
            >
              <ChevronUp size={14} />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              onClick={() => sendVirtualKey('\x1b[C')}
              className="px-2 py-1 rounded text-xs bg-gray-800 hover:bg-gray-700 active:bg-gray-600 transition-colors text-gray-200"
            >
              <ChevronRight size={14} />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              onClick={() => sendVirtualKey('|')}
              className="px-2.5 py-1 rounded text-xs font-mono font-medium bg-gray-800 hover:bg-gray-700 active:bg-gray-600 transition-colors text-gray-200"
            >
              |
            </button>
            <div className="w-px h-5 bg-gray-700 mx-0.5" />
            <button
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              onClick={() => {
                if (selectMode) {
                  xtermRef.current?.clearSelection();
                  setSelectMode(false);
                  setHasSelection(false);
                } else {
                  setSelectMode(true);
                }
              }}
              className={`px-1.5 py-1 rounded transition-colors ${selectMode ? 'text-blue-400 bg-blue-900/30' : 'text-gray-400 hover:text-gray-200'}`}
              title={selectMode ? 'Exit select mode' : 'Select text'}
            >
              <MousePointer2 size={14} />
            </button>
            {selectMode && hasSelection && (
              <button
                onMouseDown={(e) => e.preventDefault()}
                onTouchStart={(e) => e.preventDefault()}
                onClick={() => {
                  const sel = xtermRef.current?.getSelection();
                  if (sel) navigator.clipboard.writeText(sel);
                  xtermRef.current?.clearSelection();
                  xtermRef.current?.blur();
                  setSelectMode(false);
                  setHasSelection(false);
                }}
                className="px-2 py-1 rounded text-xs font-medium bg-blue-600 hover:bg-blue-500 active:bg-blue-700 transition-colors text-white flex items-center gap-1"
              >
                <Copy size={12} /> Copy
              </button>
            )}
            <div className="flex-1" />
            <button
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              onClick={() => {
                setShowTextInput(v => !v);
                if (!showTextInput) setTimeout(() => textInputRef.current?.focus(), 50);
              }}
              className={`px-1.5 py-1 rounded transition-colors ${showTextInput ? 'text-blue-400' : 'text-gray-500 hover:text-gray-300'}`}
              title="Text input"
            >
              <Type size={14} />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              onClick={() => { setShowVirtualKeys(false); setShowTextInput(false); doFit(); }}
              className="px-1.5 py-1 rounded text-gray-500 hover:text-gray-300 transition-colors"
              title="Hide virtual keys"
            >
              <Keyboard size={14} />
            </button>
            </div>
          </div>
        ) : (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.preventDefault()}
            onClick={() => { setShowVirtualKeys(true); doFit(); }}
            className="absolute bottom-1 right-1 z-20 p-1.5 rounded bg-gray-800/80 text-gray-500 hover:text-gray-300 transition-colors"
            title="Show virtual keys"
          >
            <Keyboard size={14} />
          </button>
        )
      )}
    </div>
  );
});
