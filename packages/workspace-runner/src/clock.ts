/**
 * Injectable clock so timers (debounces, backoffs, lease deadlines, fetch timeouts) can be driven by
 * tests. `realClock` is the production implementation; timers it returns are `unref`'d by callers.
 */
export interface TimerHandle {
  unref?: () => unknown;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | null | undefined): void;
  /** Repeating timer (cleared with `clearTimeout`). */
  setInterval(fn: () => void, ms: number): TimerHandle;
  /** An AbortSignal that aborts with a `TimeoutError` DOMException once `ms` elapse on this clock. */
  timeoutSignal(ms: number): AbortSignal;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => {
    // clearTimeout and clearInterval are interchangeable in Node
    if (h) clearTimeout(h as NodeJS.Timeout);
  },
  setInterval: (fn, ms) => setInterval(fn, ms),
  // native: no JS timer, does not keep the event loop alive
  timeoutSignal: (ms) => AbortSignal.timeout(ms),
};

/** Resolves after `ms` on `clock` (unref'd on the real clock: never holds the process open). */
export function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimeout(resolve, ms).unref?.();
  });
}

/** Deterministic manual clock for tests: `advance(ms)` fires due timers in order. */
export class ManualClock implements Clock {
  private t: number;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void; seq: number; every?: number }>();

  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  /** Jumps to an absolute time (running due timers), e.g. a file's mtime + threshold. */
  set(t: number): void {
    this.advance(Math.max(0, t - this.t));
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn, seq: id });
    return { id, unref: () => undefined } as TimerHandle;
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    const every = Math.max(1, ms);
    this.timers.set(id, { at: this.t + every, fn, seq: id, every });
    return { id, unref: () => undefined } as TimerHandle;
  }

  clearTimeout(handle: TimerHandle | null | undefined): void {
    const id = (handle as { id?: number } | null | undefined)?.id;
    if (id !== undefined) this.timers.delete(id);
  }

  timeoutSignal(ms: number): AbortSignal {
    const ac = new AbortController();
    this.setTimeout(() => {
      ac.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    }, ms);
    return ac.signal;
  }

  pendingTimers(): number {
    return this.timers.size;
  }

  /** Milliseconds until the next timer is due (null when none is pending). */
  nextDueIn(): number | null {
    let at = Number.POSITIVE_INFINITY;
    for (const tm of this.timers.values()) if (tm.at < at) at = tm.at;
    return at === Number.POSITIVE_INFINITY ? null : Math.max(0, at - this.t);
  }

  /** Advances time by `ms`, running every timer that becomes due (including ones scheduled meanwhile). */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let next: { id: number; at: number; fn: () => void; seq: number; every?: number } | null = null;
      for (const [id, tm] of this.timers) {
        if (tm.at <= target && (!next || tm.at < next.at || (tm.at === next.at && tm.seq < next.seq))) {
          next = { id, ...tm };
        }
      }
      if (!next) break;
      if (next.every) this.timers.set(next.id, { at: next.at + next.every, fn: next.fn, seq: next.seq, every: next.every });
      else this.timers.delete(next.id);
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = target;
  }
}
