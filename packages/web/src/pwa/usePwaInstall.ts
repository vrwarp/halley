import { useCallback, useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

export interface PwaInstallState {
  isStandalone: boolean;
  canPromptInstall: boolean;
  isIosSafari: boolean;
  triggerInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const mq = window.matchMedia?.('(display-mode: standalone)')?.matches ?? false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return mq || nav.standalone === true;
}

function detectIosSafari(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent;
  const isIos =
    /iPad|iPhone|iPod/.test(ua) ||
    (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
  if (!isIos) return false;
  // Exclude Chrome/Firefox/Edge on iOS since only Safari supports Add to Home Screen cleanly
  const isOtherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return !isOtherBrowser && /Safari/.test(ua);
}

/**
 * Tracks PWA installability: captures beforeinstallprompt on Chromium/Android/Desktop
 * and detects iOS Safari so we can show a lightweight Share -> Add to Home Screen tip.
 */
export function usePwaInstall(): PwaInstallState {
  const [isStandalone, setIsStandalone] = useState(detectStandalone);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isIosSafari] = useState(detectIosSafari);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const onAppInstalled = () => {
      setDeferredPrompt(null);
      setIsStandalone(true);
    };

    const mq = window.matchMedia?.('(display-mode: standalone)');
    const onMqChange = (e: MediaQueryListEvent) => setIsStandalone(e.matches);

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    mq?.addEventListener?.('change', onMqChange);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
      mq?.removeEventListener?.('change', onMqChange);
    };
  }, []);

  const triggerInstall = useCallback(async () => {
    if (!deferredPrompt) return 'unavailable';
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    return outcome;
  }, [deferredPrompt]);

  return {
    isStandalone,
    canPromptInstall: !isStandalone && Boolean(deferredPrompt),
    isIosSafari: !isStandalone && isIosSafari,
    triggerInstall,
  };
}
