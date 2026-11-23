export interface AsyncFileLock {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  isLocked(key: string): boolean;
}

export class PerFileMutex implements AsyncFileLock {
  private queues = new Map<string, Promise<void>>();
  private activeCounts = new Map<string, number>();

  isLocked(key: string): boolean {
    return (this.activeCounts.get(key) ?? 0) > 0;
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => next);
    this.queues.set(key, tail);

    await prev;
    this.activeCounts.set(key, (this.activeCounts.get(key) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const remaining = (this.activeCounts.get(key) ?? 1) - 1;
      if (remaining <= 0) {
        this.activeCounts.delete(key);
      } else {
        this.activeCounts.set(key, remaining);
      }
      if (this.queues.get(key) === tail) {
        this.queues.delete(key);
      }
      release();
    }
  }
}
