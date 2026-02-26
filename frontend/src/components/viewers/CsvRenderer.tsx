import { useMemo } from 'react';

interface CsvRendererProps {
  content: string;
  path: string;
}

/**
 * RFC 4180-compliant CSV/TSV parser.
 * Handles quoted fields with escaped quotes.
 */
function parseCsv(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === separator) {
        row.push(field);
        field = '';
        i++;
      } else if (ch === '\n') {
        row.push(field);
        field = '';
        if (row.length > 1 || row[0] !== '') {
          rows.push(row);
        }
        row = [];
        i++;
      } else if (ch === '\r') {
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }

  // Last field/row
  if (field || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') {
      rows.push(row);
    }
  }

  return rows;
}

export function CsvRenderer({ content, path }: CsvRendererProps) {
  const separator = path.toLowerCase().endsWith('.tsv') ? '\t' : ',';

  const rows = useMemo(() => parseCsv(content, separator), [content, separator]);

  if (rows.length === 0) {
    return (
      <div className="p-8 text-gray-400 text-center">
        No data found in file.
      </div>
    );
  }

  const header = rows[0];
  const body = rows.slice(1);

  return (
    <div className="w-[90vw] max-h-[85vh] overflow-auto">
      <table className="w-full border-collapse text-sm font-mono">
        <thead className="sticky top-0 z-10">
          <tr>
            {header.map((cell, i) => (
              <th
                key={i}
                className="bg-gray-800 text-gray-200 font-semibold px-3 py-2 text-left border-b border-gray-600 whitespace-nowrap"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr
              key={ri}
              className={ri % 2 === 0 ? 'bg-gray-900' : 'bg-gray-900/50'}
            >
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className="px-3 py-1.5 text-gray-300 border-b border-gray-800 whitespace-nowrap"
                >
                  {cell}
                </td>
              ))}
              {/* Pad missing cells */}
              {row.length < header.length &&
                Array.from({ length: header.length - row.length }).map((_, ci) => (
                  <td
                    key={`pad-${ci}`}
                    className="px-3 py-1.5 border-b border-gray-800"
                  />
                ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
