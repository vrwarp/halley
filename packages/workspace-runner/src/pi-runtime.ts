import fs from 'node:fs/promises';
import path from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  section,
  ToolResultEntry,
  ToolTask,
  UserEntry,
  wrapTool,
  type Conversation,
} from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createFitImagesExtension, fitImage } from '@earendil-works/pi-durable/images/fit';
import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import {
  createBashTool,
  createCodingTools,
  createEditTool,
  createWriteTool,
  imageLimits,
} from '@earendil-works/pi-durable/tools';
import { bool, num, obj, oneOf, opt, str } from '@earendil-works/pi-schema';
import type { AsyncFileLock } from '@halley/astro-dev-edit';
import {
  HALLEY_PLACEHOLDER_ATTR,
  slugifyPagePath,
  type DebugTraceDto,
  type DebugTraceEntryDto,
  type EditorContext,
  type ElementContext,
  type LiveRunStateDto,
  type PageRequestMetadata,
  type StagedAttachment,
  type TranscriptEntryDto,
} from '@halley/shared';
import sharp from 'sharp';
import { sanitizeProtectedPaths } from './checkpoints-and-git.js';
import type { PageCreationService } from './pages.js';
import { formatCompactCheckSummary, runAllVerificationChecks } from './verify.js';
import type { UploadManager } from './uploads.js';

export interface PiRuntimeOptions {
  repoRoot: string;
  stateDir: string;
  sessionId: string;
  previewBase: string;
  astroPort: number;
  controlPlaneInternalUrl: string;
  workspaceToken: string;
  modelId: string;
  thinkingLevel: 'off' | 'low' | 'medium' | 'high';
  getPersona?: () => 'non-technical' | 'developer';
  fileLock: AsyncFileLock;
  uploadManager: UploadManager;
  pageService?: PageCreationService;
  onLockChange: (locked: boolean, file?: string) => void;
  onRunFinishedWithEdits: (summary: string) => Promise<void>;
  onTranscriptUpdate: (snapshot: {
    entries: TranscriptEntryDto[];
    live: LiveRunStateDto;
    usageUsd: number;
  }) => void;
}

function isProtectedPath(repoRoot: string, targetPath: string): boolean {
  const abs = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(repoRoot, targetPath);
  const rel = path.relative(path.resolve(repoRoot), abs).split(path.sep).join('/');
  return rel === '.github' || rel.startsWith('.github/') || rel.startsWith('..');
}

