/**
 * Injectable time source so poll loops, backoffs and deadlines can be driven by a fake clock in
 * tests (no wall-clock sleeps). Production code uses `realClock`.
 */
import type { AuthService } from './auth/google.js';
import type { ControlPlaneDb } from './db.js';
import type { GitHubService } from './github/client.js';

export type TimerHandle = { readonly __timer?: unknown } | ReturnType<typeof setTimeout>;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | null | undefined): void;
  /** Resolves after `ms`. With `signal`, resolves early (never rejects) when it aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /**
   * An AbortSignal that aborts with a DOMException named 'TimeoutError' once `ms` has elapsed on
   * this clock (the injectable equivalent of `AbortSignal.timeout`).
   */
  timeoutSignal(ms: number): AbortSignal;
}

/**
 * `clock.timeoutSignal(ms)`, combined with `signal` when one is given (aborts on whichever fires
 * first; the reason is the first signal's reason).
 */
export function timeoutSignal(clock: Clock, ms: number, signal?: AbortSignal | null): AbortSignal {
  const t = clock.timeoutSignal(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => {
    if (h) clearTimeout(h as ReturnType<typeof setTimeout>);
  },
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
  // Native: no JS timer object, does not hold the event loop open.
  timeoutSignal: (ms) => AbortSignal.timeout(ms),
};

export type FetchFn = typeof fetch;

/** Id generator (session ids, run ids, row ids). Production uses crypto.randomUUID. */
export type IdGenerator = () => string;

/** Optional collaborators threaded through createControlPlane; every field defaults to the real thing. */
export interface ControlPlaneDeps {
  clock?: Clock;
  fetch?: FetchFn;
  randomUUID?: IdGenerator;
  /** Pre-built database (default: `<dataDir>/control-plane.sqlite` with this clock/ids). */
  db?: ControlPlaneDb;
  /** Pre-built GitHub client (default: GitHubService over config with this clock/fetch). */
  github?: GitHubService;
  /** Pre-built auth service (default: AuthService over config and db with this clock/fetch). */
  auth?: AuthService;
}
