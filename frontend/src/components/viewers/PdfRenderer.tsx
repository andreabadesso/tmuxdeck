interface PdfRendererProps {
  url: string;
}

export function PdfRenderer({ url }: PdfRendererProps) {
  return (
    <div className="w-[80vw] h-[85vh] flex flex-col">
      <iframe
        src={url}
        className="w-full h-full rounded bg-white"
        sandbox="allow-same-origin"
        title="PDF viewer"
      />
      <div className="text-center text-xs text-gray-500 py-2">
        If the PDF doesn't display,{' '}
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
          download it here
        </a>.
      </div>
    </div>
  );
}
