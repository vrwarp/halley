import { useCallback, useLayoutEffect, useRef } from 'react';

/** Exponential backoff: 1s, 2s, 4s, … capped at 30s. `attempt` is 0-based. */
export function backoffDelayMs(attempt: number, baseMs = 1000, capMs = 30_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, Math.min(attempt, 20)));
}

export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return fallback;
}

/**
 * Latest-callback ref: returns a stable function identity that always invokes the most
 * recently rendered `fn`. Use for handlers captured by long-lived subscriptions (WebSocket,
 * intervals) and for callbacks passed to memoized children.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

/**
 * Explicitly ignore an error that is safe to drop (best-effort UI work: storage, clipboard,
 * prefetches). Never silent: logs at debug level with the reason so it is visible in devtools.
 */
export function reportIgnored(err: unknown, reason: string): void {
  console.debug(`[halley] ignored: ${reason}`, err);
}
