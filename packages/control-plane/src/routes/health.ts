import { HALLEY_PREVIEW_SW_JS } from '../proxy/preview-proxy.js';
import { type App, type ControlPlaneContext } from '../control-plane-context.js';

/** Registers the health/readiness routes and the preview Service Worker script. */
export function register(app: App, ctx: ControlPlaneContext) {
  const { config, db, driver } = ctx;
  // Preview isolation Service Worker (clientId -> sessionId)
  app.get('/halley-preview-sw.js', () => {
    return new Response(HALLEY_PREVIEW_SW_JS, {
      status: 200,
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Service-Worker-Allowed': '/',
      },
    });
  });

  // Liveness: cheap (one cached `SELECT 1`), no network. Use for restart decisions.
  app.get('/api/health', (c) => {
    const dbOk = db.ping();
    return c.json(
      { ok: dbOk, db: dbOk ? 'ok' : 'unavailable', repo: config.repo, baseBranch: config.baseBranch },
      dbOk ? 200 : 503,
    );
  });

  // Readiness: db + workspaces supervisor (cached health sample, single-flight). Use for routing.
  app.get('/api/health/ready', async (c) => {
    const dbOk = db.ping();
    const supervisor = driver.getSupervisorReadiness
      ? await driver.getSupervisorReadiness()
      : { ok: true, skipped: true as const };
    const ok = dbOk && supervisor.ok;
    return c.json(
      { ok, db: dbOk ? 'ok' : 'unavailable', supervisor, schemaVersion: dbOk ? db.schemaVersion() : null },
      ok ? 200 : 503,
    );
  });

  app.get('/api/health/doctor', async (c) => {
    if (driver.runDoctorChecks) {
      const report = await driver.runDoctorChecks();
      return c.json(report, report.ok ? 200 : 503);
    }
    return c.json({
      ok: true,
      warnings: [],
      errors: [],
      details: { workspaceHostUrl: config.workspaceHostUrl || '(local)', dataDir: config.dataDir },
    });
  });
}
