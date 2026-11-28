import { PublishRequestSchema } from '@halley/shared';
import { readJsonObject } from '../http-body.js';
import { ignore, orDefault } from '../log.js';
import { isPublishInFlight } from '../session-state.js';
import { type App, type ControlPlaneContext } from '../control-plane-context.js';

/** Registers the session action routes (publish, prompt, transcript, debug trace, fix-with-pi). */
export function register(app: App, ctx: ControlPlaneContext) {
  const { clock, runnerFetch, db, auth, driver, broadcastToSession, publishService, requireSessionEdit } = ctx;
  app.post('/api/sessions/:id/publish', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const rawBody = await readJsonObject(c);
    const parsed = PublishRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message || 'Invalid publish request' }, 400);
    }
    const body = parsed.data;

    // Run durable publish pipeline in background so UI can dismiss modal & stream progress over WS
    void publishService.publish(check.session, check.user, {
      title: body.title,
      summary: body.summary,
      excludePaths: body.excludePaths,
    });
    return c.json({ ok: true, started: true });
  });

  app.post('/api/sessions/:id/prompt', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const body = await c.req.json();
    const ep = await driver.ensureRunning(check.session);
    db.touchSessionActivity(check.session.id);
    const res = await runnerFetch(`${ep.runnerUrl}/internal/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: clock.timeoutSignal(25_000),
    });
    const data = await orDefault(res.json(), { ok: res.ok }, 'prompt: runner response is not JSON', {
      sessionId: check.session.id,
      status: res.status,
    }, 'debug');
    return c.json(data, res.ok ? 200 : 400);
  });

  app.get('/api/sessions/:id/transcript', auth.requireAuth, async (c) => {
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    const parentSession = s.parent_session_id ? db.getSession(s.parent_session_id) : null;
    const parentArchive = s.parent_session_id ? db.getSessionArchive(s.parent_session_id) : null;
    const priorThread =
      parentSession && parentArchive
        ? {
            parentSessionId: parentSession.id,
            parentTitle: parentSession.title,
            parentStatus: parentSession.status,
            parentPublishedAt: parentSession.merged_at ?? parentSession.archived_at ?? parentSession.last_active_at,
            entries: (() => {
              try {
                const parsed = JSON.parse(parentArchive.transcriptJson) as { entries?: unknown[] };
                return parsed.entries ?? [];
              } catch (err) {
                ignore(err, 'transcript: parent archive is not valid JSON', { sessionId: parentSession.id });
                return [];
              }
            })(),
          }
        : null;

    // If volume expired (>420d), serve archived transcript from DB without waking a deleted volume
    if (s.volume_expired_at) {
      const ownArchive = db.getSessionArchive(s.id);
      if (ownArchive) {
        try {
          const parsed = JSON.parse(ownArchive.transcriptJson) as Record<string, unknown>;
          return c.json({ ...parsed, volumeExpired: true, priorThread });
        } catch (err) {
          // fall through to the empty transcript
          ignore(err, 'transcript: archive is not valid JSON', { sessionId: s.id });
        }
      }
      return c.json({
        entries: [],
        live: { busy: false, streamingText: '', activeTools: [], queuedCount: 0 },
        usageUsd: 0,
        volumeExpired: true,
        priorThread,
      });
    }

    if (!s.runner_url || (s.status !== 'running' && s.status !== 'published' && s.status !== 'merged')) {
      const ownArchive = db.getSessionArchive(s.id);
      if (ownArchive) {
        try {
          const parsed = JSON.parse(ownArchive.transcriptJson) as Record<string, unknown>;
          return c.json({ ...parsed, priorThread });
        } catch (err) {
          // fall through to "not running"
          ignore(err, 'transcript: archive is not valid JSON', { sessionId: s.id });
        }
      }
      return c.json(
        {
          error: 'Workspace is not running',
          status: s.status,
          bootProgress: driver.getBootProgress?.(s.id) ?? null,
          priorThread,
        },
        503,
      );
    }

    try {
      const res = await runnerFetch(`${s.runner_url}/internal/transcript`, {
        signal: clock.timeoutSignal(4000),
      });
      const data = (await orDefault(
        res.json(),
        { entries: [], live: { busy: false, streamingText: '', activeTools: [], queuedCount: 0 } },
        'transcript: runner response is not JSON',
        { status: res.status },
      )) as Record<
        string,
        unknown
      >;
      return c.json({ ...data, priorThread }, res.ok ? 200 : 502);
    } catch (err) {
      ignore(err, 'transcript: workspace not reachable; reconciling', { sessionId: s.id }, 'debug');
      void driver
        .reconcileSessions?.()
        .catch((reconcileErr) => ignore(reconcileErr, 'transcript: reconcile failed', { sessionId: s.id }, 'debug'));
      return c.json(
        {
          error: 'Workspace is not reachable',
          status: s.status,
          bootProgress: driver.getBootProgress?.(s.id) ?? null,
          priorThread,
        },
        503,
      );
    }
  });

  app.get('/api/sessions/:id/debug-trace', auth.requireAuth, async (c) => {
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    const recentLogs =
      (await driver.getSessionLogs?.(s.id).catch((err) => {
        ignore(err, 'debug-trace: reading session logs failed', { sessionId: s.id }, 'debug');
        return [];
      })) ?? [];
    try {
      const ep = await driver.ensureRunning(s);
      const res = await runnerFetch(`${ep.runnerUrl}/internal/debug/trace`);
      const data = (await orDefault(res.json(), { error: 'Invalid debug trace response' }, 'debug-trace: runner response is not JSON', {
        sessionId: s.id,
      })) as Record<
        string,
        unknown
      >;
      return c.json({ ...data, recentLogs }, res.ok ? 200 : 502);
    } catch (err) {
      return c.json(
        {
          error: err instanceof Error ? err.message : 'Workspace is not running',
          recentLogs,
        },
        503,
      );
    }
  });

  app.post('/api/sessions/:id/fix-with-pi', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const body = (await c.req.json()) as { errorSummary: string; logs?: string };
    const ep = await driver.ensureRunning(check.session);
    const promptText = [
      `Publishing failed with the following issue:`,
      body.errorSummary,
      body.logs ? `\nLogs:\n\`\`\`\n${body.logs.slice(0, 3500)}\n\`\`\`` : '',
      `\nPlease inspect the issue, fix it in the codebase, run \`run_checks\` to confirm everything passes, and summarize what you fixed.`,
    ].join('\n');

    await runnerFetch(`${ep.runnerUrl}/internal/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'submit_input',
        requestId: `fix-${clock.now()}`,
        text: promptText,
        contextChips: [],
        attachments: [],
      }),
      signal: clock.timeoutSignal(25_000),
    });
    // Never clobber an active publish (e.g. waiting_ci with a PR open) back to idle
    const cur = db.getSession(check.session.id);
    if (cur && !publishService.isPublishActive(cur.id) && !isPublishInFlight(cur.publish_state)) {
      db.updateSession(cur.id, { publish_state: 'idle', publish_error: null });
      broadcastToSession(cur.id, { type: 'publish_state', payload: { state: 'idle' } });
    }
    return c.json({ ok: true });
  });
}
