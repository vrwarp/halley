import crypto from 'node:crypto';

export type BuildPriority = 'foreground' | 'speculative';

export interface BuildQueueStatus {
  activeSessionId: string | null;
  activePriority: BuildPriority | null;
  queueLength: number;
  queuedSessionIds: string[];
}

export interface BuildLease {
  leaseId: string;
  sessionId: string;
  priority: BuildPriority;
  release: () => void;
}

interface ActiveLease {
  leaseId: string;
  sessionId: string;
  priority: BuildPriority;
  onPreempted?: () => void;
}

interface Waiter {
  id: string;
  sessionId: string;
  priority: BuildPriority;
  onPosition?: (position: number) => void;
  lastPosition?: number;
  onPreempted?: () => void;
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
  private active: ActiveLease | null = null;
  private activeTimer: NodeJS.Timeout | null = null;
  private queue: Waiter[] = [];

  constructor(
    private readonly defaultTimeoutMs = 10 * 60_000,
    private readonly maxLeaseMs = 15 * 60_000,
  ) {}

  private clearActiveTimer(): void {
    if (this.activeTimer) {
      clearTimeout(this.activeTimer);
      this.activeTimer = null;
    }
  }

  private armActiveTimer(leaseId: string): void {
    this.clearActiveTimer();
    if (this.maxLeaseMs <= 0) return;
    this.activeTimer = setTimeout(() => {
      if (this.active?.leaseId === leaseId) {
        this.active = null;
        this.activeTimer = null;
        this.pump();
      }
    }, this.maxLeaseMs);
    this.activeTimer.unref?.();
  }

  getStatus(): BuildQueueStatus {
    return {
      activeSessionId: this.active?.sessionId ?? null,
      activePriority: this.active?.priority ?? null,
      queueLength: this.queue.length,
      queuedSessionIds: this.queue.map((w) => w.sessionId),
    };
  }

  acquire(
    sessionId: string,
    opts?: {
      priority?: BuildPriority;
      timeoutMs?: number;
      signal?: AbortSignal;
      onQueued?: (position: number) => void;
      onPreempted?: () => void;
    },
  ): Promise<BuildLease> {
    const priority: BuildPriority = opts?.priority ?? 'foreground';

    // Preempt an active speculative lease immediately when a foreground build arrives
    if (this.active && this.active.priority === 'speculative' && priority === 'foreground') {
      const preempted = this.active;
      this.active = null;
      this.clearActiveTimer();
      try {
        preempted.onPreempted?.();
      } catch {
        // ignore callback errors
      }
    }

    if (!this.active) {
      const leaseId = crypto.randomUUID();
      this.active = { leaseId, sessionId, priority, onPreempted: opts?.onPreempted };
      this.armActiveTimer(leaseId);
      return Promise.resolve({
        leaseId,
        sessionId,
        priority,
        release: () => this.releaseByLease(leaseId),
      });
    }

    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<BuildLease>((resolve, reject) => {
      const waiterId = crypto.randomUUID();
      const waiter: Waiter = {
        id: waiterId,
        sessionId,
        priority,
        onPosition: opts?.onQueued,
        onPreempted: opts?.onPreempted,
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

      if (priority === 'foreground') {
        // Insert after the last queued foreground waiter, ahead of any speculative waiters
        let insertAt = this.queue.length;
        for (let i = 0; i < this.queue.length; i++) {
          if (this.queue[i]!.priority === 'speculative') {
            insertAt = i;
            break;
          }
        }
        this.queue.splice(insertAt, 0, waiter);
        this.notifyPositions();
      } else {
        this.queue.push(waiter);
        this.notifyPositions();
      }
    });
  }

  /**
   * Promotes an active speculative lease to foreground in-place (used when a
   * session coalesces its own in-flight speculative check into a foreground Publish).
   */
  promoteToForeground(leaseId: string): boolean {
    if (this.active?.leaseId !== leaseId) return false;
    this.active.priority = 'foreground';
    this.active.onPreempted = undefined;
    return true;
  }

  releaseByLease(leaseId: string): boolean {
    if (this.active?.leaseId !== leaseId) return false;
    this.active = null;
    this.clearActiveTimer();
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
      this.clearActiveTimer();
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
    this.active = {
      leaseId,
      sessionId: next.sessionId,
      priority: next.priority,
      onPreempted: next.onPreempted,
    };
    this.armActiveTimer(leaseId);
    this.notifyPositions();
    next.resolve({
      leaseId,
      sessionId: next.sessionId,
      priority: next.priority,
      release: () => this.releaseByLease(leaseId),
    });
  }

  private notifyPositions(): void {
    this.queue.forEach((w, idx) => {
      const pos = idx + 1;
      if (w.lastPosition !== pos) {
        w.lastPosition = pos;
        w.onPosition?.(pos);
      }
    });
  }
}
