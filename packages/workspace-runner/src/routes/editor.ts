import fs from 'node:fs/promises';
import path from 'node:path';
import { inlineEditingDisabledReason, inspectAstroElement, patchStaticSpan, resolveEditorRelFile } from '@halley/astro-dev-edit';
import type { Hono } from 'hono';
import type { RunnerContext } from '../runner-context.js';

/**
 * Single-writer inline editor endpoints (`/__editor/*`, also under the preview base). Registered
 * by createRunner (see RunnerContext).
 */
export function registerEditorRoutes(app: Hono, ctx: RunnerContext): void {
  const { REPO_ROOT, fileLock, scheduleInlineCheckpoint, astroManager, loadRoutesDedup } = ctx;
  // ==========================================================================
  // Single-Writer Inline Editor Endpoints (`/__editor/*` or `/p/:id/.../__editor/*`)
  // ==========================================================================
  app.use('*', async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (c.req.method === 'GET' && pathname.endsWith('/__editor/health')) {
      return c.json({ ok: true, astroReady: astroManager.getStatus().ready });
    }
    if (c.req.method === 'GET' && pathname.endsWith('/__editor/routes')) {
      const routes = await loadRoutesDedup();
      return c.json({ routes });
    }
    if (c.req.method === 'POST' && pathname.endsWith('/__editor/inspect')) {
      try {
        const body = (await c.req.json()) as { file?: string; loc?: string };
        const relFile = resolveEditorRelFile(REPO_ROOT, String(body.file ?? ''));
        if (relFile.startsWith('..') || relFile === '.github' || relFile.startsWith('.github/')) {
          return c.json({ editability: 'dynamic', reason: 'Protected path' });
        }
        const abs = path.resolve(REPO_ROOT, relFile);
        const source = await fs.readFile(abs, 'utf8');
        const inspected = await inspectAstroElement(source, String(body.loc ?? ''), {
          // binds the staleness hash to this file; unsupported Astro versions route edits to the agent
          file: relFile,
          disabledReason: await inlineEditingDisabledReason(REPO_ROOT),
        });
        if (!inspected) {
          return c.json({ editability: 'dynamic', reason: 'Unmapped AST node' });
        }
        return c.json({
          editability: inspected.editability,
          reason: inspected.reason,
          snapshotHash: inspected.snapshotHash,
          // let the patch relocate the element if the file changes between inspect and patch
          fileHash: inspected.fileHash,
          contentHash: inspected.contentHash,
          tagName: inspected.tagName,
        });
      } catch (err) {
        return c.json(
          {
            editability: 'dynamic',
            error: err instanceof Error ? err.message : 'Inspect failed',
          },
          400,
        );
      }
    }
    if (c.req.method === 'POST' && pathname.endsWith('/__editor/patch')) {
      if (ctx.readOnly) {
        return c.json({ error: 'Session is read-only' }, 403);
      }
      try {
        const body = (await c.req.json()) as {
          file?: string;
          loc?: string;
          expectedHash?: string;
          fileHash?: string;
          contentHash?: string;
          newHtml?: string;
        };
        const relFile = resolveEditorRelFile(REPO_ROOT, String(body.file ?? ''));
        const astroStatus = astroManager.getStatus();
        const result = await patchStaticSpan({
          repoRoot: REPO_ROOT,
          relFile,
          loc: String(body.loc ?? ''),
          expectedHash: String(body.expectedHash ?? ''),
          expectedFileHash: typeof body.fileHash === 'string' ? body.fileHash : undefined,
          expectedContentHash: typeof body.contentHash === 'string' ? body.contentHash : undefined,
          newHtml: String(body.newHtml ?? ''),
          previewBase: astroStatus.previewBase || ctx.previewBase,
          originalBase: astroStatus.originalBase || ctx.originalBase,
          fileLock,
        });
        if (!result.ok) {
          return c.json({ error: result.error }, result.code);
        }
        scheduleInlineCheckpoint(`Inline edit in ${relFile}`);
        return c.json({
          ok: true,
          updatedSource: result.updatedSource,
          newHash: result.newHash,
          newLoc: result.newLoc,
          newFileHash: result.newFileHash,
          newContentHash: result.newContentHash,
          relocated: result.relocated,
          topLineDelta: result.topLineDelta,
          afterLine: result.afterLine,
          afterLineDelta: result.afterLineDelta,
          sameLineEndCol: result.sameLineEndCol,
          sameLineByteDelta: result.sameLineByteDelta,
        });
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : 'Patch failed' },
          500,
        );
      }
    }
    return next();
  });
}
