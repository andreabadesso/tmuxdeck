import { useState, useEffect, useCallback } from 'react';
import { X, ExternalLink, Loader2, AlertTriangle, Code, Eye } from 'lucide-react';
import { getSubRenderer, getMonacoLanguage, hasEnrichedView } from '../utils/fileTypes';
import type { SubRenderer } from '../utils/fileTypes';
import { ImageRenderer } from './viewers/ImageRenderer';
import { CodeRenderer } from './viewers/CodeRenderer';
import { PdfRenderer } from './viewers/PdfRenderer';
import { MarkdownRenderer } from './viewers/MarkdownRenderer';
import { CsvRenderer } from './viewers/CsvRenderer';
import { LogRenderer } from './viewers/LogRenderer';

interface FileViewerProps {
  containerId: string;
  path: string;
  onClose: () => void;
}

const IS_MOCK = import.meta.env.VITE_USE_MOCK === 'true';

type ViewerState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; renderer: SubRenderer; content?: string; url: string; mime: string };

export function FileViewer({ containerId, path, onClose }: FileViewerProps) {
  const [state, setState] = useState<ViewerState>({ status: 'loading' });
  const [rawMode, setRawMode] = useState(false);

  const fileUrl = IS_MOCK
    ? 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect fill="%23334155" width="400" height="300"/><text x="200" y="150" text-anchor="middle" fill="%2394a3b8" font-size="16" font-family="monospace">[mock] ' + (path.split('/').pop() || '') + '</text></svg>')
    : `/api/v1/containers/${encodeURIComponent(containerId)}/file?path=${encodeURIComponent(path)}`;

  const filename = path.split('/').pop() || path;

  useEffect(() => {
    if (IS_MOCK) {
      setState({ status: 'ready', renderer: 'image', url: fileUrl, mime: 'image/svg+xml' });
      return;
    }

    const controller = new AbortController();

    fetch(fileUrl, { signal: controller.signal })
      .then(async (res) => {
        if (res.status === 415) {
          const detail = await res.json().catch(() => ({ detail: 'Cannot render this file type' }));
          setState({ status: 'error', message: detail.detail || 'Cannot render this file type' });
          return;
        }
        if (!res.ok) {
          const detail = await res.json().catch(() => ({ detail: res.statusText }));
          setState({ status: 'error', message: detail.detail || `HTTP ${res.status}` });
          return;
        }

        const category = res.headers.get('X-File-Category') || 'text';
        const mime = res.headers.get('X-File-Mime') || 'unknown';
        const renderer = getSubRenderer(category, path);

        if (renderer === 'image' || renderer === 'pdf') {
          const blob = await res.blob();
          const objectUrl = URL.createObjectURL(blob);
          setState({ status: 'ready', renderer, url: objectUrl, mime });
        } else {
          const content = await res.text();
          setState({ status: 'ready', renderer, content, url: fileUrl, mime });
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          setState({ status: 'error', message: err.message || 'Failed to load file' });
        }
      });

    return () => controller.abort();
  }, [fileUrl, path]);

  // Cleanup object URLs
  useEffect(() => {
    return () => {
      if (state.status === 'ready' && state.url.startsWith('blob:')) {
        URL.revokeObjectURL(state.url);
      }
    };
  }, [state]);

  // Use capture phase so ESC works even when Monaco or iframe has focus
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  const handleOpenInNewTab = () => {
    window.open(fileUrl, '_blank');
  };

  // Whether the current renderer supports a raw toggle
  const canToggleRaw = state.status === 'ready' && hasEnrichedView(state.renderer);

  // The effective renderer — if raw mode is on and the renderer supports it, show CodeRenderer instead
  const effectiveRenderer: SubRenderer | 'raw' =
    rawMode && canToggleRaw ? 'raw' : (state.status === 'ready' ? state.renderer : 'code');

  // Modal size class based on renderer
  const getModalSizeClass = (): string => {
    if (state.status !== 'ready') return 'max-w-[90vw] max-h-[90vh]';
    if (effectiveRenderer === 'raw') return ''; // CodeRenderer sizes itself
    switch (state.renderer) {
      case 'image': return 'max-w-[90vw] max-h-[90vh]';
      case 'code':
      case 'log':
      case 'markdown':
      case 'csv':
      case 'pdf':
        return '';
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className={`bg-gray-900 border border-gray-700 rounded-xl shadow-2xl flex flex-col ${getModalSizeClass()}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-2 min-w-0 mr-4">
            <span className="text-sm text-gray-300 font-mono truncate" title={path}>
              {filename}
            </span>
            {state.status === 'ready' && (
              <span className="shrink-0 text-[11px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500 border border-gray-700">
                {state.mime}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {canToggleRaw && (
              <button
                onClick={() => setRawMode((v) => !v)}
                className={`p-1.5 rounded transition-colors ${
                  rawMode
                    ? 'bg-blue-900/50 text-blue-400 hover:bg-blue-900/70'
                    : 'hover:bg-gray-800 text-gray-400 hover:text-gray-200'
                }`}
                title={rawMode ? 'Switch to enriched view' : 'Switch to raw view'}
              >
                {rawMode ? <Eye size={16} /> : <Code size={16} />}
              </button>
            )}
            <button
              onClick={handleOpenInNewTab}
              className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
              title="Open in new tab"
            >
              <ExternalLink size={16} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
              title="Close (Esc)"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Content */}
        {state.status === 'loading' && (
          <div className="flex items-center justify-center p-16">
            <div className="flex items-center gap-2 text-gray-400">
              <Loader2 size={20} className="animate-spin" />
              <span className="text-sm">Loading...</span>
            </div>
          </div>
        )}

        {state.status === 'error' && (
          <div className="flex flex-col items-center justify-center p-16 gap-3">
            <AlertTriangle size={32} className="text-amber-400" />
            <p className="text-gray-300 font-medium">Cannot render file</p>
            <p className="text-sm text-gray-500 text-center max-w-md">{state.message}</p>
          </div>
        )}

        {state.status === 'ready' && effectiveRenderer === 'image' && (
          <ImageRenderer url={state.url} filename={filename} />
        )}

        {state.status === 'ready' && effectiveRenderer === 'code' && (
          <CodeRenderer
            content={state.content || ''}
            language={getMonacoLanguage(path)}
          />
        )}

        {state.status === 'ready' && effectiveRenderer === 'raw' && (
          <CodeRenderer
            content={state.content || ''}
            language="plaintext"
          />
        )}

        {state.status === 'ready' && effectiveRenderer === 'pdf' && (
          <PdfRenderer url={state.url} />
        )}

        {state.status === 'ready' && effectiveRenderer === 'markdown' && (
          <MarkdownRenderer content={state.content || ''} />
        )}

        {state.status === 'ready' && effectiveRenderer === 'csv' && (
          <CsvRenderer content={state.content || ''} path={path} />
        )}

        {state.status === 'ready' && effectiveRenderer === 'log' && (
          <LogRenderer content={state.content || ''} />
        )}
      </div>
    </div>
  );
}
