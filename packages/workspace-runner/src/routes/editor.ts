import fs from 'node:fs/promises';
import path from 'node:path';
import {
  inlineEditingDisabledReason,
  inspectAstroElement,
  listSiteImages,
  mutateAstroElement,
  patchStaticSpan,
  resolveEditorRelFile,
  writeSiteImage,
  type ElementMutation,
} from '@halley/astro-dev-edit';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import sharp from 'sharp';
import { ignore } from '../log.js';
import type { RunnerContext } from '../runner-context.js';

/** Max accepted `/__editor/upload-image` body; enforced on the raw stream before buffering. */
export const EDITOR_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const MAX_URL_LENGTH = 4096;
const MAX_ALT_LENGTH = 1000;

const isProtectedRelFile = (relFile: string) =>
  relFile.startsWith('..') || relFile === '.github' || relFile.startsWith('.github/');

const optionalString = (v: unknown, max: number): v is string | undefined =>
  v === undefined || (typeof v === 'string' && v.length <= max);
const optionalEnum = <T extends string>(v: unknown, values: readonly T[]): v is T | null | undefined =>
  v === undefined || v === null || (typeof v === 'string' && (values as readonly string[]).includes(v));

/**
 * Explicit validation of the `/__editor/mutate` payload (the type alone is not a runtime check).
 * Returns the mutation or an error message.
 */
export function parseElementMutation(raw: unknown): ElementMutation | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Missing mutation payload';
  const m = raw as Record<string, unknown>;
  switch (m.kind) {
    case 'set-link':
      if (typeof m.href !== 'string' || m.href.length > MAX_URL_LENGTH) return 'set-link requires a string href';
      if (m.openInNewTab !== undefined && typeof m.openInNewTab !== 'boolean') return 'openInNewTab must be a boolean';
      return { kind: 'set-link', href: m.href, openInNewTab: m.openInNewTab as boolean | undefined };
    case 'set-image':
      if (!optionalString(m.src, MAX_URL_LENGTH)) return 'set-image src must be a string';
      if (!optionalString(m.alt, MAX_ALT_LENGTH)) return 'set-image alt must be a string';
      if (m.src === undefined && m.alt === undefined) return 'set-image requires src or alt';
      return { kind: 'set-image', src: m.src, alt: m.alt };
    case 'set-style':
      if (!optionalEnum(m.align, ['left', 'center', 'right'] as const)) return 'Invalid align';
      if (!optionalEnum(m.objectPosition, ['top', 'center', 'bottom', 'left', 'right'] as const)) {
        return 'Invalid objectPosition';
      }
      if (!optionalEnum(m.spacing, ['tight', 'normal', 'spacious'] as const)) return 'Invalid spacing';
      return { kind: 'set-style', align: m.align, objectPosition: m.objectPosition, spacing: m.spacing };
    case 'duplicate':
      return { kind: 'duplicate' };
    case 'delete':
      return { kind: 'delete' };
    case 'move':
      if (m.direction !== 'up' && m.direction !== 'down') return 'move requires direction up|down';
      return { kind: 'move', direction: m.direction };
    case 'add-block':
      if (!optionalEnum(m.blockKind, ['paragraph', 'heading', 'list-item', 'image'] as const) || !m.blockKind) {
        return 'Invalid blockKind';
      }
      if (!optionalString(m.imageSrc, MAX_URL_LENGTH)) return 'imageSrc must be a string';
      if (!optionalString(m.imageAlt, MAX_ALT_LENGTH)) return 'imageAlt must be a string';
      return { kind: 'add-block', blockKind: m.blockKind, imageSrc: m.imageSrc, imageAlt: m.imageAlt };
    default:
      return 'Unknown mutation kind';
  }
}

/** Re-encodes raster uploads to WebP (EXIF-oriented, metadata stripped, capped width); null keeps the original. */
async function convertUploadedImage(bytes: Buffer): Promise<{ bytes: Buffer; ext: string } | null> {
  try {
    const meta = await sharp(bytes).metadata();
    if (!meta.format || meta.format === 'svg' || meta.format === 'gif') return null;
    const webpBytes = await sharp(bytes)
      .rotate()
      .resize({ width: 2400, withoutEnlargement: true })
      .webp({ quality: 84 })
      .toBuffer();
    return { bytes: webpBytes, ext: '.webp' };
  } catch (err) {
    ignore(err, 'editor: image conversion failed; keeping original bytes');
    return null;
  }
}

