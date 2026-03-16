import { Info } from 'lucide-react';

export function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="relative group inline-flex ml-1 cursor-help">
      <Info size={12} className="text-gray-500 group-hover:text-gray-300 transition-colors" />
      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 rounded bg-gray-900 border border-gray-700 text-xs text-gray-300 max-w-xs whitespace-normal opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10 w-56 text-center">
        {text}
      </span>
    </span>
  );
}
