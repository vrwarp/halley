import type { Hono } from 'hono';
import { BuildQueueTimeoutError } from '../build-queue.js';
import { ignore, ignoreExpected, logger, readJsonBodyOrEmpty } from '../log.js';
import { envInt, killProcessesWithEnv } from '../proc.js';
import { sleep, type TimerHandle } from '../clock.js';
import { DiskPressureError } from './shared.js';
import type { SupervisorContext } from './context.js';

/**
 * Container-wide build lock endpoints (NDJSON acquire stream, promote, release, defer). Registered
 * by createWorkspaceSupervisor (see SupervisorContext).
 */
export function registerBuildLockRoutes(app: Hono, ctx: SupervisorContext): void {
  const { clock, buildQueueTimeoutMs, buildQueue, assertDiskAdmission } = ctx;
  app.post('/internal/build-lock/defer-speculative', async (c) => {
    const body = (await readJsonBodyOrEmpty(c)) as { durationMs?: number };
    buildQueue.deferSpeculativeFor(Math.min(120_000, Math.max(1_000, Number(body.durationMs) || 15_000)));
    return c.json({ ok: true });
  });

  const speculativeStreamClosers = new Map<string, () => void>();

  async function waitForLeaseRelease(leaseId: string, timeoutMs: number): Promise<boolean> {
    const deadline = clock.now() + timeoutMs;
    while (clock.now() < deadline) {
      if (!buildQueue.isLeaseActive(leaseId)) return true;
      await sleep(clock, 100);
    }
    return !buildQueue.isLeaseActive(leaseId);
  }

  // Container-wide priority FIFO build lock (NDJSON stream)
  app.post('/internal/build-lock/acquire', async (c) => {
    const body = (await readJsonBodyOrEmpty(c)) as {
      sessionId?: string;
      priority?: 'foreground' | 'speculative';
      timeoutMs?: number;
    };
    const sessionId = body.sessionId || 'unknown';
    const priority = body.priority === 'speculative' ? 'speculative' : 'foreground';
    // W-disk: a build writes dist/ + caches into the shared volume
    try {
      await assertDiskAdmission('run site checks', { sessionId, priority });
    } catch (err) {
      if (err instanceof DiskPressureError) return c.json({ error: err.message, diskPressure: true }, 507);
      throw err;
    }
    // W7: client-supplied wait timeouts are clamped to [1s, configured queue timeout]
    const requestedTimeout = Number(body.timeoutMs);
    const timeoutMs =
      Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? Math.min(buildQueueTimeoutMs, Math.max(1_000, requestedTimeout))
        : undefined;
    const encoder = new TextEncoder();
    const ac = new AbortController();

    c.req.raw.signal?.addEventListener('abort', () => ac.abort(), { once: true });

    let acquiredLeaseId: string | null = null;
    let sentAcquired = false;
    let streamCancelled = false;

    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        let heartbeat: TimerHandle | null = null;
        const closeStream = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clock.clearTimeout(heartbeat);
          if (acquiredLeaseId) {
            speculativeStreamClosers.delete(acquiredLeaseId);
          }
          try {
            controller.close();
          } catch (err) {
            // already closed by the client cancelling the stream
            ignoreExpected(err, 'build lock: close stream');
          }
        };
        const send = (obj: Record<string, unknown>): boolean => {
          if (closed) return false;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
            return true;
          } catch (err) {
            ignoreExpected(err, 'build lock: stream already closed');
            return false;
          }
        };

        void buildQueue
          .acquire(sessionId, {
            priority,
            timeoutMs,
            signal: ac.signal,
            // W7: lease overdue (or preempted holder not exiting): revoke over the open stream so
            // the runner aborts its build (killing the build's process group), wait for release,
            // and as a last resort stop the runner and reap its build processes.
            onTerminate: async (reason) => {
              const leaseId = acquiredLeaseId;
              send({ event: 'revoked', leaseId, message: reason });
              if (leaseId && (await waitForLeaseRelease(leaseId, envInt('HALLEY_BUILD_REVOKE_GRACE_MS', 10_000, 100)))) {
                return;
              }
              logger.error('supervisor: build lease holder did not stop after revocation; stopping runner', {
                sessionId,
                leaseId,
                reason,
              });
              await ctx.stopSessionProcess(sessionId).catch((e) => ignore(e, 'supervisor: stop unresponsive build holder'));
              await killProcessesWithEnv('HALLEY_SESSION_ID', sessionId).catch((e) => ignore(e, 'supervisor: reap build holder'));
            },
            onQueued: (position) => {
              send({
                event: 'queued',
                position,
                message: `Waiting for another editor's checks to finish (position ${position})…`,
              });
            },
            onPreempted:
              priority === 'speculative'
                ? () => {
                    send({ event: 'preempted', leaseId: acquiredLeaseId });
                    closeStream();
                  }
                : undefined,
          })
          .then((lease) => {
            acquiredLeaseId = lease.leaseId;
            if (streamCancelled || ac.signal.aborted) {
              buildQueue.releaseByLease(lease.leaseId);
              closeStream();
              return;
            }
            sentAcquired = send({ event: 'acquired', leaseId: lease.leaseId });
            if (!sentAcquired) {
              buildQueue.releaseByLease(lease.leaseId);
              closeStream();
              return;
            }
            // Stream stays open for every priority so 'preempted'/'revoked' reach the holder;
            // heartbeats keep idle-body timeouts from closing it during long builds.
            speculativeStreamClosers.set(lease.leaseId, closeStream);
            heartbeat = clock.setInterval(() => {
              if (!send({ event: 'heartbeat' })) closeStream();
            }, 30_000);
            heartbeat.unref?.();
          })
          .catch((err) => {
            send({
              event: err instanceof BuildQueueTimeoutError ? 'timeout' : 'error',
              message: err instanceof Error ? err.message : String(err),
            });
            closeStream();
          });
      },
      cancel() {
        streamCancelled = true;
        ac.abort();
        if (acquiredLeaseId && !sentAcquired) {
          buildQueue.releaseByLease(acquiredLeaseId);
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
      },
    });
  });

  app.post('/internal/build-lock/promote', async (c) => {
    const body = (await readJsonBodyOrEmpty(c)) as { leaseId?: string };
    const promoted = body.leaseId ? buildQueue.promoteToForeground(body.leaseId) : false;
    if (body.leaseId) {
      speculativeStreamClosers.get(body.leaseId)?.();
    }
    return c.json({ ok: true, promoted });
  });

  app.post('/internal/build-lock/release', async (c) => {
    const body = (await readJsonBodyOrEmpty(c)) as { leaseId?: string };
    const released = body.leaseId ? buildQueue.releaseByLease(body.leaseId) : false;
    if (body.leaseId) {
      speculativeStreamClosers.get(body.leaseId)?.();
    }
    return c.json({ ok: true, released });
  });
}
