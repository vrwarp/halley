import crypto from 'node:crypto';

export interface BuildQueueStatus {
  activeSessionId: string | null;
  queueLength: number;
  queuedSessionIds: string[];
}

export interface BuildLease {
  leaseId: string;
  sessionId: string;
  release: () => void;
}

interface Waiter {
  id: string;
  sessionId: string;
  onPosition?: (position: number) => void;
  resolve: (lease: BuildLease) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

export class BuildQueueTimeoutError extends Error {
  constructor(timeoutMs: number) {
    const mins = Math.max(1, Math.round(timeoutMs / 60_000));
    super(
      `Timed out after ${mins} minute${mins === 1 ? '' : 's'} waiting for another editor's checks to finish. Please try again.`,
    );
    this.name = 'BuildQueueTimeoutError';
  }
}

export class FifoBuildQueue {
  private active: { leaseId: string; sessionId: string } | null = null;
  private queue: Waiter[] = [];

  constructor(private readonly defaultTimeoutMs = 10 * 60_000) {}

  getStatus(): BuildQueueStatus {
    return {
      activeSessionId: this.active?.sessionId ?? null,
      queueLength: this.queue.length,
      queuedSessionIds: this.queue.map((w) => w.sessionId),
    };
  }

  acquire(
    sessionId: string,
    opts?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      onQueued?: (position: number) => void;
    },
  ): Promise<BuildLease> {
    if (!this.active) {
      const leaseId = crypto.randomUUID();
      this.active = { leaseId, sessionId };
      return Promise.resolve({
        leaseId,
        sessionId,
        release: () => this.releaseByLease(leaseId),
      });
    }

    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<BuildLease>((resolve, reject) => {
      const waiterId = crypto.randomUUID();
      const waiter: Waiter = {
        id: waiterId,
        sessionId,
        onPosition: opts?.onQueued,
        resolve,
        reject,
        timer: null,
      };

      const cleanup = () => {
        if (waiter.timer) {
          clearTimeout(waiter.timer);
          waiter.timer = null;
        }
        const idx = this.queue.indexOf(waiter);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          this.notifyPositions();
        }
      };

      if (opts?.signal) {
        if (opts.signal.aborted) {
          reject(new Error('Build queue wait aborted'));
          return;
        }
        opts.signal.addEventListener(
          'abort',
          () => {
            cleanup();
            reject(new Error('Build queue wait aborted'));
          },
          { once: true },
        );
      }

      waiter.timer = setTimeout(() => {
        cleanup();
        reject(new BuildQueueTimeoutError(timeoutMs));
      }, timeoutMs);
      waiter.timer.unref?.();

      this.queue.push(waiter);
      opts?.onQueued?.(this.queue.length);
    });
  }

  releaseByLease(leaseId: string): boolean {
    if (this.active?.leaseId !== leaseId) return false;
    this.active = null;
    this.pump();
    return true;
  }

  /**
   * Releases any active lock or queued waiters belonging to a session
   * (e.g. when a session's child process exits unexpectedly).
   */
  releaseBySession(sessionId: string): void {
    // Remove queued waiters for this session
    let removed = false;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const w = this.queue[i]!;
      if (w.sessionId === sessionId) {
        if (w.timer) clearTimeout(w.timer);
        this.queue.splice(i, 1);
        w.reject(new Error('Workspace stopped while waiting in build queue'));
        removed = true;
      }
    }
    if (removed) this.notifyPositions();

    if (this.active?.sessionId === sessionId) {
      this.active = null;
      this.pump();
    }
  }

  private pump(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    if (next.timer) {
      clearTimeout(next.timer);
      next.timer = null;
    }
    const leaseId = crypto.randomUUID();
    this.active = { leaseId, sessionId: next.sessionId };
    this.notifyPositions();
    next.resolve({
      leaseId,
      sessionId: next.sessionId,
      release: () => this.releaseByLease(leaseId),
    });
  }

  private notifyPositions(): void {
    this.queue.forEach((w, idx) => {
      w.onPosition?.(idx + 1);
    });
  }
}
