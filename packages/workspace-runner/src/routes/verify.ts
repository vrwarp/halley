import type { Hono } from 'hono';
import { readJsonBodyOrEmpty } from '../log.js';
import { runAllVerificationChecks } from '../verify.js';
import type { RunnerContext } from '../runner-context.js';

/** Pre-publish verification endpoints. Registered by createRunner (see RunnerContext). */
export function registerVerifyRoutes(app: Hono, ctx: RunnerContext): void {
  const {
    config,
    REPO_ROOT,
    SESSION_ID,
    SUPERVISOR_URL,
    resolveHeadSha,
    broadcast,
    triggerImmediateSpeculativeVerify,
    astroManager,
  } = ctx;
  app.post('/internal/verify/speculative', (c) => {
    if (ctx.readOnly) return c.json({ ok: false, reason: 'read-only' });
    triggerImmediateSpeculativeVerify();
    return c.json({ ok: true });
  });

  app.post('/internal/verify', async (c) => {
    const body = (await readJsonBodyOrEmpty(c)) as { pausePreview?: boolean };
    // Never need to pause live astro dev when isolated verify-sandbox is active
    const shouldPause = Boolean(body.pausePreview) && !config.verifySandbox;
    ctx.activeVerifyRuns += 1;
    try {
      if (shouldPause) {
        ctx.currentPreviewPaused = true;
        ctx.currentPreviewPauseReason = 'Running pre-publish checks…';
        broadcast({
          type: 'preview_paused',
          paused: true,
          reason: 'Running pre-publish checks…',
        });
        await astroManager.pause();
      }
      // The commit the checks run against; the control plane pushes exactly this sha on success
      const headSha = await resolveHeadSha();
      const result = await runAllVerificationChecks(REPO_ROOT, {
        supervisorUrl: SUPERVISOR_URL || undefined,
        hostSecret: ctx.activeHostSecret || undefined,
        sessionId: SESSION_ID,
        priority: 'foreground',
        onQueued: (position, message) => {
          broadcast({
            type: 'publish_state',
            payload: {
              state: 'verifying',
              queuePosition: position,
              queueMessage: message,
            },
          });
        },
        onAcquired: () => {
          broadcast({
            type: 'publish_state',
            payload: {
              state: 'verifying',
              queuePosition: null,
              queueMessage: null,
            },
          });
        },
      });
      const headAfter = await resolveHeadSha();
      return c.json({
        ...result,
        headSha,
        // HEAD moved while checks ran (e.g. a checkpoint landed): the result may not match headSha
        ...(headAfter !== headSha ? { headShaAfter: headAfter } : {}),
      });
    } catch (err) {
      return c.json(
        {
          allPassed: false,
          results: [
            {
              name: 'Build queue',
              command: 'halley-build-queue',
              passed: false,
              durationMs: 0,
              output: err instanceof Error ? err.message : 'Verification failed',
            },
          ],
        },
        200,
      );
    } finally {
      ctx.activeVerifyRuns = Math.max(0, ctx.activeVerifyRuns - 1);
      if (shouldPause) {
        try {
          await astroManager.resume();
        } catch (err) {
          console.error('[halley-runner] Failed to resume astro dev after verify:', err);
        }
        ctx.currentPreviewPaused = false;
        ctx.currentPreviewPauseReason = undefined;
        broadcast({ type: 'preview_paused', paused: false });
      }
    }
  });
}
