import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AstroIntegration } from 'astro';
import { inspectAstroElement } from './ast-classifier.js';
import { buildClientBridgeScript, EARLY_OBSERVER_SCRIPT } from './client-bridge.js';
import { PerFileMutex, type AsyncFileLock } from './file-lock.js';
import { discoverSiteRoutes } from './routes.js';
import { patchStaticSpan } from './serializer.js';

export interface HalleyDevEditOptions {
  repoRoot: string;
  previewBase: string;
  originalBase: string;
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

function resolveRelFile(repoRoot: string, rawFile: string): string {
  const abs = path.isAbsolute(rawFile)
    ? path.resolve(rawFile)
    : path.resolve(repoRoot, rawFile);
  return path.relative(path.resolve(repoRoot), abs).split(path.sep).join('/');
}

export function halleyDevEdit(options: HalleyDevEditOptions): AstroIntegration {
  const fileLock = options.fileLock ?? new PerFileMutex();
  const normalizedPreviewBase =
    options.previewBase === '/' ? '' : options.previewBase.replace(/\/$/, '');

  return {
    name: '@halley/astro-dev-edit',
    hooks: {
      'astro:config:setup': ({ command, injectScript }) => {
        if (command !== 'dev') return;

        injectScript('head-inline', EARLY_OBSERVER_SCRIPT);
        injectScript(
          'head-inline',
          `if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',()=>{${buildClientBridgeScript(options.previewBase)}});}else{${buildClientBridgeScript(options.previewBase)}}`,
        );
      },
      'astro:server:setup': ({ server }) => {
        server.middlewares.use(async (req, res, next) => {
          const urlPath = (req.url ?? '').split('?')[0] ?? '';
          const stripped =
            normalizedPreviewBase && urlPath.startsWith(normalizedPreviewBase)
              ? urlPath.slice(normalizedPreviewBase.length) || '/'
              : urlPath;

          if (req.method === 'GET' && stripped === '/__editor/routes') {
            const routes = await discoverSiteRoutes(options.repoRoot);
            sendJson(res, 200, { routes });
            return;
          }

          if (req.method === 'POST' && stripped === '/__editor/inspect') {
            try {
              const body = await readJsonBody<{ file: string; loc: string }>(req);
              const relFile = resolveRelFile(options.repoRoot, body.file);
              if (relFile.startsWith('..') || relFile === '.github' || relFile.startsWith('.github/')) {
                sendJson(res, 200, { editability: 'dynamic', reason: 'Protected path' });
                return;
              }
              const abs = path.resolve(options.repoRoot, relFile);
              const source = await fs.readFile(abs, 'utf8');
              const inspected = await inspectAstroElement(source, body.loc);
              if (!inspected) {
                sendJson(res, 200, { editability: 'dynamic', reason: 'Unmapped AST node' });
                return;
              }
              sendJson(res, 200, {
                editability: inspected.editability,
                reason: inspected.reason,
                snapshotHash: inspected.snapshotHash,
                tagName: inspected.tagName,
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
                newHtml: string;
              }>(req);
              const relFile = resolveRelFile(options.repoRoot, body.file);
              const result = await patchStaticSpan({
                repoRoot: options.repoRoot,
                relFile,
                loc: body.loc,
                expectedHash: body.expectedHash,
                newHtml: body.newHtml,
                previewBase: options.previewBase,
                originalBase: options.originalBase,
                fileLock,
              });
              if (!result.ok) {
                sendJson(res, result.code, { error: result.error });
                return;
              }
              options.onPatched?.({ file: relFile, loc: body.loc });
              if (options.onPatchedWebhookUrl) {
                void fetch(options.onPatchedWebhookUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ file: relFile, loc: body.loc }),
                }).catch(() => {});
              }
              sendJson(res, 200, { ok: true, updatedSource: result.updatedSource });
            } catch (err) {
              sendJson(res, 500, {
                error: err instanceof Error ? err.message : 'Patch failed',
              });
            }
            return;
          }

          next();
        });
      },
    },
  };
}
