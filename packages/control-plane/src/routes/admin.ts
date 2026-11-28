import { AdminAllowlistCreateSchema, AdminGrantExtraSchema, AdminSpendCapSchema } from '@halley/shared';
import { readJsonObject } from '../http-body.js';
import { type App, type ControlPlaneContext } from '../control-plane-context.js';

/** Registers the admin (users, allowlist, spend caps, optimize advisor). */
export function register(app: App, ctx: ControlPlaneContext) {
  const { config, db, auth, driver, optimizeService } = ctx;
  // Admin routes
  app.get('/api/admin/overview', auth.requireAdmin, (c) => {
    return c.json({
      allowlist: db.listAllowlist(),
      users: db.listUsers(),
      dailyCapUsd: db.getDailyCapUsd(),
      todaySpend: db.listTodaySpendByUser(),
      spendByPurpose: db.listTodaySpendByPurpose(),
      sessions: db.listSessions().map((s) => db.toSessionDto(s, c.get('user'))),
    });
  });

  app.post('/api/admin/allowlist', auth.requireAdmin, async (c) => {
    const rawBody = await readJsonObject(c);
    const parsed = AdminAllowlistCreateSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message || 'Invalid allowlist entry' }, 400);
    }
    const entry = db.addAllowlist(parsed.data.kind, parsed.data.value, c.get('user').email);
    return c.json({ entry }, 201);
  });

  app.delete('/api/admin/allowlist/:id', auth.requireAdmin, (c) => {
    db.removeAllowlist(c.req.param('id')!);
    return c.json({ ok: true });
  });

  app.post('/api/admin/cap', auth.requireAdmin, async (c) => {
    const rawBody = await readJsonObject(c);
    const parsed = AdminSpendCapSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message || 'Invalid daily cap' }, 400);
    }
    db.setDailyCapUsd(parsed.data.dailyCapUsd);
    return c.json({ dailyCapUsd: db.getDailyCapUsd() });
  });

  app.post('/api/admin/users/:id/grant-extra', auth.requireAdmin, async (c) => {
    const rawBody = await readJsonObject(c);
    const parsed = AdminGrantExtraSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message || 'Invalid extra allowance' }, 400);
    }
    db.grantExtraSpend(c.req.param('id')!, parsed.data.extraUsd ?? 10);
    return c.json({ ok: true });
  });

  app.post('/api/admin/users/:id/admin', auth.requireAdmin, async (c) => {
    const body = (await c.req.json()) as { isAdmin: boolean };
    db.setUserAdmin(c.req.param('id')!, Boolean(body.isAdmin));
    return c.json({ ok: true });
  });

  app.post('/api/admin/sessions/:id/sleep', auth.requireAdmin, async (c) => {
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    await driver.stop(s);
    return c.json({ ok: true });
  });

  // Optimize Astro (Admin-only Halley Readiness & Speed Advisor)
  app.get('/api/admin/optimize/latest', auth.requireAdmin, (c) => {
    return c.json(optimizeService.getLatestOverview());
  });

  app.post('/api/admin/optimize/scan', auth.requireAdmin, async (c) => {
    const body = (await readJsonObject(c)) as { force?: boolean };
    try {
      const report = await optimizeService.runStaticScan({ force: Boolean(body.force) });
      return c.json({
        report,
        defaultModelId: config.modelId,
        escalationModelId: config.escalationModelId,
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Failed to scan repository' },
        500,
      );
    }
  });

  app.post('/api/admin/optimize/ai-estimate', auth.requireAdmin, async (c) => {
    const body = (await readJsonObject(c)) as { sha?: string };
    if (!body.sha) return c.json({ error: 'Missing sha' }, 400);
    try {
      const estimate = await optimizeService.estimateDeepAiReview(body.sha, c.get('user'));
      return c.json({ estimate });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Failed to estimate Deep AI Review' },
        400,
      );
    }
  });

  app.post('/api/admin/optimize/ai-review', auth.requireAdmin, async (c) => {
    const body = (await readJsonObject(c)) as { sha?: string };
    if (!body.sha) return c.json({ error: 'Missing sha' }, 400);
    try {
      const report = await optimizeService.runDeepAiReview(body.sha, c.get('user'));
      return c.json({ report });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Deep AI Review failed' },
        400,
      );
    }
  });

  app.post('/api/admin/optimize/create-draft', auth.requireAdmin, async (c) => {
    const body = (await readJsonObject(c)) as {
      sha?: string;
      findingIds?: string[];
      useEscalationModel?: boolean;
      title?: string;
    };
    if (!body.sha || !Array.isArray(body.findingIds)) {
      return c.json({ error: 'Missing sha or findingIds' }, 400);
    }
    try {
      const session = await optimizeService.createOptimizationDraft(c.get('user'), {
        sha: body.sha,
        findingIds: body.findingIds,
        useEscalationModel: body.useEscalationModel,
        title: body.title,
      });
      return c.json({ session }, 201);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Failed to create Optimization Draft' },
        400,
      );
    }
  });
}
