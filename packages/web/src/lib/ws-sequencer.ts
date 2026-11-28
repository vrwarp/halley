/**
 * Client-side ordering for server→client WebSocket frames.
 *
 * The workspace runner stamps every frame with `seq` (monotonic per epoch) and `epoch` (one value
 * per runner boot). Both are optional: older runners omit them and every frame is then applied as
 * before. Pure (no React / DOM) so it can be unit-tested and reused.
 *
 * Rules
 *  - No `seq` on the frame: apply (legacy runner). An `epoch` alone still detects restarts.
 *  - Epoch differs from the last seen epoch: apply, rebase, request a full resync (the runner
 *    restarted, so anything we derived from earlier frames may be stale and frames were lost).
 *  - Same epoch, `seq <= last`: duplicate → drop. Exception: the FIRST frame on a new connection
 *    rebases instead of being dropped, so a server that restarts its counter per connection can
 *    never wedge the client into dropping everything (reconnects resync anyway, see below).
 *  - Same epoch, `seq > last + 1`: frames were lost → apply, rebase, request a full resync.
 *  - Close codes 1012 (service restart) and 1013 (try again later) mark the next connection as
 *    needing a resync; so does any reconnect after a drop (events sent while we were offline,
 *    e.g. `checkpoint_created`, are never replayed).
 */

export type ResyncReason = 'gap' | 'epoch-change' | 'server-restart-close' | 'reconnect';

export type FrameDecision =
  | { action: 'apply' }
  | { action: 'drop'; reason: 'duplicate'; seq: number; lastSeq: number }
  | { action: 'apply-and-resync'; reason: Extract<ResyncReason, 'gap' | 'epoch-change'>; detail: string };

/** WebSocket close codes after which the server state must be re-fetched. */
export const RESYNC_CLOSE_CODES: ReadonlySet<number> = new Set([1012, 1013]);

export interface FrameSequenceFields {
  seq?: unknown;
  epoch?: unknown;
}

export class WsSequencer {
  private lastSeq: number | null = null;
  private epoch: string | null = null;
  private firstFrameOnConnection = true;
  private pendingResync: ResyncReason | null = null;
  private connections = 0;
  /** The current connection already triggered a full resync on open. */
  private resyncedOnOpen = false;

  /** Call on every successful `open`. Returns a resync reason when this open must resync. */
  onOpen(): ResyncReason | null {
    this.connections += 1;
    this.firstFrameOnConnection = true;
    const pending = this.pendingResync;
    this.pendingResync = null;
    const reason: ResyncReason | null = pending ?? (this.connections > 1 ? 'reconnect' : null);
    this.resyncedOnOpen = reason !== null;
    return reason;
  }

  /** Call on `close`. 1012/1013 force a resync on the next open even if it is the first. */
  onClose(code: number): void {
    if (RESYNC_CLOSE_CODES.has(code)) this.pendingResync = 'server-restart-close';
  }

  observe(frame: FrameSequenceFields): FrameDecision {
    const first = this.firstFrameOnConnection;
    this.firstFrameOnConnection = false;
    const epoch = typeof frame.epoch === 'string' && frame.epoch ? frame.epoch : null;
    const seq = typeof frame.seq === 'number' && Number.isFinite(frame.seq) ? frame.seq : null;

    // A gap/epoch change seen on the first frame after an open that already resynced is covered
    // by that resync: just rebase.
    const coveredByOpenResync = first && this.resyncedOnOpen;
    if (epoch !== null && this.epoch !== null && epoch !== this.epoch) {
      const detail = `epoch ${this.epoch} -> ${epoch}`;
      this.epoch = epoch;
      this.lastSeq = seq;
      return coveredByOpenResync ? { action: 'apply' } : { action: 'apply-and-resync', reason: 'epoch-change', detail };
    }
    if (epoch !== null) this.epoch = epoch;
    if (seq === null) return { action: 'apply' };

    const last = this.lastSeq;
    if (last === null) {
      this.lastSeq = seq;
      return { action: 'apply' };
    }
    if (seq <= last) {
      if (first) {
        this.lastSeq = seq;
        return { action: 'apply' };
      }
      return { action: 'drop', reason: 'duplicate', seq, lastSeq: last };
    }
    this.lastSeq = seq;
    if (seq > last + 1 && !coveredByOpenResync) {
      return { action: 'apply-and-resync', reason: 'gap', detail: `expected seq ${last + 1}, got ${seq}` };
    }
    return { action: 'apply' };
  }

  /** For diagnostics/tests. */
  snapshot(): { lastSeq: number | null; epoch: string | null } {
    return { lastSeq: this.lastSeq, epoch: this.epoch };
  }
}

/**
 * Coalesces resync requests: at most one full resync in flight, plus at most one queued behind it
 * (a request that arrives mid-resync must re-run, since the in-flight fetch may predate it).
 */
export function createResyncScheduler(run: (reason: ResyncReason) => Promise<void>) {
  let inFlight: Promise<void> | null = null;
  let queued: ResyncReason | null = null;
  const start = (reason: ResyncReason): Promise<void> => {
    inFlight = run(reason)
      .catch((err: unknown) => {
        console.warn('[halley] WebSocket resync failed', reason, err);
      })
      .finally(() => {
        inFlight = null;
        if (queued) {
          const next = queued;
          queued = null;
          void start(next);
        }
      });
    return inFlight;
  };
  return (reason: ResyncReason): void => {
    if (inFlight) {
      queued = reason;
      return;
    }
    void start(reason);
  };
}
