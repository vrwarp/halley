/** Minimal FIFO async mutex. `run(fn)` executes `fn` with exclusive access; errors propagate. */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    this.pending++;
    const next = this.tail.then(fn, fn).finally(() => {
      this.pending--;
    });
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Number of holders + waiters (diagnostics). */
  get size(): number {
    return this.pending;
  }
}

/** One AsyncMutex per key, dropped when idle. */
export class KeyedMutex {
  private locks = new Map<string, AsyncMutex>();

  run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    let m = this.locks.get(key);
    if (!m) {
      m = new AsyncMutex();
      this.locks.set(key, m);
    }
    const mutex = m;
    return mutex.run(fn).finally(() => {
      if (mutex.size === 0 && this.locks.get(key) === mutex) this.locks.delete(key);
    });
  }

  isLocked(key: string): boolean {
    return (this.locks.get(key)?.size ?? 0) > 0;
  }
}
