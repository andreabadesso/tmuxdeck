import { useMemo } from 'react';

interface MarkdownRendererProps {
  content: string;
}

/**
 * Simple markdown-to-HTML renderer. No external dependencies.
 * Handles headers, bold, italic, code blocks, inline code, links, lists,
 * blockquotes, and horizontal rules.
 */
function renderMarkdown(md: string): string {
  // Normalize line endings
  let text = md.replace(/\r\n/g, '\n');

  // Fenced code blocks
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const escaped = escapeHtml(code.trimEnd());
    return `<pre class="md-code-block"><code class="language-${lang}">${escaped}</code></pre>`;
  });

  // Process block-level elements
  const lines = text.split('\n');
  const output: string[] = [];
  let inList = false;
  let listType = '';
  let inBlockquote = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Skip lines inside pre blocks (already handled)
    if (line.includes('<pre class="md-code-block">')) {
      // Find end of pre block
      output.push(line);
      while (i < lines.length - 1 && !lines[i].includes('</pre>')) {
        i++;
        output.push(lines[i]);
      }
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeList();
      closeBlockquote();
      output.push('<hr class="md-hr" />');
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      closeList();
      closeBlockquote();
      const level = headerMatch[1].length;
      output.push(`<h${level} class="md-h${level}">${inlineFormat(headerMatch[2])}</h${level}>`);
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      closeList();
      if (!inBlockquote) {
        output.push('<blockquote class="md-blockquote">');
        inBlockquote = true;
      }
      output.push(`<p>${inlineFormat(line.slice(2))}</p>`);
      continue;
    } else if (inBlockquote) {
      closeBlockquote();
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[*\-+]\s+(.*)$/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        closeList();
        output.push('<ul class="md-ul">');
        inList = true;
        listType = 'ul';
      }
      output.push(`<li>${inlineFormat(ulMatch[2])}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        closeList();
        output.push('<ol class="md-ol">');
        inList = true;
        listType = 'ol';
      }
      output.push(`<li>${inlineFormat(olMatch[2])}</li>`);
      continue;
    }

    closeList();

    // Empty line
    if (line.trim() === '') {
      output.push('');
      continue;
    }

    // Paragraph
    output.push(`<p>${inlineFormat(line)}</p>`);
  }

  closeList();
  closeBlockquote();

  return output.join('\n');

  function closeList() {
    if (inList) {
      output.push(listType === 'ul' ? '</ul>' : '</ol>');
      inList = false;
      listType = '';
    }
  }

  function closeBlockquote() {
    if (inBlockquote) {
      output.push('</blockquote>');
      inBlockquote = false;
    }
  }
}

function inlineFormat(text: string): string {
  let result = escapeHtml(text);
  // Images: ![alt](url)
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="md-img" />');
  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="md-link">$1</a>');
  // Bold+italic
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/__(.+?)__/g, '<strong>$1</strong>');
  // Italic
  result = result.replace(/\*(.+?)\*/g, '<em>$1</em>');
  result = result.replace(/_(.+?)_/g, '<em>$1</em>');
  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, '<del>$1</del>');
  // Inline code
  result = result.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
  return result;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const html = useMemo(() => renderMarkdown(content), [content]);

  return (
    <div className="w-[70vw] max-h-[85vh] overflow-auto p-6">
      <div
        className="markdown-body prose prose-invert max-w-none
          [&_.md-h1]:text-3xl [&_.md-h1]:font-bold [&_.md-h1]:mb-4 [&_.md-h1]:mt-6 [&_.md-h1]:border-b [&_.md-h1]:border-gray-700 [&_.md-h1]:pb-2
          [&_.md-h2]:text-2xl [&_.md-h2]:font-bold [&_.md-h2]:mb-3 [&_.md-h2]:mt-5 [&_.md-h2]:border-b [&_.md-h2]:border-gray-700 [&_.md-h2]:pb-2
          [&_.md-h3]:text-xl [&_.md-h3]:font-semibold [&_.md-h3]:mb-2 [&_.md-h3]:mt-4
          [&_.md-h4]:text-lg [&_.md-h4]:font-semibold [&_.md-h4]:mb-2 [&_.md-h4]:mt-3
          [&_.md-h5]:text-base [&_.md-h5]:font-semibold [&_.md-h5]:mb-1 [&_.md-h5]:mt-2
          [&_.md-h6]:text-sm [&_.md-h6]:font-semibold [&_.md-h6]:mb-1 [&_.md-h6]:mt-2
          [&_p]:mb-3 [&_p]:leading-relaxed [&_p]:text-gray-300
          [&_.md-code-block]:bg-gray-800 [&_.md-code-block]:rounded-lg [&_.md-code-block]:p-4 [&_.md-code-block]:my-4 [&_.md-code-block]:overflow-x-auto [&_.md-code-block]:text-sm [&_.md-code-block]:text-gray-300 [&_.md-code-block]:font-mono
          [&_.md-inline-code]:bg-gray-800 [&_.md-inline-code]:rounded [&_.md-inline-code]:px-1.5 [&_.md-inline-code]:py-0.5 [&_.md-inline-code]:text-sm [&_.md-inline-code]:text-pink-400 [&_.md-inline-code]:font-mono
          [&_.md-link]:text-blue-400 [&_.md-link]:underline [&_.md-link]:hover:text-blue-300
          [&_.md-ul]:list-disc [&_.md-ul]:pl-6 [&_.md-ul]:mb-3 [&_.md-ul]:text-gray-300
          [&_.md-ol]:list-decimal [&_.md-ol]:pl-6 [&_.md-ol]:mb-3 [&_.md-ol]:text-gray-300
          [&_li]:mb-1
          [&_.md-blockquote]:border-l-4 [&_.md-blockquote]:border-gray-600 [&_.md-blockquote]:pl-4 [&_.md-blockquote]:my-3 [&_.md-blockquote]:text-gray-400 [&_.md-blockquote]:italic
          [&_.md-hr]:border-gray-700 [&_.md-hr]:my-6
          [&_strong]:font-bold [&_strong]:text-gray-200
          [&_em]:italic
          [&_del]:line-through [&_del]:text-gray-500
        "
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
