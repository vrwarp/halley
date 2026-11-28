import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AstroIntegration } from 'astro';
import { inspectAstroElement } from './ast-classifier.js';
import { buildClientBridgeScript, EARLY_OBSERVER_SCRIPT } from './client-bridge.js';
import { PerFileMutex, type AsyncFileLock } from './file-lock.js';
import { listSiteImages } from './images.js';
import { mutateAstroElement, type ElementMutation } from './mutations.js';
import { discoverSiteRoutes } from './routes.js';
import { patchStaticSpan } from './serializer.js';
import { formatAstroVersions, getAstroCompat } from './compat.js';
import { warnUnexpected } from './diagnostics.js';
import { EditUndoStack } from './undo-stack.js';

export interface HalleyDevEditOptions {
  repoRoot: string;
  previewBase: string;
  originalBase: string;
  /**
   * When false (used when running under workspace-runner v2), `/__editor/inspect`,
   * `/__editor/patch`, and `/__editor/routes` are served directly by `workspace-runner`
   * so all file mutations share a single OS-process lock. `GET /__editor/health`
   * remains enabled for deterministic HTTP readiness polling.
   */
  enableLocalEndpoints?: boolean;
  fileLock?: AsyncFileLock;
  isReadOnly?: () => boolean;
  onPatched?: (event: { file: string; loc: string }) => void;
  onPatchedWebhookUrl?: string;
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function resolveEditorRelFile(repoRoot: string, rawFile: string): string {
  const abs = path.isAbsolute(rawFile)
    ? path.resolve(rawFile)
    : path.resolve(repoRoot, rawFile);
  return path.relative(path.resolve(repoRoot), abs).split(path.sep).join('/');
}

const TAILWIND_SCAN_FILE_RE = /\.(?:astro|mdx?|tsx?|jsx?|html|vue|svelte|json)$/i;

interface ViteModuleGraphLike {
  idToModuleMap?: Map<string, unknown>;
  invalidateModule?: (mod: unknown) => void;
}

interface ViteServerLike {
  moduleGraph?: ViteModuleGraphLike;
  environments?: Record<string, { moduleGraph?: ViteModuleGraphLike } | undefined>;
}

/**
 * Invalidates compiled `.css` modules in Vite's module graph (including Vite 6+
 * SSR/client environments) whenever a template or content file is added/changed/deleted.
 * Works around `@tailwindcss/vite`'s literal `addWatchFile("./**\/*")` not triggering
 * CSS re-scans for newly created `.astro` files in `astro dev`.
 */
export function invalidateCssModulesForFile(
  server: ViteServerLike,
  repoRoot: string,
  filePath: string,
): number {
  const abs = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(repoRoot, filePath);
  const rel = path.relative(path.resolve(repoRoot), abs).split(path.sep).join('/');
  if (
    !rel ||
    rel.startsWith('..') ||
    rel.startsWith('node_modules/') ||
    rel.startsWith('.git/') ||
    rel.startsWith('.astro/') ||
    rel.startsWith('dist/') ||
    rel.includes('.halley-tmp-') ||
    !TAILWIND_SCAN_FILE_RE.test(rel)
  ) {
    return 0;
  }

  let invalidated = 0;
  const seen = new Set<unknown>();
  const invalidateGraph = (graph?: ViteModuleGraphLike) => {
    if (!graph?.idToModuleMap || typeof graph.invalidateModule !== 'function') return;
    for (const [id, mod] of graph.idToModuleMap.entries()) {
      if (!id.includes('.css') || seen.has(mod)) continue;
      seen.add(mod);
      graph.invalidateModule(mod);
      invalidated += 1;
    }
  };

  invalidateGraph(server.moduleGraph);
  if (server.environments) {
    for (const env of Object.values(server.environments)) {
      invalidateGraph(env?.moduleGraph);
    }
  }
  return invalidated;
}

export function halleyDevEdit(options: HalleyDevEditOptions): AstroIntegration {
  const fileLock = options.fileLock ?? new PerFileMutex();
  const undoStack = new EditUndoStack();
  const enableLocalEndpoints = options.enableLocalEndpoints ?? true;
  const normalizedPreviewBase =
    options.previewBase === '/' ? '' : options.previewBase.replace(/\/$/, '');

  return {
    name: '@halley/astro-dev-edit',
    hooks: {
      'astro:config:setup': async ({ command, injectScript, updateConfig }) => {
        if (command !== 'dev') return;

        // The site's Astro (which emits data-astro-source-loc) and the compiler bundled here
        // (which the classifier parses with) may differ: log both, and disable inline editing
        // when the combination is unsupported rather than risk writing to the wrong span.
        const compat = await getAstroCompat(options.repoRoot);
        console.info(`[halley-dev-edit] ${formatAstroVersions(compat)}`);
        if (compat.disabledReason) console.warn(`[halley-dev-edit] ${compat.disabledReason}`);

        updateConfig({
          vite: {
            server: {
              watch: {
                ignored: ['**/dist/**', '**/.git/**', '**/.halley-tmp-*'],
              },
            },
          },
        });

        injectScript('head-inline', EARLY_OBSERVER_SCRIPT);
        injectScript(
          'head-inline',
          `if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',()=>{${buildClientBridgeScript(options.previewBase)}});}else{${buildClientBridgeScript(options.previewBase)}}`,
        );
      },
      'astro:server:setup': ({ server }) => {
        const onFsEvent = (changedFile: string) => {
          invalidateCssModulesForFile(server as unknown as ViteServerLike, options.repoRoot, changedFile);
        };
        server.watcher.on('add', onFsEvent);
        server.watcher.on('change', onFsEvent);
        server.watcher.on('unlink', onFsEvent);

        server.middlewares.use(async (req, res, next) => {
          const urlPath = (req.url ?? '').split('?')[0] ?? '';
          const stripped =
            normalizedPreviewBase && urlPath.startsWith(normalizedPreviewBase)
              ? urlPath.slice(normalizedPreviewBase.length) || '/'
              : urlPath;

          if (req.method === 'GET' && stripped === '/__editor/health') {
            sendJson(res, 200, { ok: true });
            return;
          }

          if (!enableLocalEndpoints) {
            next();
            return;
          }

          if (req.method === 'GET' && stripped === '/__editor/routes') {
            const routes = await discoverSiteRoutes(options.repoRoot);
            sendJson(res, 200, { routes });
            return;
          }

          if (req.method === 'GET' && stripped === '/__editor/images') {
            const images = await listSiteImages(options.repoRoot);
            sendJson(res, 200, { images });
            return;
          }

          if (req.method === 'POST' && stripped === '/__editor/inspect') {
            try {
              const body = await readJsonBody<{ file: string; loc: string }>(req);
              const relFile = resolveEditorRelFile(options.repoRoot, body.file);
              if (relFile.startsWith('..') || relFile === '.github' || relFile.startsWith('.github/')) {
                sendJson(res, 200, { editability: 'dynamic', reason: 'Protected path' });
                return;
              }
              const abs = path.resolve(options.repoRoot, relFile);
              const source = await fs.readFile(abs, 'utf8');
              const inspected = await inspectAstroElement(source, body.loc, {
                file: relFile,
                disabledReason: (await getAstroCompat(options.repoRoot)).disabledReason,
              });
              if (!inspected) {
                sendJson(res, 200, { editability: 'dynamic', reason: 'Unmapped AST node' });
                return;
              }
              sendJson(res, 200, {
                editability: inspected.editability,
                reason: inspected.reason,
                snapshotHash: inspected.snapshotHash,
                fileHash: inspected.fileHash,
                contentHash: inspected.contentHash,
                outerSnapshotHash: inspected.outerSnapshotHash,
                tagName: inspected.tagName,
                context: inspected.context,
                capabilities: inspected.capabilities,
              });
            } catch (err) {
              sendJson(res, 400, {
                editability: 'dynamic',
                error: err instanceof Error ? err.message : 'Inspect failed',
              });
            }
            return;
          }

          if (req.method === 'POST' && stripped === '/__editor/patch') {
            if (options.isReadOnly?.()) {
              sendJson(res, 403, { error: 'Session is read-only' });
              return;
            }
            try {
              const body = await readJsonBody<{
                file: string;
                loc: string;
                expectedHash: string;
                fileHash?: string;
                contentHash?: string;
                newHtml: string;
              }>(req);
              const relFile = resolveEditorRelFile(options.repoRoot, body.file);
              const result = await patchStaticSpan({
                repoRoot: options.repoRoot,
                relFile,
                loc: body.loc,
                expectedHash: body.expectedHash,
                expectedFileHash: typeof body.fileHash === 'string' ? body.fileHash : undefined,
                expectedContentHash: typeof body.contentHash === 'string' ? body.contentHash : undefined,
                newHtml: body.newHtml,
                previewBase: options.previewBase,
                originalBase: options.originalBase,
                fileLock,
              });
              if (!result.ok) {
                sendJson(res, result.code, { error: result.error });
                return;
              }
              if (result.beforeSource !== result.afterSource) undoStack.push({
                relFile,
                summary: `Inline edit in ${relFile}`,
                beforeSource: result.beforeSource,
                afterSource: result.afterSource,
              });
              options.onPatched?.({ file: relFile, loc: result.newLoc });
              if (options.onPatchedWebhookUrl) {
                void fetch(options.onPatchedWebhookUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ file: relFile, loc: result.newLoc }),
                }).catch((err) => warnUnexpected('onPatched webhook delivery failed', err));
              }
              sendJson(res, 200, {
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
              sendJson(res, 500, {
                error: err instanceof Error ? err.message : 'Patch failed',
              });
            }
            return;
          }

          if (req.method === 'POST' && stripped === '/__editor/mutate') {
            if (options.isReadOnly?.()) {
              sendJson(res, 403, { error: 'Session is read-only' });
              return;
            }
            try {
              const body = await readJsonBody<{
                file: string;
                loc: string;
                expectedOuterHash: string;
                fileHash?: string;
                mutation: ElementMutation;
              }>(req);
              const relFile = resolveEditorRelFile(options.repoRoot, body.file);
              const result = await mutateAstroElement({
                repoRoot: options.repoRoot,
                relFile,
                loc: body.loc,
                expectedOuterHash: body.expectedOuterHash,
                expectedFileHash: typeof body.fileHash === 'string' ? body.fileHash : undefined,
                mutation: body.mutation,
                previewBase: options.previewBase,
                originalBase: options.originalBase,
                fileLock,
              });
              if (!result.ok) {
                sendJson(res, result.code, { error: result.error });
                return;
              }
              undoStack.push({
                relFile,
                summary: result.summary,
                beforeSource: result.beforeSource,
                afterSource: result.afterSource,
              });
              options.onPatched?.({ file: relFile, loc: result.newLoc });
              sendJson(res, 200, {
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
              sendJson(res, 500, {
                error: err instanceof Error ? err.message : 'Mutation failed',
              });
            }
            return;
          }

          if (req.method === 'POST' && stripped === '/__editor/undo') {
            if (options.isReadOnly?.()) {
              sendJson(res, 403, { error: 'Session is read-only' });
              return;
            }
            const result = await undoStack.undo(options.repoRoot, fileLock);
            if (!result.ok) {
              sendJson(res, result.code, { error: result.error, canUndo: result.canUndo, canRedo: result.canRedo });
              return;
            }
            sendJson(res, 200, result);
            return;
          }

          if (req.method === 'POST' && stripped === '/__editor/redo') {
            if (options.isReadOnly?.()) {
              sendJson(res, 403, { error: 'Session is read-only' });
              return;
            }
            const result = await undoStack.redo(options.repoRoot, fileLock);
            if (!result.ok) {
              sendJson(res, result.code, { error: result.error, canUndo: result.canUndo, canRedo: result.canRedo });
              return;
            }
            sendJson(res, 200, result);
            return;
          }

          next();
        });
      },
    },
  };
}
