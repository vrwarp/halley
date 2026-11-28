import type { Clock, TimerHandle } from '../../src/clock.js';

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
  /** Timeout-signal deadlines: fire when time passes them, but never by themselves pull auto-advance forward. */
  weak?: boolean;
}

/**
 * Virtual-time Clock for tests. Timers fire only when time is advanced:
 * - manually with `advance(ms)` / `runNext()`, or
 * - automatically (`autoAdvance: true`): whenever the event loop has nothing else ready
 *   (a macrotask after the timer was registered), virtual time jumps to the earliest pending timer.
 *   Poll loops and backoffs that interleave real I/O with sleeps then run without wall-clock waits.
 */
export class FakeClock implements Clock {
  private t: number;
  private timers: FakeTimer[] = [];
  private seq = 0;
  private autoScheduled = false;
  private readonly autoAdvance: boolean;
  /** Total virtual time slept through, for assertions. */
  firedCount = 0;

  constructor(opts: { start?: number; autoAdvance?: boolean } = {}) {
    this.t = opts.start ?? Date.parse('2026-01-01T00:00:00Z');
    this.autoAdvance = opts.autoAdvance ?? false;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    return this.addTimer(fn, ms, false);
  }

  /**
   * Like `AbortSignal.timeout(ms)` on virtual time: aborts with a DOMException('TimeoutError') once
   * fake time passes `ms`. The deadline is "weak" (like the native, unref'd timer): auto-advance
   * never jumps to it on its own, so an in-flight request is only timed out when time is advanced
   * explicitly or for another timer.
   */
  timeoutSignal(ms: number): AbortSignal {
    const ac = new AbortController();
    this.addTimer(
      () => ac.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      ms,
      true,
    );
    return ac.signal;
  }

  private addTimer(fn: () => void, ms: number, weak: boolean): TimerHandle {
    const timer: FakeTimer = { id: ++this.seq, at: this.t + Math.max(0, ms), fn, weak };
    // Keep sorted by (at, id): insert after every timer due at or before this one.
    let i = this.timers.length;
    while (i > 0 && this.timers[i - 1]!.at > timer.at) i--;
    this.timers.splice(i, 0, timer);
    if (this.autoAdvance && !weak) this.scheduleAuto();
    return { __timer: timer.id };
  }

  clearTimeout(handle: TimerHandle | null | undefined): void {
    const id = (handle as { __timer?: number } | null | undefined)?.__timer;
    if (id === undefined) return;
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const h = this.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        this.clearTimeout(h);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Pending ordinary timers (timeout-signal deadlines excluded; see `pendingTimeoutSignals`). */
  pendingTimers(): number {
    return this.timers.reduce((n, t) => n + (t.weak ? 0 : 1), 0);
  }

  pendingTimeoutSignals(): number {
    return this.timers.reduce((n, t) => n + (t.weak ? 1 : 0), 0);
  }

  /** Fires the earliest timer (advancing time to it). Returns false when none is pending. */
  runNext(): boolean {
    const next = this.timers.shift();
    if (!next) return false;
    this.t = Math.max(this.t, next.at);
    this.firedCount += 1;
    next.fn();
    return true;
  }

  /** Advances virtual time by `ms`, firing due timers in order and letting their continuations run. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.runNext();
      await flushMacrotask();
    }
    this.t = target;
    await flushMacrotask();
  }

  private scheduleAuto(): void {
    if (this.autoScheduled) return;
    this.autoScheduled = true;
    setImmediate(() => {
      this.autoScheduled = false;
      // Jump to the earliest ordinary timer, firing any timeout deadlines passed on the way.
      const target = this.timers.find((t) => !t.weak);
      if (!target) return;
      while (this.timers[0] !== target) this.runNext();
      this.runNext();
      if (this.timers.some((t) => !t.weak)) this.scheduleAuto();
    });
  }
}

function flushMacrotask(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
