/**
 * Hint-based sub-renderer detection.
 * Only used AFTER the backend confirms the file is renderable via the `file` command.
 */

export type SubRenderer = 'image' | 'code' | 'markdown' | 'csv' | 'log' | 'pdf';

/** Renderers that have an enriched view with a raw-mode alternative. */
export function hasEnrichedView(renderer: SubRenderer): boolean {
  return renderer === 'markdown' || renderer === 'csv' || renderer === 'log' || renderer === 'code';
}


export function getSubRenderer(category: string, path: string): SubRenderer {
  if (category === 'image') return 'image';
  if (category === 'pdf') return 'pdf';

  // category === 'text': use extension as hint
  const ext = getExtension(path);
  if (ext === '.md' || ext === '.mdx' || ext === '.markdown') return 'markdown';
  if (ext === '.csv' || ext === '.tsv') return 'csv';
  if (ext === '.log') return 'log';
  return 'code';
}

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.py': 'python',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.json': 'json',
  '.xml': 'xml',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.conf': 'ini',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',
  '.ps1': 'powershell',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.swift': 'swift',
  '.r': 'r',
  '.R': 'r',
  '.sql': 'sql',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.lua': 'lua',
  '.pl': 'perl',
  '.pm': 'perl',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hs': 'haskell',
  '.clj': 'clojure',
  '.dart': 'dart',
  '.vue': 'html',
  '.svelte': 'html',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.proto': 'protobuf',
  '.dockerfile': 'dockerfile',
  '.tf': 'hcl',
};

const FILENAME_TO_LANGUAGE: Record<string, string> = {
  'Makefile': 'makefile',
  'makefile': 'makefile',
  'GNUmakefile': 'makefile',
  'Dockerfile': 'dockerfile',
  'Containerfile': 'dockerfile',
  '.gitignore': 'ignore',
  '.dockerignore': 'ignore',
  '.env': 'dotenv',
  '.env.local': 'dotenv',
  '.env.example': 'dotenv',
  'Vagrantfile': 'ruby',
  'Gemfile': 'ruby',
  'Rakefile': 'ruby',
  'CMakeLists.txt': 'cmake',
};

export function getMonacoLanguage(path: string): string {
  const filename = path.split('/').pop() || path;

  if (FILENAME_TO_LANGUAGE[filename]) {
    return FILENAME_TO_LANGUAGE[filename];
  }

  const ext = getExtension(path);
  return EXTENSION_TO_LANGUAGE[ext] || 'plaintext';
}

function getExtension(path: string): string {
  const filename = path.split('/').pop() || '';
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return filename.slice(dotIndex).toLowerCase();
}
