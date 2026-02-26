import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

const shortcuts = [
  { keys: ['Ctrl', 'K'], action: 'Quick-switch sessions' },
  { keys: ['Ctrl', 'H'], action: 'Show keyboard shortcuts' },
  { keys: ['Ctrl', '1–0'], action: 'Switch to numbered window' },
  { keys: ['Alt', '1–9'], action: 'Switch to window N in session' },
  { keys: ['Ctrl', 'Alt', '1–0'], action: 'Assign/unassign number' },
  { keys: ['Ctrl', '↑↓'], action: 'Next / previous window' },
  { keys: ['Esc', 'Esc'], action: 'Deselect current session' },
  { keys: ['↑', '↓'], action: 'Navigate in switcher' },
  { keys: ['Enter'], action: 'Select in switcher' },
  { keys: ['Esc'], action: 'Close dialog / switcher' },
];

export function HelpPage() {
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        navigate(-1);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-gray-100">Help</h1>
      </div>

      <div className="space-y-8">
        {/* Getting Started */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
            Getting Started
          </h2>
          <div className="space-y-3 text-sm text-gray-400">
            <p>
              TmuxDeck is a web-based dashboard for managing Docker containers with tmux sessions.
              The basic workflow is:
            </p>
            <ul className="list-disc list-inside space-y-1.5 ml-1">
              <li>Create a container from a template using the <kbd className="text-xs text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">+</kbd> button in the sidebar</li>
              <li>Click a session or window in the sidebar to connect to its terminal</li>
              <li>Use <kbd className="text-xs text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">Ctrl</kbd>+<kbd className="text-xs text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">K</kbd> to fuzzy-search and quickly switch between sessions</li>
            </ul>
          </div>
        </section>

        {/* Terminal */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
            Terminal
          </h2>
          <div className="space-y-3 text-sm text-gray-400">
            <p><span className="text-gray-300 font-medium">Copy &amp; Paste:</span> Use <kbd className="text-xs text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">Ctrl</kbd>+<kbd className="text-xs text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">Shift</kbd>+<kbd className="text-xs text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">C</kbd>/<kbd className="text-xs text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">V</kbd> on Linux/Windows, or <kbd className="text-xs text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">Cmd</kbd>+<kbd className="text-xs text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">C</kbd>/<kbd className="text-xs text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">V</kbd> on Mac.</p>
            <p><span className="text-gray-300 font-medium">Images:</span> Paste images from your clipboard or drag-and-drop image files directly onto the terminal.</p>
            <p><span className="text-gray-300 font-medium">Scrolling:</span> Use <kbd className="text-xs text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">PageUp</kbd>/<kbd className="text-xs text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">PageDown</kbd> or the mouse wheel to scroll through terminal history.</p>
            <p><span className="text-gray-300 font-medium">Connection Pool:</span> TmuxDeck keeps a pool of terminal connections alive simultaneously (configurable in Settings) so switching between sessions is instant.</p>
          </div>
        </section>

        {/* Claude Integration */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
            Claude Integration
          </h2>
          <div className="space-y-3 text-sm text-gray-400">
            <p>
              The <code className="font-mono text-gray-300 bg-gray-800 px-1 py-0.5 rounded">claude-worker</code> template ships with the Claude Code CLI pre-installed.
              Create a container from this template and run <code className="font-mono text-gray-300 bg-gray-800 px-1 py-0.5 rounded">claude</code> inside
              the terminal to start an AI-assisted coding session.
            </p>
          </div>
        </section>

        {/* Opening Files (tmuxdeck-open) */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
            Opening Files (<code className="font-mono normal-case">tmuxdeck-open</code>)
          </h2>
          <div className="space-y-3 text-sm text-gray-400">
            <p>
              The <code className="font-mono text-gray-300 bg-gray-800 px-1 py-0.5 rounded">tmuxdeck-open</code> script lets programs inside containers open files
              in TmuxDeck's browser UI (e.g. images generated by Claude).
            </p>
            <p className="text-gray-300 font-medium">Usage:</p>
            <pre className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 font-mono text-xs text-gray-300 overflow-x-auto">tmuxdeck-open /path/to/file.png</pre>
            <p>Supported file types: <code className="font-mono text-gray-300 bg-gray-800 px-1 py-0.5 rounded">png</code>, <code className="font-mono text-gray-300 bg-gray-800 px-1 py-0.5 rounded">jpg</code>, <code className="font-mono text-gray-300 bg-gray-800 px-1 py-0.5 rounded">gif</code>, <code className="font-mono text-gray-300 bg-gray-800 px-1 py-0.5 rounded">webp</code>, <code className="font-mono text-gray-300 bg-gray-800 px-1 py-0.5 rounded">svg</code>, <code className="font-mono text-gray-300 bg-gray-800 px-1 py-0.5 rounded">bmp</code></p>
          </div>
        </section>

        {/* Keyboard Shortcuts */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
            Keyboard Shortcuts
          </h2>
          <div className="space-y-2">
            {shortcuts.map((s, i) => (
              <div key={i} className="flex items-center justify-between py-1">
                <span className="text-sm text-gray-400">{s.action}</span>
                <div className="flex items-center gap-1">
                  {s.keys.map((key, j) => (
                    <span key={j}>
                      {j > 0 && <span className="text-gray-600 text-xs mx-0.5">+</span>}
                      <kbd className="text-xs text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700 min-w-[1.5rem] text-center inline-block">
                        {key}
                      </kbd>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Organizing Sessions */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
            Organizing Sessions
          </h2>
          <div className="space-y-3 text-sm text-gray-400">
            <ul className="list-disc list-inside space-y-1.5 ml-1">
              <li><span className="text-gray-300 font-medium">Reorder:</span> Drag and drop windows or sessions in the sidebar to reorder them</li>
              <li><span className="text-gray-300 font-medium">Move:</span> Drag a window from one session to another to move it between sessions</li>
              <li>
                <span className="text-gray-300 font-medium">Quick-Switch Digits:</span> Press{' '}
                <kbd className="text-xs text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">Ctrl</kbd>+<kbd className="text-xs text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">Alt</kbd>+<kbd className="text-xs text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">1–0</kbd> to
                assign a digit to the current window, then use{' '}
                <kbd className="text-xs text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">Ctrl</kbd>+<kbd className="text-xs text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">1–0</kbd> to jump to it instantly
              </li>
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
