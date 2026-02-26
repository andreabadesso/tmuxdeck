import { useMemo } from 'react';

interface LogRendererProps {
  content: string;
}

type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'default';

const LEVEL_PATTERNS: { regex: RegExp; level: LogLevel }[] = [
  { regex: /\b(ERROR|FATAL|CRITICAL)\b/i, level: 'error' },
  { regex: /\b(WARN|WARNING)\b/i, level: 'warn' },
  { regex: /\bINFO\b/i, level: 'info' },
  { regex: /\bDEBUG\b/i, level: 'debug' },
  { regex: /\bTRACE\b/i, level: 'trace' },
];

const LEVEL_CLASSES: Record<LogLevel, string> = {
  error: 'text-red-400',
  warn: 'text-amber-400',
  info: 'text-cyan-400',
  debug: 'text-gray-400',
  trace: 'text-gray-500',
  default: 'text-gray-300',
};

function classifyLine(line: string): LogLevel {
  for (const { regex, level } of LEVEL_PATTERNS) {
    if (regex.test(line)) return level;
  }
  return 'default';
}

export function LogRenderer({ content }: LogRendererProps) {
  const lines = useMemo(() => {
    return content.split('\n').map((line) => ({
      text: line,
      level: classifyLine(line),
    }));
  }, [content]);

  return (
    <div className="w-[85vw] h-[85vh] overflow-auto">
      <pre className="p-4 text-sm font-mono leading-relaxed">
        {lines.map((line, i) => (
          <div key={i} className={LEVEL_CLASSES[line.level]}>
            {line.text || '\u00A0'}
          </div>
        ))}
      </pre>
    </div>
  );
}
