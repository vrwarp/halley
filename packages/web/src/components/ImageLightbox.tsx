import type { VisualDiffHighlightDto } from '@halley/shared';
import { X, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useState } from 'react';

interface Props {
  src: string;
  alt: string;
  title: string;
  highlights?: VisualDiffHighlightDto[];
  onClose: () => void;
}

export function ImageLightbox({ src, alt, title, highlights = [], onClose }: Props) {
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[70] flex flex-col bg-stone-950/92 text-white"
    >
      <div
        className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-4 py-3"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
        <p className="truncate text-xs font-medium text-stone-200">{title}</p>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(1, Number((z - 0.5).toFixed(1))))}
            disabled={zoom <= 1}
            aria-label="Zoom out"
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-white hover:bg-white/20 disabled:opacity-40"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <span className="min-w-[44px] text-center font-mono text-xs text-stone-300">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(3, Number((z + 0.5).toFixed(1))))}
            disabled={zoom >= 3}
            aria-label="Zoom in"
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-white hover:bg-white/20 disabled:opacity-40"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close fullscreen preview"
            className="ml-1 flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-white hover:bg-white/20"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div
        className="flex-1 overflow-auto p-3"
        style={{
          touchAction: 'pinch-zoom pan-x pan-y',
          paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          className="relative mx-auto overflow-hidden rounded-lg bg-white shadow-2xl transition-[width] duration-150"
          style={{ width: `${Math.round(zoom * 100)}%`, maxWidth: zoom === 1 ? '960px' : 'none' }}
        >
          <img src={src} alt={alt} className="block w-full select-none" />
          {highlights.map((h, idx) => (
            <div
              key={idx}
              title={h.warning || h.file}
              style={{
                left: `${h.x}%`,
                top: `${h.y}%`,
                width: `${h.width}%`,
                height: `${h.height}%`,
              }}
              className={`pointer-events-none absolute rounded border-2 ${
                h.kind === 'merged_from_live'
                  ? 'border-teal-500 bg-teal-500/15'
                  : 'border-amber-500 bg-amber-500/15'
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