function resolveAnthropicModelId(
  requestedId: string,
  models: ReadonlyArray<{ id: string }>,
): string {
  const family =
    requestedId === 'sonnet-latest'
      ? 'sonnet'
      : requestedId === 'opus-latest'
        ? 'opus'
        : requestedId === 'haiku-latest'
          ? 'haiku'
          : null;
  if (!family) return requestedId;

  const parseVersion = (id: string): number[] => {
    const clean = id.replace(/-\d{8}$/, '');
    const nums = clean.match(/\d+/g)?.map(Number) ?? [0];
    // Prefer undated alias over dated snapshot when version numbers tie
    const isUndated = clean === id ? 1 : 0;
    return [...nums, isUndated];
  };

  const candidates = models
    .filter((m) => m.id.includes(family))
    .sort((a, b) => {
      const va = parseVersion(a.id);
      const vb = parseVersion(b.id);
      const len = Math.max(va.length, vb.length);
      for (let i = 0; i < len; i++) {
        const diff = (vb[i] ?? 0) - (va[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    });

  return candidates[0]?.id ?? requestedId;
}

export class HalleyPiRuntime {
  private harness!: Harness;
  private root!: Conversation;
  private watchHandle: Awaited<ReturnType<Conversation['watch']>> | null = null;
  private images!: Awaited<ReturnType<typeof createNodePhotonImages>>;
  private models = createModels();
  private resolvedModelId = '';
  private lastEditorContext: EditorContext | null = null;
  private agentsMdText: string | null = null;
  private systemContextNotes: string[] = [];
  private availableModelIds: Array<{ id: string }> = [];
  private trackedPageRequestIds = new Set<string>();

  constructor(private opts: PiRuntimeOptions) {}

  getResolvedModelId(): string {
    return this.resolvedModelId || this.opts.modelId;
  }

  resolveModelAlias(requestedId: string): string {
    if (this.availableModelIds.length === 0) return requestedId;
    return resolveAnthropicModelId(requestedId, this.availableModelIds);
  }

  isBusy(): boolean {
    const val = this.watchHandle?.value;
    if (!val) return false;
    return this.mapWatchValue(val).live.busy;
  }

  async reloadAgentsMd(): Promise<void> {
    const text = await fs
      .readFile(path.join(this.opts.repoRoot, 'AGENTS.md'), 'utf8')
      .catch(() => '');
    this.agentsMdText = text || null;
  }

  addSystemContextNote(note: string): void {
    const clean = note.trim();
    if (!clean) return;
    this.systemContextNotes.push(clean);
    if (this.systemContextNotes.length > 10) {
      this.systemContextNotes.shift();
    }
  }

  async start(): Promise<void> {
    await fs.mkdir(this.opts.stateDir, { recursive: true });
    const sqlitePath = path.join(this.opts.stateDir, 'pi.sqlite');
    const handoffText = await fs
      .readFile(path.join(this.opts.stateDir, 'handoff-context.txt'), 'utf8')
      .catch(() => '');
    if (handoffText.trim()) {
      this.addSystemContextNote(handoffText.trim());
    }

    // Route Anthropic requests through the Control Plane LLM proxy using WORKSPACE_TOKEN.
    // Raw ANTHROPIC_API_KEY never enters the workspace container.
    const baseAnthropic = anthropicProvider();
    const proxyBaseUrl = `${this.opts.controlPlaneInternalUrl.replace(/\/$/, '')}/internal/llm/anthropic`;
    const proxiedModels = baseAnthropic.getModels().map((m) => ({
      ...m,
      baseUrl: proxyBaseUrl,
    }));
    this.availableModelIds = proxiedModels;
    this.resolvedModelId = resolveAnthropicModelId(this.opts.modelId, proxiedModels);
    console.log(
      `[halley-pi] model=${this.opts.modelId} -> ${this.resolvedModelId} (thinking=${this.opts.thinkingLevel})`,
    );
    const proxiedAnthropic = {
      ...baseAnthropic,
      name: 'Anthropic (Halley Proxy)',
      baseUrl: proxyBaseUrl,
      getModels: () => proxiedModels,
      auth: {
        apiKey: {
          name: 'Halley Workspace Token',
          login: async () => ({ type: 'api_key' as const, key: this.opts.workspaceToken }),
          resolve: async () => ({
            auth: {
              headers: {
                Authorization: `Bearer ${this.opts.workspaceToken}`,
              },
            },
            source: 'Halley WORKSPACE_TOKEN',
          }),
        },
      },
    };
    this.models.setProvider(proxiedAnthropic);

    this.images = await createNodePhotonImages();
    const registry = createRegistry();
    registry.install(createCodingTools({ images: this.images }));
    registry.install(createFitImagesExtension(this.images));

    const agentsMdText = await fs
      .readFile(path.join(this.opts.repoRoot, 'AGENTS.md'), 'utf8')
      .catch(() => '');
    this.agentsMdText = agentsMdText || null;

    const halleyExtension = this.buildHalleyExtension(agentsMdText);
    registry.install(halleyExtension);

    const storage = await openNodeSqliteStorage(sqlitePath);
    this.harness = await Harness.open(
      storage,
      {
        models: this.models,
        registry,
        env: () =>
          new NodeExecutionEnv({
            cwd: this.opts.repoRoot,
          }),
        settings: {
          progress: {
            partialIntervalMs: 120,
            outputIntervalMs: 150,
            persistWithinMs: 1000,
          },
          retry: { maxRetries: 2 },
        },
      },
      BACKGROUND_CONTEXT,
    );

    this.root = await this.harness.root(BACKGROUND_CONTEXT, {
      agent: {
        model: { provider: 'anthropic', modelId: this.resolvedModelId },
        thinkingLevel: this.opts.thinkingLevel,
        cwd: this.opts.repoRoot,
      },
    });

    this.watchHandle = await this.root.watch(BACKGROUND_CONTEXT);
    this.opts.onTranscriptUpdate(this.mapWatchValue(this.watchHandle.value));
    this.watchHandle.start(async (call) => {
      if (call.kind === 'value') {
        const snapshot = this.mapWatchValue(call.value);
        if (snapshot.live.runFailure && !snapshot.live.busy && this.opts.pageService && this.trackedPageRequestIds.size > 0) {
          const reason = snapshot.live.runFailure.detail || snapshot.live.runFailure.reason || 'Run failed';
          for (const id of Array.from(this.trackedPageRequestIds)) {
            const pr = this.opts.pageService.getPageRequest(id);
            if (!pr) {
              this.trackedPageRequestIds.delete(id);
              continue;
            }
            const stillPlaceholder = await this.opts.pageService.fileStillHasPlaceholder(pr.file);
            if (stillPlaceholder) {
              await this.opts.pageService.updateStatus(id, 'failed', reason);
            } else {
              await this.opts.pageService.updateStatus(id, 'done');
            }
            this.trackedPageRequestIds.delete(id);
          }
        }
        this.opts.onTranscriptUpdate(snapshot);
      }
    });

    this.harness.resume();
  }

  private buildHalleyExtension(agentsMdText: string) {
    const opts = this.opts;

    // Track in-flight file mutations so parallel screenshot_page / run_checks calls
    // emitted in the same assistant turn always wait for writes + Vite watcher settle.
    const inFlightMutations = new Set<Promise<unknown>>();
    let lastMutationFinishedAt = 0;

    const trackMutation = async <T>(fn: () => Promise<T>): Promise<T> => {
      const p = fn();
      inFlightMutations.add(p);
      try {
        return await p;
      } finally {
        inFlightMutations.delete(p);
        lastMutationFinishedAt = Date.now();
      }
    };

    const waitForPendingMutations = async (watcherSettleMs = 0): Promise<void> => {
      while (inFlightMutations.size > 0) {
        await Promise.allSettled([...inFlightMutations]);
      }
      if (watcherSettleMs > 0 && lastMutationFinishedAt > 0) {
        const elapsed = Date.now() - lastMutationFinishedAt;
        if (elapsed < watcherSettleMs) {
          await new Promise((r) => setTimeout(r, watcherSettleMs - elapsed));
        }
      }
    };

    const processImageTool = defineTool({
      name: 'process_image',
      description:
        'Convert a staged user-uploaded image into an optimized WebP image inside the repository (strips EXIF/GPS metadata, auto-orients, and resizes). Use this whenever placing an uploaded photo into public/images/...',
      parameters: obj({
        stagedId: str({ description: 'The stagedId from the attached upload metadata' }),
        destPath: str({
          description:
            'Repository-relative destination path ending in .webp (e.g. public/images/community/youth-retreat.webp)',
        }),
        maxWidth: opt(num({ description: 'Maximum width in pixels (default 2400)' })),
        quality: opt(num({ description: 'WebP quality 1-100 (default 84)' })),
      }),
      execute: async (args) => {
        if (isProtectedPath(opts.repoRoot, args.destPath)) {
          return { output: [{ type: 'text', text: 'Cannot write to protected path.' }], isError: true };
        }
        const staged = await opts.uploadManager.resolveStagedFile(args.stagedId);
        if (!staged) {
          return {
            output: [{ type: 'text', text: `Staged upload not found: ${args.stagedId}` }],
            isError: true,
          };
        }
        const destAbs = path.resolve(opts.repoRoot, args.destPath);
        if (!destAbs.startsWith(path.resolve(opts.repoRoot) + path.sep)) {
          return { output: [{ type: 'text', text: 'Invalid destination path.' }], isError: true };
        }

        await trackMutation(() =>
          opts.fileLock.withLock(args.destPath, async () => {
            await fs.mkdir(path.dirname(destAbs), { recursive: true });
            const maxWidth = args.maxWidth ?? 2400;
            const quality = args.quality ?? 84;
            // .rotate() auto-orients from EXIF; omitting .withMetadata() strips all EXIF/GPS
            const webpBuf = await sharp(staged.bytes)
              .rotate()
              .resize({ width: maxWidth, withoutEnlargement: true })
              .webp({ quality })
              .toBuffer();
            const tmp = `${destAbs}.tmp-${Date.now()}`;
            await fs.writeFile(tmp, webpBuf);
            await fs.rename(tmp, destAbs);
          }),
        );

        const meta = await sharp(destAbs).metadata();
        return {
          output: [
            {
              type: 'text',
              text: `Saved optimized WebP (${meta.width}x${meta.height}, EXIF stripped) to ${args.destPath}`,
            },
          ],
        };
      },
    });

    const screenshotPageTool = defineTool({
      name: 'screenshot_page',
      description:
        'Capture a live browser screenshot of a route on the running astro dev preview to visually inspect layout, contrast, face cropping, and mobile responsiveness. Use viewport="both" to capture desktop and mobile together, and fullPage=true to inspect below the fold.',
      parameters: obj({
        route: str({ description: 'Site route to capture, e.g. "/" or "/im-new" or "/sermons"' }),
        viewport: oneOf(['desktop', 'mobile', 'both']),
        fullPage: opt(
          bool({ description: 'Capture full page height (capped at 3600px) instead of above-the-fold only' }),
        ),
      }),
      execute: async (args) => {
        // Ensure any parallel edit/write/bash in the same turn finishes and Vite invalidates CSS first
        await waitForPendingMutations(200);

        const cleanRoute = args.route.startsWith('/') ? args.route : `/${args.route}`;
        const endpoint = `${opts.controlPlaneInternalUrl.replace(/\/$/, '')}/internal/screenshot`;
        const viewports: Array<'desktop' | 'mobile'> =
          args.viewport === 'both' ? ['desktop', 'mobile'] : [args.viewport];
        const output: Array<
          { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        > = [];

        for (const vp of viewports) {
          const fallbackSize = vp === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 800 };
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${opts.workspaceToken}`,
            },
            body: JSON.stringify({
              route: cleanRoute,
              viewport: vp,
              ...(args.fullPage ? { fullPage: true } : {}),
            }),
          });

          if (!res.ok) {
            const errText = await res.text().catch(() => res.statusText);
            return {
              output: [
                {
                  type: 'text',
                  text: `Screenshot failed (${res.status}): ${errText}`,
                },
              ],
              isError: true,
            };
          }

          const rawContentType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0]!.trim();
          const mimeType = rawContentType.startsWith('image/') ? rawContentType : 'image/jpeg';
          const width = Number(res.headers.get('x-screenshot-width')) || fallbackSize.width;
          const height = Number(res.headers.get('x-screenshot-height')) || fallbackSize.height;
          const imgBytes = Buffer.from(await res.arrayBuffer());
          output.push(
            {
              type: 'text',
              text: `Captured ${vp} (${width}x${height}${args.fullPage ? ', fullPage' : ''}) screenshot of ${cleanRoute}`,
            },
            {
              type: 'image',
              data: imgBytes.toString('base64'),
              mimeType,
            },
          );
        }

        return { output };
      },
    });

    const runChecksTool = defineTool({
      name: 'run_checks',
      description:
        'Run the full pre-publish verification suite (Astro Hygiene Guard, astro check, production build, verify:seo, etc.) against the repository.',
      parameters: obj({}),
      execute: async () => {
        await waitForPendingMutations(0);
        const { allPassed, results } = await runAllVerificationChecks(opts.repoRoot);
        const summary = formatCompactCheckSummary(results);
        return {
          output: [{ type: 'text', text: summary }],
          isError: !allPassed,
        };
      },
    });

    const createPageTool = defineTool({
      name: 'create_page',
      description:
        'Create a new starter page on the site with validated URL, layout skeleton, unlisted noindex flags, and an automatic git checkpoint, and immediately open it in the live preview. Always call this before writing a brand-new page requested in chat.',
      parameters: obj({
        title: str({ description: 'Human-readable page title, e.g. "Spring Retreat"' }),
        slug: opt(str({ description: 'Optional URL slug (defaults to slugified title), e.g. "spring-retreat"' })),
        section: opt(str({ description: 'Optional section folder, e.g. "/events" or "/" (default "/")' })),
        purpose: opt(str({ description: 'Brief description of what the page is for' })),
        styleLikeRoute: opt(
          str({ description: 'Optional existing route to match visually, e.g. "/events/mens-retreat", or "__blank__"' }),
        ),
        navGroup: opt(str({ description: 'Optional navigation group name if adding to the site menu' })),
        unlisted: opt(bool({ description: 'True to keep the page hidden from menus, search engines, and sitemap' })),
      }),
      execute: async (args) => {
        if (!opts.pageService) {
          return { output: [{ type: 'text', text: 'Page creation service is unavailable.' }], isError: true };
        }
        try {
          const slug = (args.slug && args.slug.trim()) || slugifyPagePath(args.title);
          const result = await opts.pageService.createPage(
            {
              title: args.title,
              slug,
              section: args.section || '/',
              purpose: args.purpose,
              styleLikeRoute: args.styleLikeRoute,
              nav: args.navGroup && !args.unlisted ? { mode: 'group', group: args.navGroup } : { mode: 'none' },
              unlisted: Boolean(args.unlisted),
            },
            { fromPiTool: true },
          );
          this.trackedPageRequestIds.add(result.pageRequest.pageRequestId);
          return {
            output: [
              {
                type: 'text',
                text: `Created starter page at ${result.file} (route ${result.route}).\n\n${result.instructions}`,
              },
            ],
          };
        } catch (err) {
          return {
            output: [
              {
                type: 'text',
                text: err instanceof Error ? err.message : 'Failed to create page',
              },
            ],
            isError: true,
          };
        }
      },
    });

    const editToolDef = createEditTool();
    const writeToolDef = createWriteTool();
    const bashToolDef = createBashTool();

    const wrapFileTool = <T extends typeof editToolDef | typeof writeToolDef>(toolDef: T) =>
      wrapTool(toolDef, (base) => ({
        ...base,
        execute: async (
          args: Parameters<typeof base.execute>[0],
          api: Parameters<typeof base.execute>[1],
          ctx: Parameters<typeof base.execute>[2],
        ) => {
          const target = String((args as Record<string, unknown>).path ?? '');
          const rel = path.relative(opts.repoRoot, path.resolve(opts.repoRoot, target)).split(path.sep).join('/');
          opts.onLockChange(true, rel);
          try {
            return await trackMutation(() =>
              opts.fileLock.withLock(rel, () => base.execute(args as never, api, ctx)),
            );
          } finally {
            opts.onLockChange(false, rel);
          }
        },
      }));

    const wrapBashTool = wrapTool(bashToolDef, (base) => ({
      ...base,
      execute: async (
        args: Parameters<typeof base.execute>[0],
        api: Parameters<typeof base.execute>[1],
        ctx: Parameters<typeof base.execute>[2],
      ) => {
        opts.onLockChange(true, 'shell');
        try {
          return await trackMutation(async () => {
            const res = await base.execute(args as never, api, ctx);
            await sanitizeProtectedPaths(opts.repoRoot).catch(() => {});
            return res;
          });
        } finally {
          opts.onLockChange(false, 'shell');
        }
      },
    }));

    return defineExtension({
      name: 'halley',
      tools: [processImageTool, screenshotPageTool, runChecksTool, createPageTool],
      wraps: [wrapFileTool(editToolDef), wrapFileTool(writeToolDef), wrapBashTool],
      sections: [
        section('halley_role', () => this.buildHalleyRolePrompt()),
        section('repo_agents_md', () =>
          this.agentsMdText ? `Repository AGENTS.md:\n\n${this.agentsMdText}` : undefined,
        ),
        section('halley_context_notes', () =>
          this.systemContextNotes.length > 0
            ? `Session & Live-Site Context Notes:\n\n${this.systemContextNotes.map((n) => `- ${n}`).join('\n')}`
            : undefined,
        ),
      ],
      hooks: [
        hook(ToolTask, {
          beforeTool: (call) => {
            if (call.name === 'edit' || call.name === 'write') {
              const args = call.arguments as Record<string, unknown>;
              const p = String(args.path ?? args.file_path ?? '');
              if (p && isProtectedPath(opts.repoRoot, p)) {
                return { block: '`.github/**` workflows are protected and cannot be modified.' };
              }
              if (opts.pageService && this.trackedPageRequestIds.size > 0 && p) {
                const rel = path
                  .relative(opts.repoRoot, path.resolve(opts.repoRoot, p))
                  .split(path.sep)
                  .join('/');
                for (const id of this.trackedPageRequestIds) {
                  const pr = opts.pageService.getPageRequest(id);
                  if (!pr) continue;
                  if (rel === pr.file) {
                    void opts.pageService.updateStatus(id, 'writing');
                  } else if (/(?:site\.ts|header\.astro|nav)/i.test(rel)) {
                    void opts.pageService.updateStatus(id, 'menu');
                  }
                }
              }
            } else if (call.name === 'process_image' && opts.pageService && this.trackedPageRequestIds.size > 0) {
              for (const id of this.trackedPageRequestIds) {
                const pr = opts.pageService.getPageRequest(id);
                if (pr && pr.status !== 'done' && pr.status !== 'failed') {
                  void opts.pageService.updateStatus(id, 'photo');
                }
              }
            }
            return undefined;
          },
        }),
        hook(GenerationTask, {
          afterRun: async (run, api, context) => {
            const { items } = await api.entries(
              { minEntryId: run.first, maxEntryId: run.last, order: 'ascending' },
              500,
              undefined,
              context,
            );
            const mutated = items.some((entry) => {
              if (!ToolResultEntry.is(entry)) return false;
              const msg = entry.model?.[0];
              if (!msg || msg.role !== 'toolResult') return false;
              return ['edit', 'write', 'bash', 'process_image'].includes(msg.toolName);
            });
            if (mutated) {
              await opts.onRunFinishedWithEdits('Update via Halley chat');
            }
            if (opts.pageService && this.trackedPageRequestIds.size > 0) {
              for (const id of Array.from(this.trackedPageRequestIds)) {
                const pr = opts.pageService.getPageRequest(id);
                if (!pr) {
                  this.trackedPageRequestIds.delete(id);
                  continue;
                }
                const stillPlaceholder = await opts.pageService.fileStillHasPlaceholder(pr.file);
                if (!stillPlaceholder) {
                  await opts.pageService.updateStatus(id, 'done');
                  this.trackedPageRequestIds.delete(id);
                } else if (pr.status !== 'queued') {
                  await opts.pageService.updateStatus(
                    id,
                    'failed',
                    'Halley finished without replacing the placeholder content.',
                  );
                  this.trackedPageRequestIds.delete(id);
                }
              }
            }
            return undefined;
          },
        }),
      ],
    });
  }

  private buildHalleyRolePrompt(): string {
    const persona = this.opts.getPersona?.() ?? 'non-technical';
    const personaGuidance =
      persona === 'developer'
        ? [
            'User Persona: Technical / Developer.',
            'Be concise and direct. You may reference exact file paths, Astro components, Tailwind classes, and check outputs.',
          ]
        : [
            'User Persona: Non-technical site maintainer (church staff / volunteer).',
            'Prioritize ONLY the most important information the user needs to know—keep responses short (2–4 sentences or a couple of brief bullets).',
            'Speak in warm, plain, everyday English about pages, sections, photos, and what visitors will see. NEVER mention technical details or lingo (no file paths like `src/pages/...`, no Astro/HTML/CSS/TypeScript/JSON/git/Python terms, no stylesheets/breakpoints/grid classes/dev-server details, no component or script names, and no sitemap/robots internals) unless the user explicitly asks.',
            'While running tools, do NOT narrate technical debugging steps to the user; either invoke tools silently or share a brief plain-English update ("Checking how the page looks on desktop and mobile…").',
            'State what changed and any next step or question clearly (e.g., "I added your Spring Retreat page and kept it unlisted so it won\'t appear in menus or search. Take a look in the preview and let me know if you\'d like to add dates or photos!").',
            'Summarize verification in plain terms ("Everything passed our site checks and is ready to publish").',
          ];
    const editorCtxLines = this.lastEditorContext
      ? [
          `Live preview context: the user is currently viewing page \`${this.lastEditorContext.currentRoute}\` (viewport: ${this.lastEditorContext.viewport ?? 'desktop'}, mode: ${this.lastEditorContext.mode ?? 'edit'}).`,
          `When the user says "this page", "here", or asks what page they are looking at, use the \`[Current Preview]\` route (currently \`${this.lastEditorContext.currentRoute}\`) directly and inspect its file under \`src/pages/\` if needed.`,
        ]
      : [
          'Each user message may begin with `[Current Preview] route=... viewport=... mode=...` telling you the exact page currently open on the user\'s screen. Use it whenever the user asks what page they are looking at or refers to "this page".',
        ];
    return [
      'You are Halley, a friendly, careful AI website editor helping maintain an Astro website.',
      ...personaGuidance,
      ...editorCtxLines,
      'Whenever you mention a page on the site or the user asks for a link to a page (including pages you just created or edited), ALWAYS format it as an internal markdown link using the page\'s route, like `[Our Staff](/im-new/our-staff)` or `[Events](/events)`. NEVER give a full live-site URL (like `https://...github.io/...`) — the editor automatically turns internal `[Page Name](/route)` links into clickable buttons that open the page directly in the live preview pane.',
      'Prefer `read`, `edit`, and `write` for inspecting and editing individual files; use `bash` (`rg`, `jq`, `python3`, `node`) for multi-file searches or bulk structured data updates.',
      'Never attempt to modify files under `.github/`. They are protected and read-only.',
      `When the user asks in chat to create a brand-new page, ALWAYS call the \`create_page\` tool first to scaffold and validate the page, then edit the generated file to replace the \`${HALLEY_PLACEHOLDER_ATTR}\` section with complete content. Never leave \`${HALLEY_PLACEHOLDER_ATTR}\` in a finished page.`,
      'When creating an unlisted, hidden, or placeholder ("coming soon") page without real visitor content yet, keep `indexable={false}` (or `<meta name="robots" content="noindex" />`), do NOT link it in navigation menus or footer, and exclude it from the sitemap in `astro.config.mjs` if `@astrojs/sitemap` filter is used. Once real visitor content is added, offer or switch it to indexable.',
      'When images are attached with a `stagedId`, use `process_image` to convert and save them cleanly into `public/images/...`.',
      'After significant layout or visual changes, use `screenshot_page` (you can pass `viewport: "both"` and `fullPage: true` to inspect desktop and mobile in one step) to verify your work visually, and run `run_checks` to confirm `astro check`, `build`, and SEO checks pass.',
    ].join('\n');
  }

  getDebugTrace(): DebugTraceDto {
    const val = this.watchHandle?.value;
    const mapped = val
      ? this.mapWatchValue(val)
      : {
          entries: [],
          live: { busy: false, activeTools: [], queuedCount: 0 },
          usageUsd: 0,
        };

    const debugEntries: DebugTraceEntryDto[] = [];
    if (val) {
      for (const entry of val.entries) {
        if (UserEntry.is(entry)) {
          const content = entry.model?.[0]?.content;
          let text = '';
          let imagesCount = 0;
          if (typeof content === 'string') {
            text = content;
          } else if (Array.isArray(content)) {
            const texts: string[] = [];
            for (const b of content) {
              if (b.type === 'text') texts.push(b.text);
              else if (b.type === 'image') imagesCount += 1;
            }
            text = texts.join('\n');
          }
          debugEntries.push({
            id: String(entry.id),
            kind: entry.kind,
            role: 'user',
            text,
            ...(imagesCount > 0 ? { imagesCount } : {}),
          });
        } else if (AssistantEntry.is(entry)) {
          const msg = entry.model?.[0] as
            | {
                content?: Array<Record<string, unknown>>;
                model?: string;
                stopReason?: string;
                usage?: unknown;
              }
            | undefined;
          const blocks = Array.isArray(msg?.content) ? msg.content : [];
          const texts: string[] = [];
          const thinkings: string[] = [];
          const toolCalls: Array<{ id?: string; name: string; arguments: unknown }> = [];
          for (const b of blocks) {
            if (b.type === 'text' && typeof b.text === 'string') {
              texts.push(b.text);
            } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
              thinkings.push(b.thinking);
            } else if (b.type === 'toolCall' && typeof b.name === 'string') {
              toolCalls.push({
                id: typeof b.id === 'string' ? b.id : undefined,
                name: b.name,
                arguments: b.arguments,
              });
            }
          }
          debugEntries.push({
            id: String(entry.id),
            kind: entry.kind,
            role: 'assistant',
            ...(texts.length > 0 ? { text: texts.join('') } : {}),
            ...(thinkings.length > 0 ? { thinking: thinkings.join('\n\n') } : {}),
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
            ...(msg?.model ? { model: msg.model } : {}),
            ...(msg?.stopReason ? { stopReason: msg.stopReason } : {}),
            ...(msg?.usage ? { usage: msg.usage } : {}),
          });
        } else if (ToolResultEntry.is(entry)) {
          const msg = entry.model?.[0];
          if (msg && msg.role === 'toolResult') {
            const textOut = Array.isArray(msg.content)
              ? msg.content
                  .map((b) =>
                    b.type === 'text'
                      ? b.text
                      : `[${b.type} attachment omitted]`,
                  )
                  .join('\n')
              : '';
            debugEntries.push({
              id: String(entry.id),
              kind: entry.kind,
              role: 'tool',
              toolCallId: msg.toolCallId,
              toolName: msg.toolName,
              toolOutput: textOut,
              isError: Boolean(msg.isError),
            });
          }
        }
      }
    }

    const usageDoc = val?.docs['pi.usage'];
    return {
      exportedAt: new Date().toISOString(),
      sessionId: this.opts.sessionId,
      modelId: this.resolvedModelId || this.opts.modelId,
      thinkingLevel: this.opts.thinkingLevel,
      persona: this.opts.getPersona?.() ?? 'non-technical',
      previewBase: this.opts.previewBase,
      lastEditorContext: this.lastEditorContext,
      systemPrompt: {
        halleyRole: this.buildHalleyRolePrompt(),
        agentsMd: this.agentsMdText,
      },
      usageUsd: mapped.usageUsd,
      usageByModel: (usageDoc?.models ?? {}) as Record<string, unknown>,
      live: mapped.live,
      entries: debugEntries,
    };
  }

  private mapWatchValue(value: NonNullable<typeof this.watchHandle>['value']): {
    entries: TranscriptEntryDto[];
    live: LiveRunStateDto;
    usageUsd: number;
  } {
    const entries: TranscriptEntryDto[] = [];

    for (const entry of value.entries) {
      if (UserEntry.is(entry)) {
        const textPart = entry.model?.[0]?.content;
        const display =
          typeof textPart === 'string'
            ? textPart
            : Array.isArray(textPart)
              ? textPart
                  .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                  .map((b) => b.text)
                  .join('\n')
              : '';
        let pageRequest: PageRequestMetadata | undefined;
        const firstLine = display.split('\n')[0] ?? '';
        if (firstLine.startsWith('[Halley Page Request] ')) {
          try {
            const parsed = JSON.parse(firstLine.slice('[Halley Page Request] '.length)) as {
              pageRequestId?: string;
            };
            if (parsed.pageRequestId && this.opts.pageService) {
              pageRequest = this.opts.pageService.getPageRequest(parsed.pageRequestId);
            }
          } catch {
            // ignore malformed marker
          }
        }
        entries.push({
          id: String(entry.id),
          kind: entry.kind,
          role: 'user',
          text: display,
          ...(pageRequest ? { pageRequest } : {}),
        });
      } else if (AssistantEntry.is(entry)) {
        const msg = entry.model?.[0] as
          | { content?: Array<{ type: string; text?: string }>; stopReason?: string }
          | undefined;
        const blocks = Array.isArray(msg?.content) ? msg.content : [];
        const text = blocks
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('');
        if (text.trim()) {
          entries.push({
            id: String(entry.id),
            kind: entry.kind,
            role: 'assistant',
            text,
            ...(msg?.stopReason === 'toolUse' ? { isIntermediate: true } : {}),
          });
        }
      } else if (ToolResultEntry.is(entry)) {
        const msg = entry.model?.[0];
        if (msg && msg.role === 'toolResult') {
          const textOut = Array.isArray(msg.content)
            ? msg.content
                .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                .map((b) => b.text)
                .join('\n')
            : '';
          entries.push({
            id: String(entry.id),
            kind: entry.kind,
            role: 'tool',
            text: textOut.slice(0, 600),
            toolName: msg.toolName,
            toolStatus: msg.isError ? 'error' : 'done',
            toolOutput: textOut.slice(0, 1200),
          });
        }
      }
    }

    const liveDoc = value.docs['pi.live'] as
      | {
          run?: unknown;
          generation?: { partial?: { content?: Array<{ type: string; text?: string }> } };
          tools?: Array<{ callId: string; name: string; output?: string; status: string }>;
          runFailure?: { reason: string; detail?: string };
        }
      | undefined;
    const gen = liveDoc?.generation;
    const streamingText =
      gen?.partial?.content
        ?.filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('') ?? undefined;

    const activeTools = (liveDoc?.tools ?? []).map((t) => ({
      callId: t.callId,
      name: t.name,
      summary: t.name,
      output: t.output?.slice(0, 600),
      status: t.status as LiveRunStateDto['activeTools'][number]['status'],
    }));

    const usageDoc = value.docs['pi.usage'];
    let usageUsd = 0;
    if (usageDoc?.models) {
      for (const u of Object.values(usageDoc.models)) {
        usageUsd += u.cost?.total ?? 0;
      }
    }

    const inboxDoc = value.docs['pi.inbox'] as { items?: unknown[] } | undefined;

    return {
      entries,
      live: {
        busy: Boolean(liveDoc?.run),
        streamingText,
        activeTools,
        queuedCount: inboxDoc?.items?.length ?? 0,
        runFailure: liveDoc?.runFailure
          ? {
              reason: liveDoc.runFailure.reason,
              detail: liveDoc.runFailure.detail ? String(liveDoc.runFailure.detail) : undefined,
            }
          : undefined,
      },
      usageUsd,
    };
  }

  async submitUserInput(input: {
    requestId: string;
    text: string;
    contextChips?: ElementContext[];
    attachments?: StagedAttachment[];
    editorContext?: EditorContext;
    whenBusy?: 'steer' | 'followUp';
  }): Promise<void> {
    if (input.editorContext) {
      this.lastEditorContext = input.editorContext;
    }
    const parts: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];

    let enrichedText = input.text.trim();
    if (input.editorContext) {
      const ctxLine = `[Current Preview] route=${input.editorContext.currentRoute} viewport=${input.editorContext.viewport ?? 'desktop'} mode=${input.editorContext.mode ?? 'edit'}`;
      enrichedText = `${ctxLine}\n\n${enrichedText}`;
    }
    if (input.contextChips && input.contextChips.length > 0) {
      const chipLines = input.contextChips.map(
        (c, i) =>
          `[Selected Element ${i + 1}] file=${c.file} loc=${c.loc} route=${c.route} tag=<${c.tagName}> text=${JSON.stringify(c.renderedText)}` +
          (c.selectedText ? ` highlighted=${JSON.stringify(c.selectedText)}` : ''),
      );
      enrichedText = `${chipLines.join('\n')}\n\n${enrichedText}`;
    }

    if (input.attachments && input.attachments.length > 0) {
      const attachLines: string[] = [];
      const model = this.models.getModel('anthropic', this.resolvedModelId);
      const limits = imageLimits(model);

      for (const att of input.attachments) {
        attachLines.push(
          `[Uploaded Image] stagedId=${att.stagedId} filename=${JSON.stringify(att.filename)} mime=${att.mimeType}`,
        );
        const resolved = await this.opts.uploadManager.resolveStagedFile(att.stagedId);
        if (resolved) {
          const fitted = await fitImage(resolved.bytes, att.mimeType, limits, this.images);
          if (fitted.kind === 'fitted') {
            parts.push({
              type: 'image',
              data: fitted.image.data,
              mimeType: fitted.image.mimeType,
            });
          }
        }
      }
      enrichedText = `${attachLines.join('\n')}\n\n${enrichedText}`;
    }

    parts.unshift({ type: 'text', text: enrichedText });

    await this.root.submit(
      {
        type: 'input',
        requestId: input.requestId,
        content: parts,
        whenBusy: input.whenBusy,
      },
      BACKGROUND_CONTEXT,
    );
  }

  async submitPageCreationRequest(
    pageRequest: PageRequestMetadata,
    instructions: string,
    whenBusy?: 'followUp',
    viewport?: 'desktop' | 'tablet' | 'mobile',
  ): Promise<void> {
    this.trackedPageRequestIds.add(pageRequest.pageRequestId);
    const effectiveViewport = viewport ?? this.lastEditorContext?.viewport ?? 'desktop';
    const header = `[Halley Page Request] ${JSON.stringify({ pageRequestId: pageRequest.pageRequestId })}`;
    const ctxLine = `[Current Preview] route=${pageRequest.route} viewport=${effectiveViewport} mode=browse`;
    const parts: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];

    let enrichedText = `${header}\n${ctxLine}\n\n${instructions}`;

    if (pageRequest.attachment) {
      const att = pageRequest.attachment;
      const model = this.models.getModel('anthropic', this.resolvedModelId);
      const limits = imageLimits(model);
      const resolved = await this.opts.uploadManager.resolveStagedFile(att.stagedId);
      if (resolved) {
        const fitted = await fitImage(resolved.bytes, att.mimeType, limits, this.images);
        if (fitted.kind === 'fitted') {
          parts.push({
            type: 'image',
            data: fitted.image.data,
            mimeType: fitted.image.mimeType,
          });
        }
      }
      enrichedText = `${header}\n${ctxLine}\n[Uploaded Image] stagedId=${att.stagedId} filename=${JSON.stringify(att.filename)} mime=${att.mimeType}\n\n${instructions}`;
    }

    parts.unshift({ type: 'text', text: enrichedText });

    await this.root.submit(
      {
        type: 'input',
        requestId: `page-create-${pageRequest.pageRequestId}-${Date.now()}`,
        content: parts,
        whenBusy,
      },
      BACKGROUND_CONTEXT,
    );
  }

  async submitConflictResolutionPrompt(conflictedFiles: string[]): Promise<boolean> {
    const sub = await this.root.submit(
      {
        type: 'input',
        requestId: `rebase-conflict-${Date.now()}`,
        content: [
          `A git rebase onto the latest live site branch hit merge conflicts in: ${conflictedFiles.join(', ')}.`,
          'Please inspect the conflict markers in those files, resolve them carefully preserving both our edits and the incoming live-site updates, stage each resolved file with `git add`, and do NOT run `git rebase --continue` yourself (Halley will run it once you finish). Confirm when all listed files are cleanly resolved.',
        ].join(' '),
      },
      BACKGROUND_CONTEXT,
    );
    const settled = await sub.wait(BACKGROUND_CONTEXT);
    return settled.status === 'done';
  }

  async abort(): Promise<void> {
    await this.root.abort(BACKGROUND_CONTEXT);
    if (this.opts.pageService && this.trackedPageRequestIds.size > 0) {
      for (const id of Array.from(this.trackedPageRequestIds)) {
        await this.opts.pageService.updateStatus(id, 'failed', 'Stopped before finishing this page.');
        this.trackedPageRequestIds.delete(id);
      }
    }
  }

  async continueRun(): Promise<void> {
    await this.root.submit({ type: 'continue' }, BACKGROUND_CONTEXT);
  }

  async stop(): Promise<void> {
    await this.watchHandle?.stop().catch(() => {});
    await this.harness?.close(BACKGROUND_CONTEXT).catch(() => {});
  }
}
