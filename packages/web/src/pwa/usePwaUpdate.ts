import { useCallback, useEffect, useRef, useState } from 'react';

export interface PwaUpdateState {
  updateAvailable: boolean;
  applyUpdate: () => void;
  dismissUpdate: () => void;
}

/**
 * Registers the unified root-scoped Service Worker (`/halley-preview-sw.js`)
 * which provides both preview-tab isolation and PWA app-shell caching/offline fallback.
 * Surfaces a non-disruptive update toast whenever a newer deployment is waiting.
 */
export function usePwaUpdate(): PwaUpdateState {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const waitingWorkerRef = useRef<ServiceWorker | null>(null);
  const userRequestedReloadRef = useRef(false);
  const reloadingRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    let cancelled = false;
    let registrationRef: ServiceWorkerRegistration | null = null;

    const markWaiting = (worker: ServiceWorker | null) => {
      if (!worker || cancelled) return;
      waitingWorkerRef.current = worker;
      setUpdateAvailable(true);
    };

    const onControllerChange = () => {
      // Only reload when the user explicitly clicked "Reload" in the update toast.
      // Never reload on first-install clients.claim().
      if (!userRequestedReloadRef.current || reloadingRef.current) return;
      reloadingRef.current = true;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register('/halley-preview-sw.js', { scope: '/' });
        if (cancelled) return;
        registrationRef = reg;

        if (reg.waiting && navigator.serviceWorker.controller) {
          markWaiting(reg.waiting);
        }

        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              markWaiting(installing);
            }
          });
        });
      } catch {
        // Non-HTTPS LAN environments fall back cleanly to Referer-scoped routing
      }
    };

    void register();

    // Check for updates when returning to the tab/app
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && registrationRef) {
        void registrationRef.update().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    userRequestedReloadRef.current = true;
    const waiting = waitingWorkerRef.current;
    if (waiting) {
      waiting.postMessage({ type: 'SKIP_WAITING' });
    } else {
      window.location.reload();
    }
  }, []);

  const dismissUpdate = useCallback(() => {
    setUpdateAvailable(false);
  }, []);

  return { updateAvailable, applyUpdate, dismissUpdate };
}
