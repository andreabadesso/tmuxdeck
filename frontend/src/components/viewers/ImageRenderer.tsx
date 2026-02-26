import { useState } from 'react';
import { Loader2 } from 'lucide-react';

interface ImageRendererProps {
  url: string;
  filename: string;
}

export function ImageRenderer({ url, filename }: ImageRendererProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="p-4 flex items-center justify-center min-w-[300px] min-h-[200px]">
      {loading && !error && (
        <div className="absolute flex items-center gap-2 text-gray-400">
          <Loader2 size={20} className="animate-spin" />
          <span className="text-sm">Loading...</span>
        </div>
      )}
      {error ? (
        <div className="text-center text-red-400 px-8 py-4">
          <p className="font-medium">Failed to load image</p>
          <p className="text-sm text-red-500 mt-1">{error}</p>
        </div>
      ) : (
        <img
          src={url}
          alt={filename}
          className="max-w-[85vw] max-h-[80vh] object-contain rounded"
          onLoad={() => setLoading(false)}
          onError={() => {
            setLoading(false);
            setError(`Could not load: ${filename}`);
          }}
          style={{ display: loading ? 'none' : 'block' }}
        />
      )}
    </div>
  );
}
