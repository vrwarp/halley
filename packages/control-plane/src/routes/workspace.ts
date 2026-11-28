import { SyncStartRequestSchema } from '@halley/shared';
import { readJsonObject } from '../http-body.js';
import { ignore, orDefault } from '../log.js';
import { type App, type ControlPlaneContext } from '../control-plane-context.js';

/** Registers the workspace routes (pages, changes, undo, verify, uploads, sync). */
export function register(app: App, ctx: ControlPlaneContext) {
  const {
    config,
    clock,
    nowIso,
    runnerFetch,
    db,
    auth,
    github,
    driver,
    convertAndBroadcastIfRevert,
    requireSessionEdit,
  } = ctx;
  // Workspace git, undo, verify, uploads, publish
  app.get('/api/sessions/:id/routes', auth.requireAuth, async (c) => {
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    if ((s.status === 'published' || s.status === 'merged') && !s.runner_url) {
      return c.json({ routes: [] });
    }
    const ep = await driver.ensureRunning(s);
    const res = await runnerFetch(`${ep.runnerUrl}/internal/routes`, {
      signal: clock.timeoutSignal(15_000),
    });
    return c.json(await res.json(), res.status as 200);
  });

  app.get('/api/sessions/:id/page-options', auth.requireAuth, async (c) => {
    const user = c.get('user');
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    const spend = db.getSpendStatus(user.id);
    const ep = await driver.ensureRunning(s);
    const res = await runnerFetch(
      `${ep.runnerUrl}/internal/page-options?capped=${spend.capped ? 'true' : 'false'}`,
      { signal: clock.timeoutSignal(15_000) },
    );
    return c.json(await res.json(), res.status as 200);
  });

  app.post('/api/sessions/:id/pages', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const spend = db.getSpendStatus(check.user.id);
    const ep = await driver.ensureRunning(check.session);
    const body = (await c.req.json()) as Record<string, unknown>;
    const res = await runnerFetch(`${ep.runnerUrl}/internal/pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, capped: spend.capped }),
      signal: clock.timeoutSignal(25_000),
    });
    const data = (await res.json()) as { changedFilesCount?: number };
    if (res.ok && typeof data.changedFilesCount === 'number') {
      db.updateSession(check.session.id, { changed_files_count: data.changedFilesCount });
    }
    if (res.ok) {
      convertAndBroadcastIfRevert(check.session.id);
    }
    return c.json(data, res.status as 200);
  });

  app.post('/api/sessions/:id/pages/:pageRequestId/retry', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const spend = db.getSpendStatus(check.user.id);
    const ep = await driver.ensureRunning(check.session);
    const pageRequestId = c.req.param('pageRequestId')!;
    const reqBody = (await readJsonObject(c)) as { viewport?: string };
    const res = await runnerFetch(
      `${ep.runnerUrl}/internal/pages/${encodeURIComponent(pageRequestId)}/retry`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capped: spend.capped, viewport: reqBody.viewport }),
        signal: clock.timeoutSignal(25_000),
      },
    );
    return c.json(await res.json(), res.status as 200);
  });

  app.delete('/api/sessions/:id/pages', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const ep = await driver.ensureRunning(check.session);
    const route = c.req.query('route') || '';
    const res = await runnerFetch(
      `${ep.runnerUrl}/internal/pages?route=${encodeURIComponent(route)}`,
      { method: 'DELETE', signal: clock.timeoutSignal(25_000) },
    );
    const data = (await res.json()) as { changedFilesCount?: number };
    if (res.ok && typeof data.changedFilesCount === 'number') {
      db.updateSession(check.session.id, { changed_files_count: data.changedFilesCount });
    }
    if (res.ok) {
      convertAndBroadcastIfRevert(check.session.id);
    }
    return c.json(data, res.status as 200);
  });

  app.post('/api/sessions/:id/pages/visibility', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const spend = db.getSpendStatus(check.user.id);
    const ep = await driver.ensureRunning(check.session);
    const body = (await c.req.json()) as Record<string, unknown>;
    const res = await runnerFetch(`${ep.runnerUrl}/internal/pages/visibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, capped: spend.capped }),
      signal: clock.timeoutSignal(25_000),
    });
    const data = (await res.json()) as { changedFilesCount?: number };
    if (res.ok && typeof data.changedFilesCount === 'number') {
      db.updateSession(check.session.id, { changed_files_count: data.changedFilesCount });
    }
    if (res.ok) {
      convertAndBroadcastIfRevert(check.session.id);
    }
    return c.json(data, res.status as 200);
  });

  app.post('/api/sessions/:id/pages/rename', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const ep = await driver.ensureRunning(check.session);
    const body = await c.req.json();
    const res = await runnerFetch(`${ep.runnerUrl}/internal/pages/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: clock.timeoutSignal(25_000),
    });
    const data = (await res.json()) as { changedFilesCount?: number };
    if (res.ok && typeof data.changedFilesCount === 'number') {
      db.updateSession(check.session.id, { changed_files_count: data.changedFilesCount });
    }
    if (res.ok) {
      convertAndBroadcastIfRevert(check.session.id);
    }
    return c.json(data, res.status as 200);
  });

  app.get('/api/sessions/:id/changes', auth.requireAuth, async (c) => {
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    if ((s.status === 'published' || s.status === 'merged') && !s.runner_url) {
      return c.json({ changes: [], checkpoints: [] });
    }
    const ep = await driver.ensureRunning(s);
    const res = await runnerFetch(
      `${ep.runnerUrl}/internal/git/changes?baseRef=${encodeURIComponent(`origin/${s.base_branch}`)}`,
      { signal: clock.timeoutSignal(15_000) },
    );
    const data = (await res.json()) as { changes?: unknown[]; checkpoints?: unknown[] };
    if (res.ok && Array.isArray(data.changes)) {
      db.updateSession(s.id, { changed_files_count: data.changes.length });
    }
    return c.json(data, res.status as 200);
  });

  app.post('/api/sessions/:id/revert-file', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const ep = await driver.ensureRunning(check.session);
    const body = await c.req.json();
    const res = await runnerFetch(`${ep.runnerUrl}/internal/git/revert-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, baseRef: `origin/${check.session.base_branch}` }),
      signal: clock.timeoutSignal(25_000),
    });
    const data = (await res.json()) as { changedFilesCount?: number };
    if (res.ok) {
      if (typeof data.changedFilesCount === 'number') {
        db.updateSession(check.session.id, { changed_files_count: data.changedFilesCount });
      }
      convertAndBroadcastIfRevert(check.session.id);
    }
    return c.json(data, res.status as 200);
  });

  app.post('/api/sessions/:id/undo', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const ep = await driver.ensureRunning(check.session);
    const body = await c.req.json();
    const res = await runnerFetch(`${ep.runnerUrl}/internal/git/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: clock.timeoutSignal(25_000),
    });
    const data = (await res.json()) as { changedFilesCount?: number };
    if (res.ok && typeof data.changedFilesCount === 'number') {
      db.updateSession(check.session.id, { changed_files_count: data.changedFilesCount });
    }
    return c.json(data, res.status as 200);
  });

  app.post('/api/sessions/:id/verify', auth.requireAuth, async (c) => {
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    const ep = await driver.ensureRunning(s);
    const res = await runnerFetch(`${ep.runnerUrl}/internal/verify`, {
      method: 'POST',
      signal: clock.timeoutSignal(180_000),
    });
    return c.json(await res.json(), res.status as 200);
  });

  app.post('/api/sessions/:id/uploads', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const ep = await driver.ensureRunning(check.session);
    const formData = await c.req.formData();
    const res = await runnerFetch(`${ep.runnerUrl}/internal/uploads`, {
      method: 'POST',
      body: formData,
      signal: clock.timeoutSignal(30_000),
    });
    return c.json(await res.json(), res.status as 200);
  });

  app.post('/api/sessions/:id/sync', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const rawBody = await readJsonObject(c);
    const parsed = SyncStartRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message || 'Invalid sync request' }, 400);
    }
    const body = parsed.data;
    const ep = await driver.ensureRunning(check.session);
    const ghToken = await github.getAccessToken().catch((err) => {
      ignore(err, 'sync: no GitHub access token', { sessionId: check.session.id }, 'debug');
      return '';
    });
    let fetchedByDriver = false;
    if (ghToken || config.devLocalRepo) {
      fetchedByDriver = await driver
        .fetchIntoSession(check.session, ghToken)
        .then(() => true)
        .catch((err) => {
          // The runner fetches by itself when skipFetch is false
          ignore(err, 'sync: driver fetch failed; runner will fetch', { sessionId: check.session.id });
          return false;
        });
    }
    const res = await runnerFetch(`${ep.runnerUrl}/internal/sync/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseBranch: check.session.base_branch,
        kind: body.kind ?? 'sync',
        autoSyncOnly: body.autoSyncOnly,
        autoApplyCleanOnly: body.autoApplyCleanOnly,
        skipFetch: fetchedByDriver,
      }),
      signal: clock.timeoutSignal(55_000),
    });
    const data = (await orDefault(res.json(), { error: 'Sync failed' }, 'sync: runner response is not JSON', { sessionId: check.session.id, status: res.status }, 'debug')) as {
      review?: {
        newBaseSha?: string;
        prevBaseSha?: string;
        status?: string;
        alreadyUpToDate?: boolean;
      };
      error?: string;
    };
    if (
      data.review?.newBaseSha &&
      data.review.status !== 'needs_choices' &&
      !data.review.alreadyUpToDate
    ) {
      db.updateSession(check.session.id, {
        prev_base_sha: data.review.prevBaseSha ?? (check.session.base_sha || null),
        base_sha: data.review.newBaseSha,
        last_active_at: nowIso(),
      });
    }
    if (
      res.ok &&
      body.kind === 'publish' &&
      !(data as { heldForUser?: boolean }).heldForUser &&
      data.review?.status !== 'needs_choices'
    ) {
      void runnerFetch(`${ep.runnerUrl}/internal/verify/speculative`, { method: 'POST' }).catch((err) =>
        ignore(err, 'triggering speculative verify failed', { sessionId: check.session.id }, 'debug'),
      );
    }
    return c.json(data, res.status as 200);
  });

  app.post('/api/sessions/:id/sync/choose', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const body = await c.req.json();
    const ep = await driver.ensureRunning(check.session);
    const res = await runnerFetch(`${ep.runnerUrl}/internal/sync/choose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: clock.timeoutSignal(55_000),
    });
    const data = (await orDefault(res.json(), { error: 'Choice failed' }, 'sync choose: runner response is not JSON', { sessionId: check.session.id, status: res.status }, 'debug')) as {
      review?: { newBaseSha?: string; prevBaseSha?: string; status?: string };
    };
    if (data.review?.newBaseSha && data.review.status === 'ready_for_review') {
      db.updateSession(check.session.id, {
        prev_base_sha: data.review.prevBaseSha ?? (check.session.base_sha || null),
        base_sha: data.review.newBaseSha,
      });
    }
    return c.json(data, res.status as 200);
  });

  app.post('/api/sessions/:id/sync/undo', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const body = await readJsonObject(c);
    const ep = await driver.ensureRunning(check.session);
    const res = await runnerFetch(`${ep.runnerUrl}/internal/sync/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: clock.timeoutSignal(25_000),
    });
    const data = (await orDefault(res.json(), { ok: res.ok }, 'sync undo: runner response is not JSON', { sessionId: check.session.id, status: res.status }, 'debug')) as {
      ok?: boolean;
      changedFilesCount?: number;
    };
    if (res.ok) {
      const updates: Record<string, unknown> = {};
      if (check.session.prev_base_sha) updates.base_sha = check.session.prev_base_sha;
      if (typeof data.changedFilesCount === 'number') {
        updates.changed_files_count = data.changedFilesCount;
      }
      if (Object.keys(updates).length > 0) {
        db.updateSession(check.session.id, updates);
      }
    }
    return c.json(data, res.status as 200);
  });

  app.post('/api/sessions/:id/sync/estimate-escalation', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const body = (await readJsonObject(c)) as {
      recordIds?: string[];
      userNote?: string;
    };
    const spend = db.getSpendStatus(check.user.id);
    const remainingBudgetUsd = Math.max(
      0,
      spend.dailyCapUsd + spend.extraGrantedUsd - spend.spentTodayUsd,
    );
    const ep = await driver.ensureRunning(check.session);
    const res = await runnerFetch(`${ep.runnerUrl}/internal/sync/estimate-escalation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recordIds: body.recordIds,
        userNote: body.userNote,
        remainingBudgetUsd,
        escalationModelId: config.escalationModelId,
        hardCeilingUsd: config.escalationMaxUsd,
      }),
      signal: clock.timeoutSignal(25_000),
    });
    return c.json(
      await orDefault(res.json(), { error: 'Estimate failed' }, 'sync estimate-escalation: runner response is not JSON', {
        sessionId: check.session.id,
        status: res.status,
      }, 'debug'),
      res.status as 200,
    );
  });

  app.post('/api/sessions/:id/sync/escalate', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const body = (await readJsonObject(c)) as {
      recordIds?: string[];
      userNote?: string;
      ceilingUsd?: number;
    };
    const ep = await driver.ensureRunning(check.session);
    const res = await runnerFetch(`${ep.runnerUrl}/internal/sync/escalate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recordIds: body.recordIds,
        userNote: body.userNote,
        escalationModelId: config.escalationModelId,
        escalationThinking: config.escalationThinkingLevel,
        ceilingUsd: Math.min(body.ceilingUsd ?? config.escalationMaxUsd, config.escalationMaxUsd),
      }),
      signal: clock.timeoutSignal(55_000),
    });
    return c.json(
      await orDefault(res.json(), { error: 'Escalation failed' }, 'sync escalate: runner response is not JSON', {
        sessionId: check.session.id,
        status: res.status,
      }, 'debug'),
      res.status as 200,
    );
  });

  app.post('/api/sessions/:id/sync/apply-advanced', auth.requireAuth, async (c) => {
    const check = await requireSessionEdit(c);
    if ('error' in check) return c.json({ error: check.error }, check.status);
    const body = await c.req.json();
    const ep = await driver.ensureRunning(check.session);
    const res = await runnerFetch(`${ep.runnerUrl}/internal/sync/apply-advanced`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: clock.timeoutSignal(25_000),
    });
    return c.json(
      await orDefault(res.json(), { error: 'Apply failed' }, 'sync apply-advanced: runner response is not JSON', {
        sessionId: check.session.id,
        status: res.status,
      }, 'debug'),
      res.status as 200,
    );
  });
}
