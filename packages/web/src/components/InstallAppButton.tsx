import { Download, PlusSquare, Share, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { usePwaInstall } from '../pwa/usePwaInstall.js';

/**
 * Subtle Dashboard button that triggers the native PWA install prompt on
 * Chromium/Android/Desktop, or opens a concise 2-step "Add to Home Screen" tip
 * on iOS Safari. Automatically hidden once running in standalone mode.
 */
export function InstallAppButton() {
  const { isStandalone, canPromptInstall, isIosSafari, triggerInstall } = usePwaInstall();
  const [showIosTip, setShowIosTip] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showIosTip) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowIosTip(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowIosTip(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [showIosTip]);

  if (isStandalone || (!canPromptInstall && !isIosSafari)) {
    return null;
  }

  const handleClick = () => {
    if (canPromptInstall) {
      void triggerInstall();
    } else if (isIosSafari) {
      setShowIosTip((prev) => !prev);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={handleClick}
        title="Install Halley app"
        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-700 transition hover:bg-stone-50 sm:px-3"
      >
        <Download className="h-3.5 w-3.5 text-amber-700" />
        <span className="hidden sm:inline">Install app</span>
        <span className="sm:hidden">Install</span>
      </button>

      {showIosTip && (
        <div
          role="dialog"
          aria-label="Install Halley on iPhone or iPad"
          className="absolute right-0 mt-2 w-72 rounded-xl border border-[#E7E5E4] bg-white p-4 text-xs text-stone-700 shadow-lg z-30"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold text-stone-900">Install Halley on your Home Screen</p>
            <button
              type="button"
              onClick={() => setShowIosTip(false)}
              aria-label="Close install instructions"
              className="rounded p-0.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <ol className="mt-2.5 space-y-2 text-stone-600">
            <li className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-stone-100 text-[11px] font-semibold text-stone-700">
                1
              </span>
              <span className="flex items-center gap-1">
                Tap <Share className="inline h-3.5 w-3.5 text-stone-800" /> <strong>Share</strong> in Safari
              </span>
            </li>
            <li className="flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-stone-100 text-[11px] font-semibold text-stone-700">
                2
              </span>
              <span className="flex items-center gap-1">
                Choose <PlusSquare className="inline h-3.5 w-3.5 text-stone-800" /> <strong>Add to Home Screen</strong>
              </span>
            </li>
          </ol>
        </div>
      )}
    </div>
  );
}
