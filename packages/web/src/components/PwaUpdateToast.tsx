import { RefreshCw, X } from 'lucide-react';
import { usePwaUpdate } from '../pwa/usePwaUpdate.js';

/**
 * Non-disruptive toast shown when a newer Halley deployment is ready.
 * Never interrupts an active editing session; editors reload when ready.
 */
export function PwaUpdateToast() {
  const { updateAvailable, applyUpdate, dismissUpdate } = usePwaUpdate();

  if (!updateAvailable) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-xl border border-stone-700/80 bg-[#1C1917] px-3.5 py-2.5 text-xs text-stone-100 shadow-lg"
      style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
    >
      <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" aria-hidden="true" />
      <span className="font-medium">New version of Halley available</span>
      <button
        type="button"
        onClick={applyUpdate}
        className="inline-flex items-center gap-1 rounded-lg bg-amber-400 px-2.5 py-1 text-xs font-semibold text-stone-950 transition hover:bg-amber-300"
      >
        <RefreshCw className="h-3 w-3" />
        Reload
      </button>
      <button
        type="button"
        onClick={dismissUpdate}
        aria-label="Dismiss update notification"
        className="rounded-md p-1 text-stone-400 transition hover:bg-stone-800 hover:text-stone-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
