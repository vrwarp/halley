import { resolveLiveSiteUrl } from '../config.js';
import { ignore, orDefault } from '../log.js';
import { ScreenshotBusyError, type ScreenshotViewport } from '../screenshot-service.js';
import { externalizeDataUrls, ScreenshotStore } from '../screenshot-store.js';
import { type App, type ControlPlaneContext, type Env } from '../control-plane-context.js';

/** Registers the review routes (visual review, per-route screenshots served by id, upstream status). */
export function register(app: App, ctx: ControlPlaneContext) {
  const { config, clock, randomUUID, runnerFetch, db, auth, github, driver, screenshotService } = ctx;
  // Review screenshots are served as binary by id instead of base64 inside JSON
  // (`?screenshotFormat=dataurl` keeps the legacy embedded form).
  const screenshotStore = new ScreenshotStore({ clock, randomUUID });
  const screenshotUrl = (id: string) => `/api/screenshots/${id}`;
  const shapeScreenshots = <T,>(c: import('hono').Context<Env>, value: T): T =>
    c.req.query('screenshotFormat') === 'dataurl' ? value : externalizeDataUrls(value, screenshotStore, screenshotUrl);
  app.get('/api/screenshots/:id', auth.requireAuth, (c) => {
    const img = screenshotStore.get(c.req.param('id')!);
    if (!img) return c.json({ error: 'Not found' }, 404);
    return new Response(new Uint8Array(img.bytes), {
      headers: {
        'Content-Type': img.contentType,
        'Content-Length': String(img.bytes.byteLength),
        // Ids are never reused: safe to cache for the store's lifetime
        'Cache-Control': `private, max-age=${Math.floor(screenshotStore.ttlMs / 1000)}, immutable`,
      },
    });
  });

  /** Runner /internal/review metadata, cached briefly per session so per-route screenshot calls share one fetch. */
  type ReviewMeta = {
    draftFiles?: string[];
    mergedFromLiveFiles?: string[];
    astroReady?: boolean;
    previewBase?: string;
    liveSiteUrl?: string | null;
    baseSha?: string;
  };
  const REVIEW_META_TTL_MS = 15_000;
  const reviewMetaCache = new Map<string, { key: string; at: number; value: Promise<ReviewMeta | null> }>();
  const getReviewMeta = (s: import('../db.js').SessionRecord, runnerUrl: string): Promise<ReviewMeta | null> => {
    const key = `${runnerUrl}|${s.base_branch}`;
    const hit = reviewMetaCache.get(s.id);
    if (hit && hit.key === key && clock.now() - hit.at < REVIEW_META_TTL_MS) return hit.value;
    const qs = new URLSearchParams({ baseRef: `origin/${s.base_branch}` });
    const value = (async () => {
      const res = await runnerFetch(`${runnerUrl}/internal/review?${qs.toString()}`, {
        signal: clock.timeoutSignal(20_000),
      });
      if (!res.ok) return null;
      return (await orDefault(res.json(), {}, 'review: runner metadata response is not JSON', {
        sessionId: s.id,
      })) as ReviewMeta;
    })();
    reviewMetaCache.set(s.id, { key, at: clock.now(), value });
    // Never cache a failure
    void value.then(
      (v) => {
        if (v === null && reviewMetaCache.get(s.id)?.value === value) reviewMetaCache.delete(s.id);
      },
      () => {
        if (reviewMetaCache.get(s.id)?.value === value) reviewMetaCache.delete(s.id);
      },
    );
    if (reviewMetaCache.size > 1000) {
      for (const [id, e] of reviewMetaCache) if (clock.now() - e.at >= REVIEW_META_TTL_MS) reviewMetaCache.delete(id);
    }
    return value;
  };

  app.get('/api/sessions/:id/review', auth.requireAuth, async (c) => {
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    const ep = await driver.ensureRunning(s);
    const includeScreenshots = c.req.query('screenshots') === '1';
    const rawViewport = c.req.query('viewport');
    const screenshotViewport: ScreenshotViewport = rawViewport === 'mobile' ? 'mobile' : 'desktop';
    const activeRoute = c.req.query('activeRoute') || '';
    const qs = new URLSearchParams({
      baseRef: `origin/${s.base_branch}`,
    });
    if (activeRoute) qs.set('activeRoute', activeRoute);

    const res = await runnerFetch(`${ep.runnerUrl}/internal/review?${qs.toString()}`, {
      signal: clock.timeoutSignal(20_000),
    });
    if (res.ok && !includeScreenshots && s.status === 'running' && s.kind === 'revert') {
      void runnerFetch(`${ep.runnerUrl}/internal/verify/speculative`, { method: 'POST' }).catch((err) =>
        ignore(err, 'triggering speculative verify failed', { sessionId: s.id }, 'debug'),
      );
    }
    const data = (await orDefault(
      res.json(),
      { cards: [], pages: [], targetRoutes: [], mergeReview: null },
      'review: runner response is not JSON',
      { status: res.status },
      'debug',
    )) as {
      cards: Array<{ route?: string }>;
      pages: unknown[];
      targetRoutes?: string[];
      draftFiles?: string[];
      mergedFromLiveFiles?: string[];
      astroReady?: boolean;
      previewBase?: string;
      liveSiteUrl?: string | null;
      mergeReview: unknown;
      baseSha?: string;
      prevBaseSha?: string | null;
    };

    const resolvedRoutes =
      Array.isArray(data.targetRoutes) && data.targetRoutes.length > 0
        ? data.targetRoutes
        : [
            ...new Set([
              ...data.cards.map((card) => card.route || '/'),
              ...(data.cards.length === 0 ? ['/'] : []),
            ]),
          ].slice(0, 4);
    data.targetRoutes = resolvedRoutes;

    if (includeScreenshots && res.ok && data.astroReady !== false && ep.astroUrl) {
      driver.deferSpeculativeBuilds?.(15_000);
      const baseSuffix = ep.astroBase === '/' ? '' : ep.astroBase.replace(/\/$/, '');
      const previewBase = data.previewBase || `/p/${s.id}${baseSuffix}`;
      const draftBaseUrl = `${ep.astroUrl.replace(/\/$/, '')}${previewBase}`;
      const liveBaseUrl = resolveLiveSiteUrl(config, data.liveSiteUrl);
      data.pages = await screenshotService
        .captureLiveVsDraftPages({
          routes: resolvedRoutes,
          draftFiles: data.draftFiles ?? [],
          mergedFromLiveFiles: data.mergedFromLiveFiles ?? [],
          draftBaseUrl,
          liveBaseUrl,
          baseSha: data.baseSha ?? s.base_sha,
          viewport: screenshotViewport,
          liveTimestamp: new Date(clock.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        })
        .catch((err) => {
          ignore(err, 'review: capturing live vs draft screenshots failed', { sessionId: s.id });
          return [];
        });
    }

    if (res.ok) {
      // A fresh full review also refreshes the metadata the per-route screenshot calls use
      reviewMetaCache.set(s.id, { key: `${ep.runnerUrl}|${s.base_branch}`, at: clock.now(), value: Promise.resolve(data) });
    }
    return c.json(shapeScreenshots(c, data), res.ok ? 200 : 502);
  });

  app.get('/api/sessions/:id/review/screenshot', auth.requireAuth, async (c) => {
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    const ep = await driver.ensureRunning(s);
    const rawRoute = (c.req.query('route') || '/').trim();
    const cleanRoute = rawRoute.startsWith('/') ? rawRoute : `/${rawRoute}`;
    if (cleanRoute.includes('..')) {
      return c.json({ error: 'Invalid route' }, 400);
    }
    const rawViewport = c.req.query('viewport');
    const screenshotViewport: ScreenshotViewport = rawViewport === 'mobile' ? 'mobile' : 'desktop';

    const data = await getReviewMeta(s, ep.runnerUrl).catch((err) => {
      ignore(err, 'review: loading runner metadata failed', { sessionId: s.id });
      return null;
    });
    if (!data) {
      return c.json({ error: 'Failed to load review metadata' }, 502);
    }
    if (data.astroReady === false || !ep.astroUrl) {
      return c.json({ error: 'Preview server is not ready' }, 503);
    }

    driver.deferSpeculativeBuilds?.(15_000);
    const baseSuffix = ep.astroBase === '/' ? '' : ep.astroBase.replace(/\/$/, '');
    const previewBase = data.previewBase || `/p/${s.id}${baseSuffix}`;
    const draftBaseUrl = `${ep.astroUrl.replace(/\/$/, '')}${previewBase}`;
    const liveBaseUrl = resolveLiveSiteUrl(config, data.liveSiteUrl);

    try {
      const page = await screenshotService.captureRouteReview({
        route: cleanRoute,
        draftFiles: data.draftFiles ?? [],
        mergedFromLiveFiles: data.mergedFromLiveFiles ?? [],
        draftBaseUrl,
        liveBaseUrl,
        baseSha: data.baseSha ?? s.base_sha,
        viewport: screenshotViewport,
        liveTimestamp: new Date(clock.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        signal: c.req.raw.signal,
      });

      return c.json(shapeScreenshots(c, { page }));
    } catch (err) {
      if (c.req.raw.signal?.aborted || (err instanceof Error && /aborted/i.test(err.message))) {
        return new Response(null, { status: 204 });
      }
      if (err instanceof ScreenshotBusyError) {
        return c.json({ error: err.message, retryable: true }, 503, { 'Retry-After': '2' });
      }
      throw err;
    }
  });

  app.get('/api/sessions/:id/upstream-status', auth.requireAuth, async (c) => {
    const s = db.getSession(c.req.param('id')!);
    if (!s) return c.json({ error: 'Not found' }, 404);
    const ghCommits = await github.listMainCommits(s.base_branch, 10);
    const latestMainSha = ghCommits[0]?.sha ?? '';
    const behind = Boolean(latestMainSha && s.base_sha && latestMainSha !== s.base_sha);
    const newerCommits = behind
      ? ghCommits.slice(
          0,
          Math.max(
            1,
            ghCommits.findIndex((cm) => cm.sha === s.base_sha) === -1
              ? ghCommits.length
              : ghCommits.findIndex((cm) => cm.sha === s.base_sha),
          ),
        )
      : [];

    // Warn early if teammates have other active drafts with edits
    const coEditors = db
      .listSessions()
      .filter(
        (other) =>
          other.id !== s.id &&
          other.status !== 'published' &&
          other.status !== 'merged' &&
          !other.volume_expired_at &&
          other.changed_files_count > 0,
      )
      .map((other) => ({
        sessionId: other.id,
        title: other.title,
        ownerName: other.owner_name ?? 'A teammate',
        changedFilesCount: other.changed_files_count,
      }));

    return c.json({
      behind,
      latestMainSha,
      newerCommits,
      coEditors,
    });
  });
}
