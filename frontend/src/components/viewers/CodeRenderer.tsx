import Editor from '@monaco-editor/react';
import { Loader2 } from 'lucide-react';

interface CodeRendererProps {
  content: string;
  language: string;
}

export function CodeRenderer({ content, language }: CodeRendererProps) {
  return (
    <div className="w-[85vw] h-[85vh] flex flex-col">
      <Editor
        value={content}
        language={language}
        theme="vs-dark"
        options={{
          readOnly: true,
          minimap: { enabled: false },
          wordWrap: 'on',
          scrollBeyondLastLine: false,
          fontSize: 13,
          lineNumbers: 'on',
          renderLineHighlight: 'none',
          contextmenu: false,
          automaticLayout: true,
        }}
        loading={
          <div className="flex items-center gap-2 text-gray-400 h-full justify-center">
            <Loader2 size={20} className="animate-spin" />
            <span className="text-sm">Loading editor...</span>
          </div>
        }
      />
    </div>
  );
}