/**
 * Single-writer inline editor endpoints (`/__editor/*`, also under the preview base). Registered
 * by createRunner (see RunnerContext).
 */
export function registerEditorRoutes(app: Hono, ctx: RunnerContext): void {
  const { REPO_ROOT, fileLock, editUndoStack, scheduleInlineCheckpoint, astroManager, loadRoutesDedup } = ctx;
  const bases = () => {
    const astroStatus = astroManager.getStatus();
    return {
      previewBase: astroStatus.previewBase || ctx.previewBase,
      originalBase: astroStatus.originalBase || ctx.originalBase,
    };
  };
  const uploadImageLimit = bodyLimit({
    maxSize: EDITOR_IMAGE_MAX_BYTES,
    onError: (c) => c.json({ error: `Image exceeds ${EDITOR_IMAGE_MAX_BYTES / 1024 / 1024} MB limit` }, 413),
  });

  const handleUploadImage = async (c: Context): Promise<Response> => {
    try {
      const form = await c.req.formData();
      const fileEntry = form.get('file');
      const existingSrcEntry = form.get('existingSrc');
      if (!fileEntry || typeof fileEntry === 'string') {
        return c.json({ error: 'Missing image file' }, 400);
      }
      const rawBytes = Buffer.from(await fileEntry.arrayBuffer());
      if (rawBytes.length === 0) {
        return c.json({ error: 'Empty image file' }, 400);
      }
      const { previewBase, originalBase } = bases();
      const saved = await writeSiteImage({
        repoRoot: REPO_ROOT,
        filename: fileEntry.name || 'image.webp',
        bytes: rawBytes,
        existingSrc:
          typeof existingSrcEntry === 'string' && existingSrcEntry.length <= MAX_URL_LENGTH ? existingSrcEntry : undefined,
        previewBase,
        originalBase,
        convertImage: convertUploadedImage,
      });
      scheduleInlineCheckpoint(`Uploaded image ${saved.publicPath}`);
      const cleanBase = previewBase === '/' ? '' : previewBase.replace(/\/$/, '');
      return c.json({
        ok: true,
        publicPath: saved.publicPath,
        diskRelPath: saved.diskRelPath,
        previewUrl: `${cleanBase}${saved.publicPath}`,
        sizeBytes: saved.sizeBytes,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Image upload failed' }, 500);
    }
  };
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
    if (c.req.method === 'GET' && pathname.endsWith('/__editor/images')) {
      const images = await listSiteImages(REPO_ROOT);
      return c.json({ images });
    }
    if (c.req.method === 'POST' && pathname.endsWith('/__editor/upload-image')) {
      if (ctx.readOnly) {
        return c.json({ error: 'Session is read-only' }, 403);
      }
      let handled: Response | undefined;
      const refused = await uploadImageLimit(c, async () => {
        handled = await handleUploadImage(c);
      });
      return refused ?? handled ?? c.json({ error: 'Image upload failed' }, 500);
    }
    if (c.req.method === 'POST' && pathname.endsWith('/__editor/inspect')) {
      try {
        const body = (await c.req.json()) as { file?: string; loc?: string };
        const relFile = resolveEditorRelFile(REPO_ROOT, String(body.file ?? ''));
        if (isProtectedRelFile(relFile)) {
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
          outerSnapshotHash: inspected.outerSnapshotHash,
          tagName: inspected.tagName,
          context: inspected.context,
          capabilities: inspected.capabilities,
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
        editUndoStack.push({
          relFile,
          summary: `Inline edit in ${relFile}`,
          beforeSource: result.beforeSource,
          afterSource: result.afterSource,
        });
        scheduleInlineCheckpoint(`Inline edit in ${relFile}`);
        return c.json({
          ok: true,
          updatedSource: result.updatedSource,
          newHash: result.newHash,
          newOuterHash: result.newOuterHash,
          newLoc: result.newLoc,
          newFileHash: result.newFileHash,
          newContentHash: result.newContentHash,
          relocated: result.relocated,
          subtreeLocs: result.subtreeLocs,
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
    if (c.req.method === 'POST' && pathname.endsWith('/__editor/mutate')) {
      if (ctx.readOnly) {
        return c.json({ error: 'Session is read-only' }, 403);
      }
      try {
        let body: Record<string, unknown>;
        try {
          body = (await c.req.json()) as Record<string, unknown>;
        } catch (err) {
          ignore(err, 'editor: malformed /__editor/mutate body');
          return c.json({ error: 'Invalid JSON body' }, 400);
        }
        if (!body || typeof body !== 'object') return c.json({ error: 'Invalid JSON body' }, 400);
        if (typeof body.file !== 'string' || typeof body.loc !== 'string' || typeof body.expectedOuterHash !== 'string') {
          return c.json({ error: 'file, loc and expectedOuterHash are required strings' }, 400);
        }
        if (body.fileHash !== undefined && typeof body.fileHash !== 'string') {
          return c.json({ error: 'fileHash must be a string' }, 400);
        }
        const mutation = parseElementMutation(body.mutation);
        if (typeof mutation === 'string') return c.json({ error: mutation }, 400);
        const relFile = resolveEditorRelFile(REPO_ROOT, body.file);
        if (isProtectedRelFile(relFile)) return c.json({ error: 'Protected path' }, 400);
        const result = await mutateAstroElement({
          repoRoot: REPO_ROOT,
          relFile,
          loc: body.loc,
          expectedOuterHash: body.expectedOuterHash,
          // relocate by the outer hash if the file changed between inspect and mutate
          expectedFileHash: body.fileHash,
          mutation,
          ...bases(),
          fileLock,
        });
        if (!result.ok) {
          return c.json({ error: result.error }, result.code);
        }
        editUndoStack.push({
          relFile,
          summary: result.summary,
          beforeSource: result.beforeSource,
          afterSource: result.afterSource,
        });
        scheduleInlineCheckpoint(result.summary);
        return c.json({
          ok: true,
          kind: result.kind,
          summary: result.summary,
          newLoc: result.newLoc,
          newHash: result.newHash,
          newOuterHash: result.newOuterHash,
          newFileHash: result.newFileHash,
          relocated: result.relocated,
          topLineDelta: result.topLineDelta,
          afterLine: result.afterLine,
          afterLineDelta: result.afterLineDelta,
          sameLineEndCol: result.sameLineEndCol,
          sameLineByteDelta: result.sameLineByteDelta,
          subtreeLocs: result.subtreeLocs,
          swappedSubtreeLocs: result.swappedSubtreeLocs,
          appliedClass: result.appliedClass,
          insertedHtml: result.insertedHtml,
          resolvedHref: result.resolvedHref,
          resolvedSrc: result.resolvedSrc,
          appliedTarget: result.appliedTarget,
          appliedRel: result.appliedRel,
          appliedAlt: result.appliedAlt,
        });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'Mutation failed' }, 500);
      }
    }
    if (c.req.method === 'POST' && (pathname.endsWith('/__editor/undo') || pathname.endsWith('/__editor/redo'))) {
      if (ctx.readOnly) {
        return c.json({ error: 'Session is read-only' }, 403);
      }
      const isUndo = pathname.endsWith('/__editor/undo');
      // Under the shared fileLock; refuses (409) if the file no longer matches the recorded edit
      const result = isUndo
        ? await editUndoStack.undo(REPO_ROOT, fileLock)
        : await editUndoStack.redo(REPO_ROOT, fileLock);
      if (!result.ok) {
        return c.json({ error: result.error, canUndo: result.canUndo, canRedo: result.canRedo }, result.code);
      }
      scheduleInlineCheckpoint(`${isUndo ? 'Undid' : 'Redid'}: ${result.summary}`);
      return c.json(result);
    }
    return next();
  });
}
