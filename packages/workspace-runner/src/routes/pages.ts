import type { Hono } from 'hono';
import { readJsonBodyOrEmpty } from '../log.js';
import { PageValidationError } from '../pages.js';
import type { RunnerContext } from '../runner-context.js';

/**
 * Page discovery and page-creation / visibility / rename requests. Registered by createRunner (see
 * RunnerContext).
 */
export function registerPagesRoutes(app: Hono, ctx: RunnerContext): void {
  const { cancelSpeculativeVerify, scheduleIdleSpeculativeVerify, pageService, loadRoutesDedup } = ctx;
  app.get('/internal/routes', async (c) => {
    const routes = await loadRoutesDedup();
    return c.json({ routes });
  });

  app.get('/internal/page-options', async (c) => {
    const capped = c.req.query('capped') === 'true';
    const options = await pageService.getPageCreationOptions(capped);
    return c.json(options);
  });

  app.post('/internal/pages', async (c) => {
    if (ctx.readOnly) return c.json({ error: 'Read-only' }, 403);
    cancelSpeculativeVerify();
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      const capped = Boolean(body.capped);
      const isBusy = ctx.piRuntime?.isBusy() ?? false;
      const result = await pageService.createPage(body, { capped, isBusy });

      if (!capped && ctx.piRuntime) {
        const reqViewport = (
          body.editorContext as { viewport?: 'desktop' | 'tablet' | 'mobile' } | undefined
        )?.viewport;
        await ctx.piRuntime.submitPageCreationRequest(
          result.pageRequest,
          result.instructions,
          isBusy ? 'followUp' : undefined,
          reqViewport,
        );
      } else {
        scheduleIdleSpeculativeVerify();
      }

      return c.json(
        {
          ok: true,
          route: result.route,
          file: result.file,
          pageRequest: result.pageRequest,
          checkpoint: result.checkpoint,
          changedFilesCount: result.changedFilesCount,
        },
        201,
      );
    } catch (err) {
      if (err instanceof PageValidationError) {
        return c.json(
          { error: err.message, collisionRoute: err.collisionRoute },
          err.statusCode,
        );
      }
      return c.json(
        { error: err instanceof Error ? err.message : 'Failed to create page' },
        400,
      );
    }
  });

  app.post('/internal/pages/:pageRequestId/retry', async (c) => {
    if (ctx.readOnly) return c.json({ error: 'Read-only' }, 403);
    cancelSpeculativeVerify();
    const id = c.req.param('pageRequestId')!;
    const body = (await readJsonBodyOrEmpty(c)) as {
      capped?: boolean;
      viewport?: 'desktop' | 'tablet' | 'mobile';
    };
    const existing = pageService.getPageRequest(id);
    if (!existing) return c.json({ error: 'Page request not found' }, 404);
    if (body.capped) {
      const updated = await pageService.updateStatus(id, 'capped');
      return c.json({ ok: true, pageRequest: updated });
    }
    const isBusy = ctx.piRuntime?.isBusy() ?? false;
    const updated = await pageService.updateStatus(id, isBusy ? 'queued' : 'writing');
    if (ctx.piRuntime && updated && existing.instructions) {
      await ctx.piRuntime.submitPageCreationRequest(
        updated,
        existing.instructions,
        isBusy ? 'followUp' : undefined,
        body.viewport,
      );
    }
    return c.json({ ok: true, pageRequest: updated });
  });

  app.delete('/internal/pages', async (c) => {
    if (ctx.readOnly) return c.json({ error: 'Read-only' }, 403);
    cancelSpeculativeVerify();
    const route =
      c.req.query('route') ||
      ((await readJsonBodyOrEmpty(c)) as { route?: string }).route;
    if (!route) return c.json({ error: 'Missing route' }, 400);
    try {
      const res = await pageService.deletePage(route);
      scheduleIdleSpeculativeVerify();
      return c.json(res);
    } catch (err) {
      if (err instanceof PageValidationError) {
        return c.json({ error: err.message }, err.statusCode);
      }
      return c.json({ error: err instanceof Error ? err.message : 'Failed to delete page' }, 400);
    }
  });

  app.post('/internal/pages/visibility', async (c) => {
    if (ctx.readOnly) return c.json({ error: 'Read-only' }, 403);
    cancelSpeculativeVerify();
    const body = (await c.req.json()) as {
      route: string;
      unlisted: boolean;
      capped?: boolean;
      viewport?: 'desktop' | 'tablet' | 'mobile';
    };
    try {
      const res = await pageService.setPageVisibility(body.route, Boolean(body.unlisted));
      if (res.followUpPrompt && !body.capped && ctx.piRuntime) {
        await ctx.piRuntime.submitUserInput({
          requestId: `visibility-${Date.now()}`,
          text: res.followUpPrompt,
          editorContext: { currentRoute: res.route, viewport: body.viewport, mode: 'browse' },
          whenBusy: ctx.piRuntime.isBusy() ? 'followUp' : undefined,
        });
      } else {
        scheduleIdleSpeculativeVerify();
      }
      return c.json({
        ok: true,
        route: res.route,
        unlisted: res.unlisted,
        file: res.file,
        checkpoint: res.checkpoint,
        changedFilesCount: res.changedFilesCount,
      });
    } catch (err) {
      if (err instanceof PageValidationError) {
        return c.json({ error: err.message }, err.statusCode);
      }
      return c.json(
        { error: err instanceof Error ? err.message : 'Failed to update page visibility' },
        400,
      );
    }
  });

  app.post('/internal/pages/rename', async (c) => {
    if (ctx.readOnly) return c.json({ error: 'Read-only' }, 403);
    cancelSpeculativeVerify();
    const body = (await c.req.json()) as {
      fromRoute: string;
      toSection: string;
      toSlug: string;
    };
    try {
      const res = await pageService.renamePage(body);
      scheduleIdleSpeculativeVerify();
      return c.json(res);
    } catch (err) {
      if (err instanceof PageValidationError) {
        return c.json(
          { error: err.message, collisionRoute: err.collisionRoute },
          err.statusCode,
        );
      }
      return c.json(
        { error: err instanceof Error ? err.message : 'Failed to change page URL' },
        400,
      );
    }
  });
}
