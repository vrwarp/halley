import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/clock.js';
import { createProgressDeadline } from '../src/pi-runtime.js';

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('optimization run progress deadline', () => {
  it('never aborts a long run that keeps making progress, but stops one that goes idle', async () => {
    const clock = new ManualClock();
    let lastProgress = clock.now();
    let outcome: string | null = null;
    const d = createProgressDeadline(clock, () => lastProgress, { idleMs: 10 * 60_000, maxMs: 3 * 60 * 60_000 });
    void d.reached.then((o) => (outcome = o));

    // 2 hours of steady progress (an update every 5 minutes): far past the old fixed 30-minute cut-off
    for (let i = 0; i < 24; i++) {
      clock.advance(5 * 60_000);
      lastProgress = clock.now();
      await flush();
    }
    expect(outcome).toBeNull();

    // then silence: aborted within one check interval after 10 idle minutes, not before
    clock.advance(9 * 60_000);
    await flush();
    expect(outcome).toBeNull();
    clock.advance(2 * 60_000);
    await flush();
    expect(outcome).toBe('idle');
  });

  it('enforces the absolute ceiling even while progress continues, and cancel() stops checking', async () => {
    const clock = new ManualClock();
    let lastProgress = clock.now();
    let outcome: string | null = null;
    const d = createProgressDeadline(clock, () => lastProgress, { idleMs: 10 * 60_000, maxMs: 60 * 60_000 });
    void d.reached.then((o) => (outcome = o));
    for (let i = 0; i < 13; i++) {
      clock.advance(5 * 60_000);
      lastProgress = clock.now();
      await flush();
    }
    expect(outcome).toBe('max');

    const c = createProgressDeadline(clock, () => 0, { idleMs: 1_000, maxMs: 1_000 });
    let cancelledOutcome: string | null = null;
    void c.reached.then((o) => (cancelledOutcome = o));
    c.cancel();
    clock.advance(60_000);
    await flush();
    expect(cancelledOutcome).toBeNull();
  });
});
