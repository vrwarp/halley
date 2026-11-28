import { Download, PlusSquare, Share, X } from 'lucide-react';
import { useState } from 'react';
import { usePwaInstall } from '../pwa/usePwaInstall.js';

const DISMISS_STORAGE_KEY = 'halley_install_banner_dismissed_v1';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Calm, dismissible PWA install card positioned below primary Dashboard tasks
 * (Start a new edit & Active drafts) so it never crowds the top bar or competes
 * with the primary CTA. Automatically hidden when installed or dismissed.
 */
export function InstallAppBanner() {
  const { isStandalone, canPromptInstall, isIosSafari, triggerInstall } = usePwaInstall();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [showIosTip, setShowIosTip] = useState(false);

  if (dismissed || isStandalone || (!canPromptInstall && !isIosSafari)) {
    return null;
  }

  const handleDismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_STORAGE_KEY, '1');
    } catch {
      // ignore storage errors
    }
  };

  const handleInstall = () => {
    if (canPromptInstall) {
      void triggerInstall();
    } else if (isIosSafari) {
      setShowIosTip((prev) => !prev);
    }
  };

  return (
    <section
      aria-label="Install Halley app"
      className="mt-8 rounded-2xl border border-[#E7E5E4] bg-white px-3.5 py-3"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#F5F4F0] text-amber-700">
            <Download className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-stone-900">Install Halley</p>
            <p className="truncate text-xs text-stone-500">One-tap full-screen editor</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={handleInstall}
            className="inline-flex h-10 items-center rounded-xl bg-[#F5F4F0] px-3.5 text-xs font-semibold text-stone-900 transition hover:bg-[#EAE7E1]"
          >
            Install
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss install prompt"
            className="flex h-11 w-11 items-center justify-center rounded-xl text-stone-500 transition hover:bg-stone-100 hover:text-stone-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {showIosTip && (
        <ol className="mt-3 space-y-2 border-t border-[#F0EEEB] pt-3 text-xs text-stone-600">
          <li className="flex items-center gap-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#F5F4F0] text-[11px] font-semibold text-stone-700">
              1
            </span>
            <span className="flex items-center gap-1">
              Tap <Share className="inline h-3.5 w-3.5 text-stone-800" /> <strong>Share</strong> in Safari
            </span>
          </li>
          <li className="flex items-center gap-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#F5F4F0] text-[11px] font-semibold text-stone-700">
              2
            </span>
            <span className="flex items-center gap-1">
              Choose <PlusSquare className="inline h-3.5 w-3.5 text-stone-800" />{' '}
              <strong>Add to Home Screen</strong>
            </span>
          </li>
        </ol>
      )}
    </section>
  );
}
